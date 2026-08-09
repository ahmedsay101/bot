/**
 * Strategy V2 Trader — single-position reversal.
 * MARKET entry → TP + SL → on TP same side / on SL opposite → until lifetime ends.
 */
import { EventEmitter } from 'events';
import Decimal from 'decimal.js';
import type { IExecutionProvider } from '../execution/IExecutionProvider';
import type {
  TraderStatus,
  TraderMode,
  OrderUpdate,
  TraderConfig,
  SymbolInfo,
  TraderSummaryView,
  TradeSide,
  CloseReason,
  PositionTimelineEntry,
  HedgeRole,
  OrderStatus,
  OrderSide,
  OrderType,
} from '../../types';
import {
  adjustPrice,
  calcFee,
  planPositionPrices,
  nextSideAfterClose,
  marketSideForPosition,
  calcPositionUnrealizedPnl,
  calcPositionRoi,
} from '../utils/precision';
import { calcQuantityFromNotional } from '../calc/allocation';
import {
  buildStepLadder,
  calcStepAmount,
  calcStepNotional,
  nextStepAfterClose,
} from '../calc/capitalSteps';
import type { AccountLedger } from '../calc/AccountLedger';
import { RiskManager } from '../risk/RiskManager';
import { createContextLogger } from '../logger';
import { withRetry } from '../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('Trader');

export type TraderEvent =
  | { type: 'STATUS_CHANGED'; traderId: string; status: TraderStatus }
  | { type: 'COMPLETED'; traderId: string; symbol: string }
  | { type: 'FAILED'; traderId: string; symbol: string; error: string }
  | { type: 'PNL_UPDATE'; traderId: string; realizedPnl: string; unrealizedPnl: string; totalPnl: string }
  | { type: 'TRADER_SNAPSHOT'; trader: TraderSummaryView };

function roleForSide(side: TradeSide): HedgeRole {
  return side === 'SHORT' ? 'SHORT' : 'LONG';
}

export class Trader extends EventEmitter {
  readonly id: string;
  readonly symbol: string;
  readonly mode: TraderMode;

  private status: TraderStatus = 'INITIALIZING';
  private startedAt: Date | null = null;
  private endsAt: Date | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  private currentSide: TradeSide | null = null;
  private currentPositionNumber = 0;
  entryPrice: string | null = null;
  private tpPrice: string | null = null;
  private slPrice: string | null = null;
  private quantity: string | null = null;

  private entryClientOrderId: string | null = null;
  private tpClientOrderId: string | null = null;
  private slClientOrderId: string | null = null;

  private positionOpen = false;
  private openingNext = false;
  private closeHandled = false;

  /** Fixed at trader create — step amounts never follow PnL. */
  private traderAllocatedAmount = new Decimal(0);
  private capitalSteps = 5;
  private currentStep = 1;
  private currentStepAmount = new Decimal(0);
  private highestStepReached = 1;
  private lowestStepReached = 1;
  private stepIncreases = 0;
  private stepDecreases = 0;
  private step1Trades = 0;
  private maxStepTrades = 0;

  private positionsOpened = 0;
  private positionsClosed = 0;
  private winningPositions = 0;
  private losingPositions = 0;
  private takeProfits = 0;
  private stopLosses = 0;
  private longPositions = 0;
  private shortPositions = 0;
  private totalFees = new Decimal(0);

  private timeline: PositionTimelineEntry[] = [];
  private realizedPnl = new Decimal(0);
  private unrealizedPnl = new Decimal(0);
  private symbolInfo: SymbolInfo | null = null;
  private markPrice = '0';
  private isDestroyed = false;
  private completing = false;
  private completePromise: Promise<void> | null = null;
  private pendingOrders = new Set<string>();
  private handledCloseIds = new Set<string>();
  private readonly riskManager = new RiskManager();
  private orderViews = new Map<string, {
    clientOrderId: string;
    role: HedgeRole;
    type: OrderType;
    status: OrderStatus;
    side: OrderSide;
    price: string | null;
    stopPrice: string | null;
    hedgeLevel: number;
    quantity: string;
  }>();

  constructor(
    private readonly traderId: string,
    symbol: string,
    mode: TraderMode,
    private readonly executionProvider: IExecutionProvider,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
    private readonly accountLedger: AccountLedger,
  ) {
    super();
    this.id = traderId;
    this.symbol = symbol;
    this.mode = mode;
  }

  async initialize(): Promise<void> {
    log.info(`Initializing trader ${this.id} for ${this.symbol}`);

    this.symbolInfo = await withRetry(
      () => this.executionProvider.getSymbolInfo(this.symbol),
      { maxAttempts: 3, delayMs: 1000 },
    );

    await withRetry(
      () => this.executionProvider.setHedgeMode(true),
      { maxAttempts: 3, delayMs: 1000 },
    );
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
    const hours = Math.max(0.001, this.traderConfig.traderLifetimeHours);
    this.endsAt = new Date(this.startedAt.getTime() + hours * 3600_000);

    // Freeze allocation + capital steps for this trader's lifetime
    const allocation = await this.accountLedger.getAllocation(
      this.traderConfig.maxTraders,
      this.traderConfig.leverage,
    );
    this.traderAllocatedAmount = allocation.traderEquity;
    this.capitalSteps = Math.max(1, Math.floor(this.traderConfig.capitalSteps));
    this.currentStep = 1;
    this.currentStepAmount = calcStepAmount(this.traderAllocatedAmount, this.capitalSteps, 1);
    this.highestStepReached = 1;
    this.lowestStepReached = 1;

    this.lifecycle('TRADER_CREATE', {
      mode: this.mode,
      lifetimeHours: hours,
      endsAt: this.endsAt.toISOString(),
      startingSide: this.traderConfig.startingSide,
      traderAllocatedAmount: this.traderAllocatedAmount.toFixed(8),
      capitalSteps: this.capitalSteps,
      currentStep: this.currentStep,
      currentStepAmount: this.currentStepAmount.toFixed(8),
    });

    await this.persistTraderState();
    await this.openPosition(this.traderConfig.startingSide);
    await this.setStatus('ACTIVE');
    this.scheduleLifetimeEnd();
    this.lifecycle('TRADER_ACTIVE', {
      side: this.currentSide,
      entry: this.entryPrice,
      tp: this.tpPrice,
      sl: this.slPrice,
    });
  }

