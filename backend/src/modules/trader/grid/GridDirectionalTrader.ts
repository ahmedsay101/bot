/**
 * Two-sided grid trader:
 * - Capital MODE A: triangular side-pool scaling (GRID_CAPITAL_SCALING_ENABLED=true)
 * - Capital MODE B: 100% current capital, max 1 active (GRID_CAPITAL_SCALING_ENABLED=false)
 * - Every level has TP and SL at ± grid spacing % from entry
 * - Destroy ONLY for MAX_LIFETIME or ALL_GRID_POSITIONS_TP (FORCE for emergency)
 * - Price leaving the grid does NOT destroy the trader
 * - SL on a level closes that level only
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
import type { TrendDetectionView } from '../../trend';
import {
  buildGridPlan,
  sizeLevelPosition,
  traderProfitPercent,
  isLevelTerminal,
  resolveGridDistanceAbs,
  sideCapitalFromTrader,
  levelAllocationFraction,
  levelWeight,
  getUpperGridExhaustionPrice,
  getLowerGridExhaustionPrice,
  calcLevelTpSlPrices,
  allGridLevelsHitTp,
  totalGridLevels,
  isTpTriggeredByMark,
  isSlTriggeredByMark,
  isEntryTriggered,
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

/** Strategy terminals + FORCE for operator emergency stop. */
type ExitReason =
  | 'MAX_LIFETIME'
  | 'ALL_GRID_POSITIONS_TP'
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
  entryClientOrderId: string;
  tpClientOrderId: string | null;
  slClientOrderId: string | null;
  /** True once entry fill is confirmed. */
  filled: boolean;
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
  /** Frozen net PnL after TP/SL — never recalculated from mark. */
  realizedNetPnl: string | null;
  exitPrice: string | null;
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
  // Legacy exhaustion / side-full exits are no longer strategy terminals
  if (s === 'FULL_LONG_GRID' || s === 'FULL_SHORT_GRID' || s === 'GRID_EXHAUSTED') {
    return null;
  }
  if (s === 'TRADER_TP' || s === 'ALL_GRID_POSITIONS_TP') return 'ALL_GRID_POSITIONS_TP';
  if (s === 'MAX_LIFETIME' || s === 'FORCE' || s === 'ERROR') return s;
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
  /** Previous mark used for gap/cross diagnostics (entry still uses current >= / <=). */
  private previousMarkPrice: string | null = null;
  private symbolInfo: SymbolInfo | null = null;
  private initialCapital = new Decimal(0);
  private currentCapital = new Decimal(0);
  private startPrice: string | null = null;
  private gridDistanceAbs = new Decimal(0);
  private levelsPerSide = 10;
  private distancePercent = '5';
  private takeProfitPercent = '0';
  /** Default true — triangular scaling. */
  private capitalScalingEnabled = true;
  private trendSnapshot: TrendDetectionView | null = null;
  private levels = new Map<string, LevelState>();
  private activePositions = new Map<string, ActivePosition>();
  private activating = false;
  private handledFillIds = new Set<string>();
  /** Levels whose financial close has been finalized (idempotent). */
  private finalizedLevelKeys = new Set<string>();
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
    this.capitalScalingEnabled = traderConfig.gridCapitalScalingEnabled !== false;
  }

  getStatus(): TraderStatus { return this.status; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }
  hasOpenPosition(): boolean {
    for (const a of this.activePositions.values()) {
      if (a.filled) return true;
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
  setTrendSnapshot(trend: TrendDetectionView): void {
    this.trendSnapshot = trend;
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

  private getFirstActive(): ActivePosition | null {
    for (const a of this.activePositions.values()) {
      if (a.filled) return a;
    }
    return null;
  }

  async initialize(): Promise<void> {
    log.info(`Initializing grid trader ${this.id} for ${this.symbol}`, {
      capitalScalingEnabled: this.capitalScalingEnabled,
      levelsPerSide: this.levelsPerSide,
      spacingPercent: this.distancePercent,
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
      capitalScalingEnabled: this.capitalScalingEnabled,
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
        realizedNetPnl: null,
        exitPrice: null,
      });
    }
    this.refreshGridDistanceAbs();

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
    this.logGridExhaustionBounds();
    await this.tryActivateNextLevel();
    log.info('[LIFECYCLE] GRID_ACTIVE', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      capital: this.currentCapital.toFixed(8),
      longPool: sideCapitalFromTrader(this.initialCapital).toFixed(8),
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

    const rows = (state.gridLevels as Array<Record<string, unknown>>)
      ?? await this.db.gridLevel.findMany({ where: { traderId: this.id } });

    for (const row of rows) {
      const direction = String(row.direction) as TradeSide;
      const level = Number(row.level);
      const weight = Number(row.weight);
      const n = this.levelsPerSide;
      // Recompute from level number (ascending scale) — ignore legacy DB weight direction
      const allocationPct = levelAllocationFraction(level, n, this.capitalScalingEnabled).toFixed(8);
      const plan: GridLevelPlan = {
        level,
        direction,
        weight: levelWeight(level, n, this.capitalScalingEnabled),
        allocationPct,
        triggerPrice: String(row.triggerPrice),
        limitPrice: String(row.limitPrice),
        tpPrice: String(row.tpPrice ?? ''),
        slPrice: String(row.slPrice ?? ''),
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
        slPrice: row.slPrice != null ? String(row.slPrice) : plan.slPrice ?? null,
        completionReason: row.completionReason != null ? String(row.completionReason) : null,
        realizedNetPnl: null,
        exitPrice: row.exitPrice != null ? String(row.exitPrice) : null,
        dbId: row.id != null ? String(row.id) : undefined,
      });
      if (isLevelTerminal(status)) {
        this.finalizedLevelKeys.add(key);
      }
    }

    // Lock spacing from the ladder (never trust a drifted config %)
    this.refreshGridDistanceAbs();

    // Rebuild activePositions from ACTIVE levels only (never from TP_HIT/SL_HIT)
    for (const level of this.levels.values()) {
      if (level.status !== 'ACTIVE') continue;
      if (this.finalizedLevelKeys.has(levelKey(level.plan.direction, level.plan.level))) continue;
      if (level.entryPrice == null || level.filledQuantity == null || level.filledQuantity === '0') continue;
      const key = levelKey(level.plan.direction, level.plan.level);
      const actualNotional = calcActualNotional(level.entryPrice, level.filledQuantity);
      const braces = this.symbolInfo != null
        ? calcLevelTpSlPrices(level.entryPrice, level.plan.direction, this.distancePercent, this.symbolInfo)
        : { tpPrice: level.tpPrice ?? level.plan.tpPrice, slPrice: level.slPrice ?? level.plan.slPrice };
      level.tpPrice = braces.tpPrice;
      level.slPrice = braces.slPrice;
      this.activePositions.set(key, {
        key,
        direction: level.plan.direction,
        level: level.plan.level,
        entryPrice: level.entryPrice,
        quantity: level.filledQuantity,
        allocatedMargin: level.plan.allocatedMargin,
        actualNotional: actualNotional.toFixed(8),
        entryFee: new Decimal(String(level.fees ?? '0')),
        entryClientOrderId: level.clientOrderId ?? '',
        tpClientOrderId: null,
        slClientOrderId: null,
        filled: true,
        closing: false,
      });
    }

    // Bind open TP/SL order ids from restored order views (avoid duplicate protectives)
    const orderViews = Array.isArray(state.orderViews)
      ? (state.orderViews as Array<{
        clientOrderId: string;
        type: string;
        status: string;
        hedgeLevel: number;
        role?: string;
        side?: string;
      }>)
      : [];
    const openTypes = new Set(['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED']);
    for (const active of this.activePositions.values()) {
      const related = orderViews.filter(
        (o) => o.hedgeLevel === active.level && openTypes.has(o.status),
      );
      const tp = related.find((o) => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');
      const sl = related.find((o) => o.type === 'STOP_MARKET' || o.type === 'STOP' || o.type === 'STOP_LIMIT');
      if (tp != null) active.tpClientOrderId = tp.clientOrderId;
      if (sl != null) active.slClientOrderId = sl.clientOrderId;
    }

    // Fallback: restore single active from trader currentSide fields if no ACTIVE levels rebuilt
    if (this.activePositions.size === 0) {
      const side = state.currentSide != null ? String(state.currentSide) as TradeSide : null;
      const entry = state.entryPrice != null ? String(state.entryPrice) : null;
      const qty = state.quantity != null ? String(state.quantity) : null;
      const posNum = Number(state.currentPositionNumber ?? 0);

      if (side != null && entry != null && qty != null && qty !== '0') {
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
          entryClientOrderId: lvl?.clientOrderId ?? '',
          tpClientOrderId: null,
          slClientOrderId: null,
          filled: true,
          closing: false,
        });
        if (lvl != null && !isLevelTerminal(lvl.status) && this.symbolInfo != null) {
          lvl.status = 'ACTIVE';
          lvl.entryPrice = entry;
          lvl.filledQuantity = qty;
          const braces = calcLevelTpSlPrices(entry, side, this.distancePercent, this.symbolInfo);
          lvl.tpPrice = braces.tpPrice;
          lvl.slPrice = braces.slPrice;
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
      longOpen: this.countSideActive('LONG'),
      shortOpen: this.countSideActive('SHORT'),
    });
    this.logGridExhaustionBounds();
    // CRITICAL: restore rebuilds ACTIVE from DB but protective order client IDs are null
    // unless sim book was rehydrated — re-attach TP/SL so mark ticks can close them.
    void this.ensureProtectiveOrdersForActive();
  }

  /** After restore (or lost orders), ensure every filled ACTIVE has live TP+SL. */
  private async ensureProtectiveOrdersForActive(): Promise<void> {
    if (this.symbolInfo == null || this.exiting || this.isDestroyed) return;
    for (const active of this.activePositions.values()) {
      if (!active.filled || active.closing) continue;
      const level = this.levels.get(active.key);
      if (level == null || isLevelTerminal(level.status)) continue;
      const tp = level.tpPrice ?? level.plan.tpPrice;
      const sl = level.slPrice ?? level.plan.slPrice;
      if (tp == null || tp === '' || sl == null || sl === '') continue;
      if (active.tpClientOrderId != null && active.slClientOrderId != null) continue;
      log.warn('[LIFECYCLE] REATTACH_PROTECTIVES', {
        traderId: this.id,
        key: active.key,
        tp,
        sl,
        hadTp: active.tpClientOrderId != null,
        hadSl: active.slClientOrderId != null,
      });
      await this.placeProtectiveOrders(active, tp, sl);
    }
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
    // Mark-based TP/SL safety net (gaps + missing sim protective orders)
    void this.reconcileProtectiveByMark(previous, price).then(() => {
      this.logGridEvaluation(previous, price);
      // Price leaving the grid does NOT destroy the trader.
      void this.tryActivateNextLevel();
    });
  }

  /**
   * Close ACTIVE positions whose TP/SL has been crossed by mark — does not require
   * exact equality. Prefer SL when both are through (adverse gap).
   * Idempotent with real order fills via terminal status + handledFillIds.
   */
  private async reconcileProtectiveByMark(previousPrice: string, currentPrice: string): Promise<void> {
    if (this.exiting || this.isDestroyed || this.status !== 'ACTIVE') return;

    for (const active of [...this.activePositions.values()]) {
      if (!active.filled || active.closing) continue;
      if (this.finalizedLevelKeys.has(active.key)) {
        this.activePositions.delete(active.key);
        continue;
      }
      const level = this.levels.get(active.key);
      if (level == null || isLevelTerminal(level.status)) {
        this.activePositions.delete(active.key);
        continue;
      }

      const tp = level.tpPrice ?? level.plan.tpPrice;
      const sl = level.slPrice ?? level.plan.slPrice;
      if (tp == null || tp === '' || sl == null || sl === '') continue;

      const slHit = isSlTriggeredByMark(active.direction, currentPrice, sl);
      const tpHit = isTpTriggeredByMark(active.direction, currentPrice, tp);

      log.debug('[LIFECYCLE] POSITION_CHECK', {
        traderId: this.id,
        symbol: this.symbol,
        levelId: active.key,
        side: active.direction,
        entry: active.entryPrice,
        tp,
        sl,
        previousPrice,
        currentPrice,
        tpCrossed: tpHit,
        slCrossed: slHit,
        positionStatus: level.status,
      });

      if (!slHit && !tpHit) continue;

      // Prefer SL on dual cross (price gapped through both)
      const kind: 'TP' | 'SL' = slHit ? 'SL' : 'TP';
      const exitPx = kind === 'SL' ? sl : tp;

      log.warn('[LIFECYCLE] MARK_PROTECTIVE_RECONCILE', {
        traderId: this.id,
        key: active.key,
        kind,
        entry: active.entryPrice,
        tp,
        sl,
        previousPrice,
        currentPrice,
        expected: kind === 'SL' ? 'SL_TRIGGERED' : 'TP_TRIGGERED',
        actual: 'ACTIVE',
      });

      // Cancel any resting protectives so sim does not double-fill
      for (const oid of [active.tpClientOrderId, active.slClientOrderId]) {
        if (oid == null) continue;
        try {
          await this.executionProvider.cancelOrder({
            symbol: this.symbol,
            clientOrderId: oid,
          } as any);
        } catch { /* best-effort */ }
      }

      const synthId = `mark-${kind.toLowerCase()}-${active.key}-${Date.now()}`;
      await this.handleProtectiveFill(active.key, {
        clientOrderId: synthId,
        exchangeOrderId: synthId,
        symbol: this.symbol,
        status: 'FILLED',
        filledQuantity: active.quantity,
        avgFillPrice: currentPrice,
        fee: null,
        feeCurrency: null,
        timestamp: Date.now(),
      }, kind);

      // Use stop price as economic exit when mark jumped far past (optional: keep mark)
      void exitPx;
    }
  }

  /** Structured diagnostics for crossed-but-still-PENDING levels. */
  private logGridEvaluation(previousPrice: string, currentPrice: string): void {
    if (this.startPrice == null) return;
    const mark = new Decimal(currentPrice);
    const start = new Decimal(this.startPrice);
    const blocked = !this.capitalScalingEnabled && this.hasInFlightOrActivePosition();
    const lines: Array<Record<string, unknown>> = [];

    for (const l of this.levels.values()) {
      if (l.plan.direction === 'LONG' && !mark.gt(start)) continue;
      if (l.plan.direction === 'SHORT' && !mark.lt(start)) continue;
      const crossed = isEntryTriggered(l.plan.direction, currentPrice, l.plan.triggerPrice);
      if (!crossed && l.status !== 'ACTIVE') continue;
      const eligible = l.status === 'PENDING' && l.clientOrderId == null && !blocked
        && (this.capitalScalingEnabled || !this.hasInFlightOrActivePosition());
      let reasonNotActivated: string | null = null;
      if (l.status === 'PENDING' && crossed) {
        if (blocked) reasonNotActivated = 'max_one_active_position';
        else if (l.clientOrderId != null) reasonNotActivated = 'entry_order_in_flight';
        else reasonNotActivated = eligible ? null : 'not_selected_yet';
      }
      lines.push({
        levelId: levelKey(l.plan.direction, l.plan.level),
        side: l.plan.direction,
        entryPrice: l.plan.triggerPrice,
        previousPrice,
        currentPrice,
        crossed,
        eligible: Boolean(eligible && crossed),
        currentState: l.status,
        reasonNotActivated,
      });
    }

    if (lines.length === 0) return;
    log.info('[LIFECYCLE] GRID_EVALUATION', {
      traderId: this.id,
      symbol: this.symbol,
      previousPrice,
      currentPrice,
      startPrice: this.startPrice,
      capitalScalingEnabled: this.capitalScalingEnabled,
      activePositionCount: this.activePositions.size,
      levels: lines,
    });
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;

    for (const active of this.activePositions.values()) {
      if (update.clientOrderId === active.entryClientOrderId) {
        if (update.status === 'FILLED') {
          await this.handleEntryFill(active.key, update);
        }
        return;
      }
      if (
        active.tpClientOrderId != null
        && update.clientOrderId === active.tpClientOrderId
        && update.status === 'FILLED'
      ) {
        await this.handleProtectiveFill(active.key, update, 'TP');
        return;
      }
      if (
        active.slClientOrderId != null
        && update.clientOrderId === active.slClientOrderId
        && update.status === 'FILLED'
      ) {
        await this.handleProtectiveFill(active.key, update, 'SL');
        return;
      }
    }

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
    const longActive = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'LONG' && (l.status === 'ACTIVE' || l.status === 'TP_HIT'),
    ).length;
    const shortActive = [...this.levels.values()].filter(
      (l) => l.plan.direction === 'SHORT' && (l.status === 'ACTIVE' || l.status === 'TP_HIT'),
    ).length;
    const rates = feeRatesFromConfig(this.traderConfig);

    let openNet = new Decimal(0);
    for (const a of this.activePositions.values()) {
      if (!a.filled || a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      const gross = calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      openNet = openNet.plus(gross.minus(a.entryFee).minus(estExit));
    }
    const totalNet = this.realizedPnl.plus(openNet);
    const profitPct = traderProfitPercent(totalNet, this.initialCapital).toFixed(4);
    const longPool = sideCapitalFromTrader(this.initialCapital);
    const shortPool = sideCapitalFromTrader(this.initialCapital);
    let longUsed = new Decimal(0);
    let shortUsed = new Decimal(0);
    for (const a of this.activePositions.values()) {
      if (!a.filled) continue;
      if (a.direction === 'LONG') longUsed = longUsed.plus(a.allocatedMargin);
      else shortUsed = shortUsed.plus(a.allocatedMargin);
    }

    const currentPositions: CurrentPositionView[] = [];
    for (const a of this.activePositions.values()) {
      if (!a.filled || a.closing || this.finalizedLevelKeys.has(a.key)) continue;
      const gross = calcPositionUnrealizedPnl(a.direction, a.entryPrice, this.markPrice, a.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, a.quantity, rates);
      const netU = gross.minus(a.entryFee).minus(estExit);
      const lvlState = this.levels.get(a.key);
      currentPositions.push({
        number: a.level,
        side: a.direction,
        capitalStep: a.level,
        entryPrice: a.entryPrice,
        quantity: a.quantity,
        tpPrice: lvlState?.tpPrice ?? '',
        slPrice: lvlState?.slPrice ?? '',
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
        const terminal = isLevelTerminal(l.status);
        let uPnl: string | null = null;
        // CLOSED levels never mark-to-market — unrealized is always 0/null
        if (!terminal && active != null && active.filled && !active.closing) {
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
          allocatedMargin: active != null && !terminal ? active.allocatedMargin : l.plan.allocatedMargin,
          notional: active != null && !terminal ? active.actualNotional : l.plan.notional,
          leverage: this.traderConfig.leverage,
          quantity: active != null && !terminal ? active.quantity : l.plan.quantity,
          status: l.status,
          entryPrice: l.entryPrice,
          exitPrice: l.exitPrice,
          unrealizedPnl: terminal ? '0' : uPnl,
          realizedPnl: l.realizedNetPnl,
          tpPrice: l.tpPrice ?? l.plan.tpPrice,
          slPrice: l.slPrice ?? l.plan.slPrice,
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
        highestStepReached: Math.max(longActive, shortActive),
        lowestStepReached: 1,
        stepIncreases: 0,
        stepDecreases: 0,
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
        winningPositions: 0,
        losingPositions: 0,
        takeProfits: this.takeProfits,
        stopLosses: this.stopLosses,
        longPositions: longActive,
        shortPositions: shortActive,
        winRate: '0.00',
        grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        netRealizedPnl: this.realizedPnl.toFixed(8),
        currentStep: first?.level ?? 0,
        highestStepReached: Math.max(longActive, shortActive),
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
      pendingOrders: [...this.levels.values()].filter((l) => l.status === 'PENDING').length,
      closedOrders: 0,
      orders: [],
      behavior: 'grid_directional',
      grid: {
        startPrice: this.startPrice ?? '0',
        levelsPerSide: this.levelsPerSide,
        distancePercent: this.distancePercent,
        takeProfitPercent: this.distancePercent,
        longFilled: longActive,
        shortFilled: shortActive,
        levels: gridLevels as any,
        profitPercent: profitPct,
        exitReason: this.exitReason,
        currentCapital: this.currentCapital.toFixed(8),
        initialCapital: this.initialCapital.toFixed(8),
        gridDistanceAbs: this.gridDistanceAbs.toFixed(8),
        equity: this.currentCapital.plus(this.unrealizedPnl).toFixed(8),
        capitalHistory: this.capitalHistory,
        maxPerSide: this.levelsPerSide,
        maxOpenPositions: this.capitalScalingEnabled ? this.levelsPerSide * 2 : 1,
        activeOpenCount: [...this.activePositions.values()].filter(
          (a) => a.filled && !a.closing && !this.finalizedLevelKeys.has(a.key),
        ).length,
        longOpen: [...this.activePositions.values()].filter(
          (a) => a.filled && !a.closing && a.direction === 'LONG' && !this.finalizedLevelKeys.has(a.key),
        ).length,
        shortOpen: [...this.activePositions.values()].filter(
          (a) => a.filled && !a.closing && a.direction === 'SHORT' && !this.finalizedLevelKeys.has(a.key),
        ).length,
        longSideCapital: longPool.toFixed(8),
        shortSideCapital: shortPool.toFixed(8),
        longSideUsed: longUsed.toFixed(8),
        shortSideUsed: shortUsed.toFixed(8),
        longActive,
        shortActive,
        capitalScalingEnabled: this.capitalScalingEnabled,
        // OFF: 100% current capital for the single active slot — never capital÷levels
        capitalPerLevel: this.capitalScalingEnabled ? undefined : this.currentCapital.toFixed(8),
        activePositionMargin: this.getFirstActive()?.allocatedMargin ?? null,
        activePositionNotional: this.getFirstActive()?.actualNotional ?? null,
        maxActivePositions: this.capitalScalingEnabled ? this.levelsPerSide * 2 : 1,
        totalLevels: totalGridLevels(this.levelsPerSide),
        levelsPending: this.countByStatus('PENDING'),
        levelsActive: this.countByStatus('ACTIVE'),
        levelsTp: this.countByStatus('TP_HIT'),
        levelsSl: this.countByStatus('SL_HIT'),
        levelsDead: this.countByStatus('TP_HIT') + this.countByStatus('SL_HIT'),
        levelsTradable:
          this.countByStatus('PENDING') + this.countByStatus('ACTIVE'),
        destroyConditions: {
          lifetimeExpired: this.endsAt != null && Date.now() >= this.endsAt.getTime(),
          allPositionsTp: this.allPositionsHitTp(),
          remainingMs,
        },
        lifetimeRemaining: remainingMs,
        trend: this.trendSnapshot,
        ...(() => {
          const b = this.getExhaustionBounds();
          return {
            lastLongLevel: b.lastLong,
            lastShortLevel: b.lastShort,
            upperDestroyPrice: b.upperDestroy,
            lowerDestroyPrice: b.lowerDestroy,
          };
        })(),
      } as any,
    };

    return summary as TraderSummaryView;
  }

  // ── Activation ───────────────────────────────────────────────────────────

  private countSideActive(direction: TradeSide): number {
    return [...this.levels.values()].filter(
      (l) => l.plan.direction === direction && (l.status === 'ACTIVE' || l.status === 'TP_HIT'),
    ).length;
  }

  private countByStatus(status: string): number {
    return [...this.levels.values()].filter((l) => l.status === status).length;
  }

  private allPositionsHitTp(): boolean {
    return allGridLevelsHitTp([...this.levels.values()].map((l) => l.status));
  }

  /** Highest LONG / lowest SHORT trigger prices (final grid levels). */
  private getFinalGridTriggers(): { lastLong: string | null; lastShort: string | null } {
    let lastLong: string | null = null;
    let lastShort: string | null = null;
    let maxLongL = -1;
    let maxShortL = -1;
    for (const l of this.levels.values()) {
      if (l.plan.direction === 'LONG' && l.plan.level > maxLongL) {
        maxLongL = l.plan.level;
        lastLong = l.plan.triggerPrice;
      }
      if (l.plan.direction === 'SHORT' && l.plan.level > maxShortL) {
        maxShortL = l.plan.level;
        lastShort = l.plan.triggerPrice;
      }
    }
    return { lastLong, lastShort };
  }

  private getExhaustionBounds(): {
    lastLong: string | null;
    lastShort: string | null;
    upperDestroy: string | null;
    lowerDestroy: string | null;
  } {
    const { lastLong, lastShort } = this.getFinalGridTriggers();
    return {
      lastLong,
      lastShort,
      upperDestroy: lastLong != null
        ? getUpperGridExhaustionPrice(lastLong, this.distancePercent).toFixed(8)
        : null,
      lowerDestroy: lastShort != null
        ? getLowerGridExhaustionPrice(lastShort, this.distancePercent).toFixed(8)
        : null,
    };
  }

  private logGridExhaustionBounds(): void {
    const b = this.getExhaustionBounds();
    log.info('[LIFECYCLE] GRID_CONFIGURATION', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      gridSpacingPercent: this.distancePercent,
      capitalScalingEnabled: this.capitalScalingEnabled,
      currentCapital: this.currentCapital.toFixed(8),
      maxActivePositions: this.capitalScalingEnabled ? this.levelsPerSide * 2 : 1,
      totalLevels: totalGridLevels(this.levelsPerSide),
      lastLongLevel: b.lastLong,
      lastShortLevel: b.lastShort,
      note: this.capitalScalingEnabled
        ? 'Scaled capital (triangular side pools)'
        : 'OFF: 100% currentCapital, max 1 active — grid bounds informational',
    });
  }

  private sideCapital(direction: TradeSide): Decimal {
    return sideCapitalFromTrader(this.initialCapital);
  }

  /** Spacing between levels (display / restore). */
  private refreshGridDistanceAbs(): void {
    this.gridDistanceAbs = resolveGridDistanceAbs({
      levels: [...this.levels.values()].map((l) => ({
        level: l.plan.level,
        direction: l.plan.direction,
        triggerPrice: l.plan.triggerPrice,
      })),
      startPrice: this.startPrice,
      distancePercent: this.distancePercent,
      storedAbs: this.gridDistanceAbs.gt(0) ? this.gridDistanceAbs : null,
    });
  }

  private async tryActivateNextLevel(): Promise<void> {
    if (this.activating || this.exiting || this.isDestroyed) return;
    if (this.status !== 'ACTIVE' || this.isPaused) return;
    if (this.symbolInfo == null || this.startPrice == null) return;

    // MODE B: at most one active/in-flight position — wait until fully closed
    if (!this.capitalScalingEnabled && this.hasInFlightOrActivePosition()) {
      return;
    }

    this.activating = true;
    try {
      while (
        !this.exiting
        && !this.isDestroyed
        && this.status === 'ACTIVE'
        && !this.isPaused
      ) {
        if (!this.capitalScalingEnabled && this.hasInFlightOrActivePosition()) {
          break;
        }

        const mark = new Decimal(this.markPrice);
        const start = new Decimal(this.startPrice);
        let candidate: LevelState | null = null;

        if (mark.gt(start)) {
          const longs = [...this.levels.values()]
            .filter((l) => l.plan.direction === 'LONG' && l.status === 'PENDING' && l.clientOrderId == null)
            .filter((l) => isEntryTriggered('LONG', mark, l.plan.triggerPrice))
            .sort((a, b) => a.plan.level - b.plan.level);
          candidate = longs[0] ?? null;
        } else if (mark.lt(start)) {
          const shorts = [...this.levels.values()]
            .filter((l) => l.plan.direction === 'SHORT' && l.status === 'PENDING' && l.clientOrderId == null)
            .filter((l) => isEntryTriggered('SHORT', mark, l.plan.triggerPrice))
            .sort((a, b) => a.plan.level - b.plan.level);
          candidate = shorts[0] ?? null;
        }

        if (candidate == null) break;
        await this.activateLevel(candidate);
        // MODE B: only one activation per pass (even if mark crossed several levels)
        if (!this.capitalScalingEnabled) break;
      }
    } finally {
      this.activating = false;
    }
  }

  /** Entry ordered or filled — blocks another activation when scaling is OFF. */
  private hasInFlightOrActivePosition(): boolean {
    if ([...this.activePositions.values()].some((a) => !a.closing && !this.finalizedLevelKeys.has(a.key))) {
      return true;
    }
    for (const l of this.levels.values()) {
      if (l.status === 'ACTIVE' && !this.finalizedLevelKeys.has(levelKey(l.plan.direction, l.plan.level))) {
        return true;
      }
      if (l.status === 'PENDING' && l.clientOrderId != null) return true;
    }
    return false;
  }

  private async activateLevel(level: LevelState): Promise<void> {
    if (this.symbolInfo == null || this.startPrice == null) return;
    if (level.status !== 'PENDING' || level.clientOrderId != null) return;

    const key = levelKey(level.plan.direction, level.plan.level);
    if (this.activePositions.has(key)) return;

    if (!this.capitalScalingEnabled && this.hasInFlightOrActivePosition()) {
      log.info('[LIFECYCLE] SKIP_ACTIVATE_MAX_ONE', {
        traderId: this.id,
        key,
        reason: 'capitalScalingEnabled=false requires max 1 active position',
      });
      return;
    }

    const sized = sizeLevelPosition({
      sideCapital: this.sideCapital(level.plan.direction),
      currentTraderCapital: this.currentCapital,
      traderAllocation: this.currentCapital,
      level: level.plan.level,
      levelsPerSide: this.levelsPerSide,
      leverage: this.traderConfig.leverage,
      entryPrice: level.plan.triggerPrice,
      symbolInfo: this.symbolInfo,
      capitalScalingEnabled: this.capitalScalingEnabled,
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
    // Keep planned TP/SL until fill recalculates from actual entry
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
      entryClientOrderId: clientOrderId,
      tpClientOrderId: null,
      slClientOrderId: null,
      filled: false,
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
      } as any,
    });

    log.info('[LIFECYCLE] GRID_LEVEL_ORDERED', {
      traderId: this.id,
      key: active.key,
      margin: sized.allocatedMargin,
      notional: sized.notional,
      capital: this.currentCapital.toFixed(8),
      activeOpenCount: [...this.activePositions.values()].filter((a) => a.filled).length,
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
    if (this.exiting || this.isDestroyed) return;
    let active = this.activePositions.get(key);
    const level = this.levels.get(key);
    if (level == null || this.symbolInfo == null || update.avgFillPrice == null) return;

    if (active == null) {
      active = {
        key,
        direction: level.plan.direction,
        level: level.plan.level,
        entryPrice: update.avgFillPrice,
        quantity: update.filledQuantity || level.plan.quantity,
        allocatedMargin: level.plan.allocatedMargin,
        actualNotional: level.plan.notional,
        entryFee: new Decimal(0),
        entryClientOrderId: update.clientOrderId,
        tpClientOrderId: null,
        slClientOrderId: null,
        filled: false,
        closing: false,
      };
      this.activePositions.set(key, active);
    }

    const fillKey = `${update.clientOrderId}:ENTRY`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

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

    const actualNotional = calcActualNotional(update.avgFillPrice, qty);
    const braces = calcLevelTpSlPrices(
      update.avgFillPrice,
      active.direction,
      this.distancePercent,
      this.symbolInfo,
    );

    active.entryPrice = update.avgFillPrice;
    active.quantity = qty;
    active.entryFee = entryFee;
    active.actualNotional = actualNotional.toFixed(8);
    active.filled = true;

    level.entryPrice = update.avgFillPrice;
    level.filledQuantity = qty;
    level.fees = entryFee.toFixed(8);
    level.tpPrice = braces.tpPrice;
    level.slPrice = braces.slPrice;
    level.plan = { ...level.plan, tpPrice: braces.tpPrice, slPrice: braces.slPrice };
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

    const first = this.getFirstActive();
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        entryPrice: first?.entryPrice ?? update.avgFillPrice,
        quantity: first?.quantity ?? qty,
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

    await this.placeProtectiveOrders(active, braces.tpPrice, braces.slPrice);

    log.info('[LIFECYCLE] GRID_LEVEL_ACTIVE', {
      traderId: this.id,
      key: active.key,
      entry: update.avgFillPrice,
      tp: braces.tpPrice,
      sl: braces.slPrice,
    });

    this.recomputeUnrealized();
    this.emitSnapshot();
    await this.tryActivateNextLevel();
  }

  /** Place TAKE_PROFIT_MARKET + STOP_MARKET for a filled level (close opposite side). */
  private async placeProtectiveOrders(
    active: ActivePosition,
    tpPrice: string,
    slPrice: string,
  ): Promise<void> {
    if (this.symbolInfo == null || this.exiting || this.isDestroyed) return;
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const dir = active.direction === 'LONG' ? 'L' : 'S';
    // Close LONG with SELL; close SHORT with BUY
    const exitSide = active.direction === 'LONG' ? 'SELL' as const : 'BUY' as const;

    const tpClientOrderId = `g-${shortId}-${dir}${active.level}-tp-${uuidv4().slice(0, 6)}`;
    const slClientOrderId = `g-${shortId}-${dir}${active.level}-sl-${uuidv4().slice(0, 6)}`;

    const common = {
      traderId: this.id,
      symbol: this.symbol,
      side: exitSide,
      role: active.direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      hedgeLevel: active.level,
      quantity: active.quantity,
      positionSide: active.direction as 'LONG' | 'SHORT',
      reduceOnly: true,
    };

    try {
      const tpRes = await this.executionProvider.placeOrder({
        ...common,
        clientOrderId: tpClientOrderId,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: tpPrice,
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
          role: common.role,
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
        }, 'TP');
        return;
      }
    } catch (err) {
      log.error('Failed placing TP', { key: active.key, error: String(err) });
    }

    try {
      const slRes = await this.executionProvider.placeOrder({
        ...common,
        clientOrderId: slClientOrderId,
        type: 'STOP_MARKET',
        stopPrice: slPrice,
      } as any);
      active.slClientOrderId = slRes.clientOrderId;
      await this.db.order.upsert({
        where: { clientOrderId: slRes.clientOrderId },
        update: { status: slRes.status, exchangeOrderId: slRes.exchangeOrderId },
        create: {
          traderId: this.id,
          exchangeOrderId: slRes.exchangeOrderId,
          clientOrderId: slRes.clientOrderId,
          symbol: this.symbol,
          side: slRes.side,
          type: 'STOP_MARKET',
          status: slRes.status,
          role: common.role,
          hedgeLevel: active.level,
          quantity: slRes.quantity,
          stopPrice: slPrice,
          filledQuantity: slRes.filledQuantity,
          avgFillPrice: slRes.avgFillPrice,
          fee: slRes.fee,
          feeCurrency: slRes.feeCurrency,
        },
      });
      if (slRes.status === 'FILLED') {
        await this.handleProtectiveFill(active.key, {
          clientOrderId: slRes.clientOrderId,
          exchangeOrderId: slRes.exchangeOrderId,
          symbol: this.symbol,
          status: 'FILLED',
          filledQuantity: slRes.filledQuantity || active.quantity,
          avgFillPrice: slRes.avgFillPrice ?? slPrice,
          fee: slRes.fee,
          feeCurrency: slRes.feeCurrency,
          timestamp: Date.now(),
        }, 'SL');
      }
    } catch (err) {
      log.error('Failed placing SL', { key: active.key, error: String(err) });
    }
  }

  private async handleProtectiveFill(
    key: string,
    update: OrderUpdate,
    kind: 'TP' | 'SL',
  ): Promise<void> {
    if (this.exiting || this.isDestroyed) return;
    const level = this.levels.get(key);
    if (level == null) return;

    // Idempotent: financial close runs at most once per level
    if (this.finalizedLevelKeys.has(key)) {
      this.activePositions.delete(key);
      this.recomputeUnrealized();
      return;
    }
    if (isLevelTerminal(level.status) && !this.activePositions.has(key)) {
      this.finalizedLevelKeys.add(key);
      return;
    }

    const active = this.activePositions.get(key);
    if (active == null || !active.filled) return;

    const fillKey = `${update.clientOrderId}:${kind}`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    // Snapshot then remove from live MTM immediately (before any await)
    const entryPrice = active.entryPrice;
    const qty = update.filledQuantity || active.quantity;
    const entryFee = active.entryFee;
    const direction = active.direction;
    const levelNum = active.level;
    const exitPrice = update.avgFillPrice
      ?? (kind === 'TP' ? level.tpPrice : level.slPrice)
      ?? this.markPrice;

    active.closing = true;
    this.finalizedLevelKeys.add(key);
    this.activePositions.delete(key);
    this.recomputeUnrealized();

    const siblingId = kind === 'TP' ? active.slClientOrderId : active.tpClientOrderId;
    if (siblingId != null) {
      try {
        await this.executionProvider.cancelOrder({
          symbol: this.symbol,
          clientOrderId: siblingId,
        } as any);
      } catch {
        /* best-effort */
      }
    }

    const exitFee = resolveExecutionFee({
      price: exitPrice,
      quantity: qty,
      actualFee: update.fee,
      rates: feeRatesFromConfig(this.traderConfig),
      liquidity: 'TAKER',
    });
    const gross = calcGrossPnl(direction, entryPrice, exitPrice, qty);
    const net = gross.minus(entryFee).minus(exitFee);

    this.grossRealizedPnl = this.grossRealizedPnl.plus(gross);
    this.totalFees = this.totalFees.plus(exitFee);
    // Entry fee already booked into realizedPnl at fill time
    this.realizedPnl = this.realizedPnl.plus(gross.minus(exitFee));
    this.currentCapital = Decimal.max(0, this.currentCapital.plus(net));

    this.positionsClosed += 1;
    if (kind === 'TP') this.takeProfits += 1;
    else this.stopLosses += 1;

    level.status = kind === 'TP' ? 'TP_HIT' : 'SL_HIT';
    level.completionReason = kind === 'TP' ? 'TP' : 'SL';
    level.exitPrice = exitPrice;
    level.realizedNetPnl = net.toFixed(8);
    level.fees = entryFee.plus(exitFee).toFixed(8);

    this.capitalHistory.push({
      at: new Date().toISOString(),
      capital: this.currentCapital.toFixed(8),
      event: kind === 'TP' ? `TP_L${levelNum}_${direction}` : `SL_L${levelNum}_${direction}`,
      netPnl: net.toFixed(8),
    });

    try {
      await this.accountLedger.recordRealized(gross, exitFee);
      await this.persistLevel(level);
      await this.db.position.updateMany({
        where: { traderId: this.id, hedgeLevel: levelNum, side: direction, isOpen: true },
        data: {
          isOpen: false,
          closedAt: new Date(),
          exitPrice,
          realizedPnl: net.toFixed(8),
        } as any,
      });
      await this.db.trader.update({
        where: { id: this.id },
        data: {
          realizedPnl: this.realizedPnl.toFixed(8),
          unrealizedPnl: this.unrealizedPnl.toFixed(8),
          totalFees: this.totalFees.toFixed(8),
          currentCapital: this.currentCapital.toFixed(8),
          positionsClosed: this.positionsClosed,
          timelineJson: JSON.stringify(this.capitalHistory),
        } as any,
      });
    } catch (err) {
      log.error('[LIFECYCLE] CLOSE_PERSIST_FAILED (in-memory close kept)', {
        traderId: this.id,
        key,
        kind,
        error: String(err),
      });
    }

    log.info('[LIFECYCLE] GRID_LEVEL_CLOSED', {
      traderId: this.id,
      key,
      kind,
      exitPrice,
      net: net.toFixed(8),
      unrealizedAfter: this.unrealizedPnl.toFixed(8),
      levelsTp: this.countByStatus('TP_HIT'),
      levelsSl: this.countByStatus('SL_HIT'),
    });

    this.emitSnapshot();

    if (kind === 'TP' && this.allPositionsHitTp()) {
      await this.beginExit('ALL_GRID_POSITIONS_TP');
      return;
    }
    await this.tryActivateNextLevel();
  }

  private recomputeUnrealized(): void {
    let sum = new Decimal(0);
    for (const a of this.activePositions.values()) {
      // closing / unfilled never contribute to live unrealized
      if (!a.filled || a.closing) continue;
      const key = a.key;
      if (this.finalizedLevelKeys.has(key)) continue;
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
