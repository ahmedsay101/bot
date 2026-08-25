/**
 * Near-price directional grid trader.
 * - Levels are permanent price anchors; side assigned at activation from CURRENT mark
 * - Target: up to 2 nearest eligible EMPTY levels ABOVE mark → LONG,
 *           up to 2 nearest eligible EMPTY levels BELOW mark → SHORT
 * - Activation distance: spacing × multiplier (ref = level price)
 * - Entry: STOP_LIMIT; TP: TAKE_PROFIT_MARKET at ±spacing% from fill; no SL
 * - After TP: level → EMPTY and immediately re-reconciled (may flip LONG↔SHORT)
 * - Existing positions are NOT flipped when mark crosses their level
 * - Destroy: MAX_LIFETIME | GRID_BOUNDARY_PASSED
 */
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type { IExecutionProvider } from '../../execution/IExecutionProvider';
import type { AccountLedger } from '../../calc/AccountLedger';
import type { IManagedTrader } from '../IManagedTrader';
import type {
  TraderConfig,
  TraderMode,
  TraderStatus,
  TraderSummaryView,
  OrderUpdate,
  SymbolInfo,
  TradeSide,
  CurrentPositionView,
} from '../../../types';
import {
  buildNearPriceLevelPlans,
  assignSideForLevel,
  calcUpperBound,
  calcLowerBound,
  didCrossOutsideBoundary,
  calcNearPriceTp,
  calcStopLimitPrices,
  sizeNearPriceLevel,
  levelsPerSideFromConfig,
  activationDistancePercent,
  distancePercentFromLevel,
  isWithinActivationZone,
  isNearPriceLevelTerminal,
  equalCapitalPerLevel,
  totalGridLevels,
  resetLevelAfterTpClose,
  selectNearestTargetLevels,
  nearestGridLevelsByMark,
  NEAR_PRICE_MAX_PER_SIDE,
  type NearPriceLevelPlan,
  type NearPriceLevelStatus,
} from './nearPriceGridCalc';
import { isTpTriggeredByMark } from '../grid/gridCalc';
import {
  calcPositionUnrealizedPnl,
} from '../../calc/strategy';
import {
  calcGrossPnl,
  estimateOpenExitFee,
  feeRatesFromConfig,
  resolveExecutionFee,
} from '../../calc/fees';
import {
  calcActualNotional,
  reconcilePositionNotional,
} from '../../calc/leverage';
import { reconcileTraderAccounting } from '../../calc/accounting';
import { createContextLogger } from '../../logger';
import { withRetry } from '../../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('NearPriceDirectionalTrader');

type ExitReason = 'MAX_LIFETIME' | 'GRID_BOUNDARY_PASSED' | 'FORCE' | 'ERROR';

interface ActivePosition {
  key: string;
  direction: TradeSide;
  level: number;
  entryPrice: string;
  quantity: string;
  allocatedMargin: string;
  actualNotional: string;
  entryFee: Decimal;
  entryClientOrderId: string | null;
  tpClientOrderId: string | null;
  filled: boolean;
  closing: boolean;
}

interface LevelState {
  plan: NearPriceLevelPlan;
  /** Assigned at activation only; null while EMPTY (never permanent). */
  direction: TradeSide | null;
  status: NearPriceLevelStatus;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  entryPrice: string | null;
  filledQuantity: string | null;
  fees: string | null;
  tpPrice: string | null;
  completionReason: string | null;
  realizedNetPnl: string | null;
  exitPrice: string | null;
  allocatedMargin: string;
  notional: string;
  quantity: string;
  /** Last closed position (history); level itself is reusable. */
  lastSide: TradeSide | null;
  lastExitPrice: string | null;
  lastRealizedNetPnl: string | null;
  lastCompletionReason: string | null;
  positionsCompleted: number;
}

function levelKey(level: number): string {
  return `L:${level}`;
}

function createEmptyLevelState(plan: NearPriceLevelPlan): LevelState {
  return {
    plan,
    direction: null,
    status: 'EMPTY',
    clientOrderId: null,
    exchangeOrderId: null,
    entryPrice: null,
    filledQuantity: null,
    fees: null,
    tpPrice: null,
    completionReason: null,
    realizedNetPnl: null,
    exitPrice: null,
    allocatedMargin: '0',
    notional: '0',
    quantity: '0',
    lastSide: null,
    lastExitPrice: null,
    lastRealizedNetPnl: null,
    lastCompletionReason: null,
    positionsCompleted: 0,
  };
}

export class NearPriceDirectionalTrader extends EventEmitter implements IManagedTrader {
  readonly id: string;
  readonly symbol: string;
  readonly mode: TraderMode;

  private status: TraderStatus = 'INITIALIZING';
  private isDestroyed = false;
  private isPaused = false;
  private exiting = false;
  private activating = false;
  private symbolInfo: SymbolInfo | null = null;
  private markPrice = '0';
  private previousMarkPrice: string | null = null;
  private startPrice: string | null = null;
  private upperBound: string | null = null;
  private lowerBound: string | null = null;
  private levelsPerSide = 10;
  private spacingPercent = '2';
  private boundaryPercent = '40';
  private activationMultiplier = '2';
  private stopLimitOffsetPercent = '0.05';
  private capitalScalingEnabled = true;
  private initialCapital = new Decimal(0);
  private currentCapital = new Decimal(0);
  private realizedPnl = new Decimal(0);
  private unrealizedPnl = new Decimal(0);
  private grossRealizedPnl = new Decimal(0);
  private totalFees = new Decimal(0);
  private startedAt: Date | null = null;
  private endsAt: Date | null = null;
  private exitReason: ExitReason | null = null;
  private positionsOpened = 0;
  private positionsClosed = 0;
  private takeProfits = 0;
  private levels = new Map<string, LevelState>();
  private activePositions = new Map<string, ActivePosition>();
  private finalizedLevelKeys = new Set<string>();
  private handledFillIds = new Set<string>();
  /** When TP closes during an in-flight reconcile, run one more pass after. */
  private reconcileAgain = false;
  private capitalHistory: Array<{ at: string; capital: string; event: string; netPnl?: string }> = [];

  constructor(
    id: string,
    symbol: string,
    mode: TraderMode,
    private readonly executionProvider: IExecutionProvider,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
    private readonly accountLedger: AccountLedger,
  ) {
    super();
    this.id = id;
    this.symbol = symbol;
    this.mode = mode;
    this.boundaryPercent = String(traderConfig.gridBoundaryPercent ?? '40');
    this.spacingPercent = String(traderConfig.gridSpacingPercent ?? traderConfig.gridDistancePercent ?? '2');
    this.activationMultiplier = String(traderConfig.gridActivationMultiplier ?? '2');
    this.stopLimitOffsetPercent = String(traderConfig.stopLimitOffsetPercent ?? '0.05');
    this.capitalScalingEnabled = traderConfig.gridCapitalScalingEnabled !== false;
    this.levelsPerSide = levelsPerSideFromConfig(this.boundaryPercent, this.spacingPercent);
  }

