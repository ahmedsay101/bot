/**
 * Single-position directional grid:
 * - One open position max
 * - Levels one-shot (TP_HIT / SL_HIT terminal)
 * - TP = entry ± absolute grid distance; SL = startPrice
 * - Dynamic currentCapital (formula B: L1 = 100% … LN = 1/N)
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
  calcLevelSlPrice,
  sizeLevelPosition,
  traderProfitPercent,
  isLevelTerminal,
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
  | 'FULL_LONG_GRID'
  | 'FULL_SHORT_GRID'
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
  slPrice: string;
  entryClientOrderId: string;
  tpClientOrderId: string | null;
  slClientOrderId: string | null;
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
  private levels = new Map<string, LevelState>();
  private active: ActivePosition | null = null;
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
  }

  getStatus(): TraderStatus { return this.status; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }
  hasOpenPosition(): boolean { return this.active != null; }
  getOpenLegCount(): number { return this.active != null ? 1 : 0; }
  getId(): string { return this.id; }
  getSymbol(): string { return this.symbol; }
  getRealizedPnl(): string { return this.realizedPnl.toFixed(8); }
  getUnrealizedPnl(): string { return this.unrealizedPnl.toFixed(8); }

  getOpenNotional(): string | null {
    if (this.active == null) return null;
    return this.active.actualNotional;
  }

  async initialize(): Promise<void> {
    log.info(`Initializing single-position grid ${this.id} for ${this.symbol}`);
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
        slPrice: row.slPrice,
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
          slPrice: level.plan.slPrice,
        } as any,
      });
      level.dbId = created.id;
    }

    await this.setStatus('ACTIVE');
    this.scheduleLifetimeEnd();
    this.emitSnapshot();
    // Try immediate activation if mark already through a level (unlikely at start)
    await this.tryActivateNextLevel();
    log.info('[LIFECYCLE] GRID_ACTIVE', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      capital: this.currentCapital.toFixed(8),
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
    this.exitReason = (state.exitReason as ExitReason) ?? null;
    this.levelsPerSide = Number(state.gridLevelsPerSide ?? state.levelsPerSide ?? this.levelsPerSide);
    this.distancePercent = String(state.gridDistancePercent ?? state.distancePercent ?? this.distancePercent);
    this.takeProfitPercent = String(state.traderTakeProfitPercent ?? state.takeProfitPercent ?? this.takeProfitPercent);
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
      const plan: GridLevelPlan = {
        level,
        direction,
        weight: Number(row.weight),
        triggerPrice: String(row.triggerPrice),
        limitPrice: String(row.limitPrice),
        tpPrice: String(row.tpPrice ?? row.triggerPrice),
        slPrice: String(row.slPrice ?? this.startPrice ?? '0'),
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
        slPrice: row.slPrice != null ? String(row.slPrice) : plan.slPrice,
        completionReason: row.completionReason != null ? String(row.completionReason) : null,
        dbId: row.id != null ? String(row.id) : undefined,
      });

      // Migrate legacy FILLED (multi-leg) → treat as terminal if no open book; ACTIVE if open
      if (status === 'ACTIVE' || status === 'FILLED') {
        // Will reconcile open position from trader row / open positions below
      }
    }

    // Restore active from trader currentSide fields if present
    const side = state.currentSide != null ? String(state.currentSide) as TradeSide : null;
    const entry = state.entryPrice != null ? String(state.entryPrice) : null;
    const qty = state.quantity != null ? String(state.quantity) : null;
    const tp = state.tpPrice != null ? String(state.tpPrice) : null;
    const sl = state.slPrice != null ? String(state.slPrice) : null;
    const posNum = Number(state.currentPositionNumber ?? 0);

    if (side != null && entry != null && qty != null && qty !== '0' && tp != null && sl != null) {
      const level = posNum > 0 ? posNum : 1;
      const key = levelKey(side, level);
      const lvl = this.levels.get(key);
      const actualNotional = calcActualNotional(entry, qty);
      this.active = {
        key,
        direction: side,
        level,
        entryPrice: entry,
        quantity: qty,
        allocatedMargin: lvl?.plan.allocatedMargin ?? actualNotional.div(this.traderConfig.leverage).toFixed(8),
        actualNotional: actualNotional.toFixed(8),
        entryFee: new Decimal(String(lvl?.fees ?? '0')),
        tpPrice: tp,
        slPrice: sl,
        entryClientOrderId: lvl?.clientOrderId ?? '',
        tpClientOrderId: null,
        slClientOrderId: null,
        closing: false,
      };
      if (lvl != null && !isLevelTerminal(lvl.status)) {
        lvl.status = 'ACTIVE';
        lvl.entryPrice = entry;
        lvl.filledQuantity = qty;
      }
    }

    // Convert legacy multi-leg FILLED without active restore → TP_HIT (consumed)
    for (const level of this.levels.values()) {
      if (level.status === 'FILLED') {
        const isActive = this.active?.key === levelKey(level.plan.direction, level.plan.level);
        if (!isActive) {
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
      active: this.active?.key ?? null,
      capital: this.currentCapital.toFixed(8),
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
    if (this.active == null) {
      void this.tryActivateNextLevel();
    }
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;

    // Entry fill
    if (this.active != null && update.clientOrderId === this.active.entryClientOrderId) {
      if (update.status === 'FILLED') {
        await this.handleEntryFill(update);
      }
      return;
    }

    // TP / SL fills
    if (this.active != null) {
      if (update.clientOrderId === this.active.tpClientOrderId && update.status === 'FILLED') {
        await this.handleExitFill('TP', update);
        return;
      }
      if (update.clientOrderId === this.active.slClientOrderId && update.status === 'FILLED') {
        await this.handleExitFill('SL', update);
        return;
      }
    }

    // Pending entry still on level map
    const level = [...this.levels.values()].find((l) => l.clientOrderId === update.clientOrderId);
    if (level == null) return;
    if (update.status === 'TRIGGERED') {
      this.emitSnapshot();
      return;
    }
    if (update.status === 'FILLED') {
      await this.handleEntryFill(update);
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
      (l) => l.plan.direction === 'LONG' && (l.status === 'TP_HIT' || l.status === 'SL_HIT'),
    ).length;
    const shortDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'SHORT' && (l.status === 'TP_HIT' || l.status === 'SL_HIT'),
    ).length;
    const rates = feeRatesFromConfig(this.traderConfig);
    let openNet = new Decimal(0);
    if (this.active != null) {
      const gross = calcPositionUnrealizedPnl(
        this.active.direction,
        this.active.entryPrice,
        this.markPrice,
        this.active.quantity,
      );
      const estExit = estimateOpenExitFee(this.markPrice, this.active.quantity, rates);
      openNet = gross.minus(this.active.entryFee).minus(estExit);
    }
    const totalNet = this.realizedPnl.plus(openNet);
    const profitPct = traderProfitPercent(totalNet, this.initialCapital).toFixed(4);

    let currentPosition: CurrentPositionView | null = null;
    if (this.active != null) {
      const gross = calcPositionUnrealizedPnl(
        this.active.direction,
        this.active.entryPrice,
        this.markPrice,
        this.active.quantity,
      );
      const estExit = estimateOpenExitFee(this.markPrice, this.active.quantity, rates);
      const netU = gross.minus(this.active.entryFee).minus(estExit);
      currentPosition = {
        number: this.active.level,
        side: this.active.direction,
        capitalStep: this.active.level,
        entryPrice: this.active.entryPrice,
        quantity: this.active.quantity,
        tpPrice: this.active.tpPrice,
        slPrice: this.active.slPrice,
        stepAmount: this.active.allocatedMargin,
        positionNotional: this.active.actualNotional,
        unrealizedPnl: gross.toFixed(8),
        estimatedExitFee: estExit.toFixed(8),
        netUnrealizedPnl: netU.toFixed(8),
        entryFee: this.active.entryFee.toFixed(8),
        roiPercent: this.active.allocatedMargin !== '0'
          ? netU.div(this.active.allocatedMargin).mul(100).toFixed(4)
          : '0',
        status: 'OPEN',
      };
    }

    const gridLevels = [...this.levels.values()]
      .sort((a, b) => {
        if (a.plan.direction !== b.plan.direction) return a.plan.direction === 'LONG' ? -1 : 1;
        return a.plan.direction === 'LONG' ? b.plan.level - a.plan.level : a.plan.level - b.plan.level;
      })
      .map((l) => {
        const isActive = this.active?.key === levelKey(l.plan.direction, l.plan.level);
        let uPnl: string | null = null;
        if (isActive && this.active != null) {
          uPnl = calcPositionUnrealizedPnl(
            this.active.direction,
            this.active.entryPrice,
            this.markPrice,
            this.active.quantity,
          ).toFixed(8);
        }
        return {
          level: l.plan.level,
          direction: l.plan.direction,
          triggerPrice: l.plan.triggerPrice,
          limitPrice: l.plan.limitPrice,
          allocatedMargin: isActive && this.active != null
            ? this.active.allocatedMargin
            : l.plan.allocatedMargin,
          notional: isActive && this.active != null ? this.active.actualNotional : l.plan.notional,
          leverage: this.traderConfig.leverage,
          quantity: isActive && this.active != null ? this.active.quantity : l.plan.quantity,
          status: l.status,
          entryPrice: l.entryPrice,
          unrealizedPnl: uPnl,
          tpPrice: l.tpPrice ?? l.plan.tpPrice,
          slPrice: l.slPrice ?? l.plan.slPrice,
          weight: l.plan.weight,
          completionReason: l.completionReason,
        };
      });

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
        currentStep: this.active?.level ?? 0,
        currentStepAllocation: this.active?.allocatedMargin ?? '0',
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
      stats: {
        startedAt: this.startedAt?.toISOString() ?? null,
        endsAt: this.endsAt?.toISOString() ?? null,
        remainingMs,
        runtimeMs,
        currentPositionNumber: this.active?.level ?? 0,
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
        currentStep: this.active?.level ?? 0,
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
      openOrders: this.active != null ? 2 : 0,
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
      } as any,
    };
  }

  // ── Activation ───────────────────────────────────────────────────────────

  private async tryActivateNextLevel(): Promise<void> {
    if (this.activating || this.active != null || this.exiting || this.isDestroyed) return;
    if (this.status !== 'ACTIVE' || this.isPaused) return;
    if (this.symbolInfo == null || this.startPrice == null) return;

    this.activating = true;
    try {
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

      if (candidate == null) return;
      await this.activateLevel(candidate);
    } finally {
      this.activating = false;
    }
  }

  private async activateLevel(level: LevelState): Promise<void> {
    if (this.active != null || this.symbolInfo == null || this.startPrice == null) return;
    if (level.status !== 'PENDING') return;

    const sized = sizeLevelPosition({
      currentCapital: this.currentCapital,
      level: level.plan.level,
      levelsPerSide: this.levelsPerSide,
      leverage: this.traderConfig.leverage,
      entryPrice: level.plan.triggerPrice,
      symbolInfo: this.symbolInfo,
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

    this.active = {
      key: levelKey(level.plan.direction, level.plan.level),
      direction: level.plan.direction,
      level: level.plan.level,
      entryPrice: result.avgFillPrice ?? level.plan.triggerPrice,
      quantity: sized.quantity,
      allocatedMargin: sized.allocatedMargin,
      actualNotional: sized.notional,
      entryFee: new Decimal(0),
      tpPrice: level.plan.tpPrice,
      slPrice: level.plan.slPrice,
      entryClientOrderId: clientOrderId,
      tpClientOrderId: null,
      slClientOrderId: null,
      closing: false,
    };

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        currentSide: level.plan.direction,
        currentPositionNumber: level.plan.level,
        entryPrice: this.active.entryPrice,
        quantity: sized.quantity,
        tpPrice: level.plan.tpPrice,
        slPrice: level.plan.slPrice,
      },
    });

    log.info('[LIFECYCLE] GRID_LEVEL_ACTIVATED', {
      traderId: this.id,
      key: this.active.key,
      margin: sized.allocatedMargin,
      notional: sized.notional,
      capital: this.currentCapital.toFixed(8),
    });

    if (result.status === 'FILLED' && result.avgFillPrice != null) {
      await this.handleEntryFill({
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

  private async handleEntryFill(update: OrderUpdate): Promise<void> {
    if (this.active == null || update.avgFillPrice == null) return;
    const fillKey = `${update.clientOrderId}:ENTRY`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    const level = this.levels.get(this.active.key);
    if (level == null || this.symbolInfo == null || this.startPrice == null) return;

    const qty = update.filledQuantity || this.active.quantity;
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
      this.active.direction,
      this.gridDistanceAbs,
      this.symbolInfo,
    );
    const slPrice = calcLevelSlPrice(this.startPrice, this.symbolInfo);
    const actualNotional = calcActualNotional(update.avgFillPrice, qty);

    this.active.entryPrice = update.avgFillPrice;
    this.active.quantity = qty;
    this.active.entryFee = entryFee;
    this.active.tpPrice = tpPrice;
    this.active.slPrice = slPrice;
    this.active.actualNotional = actualNotional.toFixed(8);

    level.entryPrice = update.avgFillPrice;
    level.filledQuantity = qty;
    level.fees = entryFee.toFixed(8);
    level.tpPrice = tpPrice;
    level.slPrice = slPrice;
    level.status = 'ACTIVE';
    await this.persistLevel(level);

    reconcilePositionNotional({
      traderId: this.id,
      symbol: this.symbol,
      positionId: this.active.key,
      allocatedMargin: this.active.allocatedMargin,
      leverage: this.traderConfig.leverage,
      actualNotional,
      quantity: qty,
      entryPrice: update.avgFillPrice,
    });

    this.positionsOpened += 1;
    await this.placeExitOrders();

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        entryPrice: update.avgFillPrice,
        quantity: qty,
        tpPrice,
        slPrice,
        positionsOpened: this.positionsOpened,
        totalFees: this.totalFees.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
      },
    });

    await this.db.position.create({
      data: {
        traderId: this.id,
        symbol: this.symbol,
        side: this.active.direction,
        role: this.active.direction === 'SHORT' ? 'SHORT' : 'LONG',
        hedgeLevel: this.active.level,
        entryPrice: update.avgFillPrice,
        quantity: qty,
        leverage: this.traderConfig.leverage,
        isOpen: true,
        markPrice: this.markPrice,
      },
    });

    // Full-side on 10th fill
    const dir = this.active.direction;
    const completedOrActive = [...this.levels.values()].filter(
      (l) =>
        l.plan.direction === dir
        && (l.status === 'ACTIVE' || l.status === 'TP_HIT' || l.status === 'SL_HIT'),
    ).length;
    if (completedOrActive >= this.levelsPerSide) {
      // Defer exit until after exits placed — will close via beginExit
      void this.beginExit(dir === 'LONG' ? 'FULL_LONG_GRID' : 'FULL_SHORT_GRID');
    }

    this.emitSnapshot();
  }

  private async placeExitOrders(): Promise<void> {
    if (this.active == null || this.symbolInfo == null) return;
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const a = this.active;

    const tpId = `g-${shortId}-tp${a.level}-${uuidv4().slice(0, 8)}`;
    const slId = `g-${shortId}-sl${a.level}-${uuidv4().slice(0, 8)}`;
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
    const slReq = {
      traderId: this.id,
      clientOrderId: slId,
      symbol: this.symbol,
      side: closeSide,
      type: 'STOP_MARKET' as const,
      role,
      hedgeLevel: a.level,
      quantity: a.quantity,
      stopPrice: a.slPrice,
      positionSide: a.direction as 'LONG' | 'SHORT',
      reduceOnly: true,
    };

    const available = this.accountLedger.getBalance().toFixed();
    this.riskManager.validateOrder(tpReq, this.symbolInfo, available);
    this.riskManager.validateOrder(slReq, this.symbolInfo, available);

    const tpRes = await this.executionProvider.placeOrder(tpReq);
    const slRes = await this.executionProvider.placeOrder(slReq);
    a.tpClientOrderId = tpRes.clientOrderId;
    a.slClientOrderId = slRes.clientOrderId;

    for (const [res, type, stop, price] of [
      [tpRes, 'TAKE_PROFIT', a.tpPrice, a.tpPrice],
      [slRes, 'STOP_MARKET', a.slPrice, null],
    ] as const) {
      await this.db.order.upsert({
        where: { clientOrderId: res.clientOrderId },
        update: { status: res.status },
        create: {
          traderId: this.id,
          exchangeOrderId: res.exchangeOrderId,
          clientOrderId: res.clientOrderId,
          symbol: this.symbol,
          side: res.side,
          type,
          status: res.status,
          role,
          hedgeLevel: a.level,
          quantity: res.quantity,
          price: price,
          stopPrice: stop,
          filledQuantity: '0',
          avgFillPrice: null,
          fee: '0',
          feeCurrency: 'USDT',
        },
      });
    }

    log.info('[LIFECYCLE] GRID_EXITS_PLACED', {
      traderId: this.id,
      tp: a.tpPrice,
      sl: a.slPrice,
    });
  }

  private async handleExitFill(kind: 'TP' | 'SL', update: OrderUpdate): Promise<void> {
    if (this.active == null || this.active.closing) return;
    if (update.avgFillPrice == null) return;
    const fillKey = `${update.clientOrderId}:EXIT`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    this.active.closing = true;
    const a = this.active;
    const level = this.levels.get(a.key);
    if (level == null) return;

    // Cancel sibling exit
    const otherId = kind === 'TP' ? a.slClientOrderId : a.tpClientOrderId;
    if (otherId != null) {
      try {
        await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: otherId });
      } catch (err) {
        log.warn('cancel sibling exit failed', { error: String(err) });
      }
    }

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

    level.status = kind === 'TP' ? 'TP_HIT' : 'SL_HIT';
    level.completionReason = kind;
    await this.persistLevel(level);

    if (kind === 'TP') this.takeProfits += 1;
    else this.stopLosses += 1;
    this.positionsClosed += 1;

    this.capitalHistory.push({
      at: new Date().toISOString(),
      capital: this.currentCapital.toFixed(8),
      event: `${a.key}_${kind}`,
      netPnl: net.toFixed(8),
    });

    await this.db.position.updateMany({
      where: { traderId: this.id, hedgeLevel: a.level, isOpen: true },
      data: { isOpen: false, closedAt: new Date(), realizedPnl: net.toFixed(8) },
    });

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        currentSide: null,
        entryPrice: null,
        quantity: null,
        tpPrice: null,
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
      kind,
      net: net.toFixed(8),
      capital: this.currentCapital.toFixed(8),
    });

    this.active = null;
    this.unrealizedPnl = new Decimal(0);
    this.emitSnapshot();

    if (this.exiting) return;

    const longDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'LONG' && (l.status === 'TP_HIT' || l.status === 'SL_HIT'),
    ).length;
    const shortDone = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'SHORT' && (l.status === 'TP_HIT' || l.status === 'SL_HIT'),
    ).length;
    if (longDone >= this.levelsPerSide) {
      await this.beginExit('FULL_LONG_GRID');
      return;
    }
    if (shortDone >= this.levelsPerSide) {
      await this.beginExit('FULL_SHORT_GRID');
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
    if (this.active != null) {
      const gross = calcPositionUnrealizedPnl(
        this.active.direction,
        this.active.entryPrice,
        this.markPrice,
        this.active.quantity,
      );
      const estExit = estimateOpenExitFee(this.markPrice, this.active.quantity, rates);
      openNet = gross.minus(this.active.entryFee).minus(estExit);
    }
    const pct = traderProfitPercent(this.realizedPnl.plus(openNet), this.initialCapital);
    return pct.gte(this.takeProfitPercent);
  }

  private recomputeUnrealized(): void {
    if (this.active == null) {
      this.unrealizedPnl = new Decimal(0);
      return;
    }
    this.unrealizedPnl = calcPositionUnrealizedPnl(
      this.active.direction,
      this.active.entryPrice,
      this.markPrice,
      this.active.quantity,
    );
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
        if (this.active?.key === levelKey(level.plan.direction, level.plan.level)) continue;
        level.status = 'CANCELLED';
        level.completionReason = 'TRADER_EXIT';
        await this.persistLevel(level);
      }
    }

    if (this.active != null) {
      const a = this.active;
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
        await this.db.position.updateMany({
          where: { traderId: this.id, isOpen: true },
          data: { isOpen: false, closedAt: new Date() },
        });
      } catch (err) {
        log.error('Failed closing active grid position', { error: String(err) });
      }
      this.active = null;
    }

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
        slPrice: level.slPrice,
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