  async restore(state: {
    status: TraderStatus;
    realizedPnl: string;
    unrealizedPnl: string;
    startedAt: Date | null;
    endsAt: Date | null;
    currentSide: TradeSide | null;
    currentPositionNumber: number;
    entryPrice: string | null;
    tpPrice: string | null;
    slPrice: string | null;
    quantity: string | null;
    traderAllocatedAmount: string;
    capitalSteps: number;
    currentStep: number;
    currentStepAmount: string;
    highestStepReached: number;
    lowestStepReached: number;
    stepIncreases: number;
    stepDecreases: number;
    step1Trades: number;
    maxStepTrades: number;
    positionsOpened: number;
    positionsClosed: number;
    winningPositions: number;
    losingPositions: number;
    takeProfits: number;
    stopLosses: number;
    longPositions: number;
    shortPositions: number;
    totalFees: string;
    timelineJson: string;
    pendingClientOrderIds: string[];
    entryClientOrderId: string | null;
    tpClientOrderId: string | null;
    slClientOrderId: string | null;
    positionOpen: boolean;
    orderViews?: Array<{
      clientOrderId: string;
      role: HedgeRole;
      type: OrderType;
      status: OrderStatus;
      side: OrderSide;
      price: string | null;
      stopPrice: string | null;
      hedgeLevel: number;
      quantity: string;
    }>;
  }): Promise<void> {
    this.status = state.status;
    this.realizedPnl = new Decimal(state.realizedPnl);
    this.unrealizedPnl = new Decimal(state.unrealizedPnl);
    this.startedAt = state.startedAt;
    this.endsAt = state.endsAt;
    this.currentSide = state.currentSide;
    this.currentPositionNumber = state.currentPositionNumber;
    this.entryPrice = state.entryPrice;
    this.tpPrice = state.tpPrice;
    this.slPrice = state.slPrice;
    this.quantity = state.quantity;
    this.traderAllocatedAmount = new Decimal(state.traderAllocatedAmount || '0');
    this.capitalSteps = Math.max(1, state.capitalSteps || this.traderConfig.capitalSteps || 5);
    this.currentStep = Math.max(1, Math.min(this.capitalSteps, state.currentStep || 1));
    this.currentStepAmount = state.currentStepAmount && state.currentStepAmount !== '0'
      ? new Decimal(state.currentStepAmount)
      : calcStepAmount(this.traderAllocatedAmount, this.capitalSteps, this.currentStep);
    this.highestStepReached = state.highestStepReached || this.currentStep;
    this.lowestStepReached = state.lowestStepReached || this.currentStep;
    this.stepIncreases = state.stepIncreases || 0;
    this.stepDecreases = state.stepDecreases || 0;
    this.step1Trades = state.step1Trades || 0;
    this.maxStepTrades = state.maxStepTrades || 0;
    this.positionsOpened = state.positionsOpened;
    this.positionsClosed = state.positionsClosed;
    this.winningPositions = state.winningPositions;
    this.losingPositions = state.losingPositions;
    this.takeProfits = state.takeProfits;
    this.stopLosses = state.stopLosses;
    this.longPositions = state.longPositions;
    this.shortPositions = state.shortPositions;
    this.totalFees = new Decimal(state.totalFees);
    try {
      this.timeline = JSON.parse(state.timelineJson || '[]') as PositionTimelineEntry[];
    } catch {
      this.timeline = [];
    }
    this.pendingOrders = new Set(state.pendingClientOrderIds);
    this.entryClientOrderId = state.entryClientOrderId;
    this.tpClientOrderId = state.tpClientOrderId;
    this.slClientOrderId = state.slClientOrderId;
    this.positionOpen = state.positionOpen;
    if (state.orderViews != null) {
      this.orderViews = new Map(state.orderViews.map((o) => [o.clientOrderId, o]));
    }

    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    this.updateUnrealizedPnl();

    if (this.status === 'COMPLETING' || this.status === 'COMPLETED') {
      // no-op
    } else if (this.endsAt != null && Date.now() >= this.endsAt.getTime()) {
      void this.complete('EXPIRED');
    } else {
      this.scheduleLifetimeEnd();
      // Resume continuous trading if restart landed between close and next open
      if (this.status === 'ACTIVE' && !this.positionOpen) {
        void this.resumeIdlePosition();
      }
    }

    log.info(`Trader ${this.id} restored for ${this.symbol}`, {
      side: this.currentSide,
      pos: this.currentPositionNumber,
      step: this.currentStep,
      allocated: this.traderAllocatedAmount.toFixed(8),
      endsAt: this.endsAt?.toISOString(),
    });
  }

  /** After restart with no open position — reopen using last close reason + current step. */
  private async resumeIdlePosition(): Promise<void> {
    if (this.positionOpen || this.openingNext || this.completing) return;
    const last = this.timeline[this.timeline.length - 1];
    let side: TradeSide = this.traderConfig.startingSide;
    if (last != null && (last.closeReason === 'TP' || last.closeReason === 'SL')) {
      side = nextSideAfterClose(last.side, last.closeReason);
    } else if (this.currentSide != null) {
      side = this.currentSide;
    }
    this.lifecycle('RESUME_IDLE', { side, step: this.currentStep });
    await this.openPosition(side);
  }