  getStatus(): TraderStatus { return this.status; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }
  hasOpenPosition(): boolean {
    for (const a of this.activePositions.values()) {
      if (a.filled && !a.closing && !this.finalizedLevelKeys.has(a.key)) return true;
    }
    return false;
  }
  getOpenLegCount(): number {
    let n = 0;
    for (const a of this.activePositions.values()) {
      if (a.filled && !a.closing && !this.finalizedLevelKeys.has(a.key)) n += 1;
    }
    return n;
  }
  getId(): string { return this.id; }
  getSymbol(): string { return this.symbol; }
  getRealizedPnl(): string { return this.realizedPnl.toFixed(8); }
  getUnrealizedPnl(): string {
    this.recomputeUnrealized();
    return this.unrealizedPnl.toFixed(8);
  }
  getOpenNotional(): string | null {
    let sum = new Decimal(0);
    for (const a of this.activePositions.values()) {
      if (!a.filled || a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      sum = sum.plus(a.actualNotional);
    }
    return sum.isZero() ? null : sum.toFixed(8);
  }

  async initialize(): Promise<void> {
    log.info(`Initializing near-price trader ${this.id} for ${this.symbol}`, {
      boundaryPercent: this.boundaryPercent,
      spacingPercent: this.spacingPercent,
      activationMultiplier: this.activationMultiplier,
      levelsPerSide: this.levelsPerSide,
    });
    this.symbolInfo = await withRetry(
      () => this.executionProvider.getSymbolInfo(this.symbol),
      { maxAttempts: 3, delayMs: 1000 },
    );
    await withRetry(() => this.executionProvider.setHedgeMode(true), { maxAttempts: 3, delayMs: 1000 });
    await withRetry(
      () => this.executionProvider.setLeverage(this.symbol, this.traderConfig.leverage),
      { maxAttempts: 3, delayMs: 1000 },
    );
    await withRetry(
      () => this.executionProvider.setMarginMode(this.symbol, this.traderConfig.marginMode),
      { maxAttempts: 3, delayMs: 1000 },
    );

    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    this.previousMarkPrice = this.markPrice;
    this.startedAt = new Date();
    const hours = Math.max(0.001, this.traderConfig.traderMaxLifetimeHours ?? 12);
    this.endsAt = new Date(this.startedAt.getTime() + hours * 3600_000);

    const allocation = await this.accountLedger.getAllocation(
      this.traderConfig.maxTraders,
      this.traderConfig.leverage,
    );
    this.initialCapital = allocation.traderEquity;
    this.currentCapital = allocation.traderEquity;
    this.capitalHistory.push({
      at: new Date().toISOString(),
      capital: this.currentCapital.toFixed(8),
      event: 'INIT',
    });

    this.startPrice = this.markPrice;
    this.upperBound = calcUpperBound(this.startPrice, this.boundaryPercent).toFixed(8);
    this.lowerBound = calcLowerBound(this.startPrice, this.boundaryPercent).toFixed(8);

    const plans = buildNearPriceLevelPlans({
      startPrice: this.startPrice,
      boundaryPercent: this.boundaryPercent,
      spacingPercent: this.spacingPercent,
      symbolInfo: this.symbolInfo,
    });
    for (const plan of plans) {
      this.levels.set(levelKey(plan.level), createEmptyLevelState(plan));
    }

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        behavior: 'near_price_directional',
        startPrice: this.startPrice,
        gridLevelsPerSide: this.levelsPerSide,
        gridDistancePercent: this.spacingPercent,
        traderAllocatedAmount: this.initialCapital.toFixed(8),
        currentCapital: this.currentCapital.toFixed(8),
        initialCapital: this.initialCapital.toFixed(8),
        status: 'ACTIVE',
        startedAt: this.startedAt,
        endsAt: this.endsAt,
      } as any,
    });

    for (const level of this.levels.values()) {
      await this.persistLevel(level);
    }

    this.status = 'ACTIVE';
    this.emit('traderEvent', { type: 'STATUS_CHANGED', traderId: this.id, status: this.status });
    log.info('[LIFECYCLE] NEAR_PRICE_GRID_ACTIVE', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      lowerBound: this.lowerBound,
      upperBound: this.upperBound,
      levels: this.levels.size,
      activationDistancePct: activationDistancePercent(this.spacingPercent, this.activationMultiplier).toFixed(4),
    });

    // Immediately activate levels already in zone
    await this.tryActivateEligibleLevels();
    this.emitSnapshot();
  }

  async restore(state: any): Promise<void> {
    this.status = state.status ?? 'ACTIVE';
    this.realizedPnl = new Decimal(state.realizedPnl ?? '0');
    this.unrealizedPnl = new Decimal(state.unrealizedPnl ?? '0');
    this.totalFees = new Decimal(state.totalFees ?? '0');
    this.initialCapital = new Decimal(state.traderAllocatedAmount ?? state.initialCapital ?? '0');
    this.currentCapital = new Decimal(state.currentCapital ?? this.initialCapital);
    this.startPrice = state.startPrice ?? null;
    this.spacingPercent = String(state.gridDistancePercent ?? this.spacingPercent);
    this.levelsPerSide = state.gridLevelsPerSide ?? this.levelsPerSide;
    if (this.startPrice != null) {
      this.upperBound = calcUpperBound(this.startPrice, this.boundaryPercent).toFixed(8);
      this.lowerBound = calcLowerBound(this.startPrice, this.boundaryPercent).toFixed(8);
    }
    this.endsAt = state.endsAt != null ? new Date(state.endsAt) : null;
    this.startedAt = state.startedAt != null ? new Date(state.startedAt) : null;
    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    this.previousMarkPrice = this.markPrice;

    const rows: any[] = state.gridLevels ?? [];
    if (rows.length === 0 && this.startPrice != null && this.symbolInfo != null) {
      const plans = buildNearPriceLevelPlans({
        startPrice: this.startPrice,
        boundaryPercent: this.boundaryPercent,
        spacingPercent: this.spacingPercent,
        symbolInfo: this.symbolInfo,
      });
      for (const plan of plans) {
        this.levels.set(levelKey(plan.level), createEmptyLevelState(plan));
      }
    } else {
      for (const row of rows) {
        const dir = row.direction === 'LONG' || row.direction === 'SHORT' ? row.direction as TradeSide : null;
        let status = (row.status === 'PENDING' && dir == null ? 'EMPTY' : row.status) as NearPriceLevelStatus;
        const lvl = Number(row.level);
        // Legacy: TP_HIT meant permanent dead — migrate to reusable EMPTY + last history
        const wasTpHit = status === 'TP_HIT';
        if (wasTpHit) {
          status = 'EMPTY';
        }
        const plan: NearPriceLevelPlan = {
          level: lvl,
          geometry: new Decimal(row.triggerPrice).gte(this.startPrice ?? '0') ? 'ABOVE' : 'BELOW',
          step: lvl,
          levelPrice: row.triggerPrice,
          status,
        };
        const level = createEmptyLevelState(plan);
        if (wasTpHit) {
          level.lastSide = dir;
          level.lastCompletionReason = row.completionReason ?? 'TP';
          level.lastExitPrice = row.exitPrice ?? null;
          level.lastRealizedNetPnl = row.realizedPnl ?? null;
          level.completionReason = level.lastCompletionReason;
          level.exitPrice = level.lastExitPrice;
          level.realizedNetPnl = level.lastRealizedNetPnl;
          level.fees = row.fees ?? null;
          level.positionsCompleted = 1;
        } else {
          level.direction = dir;
          level.status = status;
          level.clientOrderId = row.clientOrderId ?? null;
          level.exchangeOrderId = row.exchangeOrderId ?? null;
          level.entryPrice = row.entryPrice ?? null;
          level.filledQuantity = row.filledQuantity ?? null;
          level.fees = row.fees ?? null;
          level.tpPrice = row.tpPrice ?? null;
          level.completionReason = row.completionReason ?? null;
          level.allocatedMargin = row.allocatedMargin ?? '0';
          level.notional = row.notional ?? '0';
          level.quantity = row.quantity ?? '0';
        }
        this.levels.set(levelKey(lvl), level);
        // Only permanently terminal statuses (CANCELLED/SKIPPED) block reactivation
        if (isNearPriceLevelTerminal(level.status)) {
          this.finalizedLevelKeys.add(levelKey(lvl));
        }
      }
    }

    const openPos: any[] = state.openPositions ?? [];
    for (const p of openPos) {
      const key = levelKey(Number(p.hedgeLevel));
      const level = this.levels.get(key);
      if (level == null) continue;
      const direction = (p.side === 'SHORT' ? 'SHORT' : 'LONG') as TradeSide;
      level.direction = direction;
      level.status = 'ACTIVE';
      level.entryPrice = p.entryPrice;
      this.activePositions.set(key, {
        key,
        direction,
        level: Number(p.hedgeLevel),
        entryPrice: p.entryPrice,
        quantity: p.quantity,
        allocatedMargin: level.allocatedMargin || new Decimal(p.quantity).mul(p.entryPrice).div(this.traderConfig.leverage).toFixed(8),
        actualNotional: new Decimal(p.quantity).mul(p.entryPrice).toFixed(8),
        entryFee: new Decimal(0),
        entryClientOrderId: p.clientOrderId ?? null,
        tpClientOrderId: null,
        filled: true,
        closing: false,
      });
    }

    if (this.status === 'ACTIVE') {
      await this.tryActivateEligibleLevels();
    }
    this.emitSnapshot();
  }

  async resumeCompleting(): Promise<void> {
    if (this.isDestroyed) return;
    await this.beginExit(this.exitReason ?? 'FORCE');
  }

  onPriceUpdate(price: string): void {
    if (this.isDestroyed || this.isPaused) return;
    const previous = this.previousMarkPrice ?? this.markPrice;
    this.previousMarkPrice = this.markPrice;
    this.markPrice = price;
    this.recomputeUnrealized();
    this.emitSnapshot();
    if (this.status !== 'ACTIVE' || this.exiting) return;
    if (this.endsAt != null && Date.now() >= this.endsAt.getTime()) {
      void this.beginExit('MAX_LIFETIME');
      return;
    }
    void this.reconcileProtectiveByMark(previous, price).then(async () => {
      if (this.exiting || this.isDestroyed || this.status !== 'ACTIVE') return;
      if (
        this.lowerBound != null
        && this.upperBound != null
        && didCrossOutsideBoundary(previous, price, this.lowerBound, this.upperBound)
      ) {
        await this.beginExit('GRID_BOUNDARY_PASSED');
        return;
      }
      await this.tryActivateEligibleLevels();
    });
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;
    for (const active of this.activePositions.values()) {
      if (update.clientOrderId === active.entryClientOrderId) {
        if (update.status === 'FILLED') await this.handleEntryFill(active.key, update);
        return;
      }
      if (
        active.tpClientOrderId != null
        && update.clientOrderId === active.tpClientOrderId
        && update.status === 'FILLED'
      ) {
        await this.handleProtectiveFill(active.key, update);
        return;
      }
    }
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    this.status = 'PAUSED';
    this.emit('traderEvent', { type: 'STATUS_CHANGED', traderId: this.id, status: this.status });
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    if (this.status === 'PAUSED') {
      this.status = 'ACTIVE';
      this.emit('traderEvent', { type: 'STATUS_CHANGED', traderId: this.id, status: this.status });
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.removeAllListeners();
  }

  async emergencyStop(): Promise<void> {
    await this.beginExit('FORCE');
  }

  toSummary(): TraderSummaryView {
    this.recomputeUnrealized();
    const remainingMs = this.endsAt != null ? Math.max(0, this.endsAt.getTime() - Date.now()) : 0;
    const runtimeMs = this.startedAt != null ? Date.now() - this.startedAt.getTime() : 0;
    const rates = feeRatesFromConfig(this.traderConfig);
    const currentPositions: CurrentPositionView[] = [];
    for (const a of this.activePositions.values()) {
      if (!a.filled || a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      const gross = calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity);
      // Entry fee already in trader.realizedPnl; only estimate remaining exit fee for "close now" net.
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      const netU = gross.minus(estExit);
      const lvl = this.levels.get(a.key);
      currentPositions.push({
        number: a.level,
        side: a.direction,
        capitalStep: a.level,
        entryPrice: a.entryPrice,
        quantity: a.quantity,
        tpPrice: lvl?.tpPrice ?? '',
        slPrice: '',
        stepAmount: a.allocatedMargin,
        positionNotional: a.actualNotional,
        unrealizedPnl: gross.toFixed(8),
        estimatedExitFee: estExit.toFixed(8),
        netUnrealizedPnl: netU.toFixed(8),
        entryFee: a.entryFee.toFixed(8),
        roiPercent: a.allocatedMargin !== '0'
          ? netU.div(a.allocatedMargin).mul(100).toFixed(4)
          : '0',
        status: 'OPEN',
      });
    }

    const gridLevels = [...this.levels.values()]
      .sort((a, b) => new Decimal(b.plan.levelPrice).cmp(new Decimal(a.plan.levelPrice)))
      .map((l) => {
        const terminal = isNearPriceLevelTerminal(l.status);
        const active = this.activePositions.get(levelKey(l.plan.level));
        let uPnl: string | null = null;
        if (active != null && active.filled && !terminal && !active.closing) {
          uPnl = calcPositionUnrealizedPnl(
            active.direction,
            active.entryPrice,
            this.markPrice,
            active.quantity,
          ).toFixed(8);
        }
        const dist = distancePercentFromLevel(this.markPrice, l.plan.levelPrice);
        const threshold = activationDistancePercent(this.spacingPercent, this.activationMultiplier);
        const eligible = l.status === 'EMPTY'
          && isWithinActivationZone(
            this.markPrice,
            l.plan.levelPrice,
            this.spacingPercent,
            this.activationMultiplier,
          );
        // EMPTY = available (reusable). PENDING = entry in flight. ACTIVE = filled.
        // TP does not kill the level — last* fields hold closed-position history.
        const hasLive = active != null && !terminal && !active.closing;
        return {
          level: l.plan.level,
          direction: (l.direction ?? 'LONG') as TradeSide,
          triggerPrice: l.plan.levelPrice,
          limitPrice: l.plan.levelPrice,
          allocatedMargin: hasLive ? active!.allocatedMargin : '0',
          notional: hasLive ? active!.actualNotional : '0',
          leverage: this.traderConfig.leverage,
          quantity: hasLive ? active!.quantity : '0',
          status: l.status,
          entryPrice: l.entryPrice,
          exitPrice: l.exitPrice ?? l.lastExitPrice,
          unrealizedPnl: terminal ? '0' : uPnl,
          realizedPnl: l.realizedNetPnl ?? l.lastRealizedNetPnl,
          tpPrice: l.tpPrice,
          slPrice: null,
          completionReason: l.completionReason ?? l.lastCompletionReason,
          geometry: l.plan.geometry,
          nearPriceStatus: l.status,
          assignedSide: l.direction,
          lastSide: l.lastSide,
          lastCompletionReason: l.lastCompletionReason,
          lastExitPrice: l.lastExitPrice,
          lastRealizedPnl: l.lastRealizedNetPnl,
          positionsCompleted: l.positionsCompleted,
          distancePercent: dist.toFixed(4),
          activationThresholdPercent: threshold.toFixed(4),
          activationEligible: eligible,
        };
      });

    const activeOpen = [...this.activePositions.values()].filter(
      (a) => a.filled && !a.closing && !this.finalizedLevelKeys.has(a.key),
    );
    let activeMargin = new Decimal(0);
    let activeNotional = new Decimal(0);
    // Filled positions + in-flight entry orders reserve capital; EMPTY levels reserve nothing
    for (const a of this.activePositions.values()) {
      if (a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      activeMargin = activeMargin.plus(a.allocatedMargin);
      activeNotional = activeNotional.plus(a.actualNotional);
    }
    const perLevel = equalCapitalPerLevel(this.initialCapital, this.levelsPerSide);
    const emptyCount = [...this.levels.values()].filter((l) => l.status === 'EMPTY').length;
    const orderPendingCount = [...this.levels.values()].filter(
      (l) => l.status === 'PENDING' && l.clientOrderId != null,
    ).length;
    const activeCount = [...this.levels.values()].filter((l) => l.status === 'ACTIVE').length;
    // Levels are reusable — do not count closed TPs as dead levels
    const permanentlyDead = [...this.levels.values()].filter(
      (l) => isNearPriceLevelTerminal(l.status),
    ).length;
    const completedPositionInstances = [...this.levels.values()].reduce(
      (n, l) => n + l.positionsCompleted,
      0,
    );

    return {
      id: this.id,
      symbol: this.symbol,
      status: this.status,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      totalPnl: this.realizedPnl.plus(this.unrealizedPnl).toFixed(8),
      grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
      totalFees: this.totalFees.toFixed(8),
      markPrice: this.markPrice,
      leverage: this.traderConfig.leverage,
      capital: {
        traderAllocatedAmount: this.initialCapital.toFixed(8),
        totalSteps: this.levelsPerSide,
        capitalSteps: this.levelsPerSide,
        currentStep: 0,
        currentStepAllocation: '0',
        currentStepAmount: this.currentCapital.toFixed(8),
        positionNotional: this.getOpenNotional() ?? '0',
        steps: [],
        highestStepReached: 0,
        lowestStepReached: 1,
        stepIncreases: 0,
        stepDecreases: 0,
        stepResets: 0,
        step1Trades: 0,
        maxStepTrades: 0,
      },
      currentPosition: currentPositions[0] ?? null,
      currentPositions,
      stats: {
        startedAt: this.startedAt?.toISOString() ?? null,
        endsAt: this.endsAt?.toISOString() ?? null,
        remainingMs,
        runtimeMs,
        currentPositionNumber: 0,
        positionsOpened: this.positionsOpened,
        positionsClosed: this.positionsClosed,
        winningPositions: 0,
        losingPositions: 0,
        takeProfits: this.takeProfits,
        stopLosses: 0,
        longPositions: activeOpen.filter((a) => a.direction === 'LONG').length,
        shortPositions: activeOpen.filter((a) => a.direction === 'SHORT').length,
        winRate: '0.00',
        grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        netRealizedPnl: this.realizedPnl.toFixed(8),
        currentStep: 0,
        highestStepReached: 0,
        lowestStepReached: 1,
        stepIncreases: 0,
        stepDecreases: 0,
        stepResets: 0,
        step1Trades: 0,
        maxStepTrades: 0,
      },
      timeline: [],
      distanceToTpPct: null,
      distanceToTpAbs: null,
      distanceToSlPct: null,
      distanceToSlAbs: null,
      openOrders: this.activePositions.size,
      pendingOrders: orderPendingCount,
      closedOrders: 0,
      orders: [],
      behavior: 'near_price_directional',
      grid: {
        startPrice: this.startPrice ?? '0',
        levelsPerSide: this.levelsPerSide,
        distancePercent: this.spacingPercent,
        takeProfitPercent: this.spacingPercent,
        longFilled: activeOpen.filter((a) => a.direction === 'LONG').length,
        shortFilled: activeOpen.filter((a) => a.direction === 'SHORT').length,
        levels: gridLevels as any,
        profitPercent: this.initialCapital.isZero()
          ? '0'
          : this.realizedPnl.plus(this.unrealizedPnl).div(this.initialCapital).mul(100).toFixed(4),
        exitReason: this.exitReason,
        currentCapital: this.currentCapital.toFixed(8),
        initialCapital: this.initialCapital.toFixed(8),
        equity: this.currentCapital.plus(this.unrealizedPnl).toFixed(8),
        capitalHistory: this.capitalHistory,
        maxPerSide: this.levelsPerSide,
        maxOpenPositions: totalGridLevels(this.levelsPerSide),
        activeOpenCount: activeOpen.length,
        longOpen: activeOpen.filter((a) => a.direction === 'LONG').length,
        shortOpen: activeOpen.filter((a) => a.direction === 'SHORT').length,
        capitalScalingEnabled: this.capitalScalingEnabled,
        capitalPerLevel: perLevel.toFixed(8),
        activePositionMargin: activeMargin.toFixed(8),
        activePositionNotional: activeNotional.toFixed(8),
        remainingAvailableCapital: Decimal.max(0, this.initialCapital.minus(activeMargin)).toFixed(8),
        perPositionNotional: perLevel.mul(this.traderConfig.leverage).toFixed(8),
        maxActivePositions: totalGridLevels(this.levelsPerSide),
        targetNearbyPositions: NEAR_PRICE_MAX_PER_SIDE * 2,
        targetLongAbove: NEAR_PRICE_MAX_PER_SIDE,
        targetShortBelow: NEAR_PRICE_MAX_PER_SIDE,
        totalLevels: totalGridLevels(this.levelsPerSide),
        levelsPending: orderPendingCount,
        levelsActive: activeCount,
        levelsTp: this.takeProfits,
        levelsSl: 0,
        levelsDead: permanentlyDead,
        levelsEmpty: emptyCount,
        levelsAvailable: emptyCount,
        levelsOrderPending: orderPendingCount,
        levelsTradable: emptyCount + orderPendingCount + activeCount,
        positionsCompleted: completedPositionInstances,
        lastLongLevel: this.lowerBound,
        lastShortLevel: this.upperBound,
        upperDestroyPrice: this.upperBound,
        lowerDestroyPrice: this.lowerBound,
        lifetimeRemaining: remainingMs,
        destroyConditions: {
          lifetimeExpired: this.endsAt != null && Date.now() >= this.endsAt.getTime(),
          pastFinalLong: this.lowerBound != null
            && new Decimal(this.markPrice).lt(this.lowerBound),
          pastFinalShort: this.upperBound != null
            && new Decimal(this.markPrice).gt(this.upperBound),
          remainingMs,
        },
        nearPrice: true,
        boundaryPercent: this.boundaryPercent,
        spacingPercent: this.spacingPercent,
        activationMultiplier: this.activationMultiplier,
        activationDistancePercent: activationDistancePercent(
          this.spacingPercent,
          this.activationMultiplier,
        ).toFixed(4),
        upperBound: this.upperBound,
        lowerBound: this.lowerBound,
      } as any,
    };
  }

  private getEqualMarginPerLevel(): Decimal {
    return equalCapitalPerLevel(this.initialCapital, this.levelsPerSide);
  }

  private getActiveMarginUsed(): Decimal {
    let used = new Decimal(0);
    for (const a of this.activePositions.values()) {
      if (a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      used = used.plus(a.allocatedMargin);
    }
    return used;
  }

  private hasFreeEqualMargin(): boolean {
    if (this.capitalScalingEnabled) return true;
    const needed = this.getEqualMarginPerLevel();
    if (needed.lte(0)) return false;
    if (this.initialCapital.minus(this.getActiveMarginUsed()).lt(needed)) return false;
    if (this.currentCapital.lt(needed)) return false;
    return true;
  }

  private async tryActivateEligibleLevels(): Promise<void> {
    if (this.activating || this.exiting || this.isDestroyed) return;
    if (this.status !== 'ACTIVE' || this.isPaused) return;
    if (this.symbolInfo == null || this.startPrice == null) return;

    this.activating = true;
    try {
      const threshold = activationDistancePercent(this.spacingPercent, this.activationMultiplier);
      const allSnapshots = [...this.levels.values()].map((l) => ({
        level: l.plan.level,
        levelPrice: l.plan.levelPrice,
        status: l.status,
        clientOrderId: l.clientOrderId,
        key: levelKey(l.plan.level),
        direction: l.direction,
      }));

      const geometric = nearestGridLevelsByMark(allSnapshots, this.markPrice, NEAR_PRICE_MAX_PER_SIDE);
      const selection = selectNearestTargetLevels(
        allSnapshots,
        this.markPrice,
        this.spacingPercent,
        this.activationMultiplier,
        NEAR_PRICE_MAX_PER_SIDE,
      );

      const existingSummary = allSnapshots
        .filter((l) => l.status === 'PENDING' || l.status === 'ACTIVE')
        .map((l) => ({
          level: l.level,
          levelPrice: l.levelPrice,
          status: l.status,
          side: l.direction,
        }));

      log.info('[LIFECYCLE] GRID_RECONCILIATION', {
        traderId: this.id,
        symbol: this.symbol,
        currentPrice: this.markPrice,
        activationThresholdPercent: threshold.toFixed(4),
        nearestLevelsAbove: geometric.above.map((l) => l.levelPrice),
        nearestLevelsBelow: geometric.below.map((l) => l.levelPrice),
        desiredAvailableAssignments: selection.targets.map((t) => ({
          level: t.level.level,
          levelPrice: t.level.levelPrice,
          side: t.side,
        })),
        existing: existingSummary,
        action: selection.targets.map((t) => `Create ${t.side} for ${t.level.levelPrice}`),
      });

      for (const t of selection.targets) {
        if (this.exiting || this.isDestroyed) break;
        if (!this.capitalScalingEnabled && !this.hasFreeEqualMargin()) break;
        const level = this.levels.get(levelKey(t.level.level));
        if (level == null || level.status !== 'EMPTY') continue;
        await this.activateLevel(level);
      }
    } finally {
      this.activating = false;
    }
    if (this.reconcileAgain && !this.exiting && !this.isDestroyed) {
      this.reconcileAgain = false;
      await this.tryActivateEligibleLevels();
    }
  }

  /** Reconcile now, or queue another pass if already reconciling (e.g. TP mid-activate). */
  private async requestGridReconcile(): Promise<void> {
    if (this.activating) {
      this.reconcileAgain = true;
      return;
    }
    await this.tryActivateEligibleLevels();
  }

  private async activateLevel(level: LevelState): Promise<void> {
    if (this.symbolInfo == null) return;
    // Only EMPTY levels may receive a new entry order (PENDING = order already placed)
    if (level.status !== 'EMPTY') return;
    if (level.clientOrderId != null) return;
    const key = levelKey(level.plan.level);
    // One current position/order per level; never a permanent side or permanent finalized lock
    if (this.activePositions.has(key)) return;
    if (!this.capitalScalingEnabled && !this.hasFreeEqualMargin()) return;

    // Re-check activation vs CURRENT mark (not start)
    if (!isWithinActivationZone(
      this.markPrice,
      level.plan.levelPrice,
      this.spacingPercent,
      this.activationMultiplier,
    )) {
      return;
    }

    const side = assignSideForLevel(this.markPrice, level.plan.levelPrice);
    const sized = sizeNearPriceLevel({
      traderAllocation: this.initialCapital,
      levelsPerSide: this.levelsPerSide,
      step: level.plan.step,
      leverage: this.traderConfig.leverage,
      entryPrice: level.plan.levelPrice,
      symbolInfo: this.symbolInfo,
      capitalScalingEnabled: this.capitalScalingEnabled,
    });
    if (new Decimal(sized.quantity).lte(0)) {
      level.status = 'SKIPPED';
      await this.persistLevel(level);
      return;
    }

    level.direction = side;
    level.allocatedMargin = sized.allocatedMargin;
    level.notional = sized.notional;
    level.quantity = sized.quantity;
    level.status = 'PENDING';

    const { stopPrice, limitPrice } = calcStopLimitPrices(
      level.plan.levelPrice,
      side,
      this.stopLimitOffsetPercent,
      this.symbolInfo,
    );

    // Already through stop → market entry
    const mark = new Decimal(this.markPrice);
    const alreadyThrough = side === 'LONG' ? mark.gte(stopPrice) : mark.lte(stopPrice);
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const clientOrderId = `np-${shortId}-${side[0]}${level.plan.level}-e-${uuidv4().slice(0, 6)}`;
    const orderSide = side === 'LONG' ? 'BUY' as const : 'SELL' as const;

    try {
      const res = alreadyThrough
        ? await this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: orderSide,
          type: 'MARKET',
          role: side,
          hedgeLevel: level.plan.level,
          quantity: sized.quantity,
          positionSide: side,
        } as any)
        : await this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: orderSide,
          type: 'STOP_LIMIT',
          role: side,
          hedgeLevel: level.plan.level,
          quantity: sized.quantity,
          price: limitPrice,
          stopPrice,
          positionSide: side,
        } as any);

      level.clientOrderId = res.clientOrderId;
      level.exchangeOrderId = res.exchangeOrderId;
      await this.db.order.upsert({
        where: { clientOrderId: res.clientOrderId },
        update: { status: res.status, exchangeOrderId: res.exchangeOrderId },
        create: {
          traderId: this.id,
          exchangeOrderId: res.exchangeOrderId,
          clientOrderId: res.clientOrderId,
          symbol: this.symbol,
          side: res.side,
          type: alreadyThrough ? 'MARKET' : 'STOP_LIMIT',
          status: res.status,
          role: side,
          hedgeLevel: level.plan.level,
          quantity: res.quantity,
          price: alreadyThrough ? null : limitPrice,
          stopPrice: alreadyThrough ? null : stopPrice,
          filledQuantity: res.filledQuantity,
          avgFillPrice: res.avgFillPrice,
          fee: res.fee,
          feeCurrency: res.feeCurrency,
        },
      });

      this.activePositions.set(key, {
        key,
        direction: side,
        level: level.plan.level,
        entryPrice: level.plan.levelPrice,
        quantity: sized.quantity,
        allocatedMargin: sized.allocatedMargin,
        actualNotional: sized.notional,
        entryFee: new Decimal(0),
        entryClientOrderId: res.clientOrderId,
        tpClientOrderId: null,
        filled: false,
        closing: false,
      });
      await this.persistLevel(level);

      log.info('[LIFECYCLE] NEAR_PRICE_LEVEL_ORDERED', {
        traderId: this.id,
        key,
        side,
        levelPrice: level.plan.levelPrice,
        stopPrice,
        limitPrice,
        alreadyThrough,
        type: alreadyThrough ? 'MARKET' : 'STOP_LIMIT',
      });

      if (res.status === 'FILLED') {
        await this.handleEntryFill(key, {
          clientOrderId: res.clientOrderId,
          exchangeOrderId: res.exchangeOrderId,
          symbol: this.symbol,
          status: 'FILLED',
          filledQuantity: res.filledQuantity || sized.quantity,
          avgFillPrice: res.avgFillPrice ?? level.plan.levelPrice,
          fee: res.fee,
          feeCurrency: res.feeCurrency,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      log.error('Failed activating near-price level', { key, error: String(err) });
      level.status = 'EMPTY';
      level.direction = null;
      level.clientOrderId = null;
      this.activePositions.delete(key);
      await this.persistLevel(level);
    }
  }

  private async handleEntryFill(key: string, update: OrderUpdate): Promise<void> {
    const level = this.levels.get(key);
    const active = this.activePositions.get(key);
    if (level == null || active == null) return;
    if (active.filled || this.finalizedLevelKeys.has(key)) return;
    if (level.direction == null) return;

    const fillKey = `${update.clientOrderId}:ENTRY`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    const entry = update.avgFillPrice ?? level.plan.levelPrice;
    const qty = update.filledQuantity || active.quantity;
    const fee = resolveExecutionFee({
      price: entry,
      quantity: qty,
      actualFee: update.fee,
      rates: feeRatesFromConfig(this.traderConfig),
      liquidity: 'TAKER',
    });

    active.filled = true;
    active.entryPrice = entry;
    active.quantity = qty;
    active.entryFee = fee;
    active.actualNotional = calcActualNotional(entry, qty).toFixed(8);
    reconcilePositionNotional({
      traderId: this.id,
      symbol: this.symbol,
      positionId: active.key,
      allocatedMargin: active.allocatedMargin,
      leverage: this.traderConfig.leverage,
      actualNotional: active.actualNotional,
      quantity: qty,
      entryPrice: entry,
    });
    // Keep allocatedMargin as planned; notional from fill
    active.allocatedMargin = new Decimal(active.actualNotional)
      .div(Math.max(1, this.traderConfig.leverage))
      .toFixed(8);

    const tp = calcNearPriceTp(entry, level.direction, this.spacingPercent, this.symbolInfo!);
    level.status = 'ACTIVE';
    level.entryPrice = entry;
    level.filledQuantity = qty;
    level.fees = fee.toFixed(8);
    level.tpPrice = tp;
    level.allocatedMargin = active.allocatedMargin;
    level.notional = active.actualNotional;
    level.quantity = qty;
    this.positionsOpened += 1;
    this.totalFees = this.totalFees.plus(fee);
    // Book entry fee immediately into realized + global ledger (same as GridDirectionalTrader).
    // Trader currentCapital is adjusted by full net (gross − entry − exit) only at close.
    this.realizedPnl = this.realizedPnl.minus(fee);
    await this.accountLedger.recordFee(fee);
    await this.persistLevel(level);

    await this.db.position.create({
      data: {
        traderId: this.id,
        symbol: this.symbol,
        side: level.direction,
        role: level.direction,
        hedgeLevel: level.plan.level,
        entryPrice: entry,
        quantity: qty,
        leverage: this.traderConfig.leverage,
        isOpen: true,
        markPrice: this.markPrice,
      },
    });
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        realizedPnl: this.realizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
      } as any,
    });

    await this.placeTp(active, tp);
    this.recomputeUnrealized();
    this.emitSnapshot();
  }

  private async placeTp(active: ActivePosition, tpPrice: string): Promise<void> {
    if (this.symbolInfo == null || this.exiting || this.isDestroyed) return;
    if (this.finalizedLevelKeys.has(active.key) || active.closing) return;
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const tpClientOrderId = `np-${shortId}-${active.direction[0]}${active.level}-tp-${uuidv4().slice(0, 6)}`;
    const exitSide = active.direction === 'LONG' ? 'SELL' as const : 'BUY' as const;

    if (isTpTriggeredByMark(active.direction, this.markPrice, tpPrice)) {
      await this.handleProtectiveFill(active.key, {
        clientOrderId: `mark-tp-immediate-${active.key}`,
        exchangeOrderId: `mark-tp-immediate-${active.key}`,
        symbol: this.symbol,
        status: 'FILLED',
        filledQuantity: active.quantity,
        avgFillPrice: tpPrice,
        fee: null,
        feeCurrency: null,
        timestamp: Date.now(),
      });
      return;
    }

    try {
      const tpRes = await this.executionProvider.placeOrder({
        traderId: this.id,
        clientOrderId: tpClientOrderId,
        symbol: this.symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        role: active.direction,
        hedgeLevel: active.level,
        quantity: active.quantity,
        stopPrice: tpPrice,
        positionSide: active.direction,
        reduceOnly: true,
      } as any);
      active.tpClientOrderId = tpRes.clientOrderId;
      await this.db.order.upsert({
        where: { clientOrderId: tpRes.clientOrderId },
        update: { status: tpRes.status, exchangeOrderId: tpRes.exchangeOrderId },
        create: {
          traderId: this.id,
          exchangeOrderId: tpRes.exchangeOrderId,
          clientOrderId: tpRes.clientOrderId,
          symbol: this.symbol,
          side: tpRes.side,
          type: 'TAKE_PROFIT_MARKET',
          status: tpRes.status,
          role: active.direction,
          hedgeLevel: active.level,
          quantity: tpRes.quantity,
          stopPrice: tpPrice,
          filledQuantity: tpRes.filledQuantity,
          avgFillPrice: tpRes.avgFillPrice,
          fee: tpRes.fee,
          feeCurrency: tpRes.feeCurrency,
        },
      });
      if (tpRes.status === 'FILLED') {
        await this.handleProtectiveFill(active.key, {
          clientOrderId: tpRes.clientOrderId,
          exchangeOrderId: tpRes.exchangeOrderId,
          symbol: this.symbol,
          status: 'FILLED',
          filledQuantity: tpRes.filledQuantity || active.quantity,
          avgFillPrice: tpRes.avgFillPrice ?? tpPrice,
          fee: tpRes.fee,
          feeCurrency: tpRes.feeCurrency,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      log.error('Failed placing near-price TP', { key: active.key, error: String(err) });
    }
  }

  private async reconcileProtectiveByMark(previousPrice: string, currentPrice: string): Promise<void> {
    if (this.exiting || this.isDestroyed || this.status !== 'ACTIVE') return;
    for (const active of [...this.activePositions.values()]) {
      if (!active.filled || active.closing) continue;
      if (this.finalizedLevelKeys.has(active.key)) {
        this.activePositions.delete(active.key);
        continue;
      }
      const level = this.levels.get(active.key);
      if (level == null || isNearPriceLevelTerminal(level.status)) {
        this.activePositions.delete(active.key);
        continue;
      }
      const tp = level.tpPrice;
      if (tp == null || tp === '') continue;
      if (!isTpTriggeredByMark(active.direction, currentPrice, tp)) continue;
      if (active.tpClientOrderId != null) {
        try {
          await this.executionProvider.cancelOrder({
            symbol: this.symbol,
            clientOrderId: active.tpClientOrderId,
          } as any);
        } catch { /* best-effort */ }
      }
      await this.handleProtectiveFill(active.key, {
        clientOrderId: `mark-tp-${active.key}-${Date.now()}`,
        exchangeOrderId: `mark-tp-${active.key}`,
        symbol: this.symbol,
        status: 'FILLED',
        filledQuantity: active.quantity,
        avgFillPrice: tp,
        fee: null,
        feeCurrency: null,
        timestamp: Date.now(),
      });
    }
  }

  private async handleProtectiveFill(key: string, update: OrderUpdate): Promise<void> {
    // Allow settlement while COMPLETING (force-close). Block only after destroy.
    if (this.isDestroyed) return;
    const level = this.levels.get(key);
    if (level == null || level.direction == null) return;
    const active = this.activePositions.get(key);
    if (active == null || !active.filled) return;
    if (active.closing && this.handledFillIds.has(`${update.clientOrderId}:TP`)) {
      this.activePositions.delete(key);
      this.recomputeUnrealized();
      return;
    }

    const fillKey = `${update.clientOrderId}:TP`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    active.closing = true;
    const closedSide = active.direction;
    const exit = update.avgFillPrice ?? level.tpPrice ?? this.markPrice;
    const qty = update.filledQuantity || active.quantity;
    const exitFee = resolveExecutionFee({
      price: exit,
      quantity: qty,
      actualFee: update.fee,
      rates: feeRatesFromConfig(this.traderConfig),
      liquidity: 'TAKER',
    });
    const gross = calcGrossPnl(closedSide, active.entryPrice, exit, qty);
    const net = gross.minus(active.entryFee).minus(exitFee);

    // Remove from active accounting — release margin for this instance
    this.activePositions.delete(key);
    this.finalizedLevelKeys.delete(key);
    this.recomputeUnrealized();

    // Position instance history (level remains reusable)
    level.lastSide = closedSide;
    level.lastExitPrice = exit;
    level.lastRealizedNetPnl = net.toFixed(8);
    level.lastCompletionReason = 'TP';
    level.positionsCompleted += 1;
    level.completionReason = 'TP';
    level.exitPrice = exit;
    level.realizedNetPnl = net.toFixed(8);
    level.fees = active.entryFee.plus(exitFee).toFixed(8);

    // Reset level to EMPTY/AVAILABLE — no permanent DEAD/TP_HIT
    Object.assign(level, resetLevelAfterTpClose());

    // Entry fee already booked into realized/totalFees/ledger at entry.
    // TP books gross − exitFee into realized; capital moves by full net (gross − entry − exit).
    this.grossRealizedPnl = this.grossRealizedPnl.plus(gross);
    this.totalFees = this.totalFees.plus(exitFee);
    this.realizedPnl = this.realizedPnl.plus(gross.minus(exitFee));
    this.currentCapital = Decimal.max(0, this.currentCapital.plus(net));
    this.positionsClosed += 1;
    this.takeProfits += 1;
    this.capitalHistory.push({
      at: new Date().toISOString(),
      capital: this.currentCapital.toFixed(8),
      event: 'TP',
      netPnl: net.toFixed(8),
    });

    log.info('[LIFECYCLE] NEAR_PRICE_LEVEL_AVAILABLE', {
      traderId: this.id,
      level: level.plan.level,
      levelPrice: level.plan.levelPrice,
      closedSide,
      exit,
      grossPnl: gross.toFixed(8),
      entryFee: active.entryFee.toFixed(8),
      exitFee: exitFee.toFixed(8),
      netPnl: net.toFixed(8),
      positionsCompleted: level.positionsCompleted,
    });

    try {
      // Propagate to global AccountLedger (was missing — caused global realized/fees = 0)
      await this.accountLedger.recordRealized(gross, exitFee);
      await this.persistLevel(level);
      await this.db.position.updateMany({
        where: { traderId: this.id, hedgeLevel: active.level, isOpen: true },
        data: { isOpen: false, closedAt: new Date(), realizedPnl: net.toFixed(8) },
      });
      await this.db.trader.update({
        where: { id: this.id },
        data: {
          realizedPnl: this.realizedPnl.toFixed(8),
          unrealizedPnl: this.unrealizedPnl.toFixed(8),
          currentCapital: this.currentCapital.toFixed(8),
          totalFees: this.totalFees.toFixed(8),
        } as any,
      });
    } catch (err) {
      log.error('[LIFECYCLE] NEAR_PRICE_CLOSE_PERSIST_FAILED (in-memory close kept)', {
        traderId: this.id,
        key,
        error: String(err),
      });
    }

    const openEntryFees = [...this.activePositions.values()]
      .filter((a) => a.filled && !a.closing)
      .reduce((s, a) => s.plus(a.entryFee), new Decimal(0));
    const recon = reconcileTraderAccounting({
      initialCapital: this.initialCapital,
      realizedNetPnl: this.realizedPnl,
      unrealizedPnl: this.unrealizedPnl,
      totalFees: this.totalFees,
      actualCurrentCapital: this.currentCapital,
      actualEquity: this.currentCapital.plus(this.unrealizedPnl),
      openEntryFees,
    });
    if (!recon.ok) {
      log.warn('[LIFECYCLE] TRADER_ACCOUNTING_RECONCILIATION', {
        traderId: this.id,
        symbol: this.symbol,
        ...recon,
      });
    }

    const newSide = assignSideForLevel(this.markPrice, level.plan.levelPrice);
    log.info('[LIFECYCLE] NEAR_PRICE_LEVEL_REASSIGN', {
      traderId: this.id,
      level: level.plan.level,
      levelPrice: level.plan.levelPrice,
      previous: closedSide,
      currentPrice: this.markPrice,
      newSide,
      positionsCompleted: level.positionsCompleted,
    });

    this.emitSnapshot();
    // Immediately reconcile: reuse level if it is among nearest eligible targets
    await this.requestGridReconcile();
  }

  private recomputeUnrealized(): void {
    // Gross mark-to-market only (same as Grid). Entry fees live in realizedPnl;
    // do NOT subtract them again here or totalPnl double-counts fees.
    let sum = new Decimal(0);
    for (const a of this.activePositions.values()) {
      if (!a.filled || a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      sum = sum.plus(
        calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity),
      );
    }
    this.unrealizedPnl = sum;
  }

  private async persistLevel(level: LevelState): Promise<void> {
    const direction = level.direction ?? 'EMPTY';
    const data = {
      traderId: this.id,
      level: level.plan.level,
      direction,
      triggerPrice: level.plan.levelPrice,
      limitPrice: level.plan.levelPrice,
      weight: level.plan.step,
      allocatedMargin: level.allocatedMargin,
      notional: level.notional,
      quantity: level.quantity,
      status: level.status,
      clientOrderId: level.clientOrderId,
      exchangeOrderId: level.exchangeOrderId,
      entryPrice: level.entryPrice,
      filledQuantity: level.filledQuantity,
      fees: level.fees,
      tpPrice: level.tpPrice,
      slPrice: null,
      completionReason: level.completionReason,
    };
    try {
      const api = (this.db as any).gridLevel;
      if (api?.upsert == null) return;
      // Prefer update by traderId+level when direction may have changed EMPTY→LONG/SHORT
      const existing = await api.findFirst({
        where: { traderId: this.id, level: level.plan.level },
      });
      if (existing != null) {
        await api.update({ where: { id: existing.id }, data });
      } else {
        await api.create({ data });
      }
    } catch (err) {
      log.warn('persistLevel failed', { level: level.plan.level, error: String(err) });
    }
  }

  private emitSnapshot(): void {
    this.emit('traderEvent', {
      type: 'TRADER_SNAPSHOT',
      trader: this.toSummary(),
    });
  }

  private async beginExit(reason: ExitReason): Promise<void> {
    if (this.exiting || this.isDestroyed) return;
    this.exiting = true;
    this.exitReason = reason;
    this.status = 'COMPLETING';
    log.info('[LIFECYCLE] NEAR_PRICE_EXIT', { traderId: this.id, reason });

    for (const active of [...this.activePositions.values()]) {
      if (active.entryClientOrderId != null && !active.filled) {
        try {
          await this.executionProvider.cancelOrder({
            symbol: this.symbol,
            clientOrderId: active.entryClientOrderId,
          } as any);
        } catch { /* best-effort */ }
      }
      if (active.tpClientOrderId != null) {
        try {
          await this.executionProvider.cancelOrder({
            symbol: this.symbol,
            clientOrderId: active.tpClientOrderId,
          } as any);
        } catch { /* best-effort */ }
      }
      if (active.filled && !active.closing && !this.finalizedLevelKeys.has(active.key)) {
        try {
          const exitSide = active.direction === 'LONG' ? 'SELL' as const : 'BUY' as const;
          const cid = `np-force-${active.key}-${uuidv4().slice(0, 6)}`;
          const res = await this.executionProvider.placeOrder({
            traderId: this.id,
            clientOrderId: cid,
            symbol: this.symbol,
            side: exitSide,
            type: 'MARKET',
            role: active.direction,
            hedgeLevel: active.level,
            quantity: active.quantity,
            positionSide: active.direction,
            reduceOnly: true,
          } as any);
          if (res.status === 'FILLED') {
            await this.handleProtectiveFill(active.key, {
              clientOrderId: res.clientOrderId,
              exchangeOrderId: res.exchangeOrderId,
              symbol: this.symbol,
              status: 'FILLED',
              filledQuantity: res.filledQuantity || active.quantity,
              avgFillPrice: res.avgFillPrice ?? this.markPrice,
              fee: res.fee,
              feeCurrency: res.feeCurrency,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          log.warn('Force close failed', { key: active.key, error: String(err) });
        }
      }
    }

    this.status = 'COMPLETED';
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        status: 'COMPLETED',
        exitReason: reason,
        realizedPnl: this.realizedPnl.toFixed(8),
        currentCapital: this.currentCapital.toFixed(8),
      } as any,
    });
    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
      reason,
    });
  }
}
