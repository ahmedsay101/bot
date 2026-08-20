/**
 * Max-2 open-position directional grid (no SL):
 * - Up to maxOpenPositions simultaneous opens (default 2)
 * - Levels one-shot: PENDING → ACTIVE → TP_HIT | CANCELLED
 * - TP = entry ± absolute grid distance; no stop-loss orders
 * - Dynamic currentCapital (L1 = 50% of current with maxOpen=2)
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
  buildGridPlan,
  calcGridDistanceAbs,
  calcLevelTpPrice,
  sizeLevelPosition,
  traderProfitPercent,
  isLevelTerminal,
  DEFAULT_MAX_OPEN_POSITIONS,
  type GridLevelPlan,
} from './gridCalc';
import {
  calcPositionUnrealizedPnl,
  marketSideForPosition,
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
import { RiskManager } from '../../risk/RiskManager';
import { createContextLogger } from '../../logger';
import { withRetry } from '../../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('GridDirectionalTrader');

type ExitReason =
  | 'TRADER_TP'
  | 'MAX_LIFETIME'
  | 'GRID_EXHAUSTED'
  | 'FORCE'
  | 'ERROR';

interface ActivePosition {
  key: string;
  direction: TradeSide;
  level: number;
  entryPrice: string;
  quantity: string;
  allocatedMargin: string;
  actualNotional: string;
  entryFee: Decimal;
  tpPrice: string;
  entryClientOrderId: string;
  tpClientOrderId: string | null;
  closing: boolean;
}

interface LevelState {
  plan: GridLevelPlan;
  status: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  entryPrice: string | null;
  filledQuantity: string | null;
  fees: string | null;
  tpPrice: string | null;
  slPrice: string | null;
  completionReason: string | null;
  dbId?: string;
}

interface CapitalHistoryEntry {
  at: string;
  capital: string;
  event: string;
  netPnl?: string;
}

function levelKey(direction: TradeSide, level: number): string {
  return `${direction}:${level}`;
}

function normalizeExitReason(raw: unknown): ExitReason | null {
  if (raw == null) return null;
  const s = String(raw);
  if (s === 'FULL_LONG_GRID' || s === 'FULL_SHORT_GRID') return 'GRID_EXHAUSTED';
  if (
    s === 'TRADER_TP'
    || s === 'MAX_LIFETIME'
    || s === 'GRID_EXHAUSTED'
    || s === 'FORCE'
    || s === 'ERROR'
  ) {
    return s;
  }
  return null;
}

export class GridDirectionalTrader extends EventEmitter implements IManagedTrader {
  readonly id: string;
  readonly symbol: string;
  readonly mode: TraderMode;

  private status: TraderStatus = 'INITIALIZING';
  private startedAt: Date | null = null;
  private endsAt: Date | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private markPrice = '0';
  private symbolInfo: SymbolInfo | null = null;
  private initialCapital = new Decimal(0);
  private currentCapital = new Decimal(0);
  private startPrice: string | null = null;
  private gridDistanceAbs = new Decimal(0);
  private levelsPerSide = 10;
  private distancePercent = '5';
  private takeProfitPercent = '10';
  private maxOpenPositions = DEFAULT_MAX_OPEN_POSITIONS;
  private levels = new Map<string, LevelState>();
  private activePositions = new Map<string, ActivePosition>();
  private activating = false;
  private handledFillIds = new Set<string>();
  private exiting = false;
  private isDestroyed = false;
  private isPaused = false;
  private exitReason: ExitReason | null = null;
  private realizedPnl = new Decimal(0);
  private grossRealizedPnl = new Decimal(0);
  private totalFees = new Decimal(0);
  private unrealizedPnl = new Decimal(0);
  private positionsOpened = 0;
  private positionsClosed = 0;
  private takeProfits = 0;
  private stopLosses = 0;
  private capitalHistory: CapitalHistoryEntry[] = [];
  private riskManager: RiskManager;

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
    this.riskManager = new RiskManager();
    this.levelsPerSide = Math.max(1, Math.floor(traderConfig.gridLevelsPerSide ?? 10));
    this.distancePercent = String(traderConfig.gridDistancePercent ?? '2');
    this.takeProfitPercent = String(traderConfig.traderTakeProfitPercent ?? '10');
    this.maxOpenPositions = Math.max(
      1,
      Math.floor((traderConfig as any).maxOpenPositionsPerTrader ?? DEFAULT_MAX_OPEN_POSITIONS),
    );
  }

  getStatus(): TraderStatus { return this.status; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }
  hasOpenPosition(): boolean { return this.activePositions.size > 0; }
  getOpenLegCount(): number { return this.activePositions.size; }
  getId(): string { return this.id; }
  getSymbol(): string { return this.symbol; }
  getRealizedPnl(): string { return this.realizedPnl.toFixed(8); }
  getUnrealizedPnl(): string { return this.unrealizedPnl.toFixed(8); }

  getOpenNotional(): string | null {
    if (this.activePositions.size === 0) return null;
    let sum = new Decimal(0);
    for (const a of this.activePositions.values()) {
      sum = sum.plus(a.actualNotional);
    }
    return sum.toFixed(8);
  }

  private getFirstActive(): ActivePosition | null {
    for (const a of this.activePositions.values()) return a;
    return null;
  }

  async initialize(): Promise<void> {
    log.info(`Initializing no-SL max-${this.maxOpenPositions} grid ${this.id} for ${this.symbol}`);
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

    const plan = buildGridPlan({
      startPrice: this.markPrice,
      traderAllocation: this.currentCapital,
      leverage: this.traderConfig.leverage,
      levelsPerSide: this.levelsPerSide,
      distancePercent: this.distancePercent,
      symbolInfo: this.symbolInfo,
      maxOpenPositions: this.maxOpenPositions,
    });
    this.startPrice = plan.startPrice;
    this.gridDistanceAbs = new Decimal(plan.gridDistanceAbs);

    for (const row of plan.levels) {
      this.levels.set(levelKey(row.direction, row.level), {
        plan: row,
        status: 'PENDING',
        clientOrderId: null,
        exchangeOrderId: null,
        entryPrice: null,
        filledQuantity: null,
        fees: null,
        tpPrice: row.tpPrice,
        slPrice: null,
        completionReason: null,
      });
    }

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        behavior: 'grid_directional',
        startPrice: this.startPrice,
        gridLevelsPerSide: this.levelsPerSide,
        gridDistancePercent: this.distancePercent,
        traderTakeProfitPercent: this.takeProfitPercent,
        traderAllocatedAmount: this.initialCapital.toFixed(8),
        currentCapital: this.currentCapital.toFixed(8),
        initialCapital: this.initialCapital.toFixed(8),
        startedAt: this.startedAt,
        endsAt: this.endsAt,
        status: 'INITIALIZING',
        timelineJson: JSON.stringify(this.capitalHistory),
        maxOpenPositionsPerTrader: this.maxOpenPositions,
      } as any,
    });

    for (const level of this.levels.values()) {
      const created = await this.db.gridLevel.create({
        data: {
          traderId: this.id,
          level: level.plan.level,
          direction: level.plan.direction,
          triggerPrice: level.plan.triggerPrice,
          limitPrice: level.plan.limitPrice,
          weight: level.plan.weight,
          allocatedMargin: level.plan.allocatedMargin,
          notional: level.plan.notional,
          quantity: level.plan.quantity,
          status: 'PENDING',
          tpPrice: level.plan.tpPrice,
          slPrice: null,
        } as any,
      });
      level.dbId = created.id;
    }

    await this.setStatus('ACTIVE');
    this.scheduleLifetimeEnd();
    this.emitSnapshot();
    await this.tryActivateNextLevel();
    log.info('[LIFECYCLE] GRID_ACTIVE', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      capital: this.currentCapital.toFixed(8),
      maxOpenPositions: this.maxOpenPositions,
      endsAt: this.endsAt?.toISOString(),
    });
  }

  async restore(state: Record<string, unknown>): Promise<void> {
    this.status = (state.status as TraderStatus) ?? 'ACTIVE';
    this.realizedPnl = new Decimal(String(state.realizedPnl ?? '0'));
    this.unrealizedPnl = new Decimal(String(state.unrealizedPnl ?? '0'));
    this.totalFees = new Decimal(String(state.totalFees ?? '0'));
    this.grossRealizedPnl = this.realizedPnl.plus(this.totalFees);
    this.startedAt = state.startedAt instanceof Date ? state.startedAt : state.startedAt != null ? new Date(String(state.startedAt)) : null;
    this.endsAt = state.endsAt instanceof Date ? state.endsAt : state.endsAt != null ? new Date(String(state.endsAt)) : null;
    this.startPrice = state.startPrice != null ? String(state.startPrice) : null;
    this.initialCapital = new Decimal(String(state.traderAllocatedAmount ?? state.initialCapital ?? '0'));
    this.currentCapital = new Decimal(String(state.currentCapital ?? state.traderAllocatedAmount ?? '0'));
    this.exitReason = normalizeExitReason(state.exitReason);
    this.levelsPerSide = Number(state.gridLevelsPerSide ?? state.levelsPerSide ?? this.levelsPerSide);
    this.distancePercent = String(state.gridDistancePercent ?? state.distancePercent ?? this.distancePercent);
    this.takeProfitPercent = String(state.traderTakeProfitPercent ?? state.takeProfitPercent ?? this.takeProfitPercent);
    this.maxOpenPositions = Math.max(
      1,
      Math.floor(
        Number(
          state.maxOpenPositionsPerTrader
            ?? state.maxOpenPositions
            ?? (this.traderConfig as any).maxOpenPositionsPerTrader
            ?? DEFAULT_MAX_OPEN_POSITIONS,
        ),
      ),
    );
    this.positionsOpened = Number(state.positionsOpened ?? 0);
    this.positionsClosed = Number(state.positionsClosed ?? 0);
    this.takeProfits = Number(state.takeProfits ?? 0);
    this.stopLosses = Number(state.stopLosses ?? 0);

    try {
      const hist = state.timelineJson != null ? JSON.parse(String(state.timelineJson)) : [];
      if (Array.isArray(hist)) this.capitalHistory = hist as CapitalHistoryEntry[];
    } catch { /* ignore */ }

    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    if (this.startPrice != null) {
      this.gridDistanceAbs = calcGridDistanceAbs(this.startPrice, this.distancePercent);
    }

    const rows = (state.gridLevels as Array<Record<string, unknown>>)
      ?? await this.db.gridLevel.findMany({ where: { traderId: this.id } });

    for (const row of rows) {
      const direction = String(row.direction) as TradeSide;
      const level = Number(row.level);
      const weight = Number(row.weight);
      const n = this.levelsPerSide;
      const allocationPct = new Decimal(weight).div(n).div(this.maxOpenPositions).toFixed(8);
      const plan: GridLevelPlan = {
        level,
        direction,
        weight,
        allocationPct,
        triggerPrice: String(row.triggerPrice),
        limitPrice: String(row.limitPrice),
        tpPrice: String(row.tpPrice ?? row.triggerPrice),
        theoreticalMargin: String(row.allocatedMargin),
        allocatedMargin: String(row.allocatedMargin),
        notional: String(row.notional),
        quantity: String(row.quantity),
      };
      const key = levelKey(direction, level);
      const status = String(row.status);
      this.levels.set(key, {
        plan,
        status,
        clientOrderId: row.clientOrderId != null ? String(row.clientOrderId) : null,
        exchangeOrderId: row.exchangeOrderId != null ? String(row.exchangeOrderId) : null,
        entryPrice: row.entryPrice != null ? String(row.entryPrice) : null,
        filledQuantity: row.filledQuantity != null ? String(row.filledQuantity) : null,
        fees: row.fees != null ? String(row.fees) : null,
        tpPrice: row.tpPrice != null ? String(row.tpPrice) : plan.tpPrice,
        slPrice: null,
        completionReason: row.completionReason != null ? String(row.completionReason) : null,
        dbId: row.id != null ? String(row.id) : undefined,
      });
    }

    // Rebuild activePositions from ACTIVE levels
    for (const level of this.levels.values()) {
      if (level.status !== 'ACTIVE') continue;
      if (level.entryPrice == null || level.filledQuantity == null || level.filledQuantity === '0') continue;
      const key = levelKey(level.plan.direction, level.plan.level);
      const actualNotional = calcActualNotional(level.entryPrice, level.filledQuantity);
      this.activePositions.set(key, {
        key,
        direction: level.plan.direction,
        level: level.plan.level,
        entryPrice: level.entryPrice,
        quantity: level.filledQuantity,
        allocatedMargin: level.plan.allocatedMargin,
        actualNotional: actualNotional.toFixed(8),
        entryFee: new Decimal(String(level.fees ?? '0')),
        tpPrice: level.tpPrice ?? level.plan.tpPrice,
        entryClientOrderId: level.clientOrderId ?? '',
        tpClientOrderId: null,
        closing: false,
      });
    }

    // Fallback: restore single active from trader currentSide fields if no ACTIVE levels rebuilt
    if (this.activePositions.size === 0) {
      const side = state.currentSide != null ? String(state.currentSide) as TradeSide : null;
      const entry = state.entryPrice != null ? String(state.entryPrice) : null;
      const qty = state.quantity != null ? String(state.quantity) : null;
      const tp = state.tpPrice != null ? String(state.tpPrice) : null;
      const posNum = Number(state.currentPositionNumber ?? 0);

      if (side != null && entry != null && qty != null && qty !== '0' && tp != null) {
        const level = posNum > 0 ? posNum : 1;
        const key = levelKey(side, level);
        const lvl = this.levels.get(key);
        const actualNotional = calcActualNotional(entry, qty);
        this.activePositions.set(key, {
          key,
          direction: side,
          level,
          entryPrice: entry,
          quantity: qty,
          allocatedMargin: lvl?.plan.allocatedMargin ?? actualNotional.div(this.traderConfig.leverage).toFixed(8),
          actualNotional: actualNotional.toFixed(8),
          entryFee: new Decimal(String(lvl?.fees ?? '0')),
          tpPrice: tp,
          entryClientOrderId: lvl?.clientOrderId ?? '',
          tpClientOrderId: null,
          closing: false,
        });
        if (lvl != null && !isLevelTerminal(lvl.status)) {
          lvl.status = 'ACTIVE';
          lvl.entryPrice = entry;
          lvl.filledQuantity = qty;
          lvl.tpPrice = tp;
          lvl.slPrice = null;
        }
      }
    }

    // Convert legacy multi-leg FILLED without active restore → TP_HIT (consumed)
    for (const level of this.levels.values()) {
      if (level.status === 'FILLED') {
        const key = levelKey(level.plan.direction, level.plan.level);
        if (!this.activePositions.has(key)) {
          level.status = 'TP_HIT';
          level.completionReason = 'LEGACY_FILLED';
        }
      }
    }

    if (this.status === 'ACTIVE') this.scheduleLifetimeEnd();
    if (this.status === 'COMPLETING') void this.resumeCompleting();
    log.info('Grid trader restored', {
      traderId: this.id,
      levels: this.levels.size,
      activeCount: this.activePositions.size,
      activeKeys: [...this.activePositions.keys()],
      capital: this.currentCapital.toFixed(8),
      maxOpenPositions: this.maxOpenPositions,
    });
  }

  async resumeCompleting(): Promise<void> {
    if (this.isDestroyed) return;
    await this.beginExit(this.exitReason ?? 'FORCE');
  }

  onPriceUpdate(price: string): void {
    if (this.isDestroyed || this.isPaused) return;
    this.markPrice = price;
    this.recomputeUnrealized();
    this.emitSnapshot();
    if (this.status !== 'ACTIVE' || this.exiting) return;
    if (this.endsAt != null && Date.now() >= this.endsAt.getTime()) {
      void this.beginExit('MAX_LIFETIME');
      return;
    }
    if (this.isTraderTpHit()) {
      void this.beginExit('TRADER_TP');
      return;
    }
    if (this.activePositions.size < this.maxOpenPositions) {
      void this.tryActivateNextLevel();
    }
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;

    // Match entry / TP across all active positions
    for (const active of this.activePositions.values()) {
      if (update.clientOrderId === active.entryClientOrderId) {
        if (update.status === 'FILLED') {
          await this.handleEntryFill(active.key, update);
        }
        return;
      }
      if (active.tpClientOrderId != null && update.clientOrderId === active.tpClientOrderId) {
        if (update.status === 'FILLED') {
          await this.handleTpFill(active.key, update);
        }
        return;
      }
    }

    // Ignore any SL fills (legacy / stray)
    if (update.clientOrderId != null && /[-_]sl/i.test(update.clientOrderId)) {
      return;
    }

    // Pending entry still on level map
    const level = [...this.levels.values()].find((l) => l.clientOrderId === update.clientOrderId);
    if (level == null) return;
    if (update.status === 'TRIGGERED') {
      this.emitSnapshot();
      return;
    }
    if (update.status === 'FILLED') {
      const key = levelKey(level.plan.direction, level.plan.level);
      await this.handleEntryFill(key, update);
    }
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    await this.setStatus('PAUSED');
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    if (this.status === 'PAUSED') await this.setStatus('ACTIVE');
  }

  async emergencyStop(): Promise<void> {
    await this.beginExit('FORCE');
  }

  destroy(): void {
    this.clearLifetimeTimer();
    this.isDestroyed = true;
    this.removeAllListeners();
  }

  toSummary(): TraderSummaryView {
    this.recomputeUnrealized();
    const now = Date.now();
    const remainingMs = this.endsAt != null ? Math.max(0, this.endsAt.getTime() - now) : 0;
    const runtimeMs = this.startedAt != null ? Math.max(0, now - this.startedAt.getTime()) : 0;
    const longDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'LONG' && l.status === 'TP_HIT',
    ).length;
    const shortDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'SHORT' && l.status === 'TP_HIT',
    ).length;
    const rates = feeRatesFromConfig(this.traderConfig);

    let openNet = new Decimal(0);
    for (const a of this.activePositions.values()) {
      const gross = calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      openNet = openNet.plus(gross.minus(a.entryFee).minus(estExit));
    }
    const totalNet = this.realizedPnl.plus(openNet);
    const profitPct = traderProfitPercent(totalNet, this.initialCapital).toFixed(4);

    const currentPositions: CurrentPositionView[] = [];
    for (const a of this.activePositions.values()) {
      const gross = calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      const netU = gross.minus(a.entryFee).minus(estExit);
      currentPositions.push({
        number: a.level,
        side: a.direction,
        capitalStep: a.level,
        entryPrice: a.entryPrice,
        quantity: a.quantity,
        tpPrice: a.tpPrice,
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
    const currentPosition = currentPositions[0] ?? null;
    const first = this.getFirstActive();

    const gridLevels = [...this.levels.values()]
      .sort((a, b) => {
        if (a.plan.direction !== b.plan.direction) return a.plan.direction === 'LONG' ? -1 : 1;
        return a.plan.direction === 'LONG' ? b.plan.level - a.plan.level : a.plan.level - b.plan.level;
      })
      .map((l) => {
        const key = levelKey(l.plan.direction, l.plan.level);
        const active = this.activePositions.get(key);
        let uPnl: string | null = null;
        if (active != null) {
          uPnl = calcPositionUnrealizedPnl(
            active.direction,
            active.entryPrice,
            this.markPrice,
            active.quantity,
          ).toFixed(8);
        }
        return {
          level: l.plan.level,
          direction: l.plan.direction,
          triggerPrice: l.plan.triggerPrice,
          limitPrice: l.plan.limitPrice,
          allocatedMargin: active != null ? active.allocatedMargin : l.plan.allocatedMargin,
          notional: active != null ? active.actualNotional : l.plan.notional,
          leverage: this.traderConfig.leverage,
          quantity: active != null ? active.quantity : l.plan.quantity,
          status: l.status,
          entryPrice: l.entryPrice,
          unrealizedPnl: uPnl,
          tpPrice: l.tpPrice ?? l.plan.tpPrice,
          slPrice: null,
          weight: l.plan.weight,
          allocationPct: l.plan.allocationPct,
          completionReason: l.completionReason,
        };
      });

    const summary = {
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
        currentStep: first?.level ?? 0,
        currentStepAllocation: first?.allocatedMargin ?? '0',
        currentStepAmount: this.currentCapital.toFixed(8),
        positionNotional: this.getOpenNotional() ?? '0',
        steps: [],
        highestStepReached: Math.max(longDone, shortDone),
        lowestStepReached: 1,
        stepIncreases: this.takeProfits,
        stepDecreases: this.stopLosses,
        stepResets: 0,
        step1Trades: 0,
        maxStepTrades: 0,
      },
      currentPosition,
      currentPositions,
      stats: {
        startedAt: this.startedAt?.toISOString() ?? null,
        endsAt: this.endsAt?.toISOString() ?? null,
        remainingMs,
        runtimeMs,
        currentPositionNumber: first?.level ?? 0,
        positionsOpened: this.positionsOpened,
        positionsClosed: this.positionsClosed,
        winningPositions: this.takeProfits,
        losingPositions: this.stopLosses,
        takeProfits: this.takeProfits,
        stopLosses: this.stopLosses,
        longPositions: longDone,
        shortPositions: shortDone,
        winRate: this.positionsClosed > 0
          ? ((this.takeProfits / this.positionsClosed) * 100).toFixed(2)
          : '0.00',
        grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        netRealizedPnl: this.realizedPnl.toFixed(8),
        currentStep: first?.level ?? 0,
        highestStepReached: Math.max(longDone, shortDone),
        lowestStepReached: 1,
        stepIncreases: this.takeProfits,
        stepDecreases: this.stopLosses,
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
      pendingOrders: [...this.levels.values()].filter((l) => l.status === 'PENDING').length,
      closedOrders: longDone + shortDone,
      orders: [],
      behavior: 'grid_directional',
      grid: {
        startPrice: this.startPrice ?? '0',
        levelsPerSide: this.levelsPerSide,
        distancePercent: this.distancePercent,
        takeProfitPercent: this.takeProfitPercent,
        longFilled: longDone,
        shortFilled: shortDone,
        levels: gridLevels as any,
        profitPercent: profitPct,
        exitReason: this.exitReason,
        currentCapital: this.currentCapital.toFixed(8),
        initialCapital: this.initialCapital.toFixed(8),
        gridDistanceAbs: this.gridDistanceAbs.toFixed(8),
        capitalHistory: this.capitalHistory,
        maxOpenPositions: this.maxOpenPositions,
        activeOpenCount: this.activePositions.size,
      } as any,
    };

    return summary as TraderSummaryView;
  }

  // ── Activation ───────────────────────────────────────────────────────────

  private async tryActivateNextLevel(): Promise<void> {
    if (this.activating || this.exiting || this.isDestroyed) return;
    if (this.status !== 'ACTIVE' || this.isPaused) return;
    if (this.symbolInfo == null || this.startPrice == null) return;
    if (this.activePositions.size >= this.maxOpenPositions) return;

    this.activating = true;
    try {
      while (
        this.activePositions.size < this.maxOpenPositions
        && !this.exiting
        && !this.isDestroyed
        && this.status === 'ACTIVE'
        && !this.isPaused
      ) {
        const mark = new Decimal(this.markPrice);
        const start = new Decimal(this.startPrice);
        let candidate: LevelState | null = null;

        if (mark.gt(start)) {
          const longs = [...this.levels.values()]
            .filter((l) => l.plan.direction === 'LONG' && l.status === 'PENDING')
            .filter((l) => mark.gte(l.plan.triggerPrice))
            .sort((a, b) => a.plan.level - b.plan.level);
          candidate = longs[0] ?? null;
        } else if (mark.lt(start)) {
          const shorts = [...this.levels.values()]
            .filter((l) => l.plan.direction === 'SHORT' && l.status === 'PENDING')
            .filter((l) => mark.lte(l.plan.triggerPrice))
            .sort((a, b) => a.plan.level - b.plan.level);
          candidate = shorts[0] ?? null;
        }

        if (candidate == null) break;
        await this.activateLevel(candidate);
      }
    } finally {
      this.activating = false;
    }
  }

  private async activateLevel(level: LevelState): Promise<void> {
    if (this.activePositions.size >= this.maxOpenPositions) return;
    if (this.symbolInfo == null || this.startPrice == null) return;
    if (level.status !== 'PENDING') return;

    const key = levelKey(level.plan.direction, level.plan.level);
    if (this.activePositions.has(key)) return;

    const sized = sizeLevelPosition({
      currentCapital: this.currentCapital,
      level: level.plan.level,
      levelsPerSide: this.levelsPerSide,
      leverage: this.traderConfig.leverage,
      entryPrice: level.plan.triggerPrice,
      symbolInfo: this.symbolInfo,
      maxOpenPositions: this.maxOpenPositions,
    });
    if (new Decimal(sized.quantity).lte(0)) {
      level.status = 'SKIPPED';
      await this.persistLevel(level);
      return;
    }

    level.plan = {
      ...level.plan,
      allocatedMargin: sized.allocatedMargin,
      notional: sized.notional,
      quantity: sized.quantity,
      weight: sized.weight,
      allocationPct: sized.allocationPct,
    };

    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const dir = level.plan.direction === 'LONG' ? 'L' : 'S';
    const clientOrderId = `g-${shortId}-${dir}${level.plan.level}-${uuidv4().slice(0, 8)}`;
    const side = marketSideForPosition(level.plan.direction);
    const alreadyThrough = level.plan.direction === 'LONG'
      ? new Decimal(this.markPrice).gte(level.plan.triggerPrice)
      : new Decimal(this.markPrice).lte(level.plan.triggerPrice);

    const req = {
      traderId: this.id,
      clientOrderId,
      symbol: this.symbol,
      side,
      type: (alreadyThrough ? 'MARKET' : 'STOP_MARKET') as 'MARKET' | 'STOP_MARKET',
      role: level.plan.direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      hedgeLevel: level.plan.level,
      quantity: sized.quantity,
      stopPrice: alreadyThrough ? undefined : level.plan.triggerPrice,
      positionSide: level.plan.direction as 'LONG' | 'SHORT',
    };

    const available = this.accountLedger.getBalance().toFixed();
    this.riskManager.validateOrder(req as any, this.symbolInfo, available);
    const result = await this.executionProvider.placeOrder(req as any);

    level.clientOrderId = result.clientOrderId;
    level.exchangeOrderId = result.exchangeOrderId;
    level.status = 'ACTIVE';
    level.slPrice = null;
    await this.db.order.upsert({
      where: { clientOrderId },
      update: { exchangeOrderId: result.exchangeOrderId, status: result.status },
      create: {
        traderId: this.id,
        exchangeOrderId: result.exchangeOrderId,
        clientOrderId,
        symbol: this.symbol,
        side: result.side,
        type: req.type,
        status: result.status,
        role: req.role,
        hedgeLevel: level.plan.level,
        quantity: result.quantity,
        price: result.price,
        stopPrice: result.stopPrice,
        filledQuantity: result.filledQuantity,
        avgFillPrice: result.avgFillPrice,
        fee: result.fee,
        feeCurrency: result.feeCurrency,
      },
    });
    await this.persistLevel(level);

    const active: ActivePosition = {
      key,
      direction: level.plan.direction,
      level: level.plan.level,
      entryPrice: result.avgFillPrice ?? level.plan.triggerPrice,
      quantity: sized.quantity,
      allocatedMargin: sized.allocatedMargin,
      actualNotional: sized.notional,
      entryFee: new Decimal(0),
      tpPrice: level.plan.tpPrice,
      entryClientOrderId: clientOrderId,
      tpClientOrderId: null,
      closing: false,
    };
    this.activePositions.set(key, active);

    const first = this.getFirstActive();
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        currentSide: first?.direction ?? level.plan.direction,
        currentPositionNumber: first?.level ?? level.plan.level,
        entryPrice: first?.entryPrice ?? active.entryPrice,
        quantity: first?.quantity ?? sized.quantity,
        tpPrice: first?.tpPrice ?? level.plan.tpPrice,
        slPrice: null,
      } as any,
    });

    log.info('[LIFECYCLE] GRID_LEVEL_ACTIVATED', {
      traderId: this.id,
      key: active.key,
      margin: sized.allocatedMargin,
      notional: sized.notional,
      capital: this.currentCapital.toFixed(8),
      activeOpenCount: this.activePositions.size,
      maxOpenPositions: this.maxOpenPositions,
    });

    if (result.status === 'FILLED' && result.avgFillPrice != null) {
      await this.handleEntryFill(key, {
        clientOrderId,
        exchangeOrderId: result.exchangeOrderId,
        symbol: this.symbol,
        status: 'FILLED',
        filledQuantity: result.filledQuantity || sized.quantity,
        avgFillPrice: result.avgFillPrice,
        fee: result.fee,
        feeCurrency: result.feeCurrency,
        timestamp: Date.now(),
      });
    }

    this.emitSnapshot();
  }

  private async handleEntryFill(key: string, update: OrderUpdate): Promise<void> {
    const active = this.activePositions.get(key);
    if (active == null || update.avgFillPrice == null) return;
    const fillKey = `${update.clientOrderId}:ENTRY`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    const level = this.levels.get(key);
    if (level == null || this.symbolInfo == null || this.startPrice == null) return;

    const qty = update.filledQuantity || active.quantity;
    const entryFee = resolveExecutionFee({
      price: update.avgFillPrice,
      quantity: qty,
      actualFee: update.fee,
      rates: feeRatesFromConfig(this.traderConfig),
      liquidity: 'TAKER',
    });
    this.totalFees = this.totalFees.plus(entryFee);
    this.realizedPnl = this.realizedPnl.minus(entryFee);
    await this.accountLedger.recordFee(entryFee);

    const tpPrice = calcLevelTpPrice(
      update.avgFillPrice,
      active.direction,
      this.gridDistanceAbs,
      this.symbolInfo,
    );
    const actualNotional = calcActualNotional(update.avgFillPrice, qty);

    active.entryPrice = update.avgFillPrice;
    active.quantity = qty;
    active.entryFee = entryFee;
    active.tpPrice = tpPrice;
    active.actualNotional = actualNotional.toFixed(8);

    level.entryPrice = update.avgFillPrice;
    level.filledQuantity = qty;
    level.fees = entryFee.toFixed(8);
    level.tpPrice = tpPrice;
    level.slPrice = null;
    level.status = 'ACTIVE';
    await this.persistLevel(level);

    reconcilePositionNotional({
      traderId: this.id,
      symbol: this.symbol,
      positionId: active.key,
      allocatedMargin: active.allocatedMargin,
      leverage: this.traderConfig.leverage,
      actualNotional,
      quantity: qty,
      entryPrice: update.avgFillPrice,
    });

    this.positionsOpened += 1;
    await this.placeExitOrders(active);

    const first = this.getFirstActive();
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        entryPrice: first?.entryPrice ?? update.avgFillPrice,
        quantity: first?.quantity ?? qty,
        tpPrice: first?.tpPrice ?? tpPrice,
        slPrice: null,
        positionsOpened: this.positionsOpened,
        totalFees: this.totalFees.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
      } as any,
    });

    await this.db.position.create({
      data: {
        traderId: this.id,
        symbol: this.symbol,
        side: active.direction,
        role: active.direction === 'SHORT' ? 'SHORT' : 'LONG',
        hedgeLevel: active.level,
        entryPrice: update.avgFillPrice,
        quantity: qty,
        leverage: this.traderConfig.leverage,
        isOpen: true,
        markPrice: this.markPrice,
      },
    });

    // Do NOT exit on Nth activation — only after Nth TP_HIT (handled in handleTpFill)
    this.emitSnapshot();
  }

  private async placeExitOrders(active: ActivePosition): Promise<void> {
    if (this.symbolInfo == null) return;
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const a = active;

    const tpId = `g-${shortId}-tp${a.level}-${uuidv4().slice(0, 8)}`;
    const closeSide = a.direction === 'LONG' ? 'SELL' as const : 'BUY' as const;
    const role = a.direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const;

    const tpReq = {
      traderId: this.id,
      clientOrderId: tpId,
      symbol: this.symbol,
      side: closeSide,
      type: 'TAKE_PROFIT' as const,
      role,
      hedgeLevel: a.level,
      quantity: a.quantity,
      price: a.tpPrice,
      stopPrice: a.tpPrice,
      positionSide: a.direction as 'LONG' | 'SHORT',
      reduceOnly: true,
    };

    const available = this.accountLedger.getBalance().toFixed();
    this.riskManager.validateOrder(tpReq, this.symbolInfo, available);

    const tpRes = await this.executionProvider.placeOrder(tpReq);
    a.tpClientOrderId = tpRes.clientOrderId;

    await this.db.order.upsert({
      where: { clientOrderId: tpRes.clientOrderId },
      update: { status: tpRes.status },
      create: {
        traderId: this.id,
        exchangeOrderId: tpRes.exchangeOrderId,
        clientOrderId: tpRes.clientOrderId,
        symbol: this.symbol,
        side: tpRes.side,
        type: 'TAKE_PROFIT',
        status: tpRes.status,
        role,
        hedgeLevel: a.level,
        quantity: tpRes.quantity,
        price: a.tpPrice,
        stopPrice: a.tpPrice,
        filledQuantity: '0',
        avgFillPrice: null,
        fee: '0',
        feeCurrency: 'USDT',
      },
    });

    log.info('[LIFECYCLE] GRID_EXITS_PLACED', {
      traderId: this.id,
      key: a.key,
      tp: a.tpPrice,
    });
  }

  private async handleTpFill(key: string, update: OrderUpdate): Promise<void> {
    const active = this.activePositions.get(key);
    if (active == null || active.closing) return;
    if (update.avgFillPrice == null) return;
    const fillKey = `${update.clientOrderId}:EXIT`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    active.closing = true;
    const a = active;
    const level = this.levels.get(a.key);
    if (level == null) return;

    const exitFee = resolveExecutionFee({
      price: update.avgFillPrice,
      quantity: a.quantity,
      actualFee: update.fee,
      rates: feeRatesFromConfig(this.traderConfig),
      liquidity: 'TAKER',
    });
    const gross = calcGrossPnl(a.direction, a.entryPrice, update.avgFillPrice, a.quantity);
    const net = gross.minus(a.entryFee).minus(exitFee);

    this.grossRealizedPnl = this.grossRealizedPnl.plus(gross);
    this.totalFees = this.totalFees.plus(exitFee);
    this.realizedPnl = this.realizedPnl.plus(gross.minus(exitFee)); // entry fee already deducted
    this.currentCapital = this.currentCapital.plus(net);
    if (this.currentCapital.isNeg()) this.currentCapital = new Decimal(0);

    await this.accountLedger.recordRealized(gross, exitFee);

    level.status = 'TP_HIT';
    level.completionReason = 'TP';
    level.slPrice = null;
    await this.persistLevel(level);

    this.takeProfits += 1;
    this.positionsClosed += 1;

    this.capitalHistory.push({
      at: new Date().toISOString(),
      capital: this.currentCapital.toFixed(8),
      event: `${a.key}_TP`,
      netPnl: net.toFixed(8),
    });

    await this.db.position.updateMany({
      where: { traderId: this.id, hedgeLevel: a.level, isOpen: true },
      data: { isOpen: false, closedAt: new Date(), realizedPnl: net.toFixed(8) },
    });

    this.activePositions.delete(a.key);
    this.recomputeUnrealized();

    const first = this.getFirstActive();
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        currentSide: first?.direction ?? null,
        currentPositionNumber: first?.level ?? null,
        entryPrice: first?.entryPrice ?? null,
        quantity: first?.quantity ?? null,
        tpPrice: first?.tpPrice ?? null,
        slPrice: null,
        currentCapital: this.currentCapital.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        takeProfits: this.takeProfits,
        stopLosses: this.stopLosses,
        positionsClosed: this.positionsClosed,
        timelineJson: JSON.stringify(this.capitalHistory),
      } as any,
    });

    log.info('[LIFECYCLE] GRID_LEVEL_CLOSED', {
      traderId: this.id,
      key: a.key,
      kind: 'TP',
      net: net.toFixed(8),
      capital: this.currentCapital.toFixed(8),
      activeOpenCount: this.activePositions.size,
    });

    this.emitSnapshot();

    if (this.exiting) return;

    const longDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'LONG' && l.status === 'TP_HIT',
    ).length;
    const shortDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'SHORT' && l.status === 'TP_HIT',
    ).length;
    if (longDone >= this.levelsPerSide || shortDone >= this.levelsPerSide) {
      await this.beginExit('GRID_EXHAUSTED');
      return;
    }
    if (this.isTraderTpHit()) {
      await this.beginExit('TRADER_TP');
      return;
    }

    await this.tryActivateNextLevel();
  }

  private isTraderTpHit(): boolean {
    const rates = feeRatesFromConfig(this.traderConfig);
    let openNet = new Decimal(0);
    for (const a of this.activePositions.values()) {
      const gross = calcPositionUnrealizedPnl(
        a.direction,
        a.entryPrice,
        this.markPrice,
        a.quantity,
      );
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      openNet = openNet.plus(gross.minus(a.entryFee).minus(estExit));
    }
    const pct = traderProfitPercent(this.realizedPnl.plus(openNet), this.initialCapital);
    return pct.gte(this.takeProfitPercent);
  }

  private recomputeUnrealized(): void {
    if (this.activePositions.size === 0) {
      this.unrealizedPnl = new Decimal(0);
      return;
    }
    let sum = new Decimal(0);
    for (const a of this.activePositions.values()) {
      sum = sum.plus(
        calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity),
      );
    }
    this.unrealizedPnl = sum;
  }

  private async beginExit(reason: ExitReason): Promise<void> {
    if (this.exiting || this.isDestroyed) return;
    this.exiting = true;
    this.exitReason = reason;
    this.clearLifetimeTimer();
    await this.setStatus('COMPLETING');
    log.info('[LIFECYCLE] GRID_EXITING', { traderId: this.id, reason });

    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
    } catch (err) {
      log.warn('cancelAllOrders during grid exit', { error: String(err) });
    }

    for (const level of this.levels.values()) {
      if (level.status === 'PENDING' || level.status === 'ACTIVE') {
        const key = levelKey(level.plan.direction, level.plan.level);
        // Keep currently-open actives for forced close path below
        if (this.activePositions.has(key)) continue;
        level.status = 'CANCELLED';
        level.completionReason = 'TRADER_EXIT';
        await this.persistLevel(level);
      }
    }

    for (const a of [...this.activePositions.values()]) {
      try {
        const result = await this.executionProvider.closePosition(
          this.symbol,
          a.direction,
          a.quantity,
        );
        const fill = result.avgFillPrice ?? this.markPrice;
        const exitFee = resolveExecutionFee({
          price: fill,
          quantity: a.quantity,
          actualFee: result.fee,
          rates: feeRatesFromConfig(this.traderConfig),
          liquidity: 'TAKER',
        });
        const gross = calcGrossPnl(a.direction, a.entryPrice, fill, a.quantity);
        const net = gross.minus(a.entryFee).minus(exitFee);
        this.grossRealizedPnl = this.grossRealizedPnl.plus(gross);
        this.totalFees = this.totalFees.plus(exitFee);
        this.realizedPnl = this.realizedPnl.plus(gross.minus(exitFee));
        this.currentCapital = Decimal.max(0, this.currentCapital.plus(net));
        await this.accountLedger.recordRealized(gross, exitFee);

        const level = this.levels.get(a.key);
        if (level != null && !isLevelTerminal(level.status)) {
          level.status = 'CANCELLED';
          level.completionReason = reason;
          await this.persistLevel(level);
        }
      } catch (err) {
        log.error('Failed closing active grid position', {
          key: a.key,
          error: String(err),
        });
      }
      this.activePositions.delete(a.key);
    }

    await this.db.position.updateMany({
      where: { traderId: this.id, isOpen: true },
      data: { isOpen: false, closedAt: new Date() },
    });

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        exitReason: reason,
        completionReason: reason,
        realizedPnl: this.realizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        currentCapital: this.currentCapital.toFixed(8),
        currentSide: null,
        slPrice: null,
        timelineJson: JSON.stringify(this.capitalHistory),
      } as any,
    });

    await this.setStatus('COMPLETED');
    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
      reason,
    });
    this.destroy();
  }

  private async persistLevel(level: LevelState): Promise<void> {
    if (level.dbId == null) return;
    const terminal = isLevelTerminal(level.status);
    await this.db.gridLevel.update({
      where: { id: level.dbId },
      data: {
        status: level.status,
        clientOrderId: level.clientOrderId,
        exchangeOrderId: level.exchangeOrderId,
        entryPrice: level.entryPrice,
        filledQuantity: level.filledQuantity,
        fees: level.fees,
        allocatedMargin: level.plan.allocatedMargin,
        notional: level.plan.notional,
        quantity: level.plan.quantity,
        tpPrice: level.tpPrice,
        slPrice: null,
        completionReason: level.completionReason,
        completedAt: terminal ? new Date() : undefined,
        filledAt: level.entryPrice != null ? new Date() : undefined,
      } as any,
    });
  }

  private async setStatus(status: TraderStatus): Promise<void> {
    this.status = status;
    await this.db.trader.update({ where: { id: this.id }, data: { status } });
    this.emit('traderEvent', { type: 'STATUS_CHANGED', traderId: this.id, status });
  }

  private scheduleLifetimeEnd(): void {
    this.clearLifetimeTimer();
    if (this.endsAt == null) return;
    const ms = Math.max(0, this.endsAt.getTime() - Date.now());
    this.lifetimeTimer = setTimeout(() => {
      void this.beginExit('MAX_LIFETIME');
    }, ms);
  }

  private clearLifetimeTimer(): void {
    if (this.lifetimeTimer != null) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
  }

  private emitSnapshot(): void {
    this.emit('traderEvent', { type: 'TRADER_SNAPSHOT', trader: this.toSummary() });
  }
}