  async resumeCompleting(): Promise<void> {
    if (this.status !== 'COMPLETING' || this.isDestroyed) return;
    await this.complete('FORCE');
  }

  destroy(): void {
    this.clearLifetimeTimer();
    this.lifecycle('TRADER_DESTROYED');
    this.isDestroyed = true;
    this.removeAllListeners();
  }

  onPriceUpdate(price: string): void {
    if (this.isDestroyed || this.status !== 'ACTIVE') return;
    this.markPrice = price;
    this.updateUnrealizedPnl();

    if (this.endsAt != null && Date.now() >= this.endsAt.getTime()) {
      void this.complete('EXPIRED');
      return;
    }

    const now = Date.now();
    if (now - (this as unknown as { lastSnap?: number }).lastSnap! > 500 || !(this as unknown as { lastSnap?: number }).lastSnap) {
      (this as unknown as { lastSnap?: number }).lastSnap = now;
      this.emitPnlUpdate();
      this.emitSnapshot();
    }
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;

    if (update.status === 'TRIGGERED' || update.status === 'NEW' || update.status === 'PENDING') {
      this.touchOrderView(update.clientOrderId, { status: update.status });
      await this.db.order.updateMany({
        where: { clientOrderId: update.clientOrderId },
        data: { status: update.status },
      });
      return;
    }

    if (update.status === 'CANCELED' || update.status === 'REJECTED' || update.status === 'EXPIRED') {
      this.pendingOrders.delete(update.clientOrderId);
      this.touchOrderView(update.clientOrderId, { status: update.status });
      this.riskManager.releaseOrder(update.clientOrderId);
      await this.db.order.updateMany({
        where: { clientOrderId: update.clientOrderId },
        data: { status: update.status },
      });
      this.emitSnapshot();
      return;
    }

    if (update.status === 'PARTIALLY_FILLED') {
      this.touchOrderView(update.clientOrderId, { status: 'PARTIALLY_FILLED' });
      if (update.clientOrderId === this.entryClientOrderId && update.filledQuantity) {
        this.quantity = update.filledQuantity;
      }
      await this.db.order.updateMany({
        where: { clientOrderId: update.clientOrderId },
        data: {
          status: 'PARTIALLY_FILLED',
          filledQuantity: update.filledQuantity,
          ...(update.avgFillPrice != null ? { avgFillPrice: update.avgFillPrice } : {}),
        },
      });
      this.emitSnapshot();
      return;
    }

    if (update.status !== 'FILLED') return;
    const enriched = this.enrichFillUpdate(update);

    if (update.clientOrderId === this.entryClientOrderId) {
      await this.onEntryFilled(enriched);
    } else if (update.clientOrderId === this.tpClientOrderId) {
      await this.onTpFilled(enriched);
    } else if (update.clientOrderId === this.slClientOrderId) {
      await this.onSlFilled(enriched);
    }
  }

  private enrichFillUpdate(update: OrderUpdate): OrderUpdate {
    if (update.avgFillPrice != null && update.avgFillPrice !== '' && update.avgFillPrice !== '0') {
      return update;
    }
    const view = this.orderViews.get(update.clientOrderId);
    const fallbacks = [
      view?.price,
      view?.stopPrice,
      update.clientOrderId === this.tpClientOrderId ? this.tpPrice : null,
      update.clientOrderId === this.slClientOrderId ? this.slPrice : null,
      this.entryPrice,
      this.markPrice !== '0' ? this.markPrice : null,
    ];
    for (const f of fallbacks) {
      if (f != null && f !== '' && f !== '0') {
        return { ...update, avgFillPrice: f };
      }
    }
    return update;
  }

  private async openPosition(side: TradeSide): Promise<void> {
    if (this.symbolInfo == null || this.openingNext || this.completing) return;
    if (this.positionOpen) {
      log.warn(`Refusing second position for ${this.symbol}`);
      return;
    }

    this.openingNext = true;
    this.closeHandled = false;
    try {
      // Refresh step amount from frozen allocation (SSOT)
      this.currentStepAmount = calcStepAmount(
        this.traderAllocatedAmount,
        this.capitalSteps,
        this.currentStep,
      );
      const notional = this.resolvePositionNotional();
      const mark = this.markPrice !== '0'
        ? this.markPrice
        : await this.executionProvider.getMarkPrice(this.symbol);
      this.markPrice = mark;
      const qty = calcQuantityFromNotional(notional, mark, this.symbolInfo);

      this.currentPositionNumber += 1;
      this.currentSide = side;
      this.quantity = qty;
      this.entryPrice = null;
      this.tpPrice = null;
      this.slPrice = null;

      if (this.currentStep === 1) this.step1Trades += 1;
      if (this.currentStep === this.capitalSteps) this.maxStepTrades += 1;

      const clientOrderId = `entry_${this.id}_p${this.currentPositionNumber}_${Date.now()}`;
      this.entryClientOrderId = clientOrderId;
      this.pendingOrders.add(clientOrderId);

      const result = await withRetry(
        () =>
          this.placeValidated({
            traderId: this.id,
            clientOrderId,
            symbol: this.symbol,
            side: marketSideForPosition(side),
            type: 'MARKET',
            role: roleForSide(side),
            hedgeLevel: this.currentPositionNumber,
            quantity: qty,
            positionSide: side,
          }),
        { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
      );

      await this.persistOrder(result, roleForSide(side), this.currentPositionNumber);

      if (result.status === 'FILLED' && result.avgFillPrice != null) {
        await this.onEntryFilled({
          clientOrderId,
          exchangeOrderId: result.exchangeOrderId,
          symbol: this.symbol,
          status: 'FILLED',
          filledQuantity: result.filledQuantity,
          avgFillPrice: result.avgFillPrice,
          fee: result.fee,
          feeCurrency: result.feeCurrency,
          timestamp: Date.now(),
        });
      }

      this.lifecycle('POSITION_SUBMITTED', {
        number: this.currentPositionNumber,
        side,
        qty,
        capitalStep: this.currentStep,
        stepAmount: this.currentStepAmount.toFixed(8),
        notional: notional.toFixed(8),
      });
    } finally {
      this.openingNext = false;
    }
  }

  private async onEntryFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null || this.currentSide == null || this.symbolInfo == null) return;
    if (this.positionOpen && this.entryPrice != null) return;

