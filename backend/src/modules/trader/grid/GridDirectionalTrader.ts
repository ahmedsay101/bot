/**
 * Directional pyramiding grid — 2N Stop-Limit entries, positions stay open until trader exit.
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
  OrderStatus,
  CloseReason,
} from '../../../types';
import {
  buildGridPlan,
  traderProfitPercent,
  type GridLevelPlan,
} from './gridCalc';
import {
  calcPositionUnrealizedPnl,
  marketSideForPosition,
} from '../../calc/strategy';
import {
  estimateOpenExitFee,
  feeRatesFromConfig,
  resolveExecutionFee,
} from '../../calc/fees';
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

interface OpenLeg {
  key: string;
  direction: TradeSide;
  level: number;
  entryPrice: string;
  quantity: string;
  entryFee: Decimal;
  allocatedMargin: string;
  clientOrderId: string;
}

interface LevelState {
  plan: GridLevelPlan;
  status: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  entryPrice: string | null;
  filledQuantity: string | null;
  fees: string | null;
  dbId?: string;
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
  private traderAllocatedAmount = new Decimal(0);
  private startPrice: string | null = null;
  private levelsPerSide = 10;
  private distancePercent = '5';
  private takeProfitPercent = '10';
  private levels = new Map<string, LevelState>();
  private openLegs = new Map<string, OpenLeg>();
  private handledFillIds = new Set<string>();
  private exiting = false;
  private isDestroyed = false;
  private isPaused = false;
  private exitReason: ExitReason | null = null;
  private realizedPnl = new Decimal(0);
  private grossRealizedPnl = new Decimal(0);
  private totalFees = new Decimal(0);
  private unrealizedPnl = new Decimal(0);
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
    this.distancePercent = String(traderConfig.gridDistancePercent ?? '5');
    this.takeProfitPercent = String(traderConfig.traderTakeProfitPercent ?? '10');
  }

  getStatus(): TraderStatus {
    return this.status;
  }

  isActive(): boolean {
    return this.status === 'ACTIVE' && !this.isDestroyed;
  }

  hasOpenPosition(): boolean {
    return this.openLegs.size > 0;
  }

  getOpenLegCount(): number {
    return this.openLegs.size;
  }

  getOpenNotional(): string | null {
    if (this.openLegs.size === 0) return null;
    let n = new Decimal(0);
    for (const leg of this.openLegs.values()) {
      n = n.plus(new Decimal(leg.entryPrice).mul(leg.quantity));
    }
    return n.toFixed(8);
  }

  async initialize(): Promise<void> {
    log.info(`Initializing grid trader ${this.id} for ${this.symbol}`);
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
    this.startPrice = this.markPrice;

    this.startedAt = new Date();
    const hours = Math.max(0.001, this.traderConfig.traderMaxLifetimeHours ?? 12);
    this.endsAt = new Date(this.startedAt.getTime() + hours * 3600_000);

    const allocation = await this.accountLedger.getAllocation(
      this.traderConfig.maxTraders,
      this.traderConfig.leverage,
    );
    this.traderAllocatedAmount = allocation.traderEquity;

    const plan = buildGridPlan({
      startPrice: this.startPrice,
      traderAllocation: this.traderAllocatedAmount,
      leverage: this.traderConfig.leverage,
      levelsPerSide: this.levelsPerSide,
      distancePercent: this.distancePercent,
      symbolInfo: this.symbolInfo,
    });
    this.startPrice = plan.startPrice;

    for (const row of plan.levels) {
      this.levels.set(levelKey(row.direction, row.level), {
        plan: row,
        status: 'PENDING',
        clientOrderId: null,
        exchangeOrderId: null,
        entryPrice: null,
        filledQuantity: null,
        fees: null,
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
        traderAllocatedAmount: this.traderAllocatedAmount.toFixed(8),
        startedAt: this.startedAt,
        endsAt: this.endsAt,
        initialCapital: this.traderAllocatedAmount.toFixed(8),
        status: 'INITIALIZING',
      },
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
        },
      });
      level.dbId = created.id;
    }

    for (const level of this.levels.values()) {
      if (new Decimal(level.plan.quantity).lte(0)) {
        log.warn('Skipping zero-qty grid level', {
          traderId: this.id,
          direction: level.plan.direction,
          level: level.plan.level,
        });
        level.status = 'SKIPPED';
        await this.persistLevel(level);
        continue;
      }
      await this.placeGridOrder(level);
    }

    await this.setStatus('ACTIVE');
    this.scheduleLifetimeEnd();
    this.emitSnapshot();
    log.info('[LIFECYCLE] GRID_ACTIVE', {
      traderId: this.id,
      symbol: this.symbol,
      startPrice: this.startPrice,
      levels: this.levels.size,
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
    this.traderAllocatedAmount = new Decimal(String(state.traderAllocatedAmount ?? '0'));
    this.exitReason = (state.exitReason as ExitReason) ?? null;
    this.levelsPerSide = Number(
      state.gridLevelsPerSide ?? state.levelsPerSide ?? this.levelsPerSide,
    );
    this.distancePercent = String(
      state.gridDistancePercent ?? state.distancePercent ?? this.distancePercent,
    );
    this.takeProfitPercent = String(
      state.traderTakeProfitPercent ?? state.takeProfitPercent ?? this.takeProfitPercent,
    );

    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);

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
        theoreticalMargin: String(row.allocatedMargin),
        allocatedMargin: String(row.allocatedMargin),
        notional: String(row.notional),
        quantity: String(row.quantity),
      };
      const key = levelKey(direction, level);
      this.levels.set(key, {
        plan,
        status: String(row.status),
        clientOrderId: row.clientOrderId != null ? String(row.clientOrderId) : null,
        exchangeOrderId: row.exchangeOrderId != null ? String(row.exchangeOrderId) : null,
        entryPrice: row.entryPrice != null ? String(row.entryPrice) : null,
        filledQuantity: row.filledQuantity != null ? String(row.filledQuantity) : null,
        fees: row.fees != null ? String(row.fees) : null,
        dbId: row.id != null ? String(row.id) : undefined,
      });
      if (String(row.status) === 'FILLED' && row.entryPrice != null && row.filledQuantity != null) {
        this.openLegs.set(key, {
          key,
          direction,
          level,
          entryPrice: String(row.entryPrice),
          quantity: String(row.filledQuantity),
          entryFee: new Decimal(String(row.fees ?? '0')),
          allocatedMargin: String(row.allocatedMargin),
          clientOrderId: String(row.clientOrderId ?? ''),
        });
      }
    }

    if (this.status === 'ACTIVE') this.scheduleLifetimeEnd();
    if (this.status === 'COMPLETING') void this.resumeCompleting();
    log.info('Grid trader restored', { traderId: this.id, levels: this.levels.size, legs: this.openLegs.size });
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
    }
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;
    const level = [...this.levels.values()].find((l) => l.clientOrderId === update.clientOrderId);
    if (level == null) return;

    if (update.status === 'TRIGGERED') {
      level.status = 'TRIGGERED';
      await this.persistLevel(level);
      this.emitSnapshot();
      return;
    }

    if (update.status === 'PARTIALLY_FILLED' || update.status === 'FILLED') {
      if (update.status === 'PARTIALLY_FILLED') {
        level.status = 'PARTIALLY_FILLED';
        await this.persistLevel(level);
        this.emitSnapshot();
        return;
      }
      await this.handleLevelFill(level, update);
    }

    if (update.status === 'CANCELED' || update.status === 'EXPIRED' || update.status === 'REJECTED') {
      if (level.status !== 'FILLED') {
        level.status = update.status;
        await this.persistLevel(level);
      }
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

  getId(): string { return this.id; }
  getSymbol(): string { return this.symbol; }
  getRealizedPnl(): string { return this.realizedPnl.toFixed(8); }
  getUnrealizedPnl(): string { return this.unrealizedPnl.toFixed(8); }

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
    const longFilled = [...this.levels.values()].filter((l) => l.plan.direction === 'LONG' && l.status === 'FILLED').length;
    const shortFilled = [...this.levels.values()].filter((l) => l.plan.direction === 'SHORT' && l.status === 'FILLED').length;
    const rates = feeRatesFromConfig(this.traderConfig);
    let openNet = new Decimal(0);
    for (const leg of this.openLegs.values()) {
      const gross = calcPositionUnrealizedPnl(leg.direction, leg.entryPrice, this.markPrice, leg.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, leg.quantity, rates);
      openNet = openNet.plus(gross.minus(leg.entryFee).minus(estExit));
    }
    const profitPct = traderProfitPercent(openNet, this.traderAllocatedAmount).toFixed(4);
    const usedMargin = [...this.openLegs.values()].reduce((s, l) => s.plus(l.allocatedMargin), new Decimal(0));
    const net = this.realizedPnl.plus(this.unrealizedPnl);

    const gridLevels = [...this.levels.values()]
      .sort((a, b) => {
        if (a.plan.direction !== b.plan.direction) return a.plan.direction === 'LONG' ? -1 : 1;
        return a.plan.direction === 'LONG' ? b.plan.level - a.plan.level : a.plan.level - b.plan.level;
      })
      .map((l) => {
        const leg = this.openLegs.get(levelKey(l.plan.direction, l.plan.level));
        let uPnl: string | null = null;
        if (leg != null) {
          uPnl = calcPositionUnrealizedPnl(leg.direction, leg.entryPrice, this.markPrice, leg.quantity).toFixed(8);
        }
        return {
          level: l.plan.level,
          direction: l.plan.direction,
          triggerPrice: l.plan.triggerPrice,
          limitPrice: l.plan.limitPrice,
          allocatedMargin: l.plan.allocatedMargin,
          notional: l.plan.notional,
          quantity: l.plan.quantity,
          status: l.status,
          entryPrice: l.entryPrice,
          unrealizedPnl: uPnl,
        };
      });

    return {
      id: this.id,
      symbol: this.symbol,
      status: this.status,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      totalPnl: net.toFixed(8),
      grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
      totalFees: this.totalFees.toFixed(8),
      markPrice: this.markPrice,
      leverage: this.traderConfig.leverage,
      capital: {
        traderAllocatedAmount: this.traderAllocatedAmount.toFixed(8),
        totalSteps: this.levelsPerSide,
        capitalSteps: this.levelsPerSide,
        currentStep: Math.max(longFilled, shortFilled),
        currentStepAllocation: usedMargin.toFixed(8),
        currentStepAmount: usedMargin.toFixed(8),
        positionNotional: this.getOpenNotional() ?? '0',
        steps: [],
        highestStepReached: Math.max(longFilled, shortFilled),
        lowestStepReached: 1,
        stepIncreases: 0,
        stepDecreases: 0,
        stepResets: 0,
        step1Trades: 0,
        maxStepTrades: 0,
      },
      currentPosition: null,
      stats: {
        startedAt: this.startedAt?.toISOString() ?? null,
        endsAt: this.endsAt?.toISOString() ?? null,
        remainingMs,
        runtimeMs,
        currentPositionNumber: this.openLegs.size,
        positionsOpened: longFilled + shortFilled,
        positionsClosed: 0,
        winningPositions: 0,
        losingPositions: 0,
        takeProfits: 0,
        stopLosses: 0,
        longPositions: longFilled,
        shortPositions: shortFilled,
        winRate: '0.00',
        grossRealizedPnl: this.grossRealizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        netRealizedPnl: this.realizedPnl.toFixed(8),
        currentStep: Math.max(longFilled, shortFilled),
        highestStepReached: Math.max(longFilled, shortFilled),
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
      openOrders: [...this.levels.values()].filter((l) => l.status === 'PENDING' || l.status === 'TRIGGERED').length,
      pendingOrders: [...this.levels.values()].filter((l) => l.status === 'PENDING').length,
      closedOrders: [...this.levels.values()].filter((l) => l.status === 'FILLED' || l.status === 'CANCELED').length,
      orders: [],
      behavior: 'grid_directional',
      grid: {
        startPrice: this.startPrice ?? '0',
        levelsPerSide: this.levelsPerSide,
        distancePercent: this.distancePercent,
        takeProfitPercent: this.takeProfitPercent,
        longFilled,
        shortFilled,
        levels: gridLevels,
        profitPercent: profitPct,
        exitReason: this.exitReason,
      },
    };
  }

  private async placeGridOrder(level: LevelState): Promise<void> {
    if (this.symbolInfo == null) throw new Error('symbolInfo missing');
    const shortId = this.id.replace(/-/g, '').slice(0, 8);
    const dir = level.plan.direction === 'LONG' ? 'L' : 'S';
    const clientOrderId = `g-${shortId}-${dir}${level.plan.level}-${uuidv4().slice(0, 8)}`;
    const side = marketSideForPosition(level.plan.direction);
    const req = {
      traderId: this.id,
      clientOrderId,
      symbol: this.symbol,
      side,
      type: 'STOP_LIMIT' as const,
      role: level.plan.direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      hedgeLevel: level.plan.level,
      quantity: level.plan.quantity,
      price: level.plan.limitPrice,
      stopPrice: level.plan.triggerPrice,
      positionSide: level.plan.direction as 'LONG' | 'SHORT',
    };
    const available = this.accountLedger.getBalance().toFixed();
    this.riskManager.validateOrder(req, this.symbolInfo, available);
    const result = await this.executionProvider.placeOrder(req);
    level.clientOrderId = result.clientOrderId;
    level.exchangeOrderId = result.exchangeOrderId;
    level.status = result.status === 'NEW' || result.status === 'PENDING' ? 'PENDING' : result.status;
    await this.db.order.upsert({
      where: { clientOrderId },
      update: {
        exchangeOrderId: result.exchangeOrderId,
        status: result.status,
      },
      create: {
        traderId: this.id,
        exchangeOrderId: result.exchangeOrderId,
        clientOrderId,
        symbol: this.symbol,
        side: result.side,
        type: 'STOP_LIMIT',
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
  }

  private async handleLevelFill(level: LevelState, update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    const fillKey = `${update.clientOrderId}:${update.exchangeOrderId}:FILLED`;
    if (this.handledFillIds.has(fillKey)) return;
    this.handledFillIds.add(fillKey);

    const qty = update.filledQuantity || level.plan.quantity;
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

    level.status = 'FILLED';
    level.entryPrice = update.avgFillPrice;
    level.filledQuantity = qty;
    level.fees = entryFee.toFixed(8);
    await this.persistLevel(level);

    const key = levelKey(level.plan.direction, level.plan.level);
    this.openLegs.set(key, {
      key,
      direction: level.plan.direction,
      level: level.plan.level,
      entryPrice: update.avgFillPrice,
      quantity: qty,
      entryFee,
      allocatedMargin: level.plan.allocatedMargin,
      clientOrderId: update.clientOrderId,
    });

    await this.db.position.create({
      data: {
        traderId: this.id,
        symbol: this.symbol,
        side: level.plan.direction,
        role: level.plan.direction === 'SHORT' ? 'SHORT' : 'LONG',
        hedgeLevel: level.plan.level,
        entryPrice: update.avgFillPrice,
        quantity: qty,
        leverage: this.traderConfig.leverage,
        isOpen: true,
        markPrice: this.markPrice,
      },
    });

    log.info('[LIFECYCLE] GRID_LEVEL_FILLED', {
      traderId: this.id,
      direction: level.plan.direction,
      level: level.plan.level,
      entry: update.avgFillPrice,
      qty,
    });

    this.recomputeUnrealized();
    this.emitSnapshot();

    if (this.exiting || this.status !== 'ACTIVE') return;

    const longFilled = [...this.levels.values()].filter((l) => l.plan.direction === 'LONG' && l.status === 'FILLED').length;
    const shortFilled = [...this.levels.values()].filter((l) => l.plan.direction === 'SHORT' && l.status === 'FILLED').length;
    if (longFilled >= this.levelsPerSide) {
      await this.beginExit('FULL_LONG_GRID');
      return;
    }
    if (shortFilled >= this.levelsPerSide) {
      await this.beginExit('FULL_SHORT_GRID');
      return;
    }
    if (this.isTraderTpHit()) {
      await this.beginExit('TRADER_TP');
    }
  }

  private isTraderTpHit(): boolean {
    // Combined net = sum(gross unrealized − entryFee − estExitFee) over open legs
    const rates = feeRatesFromConfig(this.traderConfig);
    let openNet = new Decimal(0);
    for (const leg of this.openLegs.values()) {
      const gross = calcPositionUnrealizedPnl(leg.direction, leg.entryPrice, this.markPrice, leg.quantity);
      const estExit = estimateOpenExitFee(this.markPrice, leg.quantity, rates);
      openNet = openNet.plus(gross.minus(leg.entryFee).minus(estExit));
    }
    const pct = traderProfitPercent(openNet, this.traderAllocatedAmount);
    return pct.gte(this.takeProfitPercent);
  }

  private recomputeUnrealized(): void {
    let gross = new Decimal(0);
    for (const leg of this.openLegs.values()) {
      gross = gross.plus(calcPositionUnrealizedPnl(leg.direction, leg.entryPrice, this.markPrice, leg.quantity));
    }
    this.unrealizedPnl = gross;
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
      if (level.status === 'PENDING' || level.status === 'TRIGGERED' || level.status === 'PARTIALLY_FILLED') {
        level.status = 'CANCELED';
        await this.persistLevel(level);
      }
    }

    for (const leg of [...this.openLegs.values()]) {
      try {
        const result = await this.executionProvider.closePosition(this.symbol, leg.direction, leg.quantity);
        const fill = result.avgFillPrice ?? this.markPrice;
        const exitFee = resolveExecutionFee({
          price: fill,
          quantity: leg.quantity,
          actualFee: result.fee,
          rates: feeRatesFromConfig(this.traderConfig),
          liquidity: 'TAKER',
        });
        const gross = calcPositionUnrealizedPnl(leg.direction, leg.entryPrice, fill, leg.quantity);
        this.grossRealizedPnl = this.grossRealizedPnl.plus(gross);
        this.realizedPnl = this.realizedPnl.plus(gross.minus(exitFee));
        this.totalFees = this.totalFees.plus(exitFee);
        await this.accountLedger.recordRealized(gross, exitFee);
        this.openLegs.delete(leg.key);
        await this.db.position.updateMany({
          where: { traderId: this.id, hedgeLevel: leg.level, isOpen: true, side: leg.direction },
          data: { isOpen: false, closedAt: new Date(), realizedPnl: gross.minus(exitFee).toFixed(8) },
        });
      } catch (err) {
        log.error('Failed closing grid leg', { traderId: this.id, leg: leg.key, error: String(err) });
      }
    }

    this.unrealizedPnl = new Decimal(0);
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        exitReason: reason,
        realizedPnl: this.realizedPnl.toFixed(8),
        completionReason: reason,
      },
    });
    await this.setStatus('COMPLETED');
    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
      reason: reason as CloseReason,
    });
  }

  private async persistLevel(level: LevelState): Promise<void> {
    const data = {
      status: level.status,
      clientOrderId: level.clientOrderId,
      exchangeOrderId: level.exchangeOrderId,
      entryPrice: level.entryPrice,
      filledQuantity: level.filledQuantity,
      fees: level.fees,
      filledAt: level.status === 'FILLED' ? new Date() : undefined,
      triggeredAt: level.status === 'TRIGGERED' || level.status === 'FILLED' ? new Date() : undefined,
    };
    if (level.dbId != null) {
      await this.db.gridLevel.update({ where: { id: level.dbId }, data });
    } else {
      await this.db.gridLevel.updateMany({
        where: { traderId: this.id, direction: level.plan.direction, level: level.plan.level },
        data,
      });
    }
  }

  private async setStatus(status: TraderStatus): Promise<void> {
    this.status = status;
    await this.db.trader.update({ where: { id: this.id }, data: { status } }).catch(() => {});
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
    this.emit('traderEvent', {
      type: 'PNL_UPDATE',
      traderId: this.id,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      totalPnl: this.realizedPnl.plus(this.unrealizedPnl).toFixed(8),
    });
  }
}