    this.entryPrice = update.avgFillPrice;
    if (update.filledQuantity) this.quantity = update.filledQuantity;
    this.positionOpen = true;
    this.positionsOpened += 1;
    if (this.currentSide === 'LONG') this.longPositions += 1;
    else this.shortPositions += 1;

    const fee = calcFee(this.entryPrice, this.quantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.minus(fee);
    this.totalFees = this.totalFees.plus(fee);
    await this.accountLedger.recordFee(fee);

    this.pendingOrders.delete(update.clientOrderId);
    this.riskManager.releaseOrder(update.clientOrderId);

    const plan = planPositionPrices(this.entryPrice, this.currentSide, this.traderConfig);
    this.tpPrice = adjustPrice(plan.takeProfit, this.symbolInfo);
    this.slPrice = adjustPrice(plan.stopLoss, this.symbolInfo);

    this.timeline.push({
      number: this.currentPositionNumber,
      side: this.currentSide,
      capitalStep: this.currentStep,
      stepAmount: this.currentStepAmount.toFixed(8),
      entryPrice: this.entryPrice,
      exitPrice: null,
      quantity: this.quantity ?? '0',
      leverage: this.traderConfig.leverage,
      takeProfit: this.tpPrice,
      stopLoss: this.slPrice,
      fees: fee.toFixed(8),
      closeReason: null,
      realizedPnl: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
    });

    await this.upsertPosition(this.currentSide, this.entryPrice, this.quantity ?? '0', true);
    await this.persistTrade(update, roleForSide(this.currentSide), this.currentPositionNumber, fee.neg().toFixed(8));
    await this.placeProtectiveOrders();
    // Sync TP/SL onto timeline after protective prices are set
    const lastOpen = this.timeline[this.timeline.length - 1];
    if (lastOpen != null && lastOpen.number === this.currentPositionNumber) {
      lastOpen.takeProfit = this.tpPrice;
      lastOpen.stopLoss = this.slPrice;
    }
    await this.persistTraderState();
    this.emitSnapshot();

    this.lifecycle('POSITION_OPEN', {
      number: this.currentPositionNumber,
      side: this.currentSide,
      entry: this.entryPrice,
      tp: this.tpPrice,
      sl: this.slPrice,
      capitalStep: this.currentStep,
      stepAmount: this.currentStepAmount.toFixed(8),
    });
  }

  private async placeProtectiveOrders(): Promise<void> {
    if (
      this.symbolInfo == null
      || this.currentSide == null
      || this.entryPrice == null
      || this.quantity == null
      || this.tpPrice == null
      || this.slPrice == null
    ) return;

    const closeSide: OrderSide = this.currentSide === 'SHORT' ? 'BUY' : 'SELL';
    const posSide = this.currentSide;

    const tpId = `tp_${this.id}_p${this.currentPositionNumber}_${Date.now()}`;
    this.tpClientOrderId = tpId;
    this.pendingOrders.add(tpId);

    const tpResult = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId: tpId,
          symbol: this.symbol,
          side: closeSide,
          type: 'TAKE_PROFIT',
          role: roleForSide(this.currentSide!),
          hedgeLevel: this.currentPositionNumber,
          quantity: this.quantity!,
          price: this.tpPrice!,
          stopPrice: this.tpPrice!,
          positionSide: posSide,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );
    await this.persistOrder(tpResult, roleForSide(this.currentSide), this.currentPositionNumber);

    const slId = `sl_${this.id}_p${this.currentPositionNumber}_${Date.now()}`;
    this.slClientOrderId = slId;
    this.pendingOrders.add(slId);

    const slResult = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId: slId,
          symbol: this.symbol,
          side: closeSide,
          type: 'STOP_MARKET',
          role: roleForSide(this.currentSide!),
          hedgeLevel: this.currentPositionNumber,
          quantity: this.quantity!,
          stopPrice: this.slPrice!,
          positionSide: posSide,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );
    await this.persistOrder(slResult, roleForSide(this.currentSide), this.currentPositionNumber);
  }

  private async onTpFilled(update: OrderUpdate): Promise<void> {
    await this.closePosition(update, 'TP');
  }

  private async onSlFilled(update: OrderUpdate): Promise<void> {
    await this.closePosition(update, 'SL');
  }

  private async closePosition(update: OrderUpdate, reason: CloseReason): Promise<void> {
    if (update.avgFillPrice == null || this.currentSide == null || this.entryPrice == null) return;
    if (this.handledCloseIds.has(update.clientOrderId) || this.closeHandled) return;
    if (!this.positionOpen) return;
    this.handledCloseIds.add(update.clientOrderId);
    this.closeHandled = true;

    const qty = this.quantity ?? '0';
    const side = this.currentSide;
    const entry = this.entryPrice;
    const fill = update.avgFillPrice;

    const gross = side === 'SHORT'
      ? new Decimal(entry).minus(fill).mul(qty)
      : new Decimal(fill).minus(entry).mul(qty);
    const fee = calcFee(fill, qty, this.traderConfig.feeRate);
    const net = gross.minus(fee);
    this.realizedPnl = this.realizedPnl.plus(net);
    this.totalFees = this.totalFees.plus(fee);
    await this.accountLedger.recordRealized(gross, fee);

    this.positionsClosed += 1;
    if (reason === 'TP') {
      this.takeProfits += 1;
      this.winningPositions += 1;
    } else if (reason === 'SL') {
      this.stopLosses += 1;
      this.losingPositions += 1;
    } else if (net.gte(0)) {
      this.winningPositions += 1;
    } else {
      this.losingPositions += 1;
    }

    // Cancel the sibling protective order
    const sibling = reason === 'TP' ? this.slClientOrderId : this.tpClientOrderId;
    if (sibling != null) {
      try {
        await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: sibling });
      } catch (err) {
        log.debug('Cancel sibling after close', { error: String(err) });
      }
      this.pendingOrders.delete(sibling);
      this.riskManager.releaseOrder(sibling);
    }
    this.pendingOrders.delete(update.clientOrderId);
    this.riskManager.releaseOrder(update.clientOrderId);

    const last = this.timeline[this.timeline.length - 1];
    if (last != null && last.number === this.currentPositionNumber) {
      last.exitPrice = fill;
      last.closeReason = reason;
      last.realizedPnl = net.toFixed(8);
      last.fees = new Decimal(last.fees ?? '0').plus(fee).toFixed(8);
      last.closedAt = new Date().toISOString();
    }

    await this.upsertPosition(side, entry, qty, false, net.toFixed(8));
    await this.persistTrade(update, roleForSide(side), this.currentPositionNumber, net.toFixed(8));

    this.positionOpen = false;
    this.unrealizedPnl = new Decimal(0);
    this.tpClientOrderId = null;
    this.slClientOrderId = null;
    this.entryClientOrderId = null;

    // Advance capital step exactly once (guarded by closeHandled / handledCloseIds)
    if (reason === 'TP' || reason === 'SL') {
      this.applyStepProgression(reason);
    }

    this.lifecycle(reason === 'TP' ? 'POSITION_TP' : reason === 'SL' ? 'POSITION_SL' : 'POSITION_CLOSED', {
      number: this.currentPositionNumber,
      side,
      fill,
      net: net.toFixed(8),
      nextStep: this.currentStep,
      nextStepAmount: this.currentStepAmount.toFixed(8),
    });

    await this.persistTraderState();
    this.emitPnlUpdate();
    this.emitSnapshot();

    if (this.completing || this.status === 'COMPLETING' || this.status === 'COMPLETED') return;
    if (this.endsAt != null && Date.now() >= this.endsAt.getTime()) {
      await this.complete('EXPIRED');
      return;
    }

    // Continuous trading: open next immediately (direction + capital step already updated)
    const next = nextSideAfterClose(side, reason === 'TP' ? 'TP' : 'SL');
    await this.openPosition(next);
  }

  /** TP → step+1 (cap); SL → step−1 (floor 1). Idempotent only via close handlers. */
  private applyStepProgression(reason: 'TP' | 'SL'): void {
    const prev = this.currentStep;
    const next = nextStepAfterClose(prev, reason, this.capitalSteps);
    if (next > prev) this.stepIncreases += 1;
    if (next < prev) this.stepDecreases += 1;
    this.currentStep = next;
    this.currentStepAmount = calcStepAmount(
      this.traderAllocatedAmount,
      this.capitalSteps,
      this.currentStep,
    );
    if (this.currentStep > this.highestStepReached) this.highestStepReached = this.currentStep;
    if (this.currentStep < this.lowestStepReached) this.lowestStepReached = this.currentStep;
  }

  private scheduleLifetimeEnd(): void {
    this.clearLifetimeTimer();
    if (this.endsAt == null) return;
    const ms = this.endsAt.getTime() - Date.now();
    if (ms <= 0) {
      void this.complete('EXPIRED');
      return;
    }
    this.lifetimeTimer = setTimeout(() => {
      void this.complete('EXPIRED');
    }, ms);
  }

  private clearLifetimeTimer(): void {
    if (this.lifetimeTimer != null) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
  }

  private async complete(reason: CloseReason = 'EXPIRED'): Promise<void> {
    if (this.status === 'COMPLETED') return;
    if (this.completePromise != null) return this.completePromise;
    this.completePromise = this.runComplete(reason);
    return this.completePromise;
  }

  private async runComplete(reason: CloseReason): Promise<void> {
    this.completing = true;
    this.clearLifetimeTimer();
    if (this.status !== 'COMPLETING') {
      await this.setStatus('COMPLETING');
    }

    this.lifecycle('TRADER_COMPLETING', { reason });

    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
      for (const [id, view] of this.orderViews) {
        if (['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED'].includes(view.status)) {
          this.touchOrderView(id, { status: 'CANCELED' });
        }
      }
    } catch (err) {
      log.warn(`Cancel orders on complete failed for ${this.symbol}`, { error: String(err) });
    }

    try {
      const positions = await this.executionProvider.getPositions(this.symbol);
      for (const pos of positions) {
        const qty = new Decimal(pos.quantity).abs();
        if (qty.lte(0)) continue;
        const closeResult = await this.executionProvider.closePosition(
          this.symbol,
          pos.side as 'LONG' | 'SHORT',
          qty.toFixed(),
        );
        if (this.positionOpen && closeResult.avgFillPrice != null && this.entryPrice != null && this.currentSide != null) {
          const fill = closeResult.avgFillPrice;
          const gross = this.currentSide === 'SHORT'
            ? new Decimal(this.entryPrice).minus(fill).mul(qty)
            : new Decimal(fill).minus(this.entryPrice).mul(qty);
          const fee = new Decimal(closeResult.fee || '0');
          const net = gross.minus(fee);
          this.realizedPnl = this.realizedPnl.plus(net);
          this.totalFees = this.totalFees.plus(fee);
          await this.accountLedger.recordRealized(gross, fee);
          this.positionsClosed += 1;
          if (net.gte(0)) this.winningPositions += 1;
          else this.losingPositions += 1;
          const last = this.timeline[this.timeline.length - 1];
          if (last != null && last.closedAt == null) {
            last.exitPrice = fill;
            last.closeReason = reason;
            last.realizedPnl = net.toFixed(8);
            last.closedAt = new Date().toISOString();
          }
        }
      }
    } catch (err) {
      log.warn(`Force close on complete failed for ${this.symbol}`, { error: String(err) });
    }

    this.positionOpen = false;
    this.unrealizedPnl = new Decimal(0);
    await this.persistFinalStatistics();
    await this.setStatus('COMPLETED');
    this.isDestroyed = true;

    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
    } satisfies TraderEvent);

    this.lifecycle('TRADER_COMPLETED', {
      reason,
      realizedPnl: this.realizedPnl.toFixed(8),
      positionsOpened: this.positionsOpened,
      takeProfits: this.takeProfits,
      stopLosses: this.stopLosses,
    });
  }

  async pause(): Promise<void> {
    if (this.status === 'ACTIVE') await this.setStatus('PAUSED');
  }

  async resume(): Promise<void> {
    if (this.status === 'PAUSED') {
      await this.setStatus('ACTIVE');
      this.scheduleLifetimeEnd();
    }
  }

  async emergencyStop(): Promise<void> {
    this.isDestroyed = true;
    this.clearLifetimeTimer();
    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
      const positions = await this.executionProvider.getPositions(this.symbol);
      for (const pos of positions) {
        const qty = new Decimal(pos.quantity).abs().toFixed();
        await this.executionProvider.closePosition(this.symbol, pos.side as 'LONG' | 'SHORT', qty);
      }
    } catch (err) {
      log.error(`Emergency stop partial failure for ${this.symbol}`, { error: String(err) });
    }
    await this.setStatus('FAILED');
    this.emit('traderEvent', {
      type: 'FAILED',
      traderId: this.id,
      symbol: this.symbol,
      error: 'emergency_stop',
    } satisfies TraderEvent);
  }

  /** Notional = current step margin × leverage (allocation frozen at create). */
  private resolvePositionNotional(): Decimal {
    return calcStepNotional(this.currentStepAmount, this.traderConfig.leverage);
  }

  private updateUnrealizedPnl(): void {
    if (!this.positionOpen || this.entryPrice == null || this.quantity == null || this.currentSide == null) {
      this.unrealizedPnl = new Decimal(0);
      return;
    }
    this.unrealizedPnl = calcPositionUnrealizedPnl(
      this.currentSide,
      this.entryPrice,
      this.markPrice,
      this.quantity,
    );
  }

  private emitPnlUpdate(): void {
    this.emit('traderEvent', {
      type: 'PNL_UPDATE',
      traderId: this.id,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      totalPnl: this.realizedPnl.plus(this.unrealizedPnl).toFixed(8),
    } satisfies TraderEvent);
  }

  private emitSnapshot(): void {
    this.emit('traderEvent', {
      type: 'TRADER_SNAPSHOT',
      trader: this.toSummary(),
    } satisfies TraderEvent);
  }

  private async setStatus(status: TraderStatus): Promise<void> {
    this.status = status;
    await this.db.trader.update({ where: { id: this.id }, data: { status } });
    this.emit('traderEvent', {
      type: 'STATUS_CHANGED',
      traderId: this.id,
      status,
    } satisfies TraderEvent);
    this.emitSnapshot();
  }

  private async persistTraderState(): Promise<void> {
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        startedAt: this.startedAt,
        endsAt: this.endsAt,
        currentSide: this.currentSide,
        currentPositionNumber: this.currentPositionNumber,
        entryPrice: this.entryPrice,
        tpPrice: this.tpPrice,
        slPrice: this.slPrice,
        quantity: this.quantity,
        traderAllocatedAmount: this.traderAllocatedAmount.toFixed(8),
        capitalSteps: this.capitalSteps,
        currentStep: this.currentStep,
        currentStepAmount: this.currentStepAmount.toFixed(8),
        highestStepReached: this.highestStepReached,
        lowestStepReached: this.lowestStepReached,
        stepIncreases: this.stepIncreases,
        stepDecreases: this.stepDecreases,
        step1Trades: this.step1Trades,
        maxStepTrades: this.maxStepTrades,
        positionsOpened: this.positionsOpened,
        positionsClosed: this.positionsClosed,
        winningPositions: this.winningPositions,
        losingPositions: this.losingPositions,
        takeProfits: this.takeProfits,
        stopLosses: this.stopLosses,
        longPositions: this.longPositions,
        shortPositions: this.shortPositions,
        totalFees: this.totalFees.toFixed(8),
        timelineJson: JSON.stringify(this.timeline),
        realizedPnl: this.realizedPnl.toFixed(8),
        unrealizedPnl: this.unrealizedPnl.toFixed(8),
        positionSize: this.quantity ?? this.traderConfig.positionSize,
      },
    });
  }

  private async placeValidated(req: import('../../types').OrderRequest): Promise<import('../../types').OrderResult> {
    if (this.symbolInfo == null) throw new Error('Symbol info not loaded');
    const available = this.accountLedger.getBalance().toFixed();
    this.riskManager.releaseOrder(req.clientOrderId);
    this.riskManager.validateOrder(req, this.symbolInfo, available);
    const result = await this.executionProvider.placeOrder(req);
    this.riskManager.trackOpenOrder(req.clientOrderId);
    return result;
  }

  private async persistOrder(
    result: import('../../types').OrderResult,
    role: HedgeRole,
    positionNumber: number,
  ): Promise<void> {
    this.orderViews.set(result.clientOrderId, {
      clientOrderId: result.clientOrderId,
      role,
      type: result.type,
      status: result.status,
      side: result.side,
      price: result.price,
      stopPrice: result.stopPrice,
      hedgeLevel: positionNumber,
      quantity: result.quantity,
    });

    await this.db.order.upsert({
      where: { clientOrderId: result.clientOrderId },
      update: {
        exchangeOrderId: result.exchangeOrderId,
        status: result.status,
        side: result.side,
        type: result.type,
        price: result.price,
        stopPrice: result.stopPrice,
        filledQuantity: result.filledQuantity,
        avgFillPrice: result.avgFillPrice,
        fee: result.fee,
        feeCurrency: result.feeCurrency,
        filledAt: result.filledAt,
      },
      create: {
        traderId: this.id,
        exchangeOrderId: result.exchangeOrderId,
        clientOrderId: result.clientOrderId,
        symbol: result.symbol,
        side: result.side,
        type: result.type,
        status: result.status,
        role,
        hedgeLevel: positionNumber,
        quantity: result.quantity,
        price: result.price,
        stopPrice: result.stopPrice,
        filledQuantity: result.filledQuantity,
        avgFillPrice: result.avgFillPrice,
        fee: result.fee,
        feeCurrency: result.feeCurrency,
        filledAt: result.filledAt,
      },
    });
  }

  private touchOrderView(clientOrderId: string, patch: { status: OrderStatus }): void {
    const prev = this.orderViews.get(clientOrderId);
    if (prev != null) this.orderViews.set(clientOrderId, { ...prev, ...patch });
  }

  private async upsertPosition(
    side: TradeSide,
    entryPrice: string,
    quantity: string,
    isOpen: boolean,
    realizedPnl = '0',
  ): Promise<void> {
    const existing = await this.db.position.findFirst({
      where: {
        traderId: this.id,
        symbol: this.symbol,
        side,
        hedgeLevel: this.currentPositionNumber,
        isOpen: true,
      },
    });
    if (existing != null) {
      await this.db.position.update({
        where: { id: existing.id },
        data: {
          entryPrice,
          quantity,
          isOpen,
          realizedPnl,
          closedAt: isOpen ? null : new Date(),
          markPrice: this.markPrice,
        },
      });
    } else if (isOpen) {
      await this.db.position.create({
        data: {
          traderId: this.id,
          symbol: this.symbol,
          side,
          role: roleForSide(side),
          hedgeLevel: this.currentPositionNumber,
          entryPrice,
          quantity,
          leverage: this.traderConfig.leverage,
          isOpen: true,
          markPrice: this.markPrice,
        },
      });
    }
  }

  private async persistTrade(
    update: OrderUpdate,
    role: HedgeRole,
    positionNumber: number,
    realizedPnl: string,
  ): Promise<void> {
    const view = this.orderViews.get(update.clientOrderId);
    await this.db.trade.create({
      data: {
        traderId: this.id,
        orderId: update.clientOrderId,
        symbol: this.symbol,
        side: view?.side ?? 'BUY',
        role,
        hedgeLevel: positionNumber,
        quantity: update.filledQuantity || view?.quantity || '0',
        price: update.avgFillPrice ?? '0',
        fee: update.fee ?? '0',
        feeCurrency: update.feeCurrency ?? 'USDT',
        realizedPnl,
        tradeTime: new Date(update.timestamp || Date.now()),
      },
    });
  }

  private async persistFinalStatistics(): Promise<void> {
    await this.persistTraderState();
    await this.db.traderStatistics.upsert({
      where: { traderId: this.id },
      update: {
        hedgeWins: this.takeProfits,
        hedgeLosses: this.stopLosses,
        totalHedgeLevels: this.currentPositionNumber,
        totalFees: this.totalFees.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
        durationMs: this.startedAt != null
          ? BigInt(Date.now() - this.startedAt.getTime())
          : BigInt(0),
      },
      create: {
        traderId: this.id,
        symbol: this.symbol,
        mode: this.mode,
        shortEntryPrice: this.entryPrice ?? '0',
        totalHedgeLevels: this.currentPositionNumber,
        hedgeWins: this.takeProfits,
        hedgeLosses: this.stopLosses,
        totalFees: this.totalFees.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
        durationMs: this.startedAt != null
          ? BigInt(Date.now() - this.startedAt.getTime())
          : BigInt(0),
      },
    });
    await this.db.trader.update({
      where: { id: this.id },
      data: { completedAt: new Date(), realizedPnl: this.realizedPnl.toFixed(8) },
    });
  }

  toSummary(): TraderSummaryView {
    this.updateUnrealizedPnl();
    const now = Date.now();
    const remainingMs = this.endsAt != null ? Math.max(0, this.endsAt.getTime() - now) : 0;
    const runtimeMs = this.startedAt != null ? Math.max(0, now - this.startedAt.getTime()) : 0;
    const closed = this.positionsClosed;
    const wins = this.winningPositions;
    const winRate = closed > 0
      ? new Decimal(wins).div(closed).mul(100).toFixed(2)
      : '0.00';

    let distanceToTpPct: string | null = null;
    let distanceToTpAbs: string | null = null;
    let distanceToSlPct: string | null = null;
    let distanceToSlAbs: string | null = null;

    if (this.positionOpen && this.entryPrice != null && this.tpPrice != null && this.slPrice != null) {
      const mark = new Decimal(this.markPrice);
      const tp = new Decimal(this.tpPrice);
      const sl = new Decimal(this.slPrice);
      const entry = new Decimal(this.entryPrice);
      distanceToTpAbs = mark.minus(tp).toFixed(8);
      distanceToSlAbs = mark.minus(sl).toFixed(8);
      if (!entry.isZero()) {
        distanceToTpPct = mark.minus(tp).div(entry).mul(100).toFixed(4);
        distanceToSlPct = mark.minus(sl).div(entry).mul(100).toFixed(4);
      }
    }

    const orderList = [...this.orderViews.values()];
    const openStatuses = new Set(['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED']);
    const openOrders = orderList.filter((o) => openStatuses.has(o.status)).length;
    const closedOrders = orderList.filter((o) => !openStatuses.has(o.status)).length;

    // Capital SSOT — always derive from frozen allocation + current step
    const stepAllocation = calcStepAmount(
      this.traderAllocatedAmount,
      this.capitalSteps,
      this.currentStep,
    );
    this.currentStepAmount = stepAllocation;
    const positionNotional = calcStepNotional(stepAllocation, this.traderConfig.leverage);
    const stepAllocationStr = stepAllocation.toFixed(8);
    const positionNotionalStr = positionNotional.toFixed(8);

    const currentPosition = this.positionOpen && this.currentSide != null && this.entryPrice != null
      ? {
          number: this.currentPositionNumber,
          side: this.currentSide,
          capitalStep: this.currentStep,
          stepAmount: stepAllocationStr,
          positionNotional: positionNotionalStr,
          entryPrice: this.entryPrice,
          quantity: this.quantity ?? '0',
          tpPrice: this.tpPrice ?? '0',
          slPrice: this.slPrice ?? '0',
          unrealizedPnl: this.unrealizedPnl.toFixed(8),
          roiPercent: calcPositionRoi(
            this.currentSide,
            this.entryPrice,
            this.markPrice,
            this.quantity ?? '0',
          ).toFixed(4),
          status: 'OPEN' as const,
        }
      : null;

    const ladder = buildStepLadder(this.traderAllocatedAmount, this.capitalSteps).map((s) => ({
      step: s.step,
      amount: s.amount.toFixed(8),
      isCurrent: s.step === this.currentStep,
    }));

    return {
      id: this.id,
      symbol: this.symbol,
      status: this.status,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      totalPnl: this.realizedPnl.plus(this.unrealizedPnl).toFixed(8),
      markPrice: this.markPrice,
      leverage: this.traderConfig.leverage,
      capital: {
        traderAllocatedAmount: this.traderAllocatedAmount.toFixed(8),
        totalSteps: this.capitalSteps,
        capitalSteps: this.capitalSteps,
        currentStep: this.currentStep,
        currentStepAllocation: stepAllocationStr,
        currentStepAmount: stepAllocationStr,
        positionNotional: positionNotionalStr,
        steps: ladder,
        highestStepReached: this.highestStepReached,
        lowestStepReached: this.lowestStepReached,
        stepIncreases: this.stepIncreases,
        stepDecreases: this.stepDecreases,
        step1Trades: this.step1Trades,
        maxStepTrades: this.maxStepTrades,
      },
      currentPosition,
      stats: {
        startedAt: this.startedAt?.toISOString() ?? null,
        endsAt: this.endsAt?.toISOString() ?? null,
        remainingMs,
        runtimeMs,
        currentPositionNumber: this.currentPositionNumber,
        positionsOpened: this.positionsOpened,
        positionsClosed: this.positionsClosed,
        winningPositions: this.winningPositions,
        losingPositions: this.losingPositions,
        takeProfits: this.takeProfits,
        stopLosses: this.stopLosses,
        longPositions: this.longPositions,
        shortPositions: this.shortPositions,
        winRate,
        totalFees: this.totalFees.toFixed(8),
        currentStep: this.currentStep,
        highestStepReached: this.highestStepReached,
        lowestStepReached: this.lowestStepReached,
        stepIncreases: this.stepIncreases,
        stepDecreases: this.stepDecreases,
        step1Trades: this.step1Trades,
        maxStepTrades: this.maxStepTrades,
      },
      timeline: [...this.timeline],
      distanceToTpPct,
      distanceToTpAbs,
      distanceToSlPct,
      distanceToSlAbs,
      openOrders,
      pendingOrders: openOrders,
      closedOrders,
      orders: orderList,
    };
  }

  private lifecycle(event: string, data: Record<string, unknown> = {}): void {
    log.info(`[LIFECYCLE] ${event}`, {
      traderId: this.id,
      symbol: this.symbol,
      traderStatus: this.status,
      ...data,
    });
  }

  getStatus(): TraderStatus { return this.status; }
  getSymbol(): string { return this.symbol; }
  getId(): string { return this.id; }
  getRealizedPnl(): string { return this.realizedPnl.toFixed(8); }
  getUnrealizedPnl(): string { return this.unrealizedPnl.toFixed(8); }
  getMarkPrice(): string { return this.markPrice; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }
  getEndsAt(): Date | null { return this.endsAt; }
  getCurrentSide(): TradeSide | null { return this.currentSide; }
  hasOpenPosition(): boolean { return this.positionOpen; }
  getOpenNotional(): string | null {
    if (!this.positionOpen || this.entryPrice == null || this.quantity == null) return null;
    return new Decimal(this.entryPrice).mul(this.quantity).toFixed(8);
  }
}
