import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type { IExecutionProvider } from '../execution/IExecutionProvider';
import type {
  TraderStatus,
  TraderMode,
  OrderUpdate,
  HedgeLevel,
  TraderConfig,
  SymbolInfo,
  TraderSummaryView,
} from '../../types';
import {
  calcShortTp,
  calcHedgeEntry,
  calcHedgeTp,
  calcNextHedgeEntry,
  calcFee,
  calcShortUnrealizedPnl,
  calcLongUnrealizedPnl,
  adjustPrice,
} from '../utils/precision';
import { calcQuantityFromNotional } from '../calc/allocation';
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

export class Trader extends EventEmitter {
  readonly id: string;
  readonly symbol: string;
  readonly mode: TraderMode;

  private status: TraderStatus = 'INITIALIZING';
  private shortEntryPrice: string | null = null;
  private shortTpPrice: string | null = null;
  private shortQuantity: string | null = null;
  private shortClientOrderId: string | null = null;
  private shortTpClientOrderId: string | null = null;
  private currentHedgeLevel = 0;
  private hedgeLevels: HedgeLevel[] = [];
  private activeHedgeClientOrderId: string | null = null;
  private realizedPnl = new Decimal(0);
  private unrealizedPnl = new Decimal(0);
  private symbolInfo: SymbolInfo | null = null;
  private markPrice: string = '0';
  private isDestroyed = false;
  private completing = false;
  private completePromise: Promise<void> | null = null;
  private shortTpHandled = false;
  private pendingOrders = new Set<string>();
  private hedgeOrderIds = new Map<number, { tpClientId: string; slClientId: string }>();
  private lastSnapshotAt = 0;
  private readonly riskManager = new RiskManager();
  private handledHedgeEvents = new Set<string>(); // `${level}:TP` | `${level}:SL`
  /** In-memory order ledger for dashboard (role/status/prices). */
  private orderViews = new Map<string, {
    clientOrderId: string;
    role: import('../../types').HedgeRole;
    type: import('../../types').OrderType;
    status: import('../../types').OrderStatus;
    side: import('../../types').OrderSide;
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

    // Strategy holds SHORT + LONG simultaneously — require Hedge Mode
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

    this.lifecycle('TRADER_CREATE', { mode: this.mode });
    await this.openShort();
    await this.setStatus('ACTIVE');
    this.lifecycle('TRADER_ACTIVE', {
      shortEntry: this.shortEntryPrice,
      shortTp: this.shortTpPrice,
      shortQty: this.shortQuantity,
      hedgeLevel: this.currentHedgeLevel,
    });
  }

  /** Restore a trader from persisted state (called on restart). */
  async restore(state: {
    shortEntryPrice: string | null;
    shortTpPrice: string | null;
    shortQuantity: string | null;
    currentHedgeLevel: number;
    hedgeLevels: HedgeLevel[];
    status: TraderStatus;
    realizedPnl: string;
    unrealizedPnl: string;
    pendingClientOrderIds: string[];
    shortClientOrderId: string | null;
    shortTpClientOrderId: string | null;
    activeHedgeClientOrderId: string | null;
    hedgeOrderIds: Array<{ level: number; tpClientId: string; slClientId: string }>;
    orderViews?: Array<{
      clientOrderId: string;
      role: import('../../types').HedgeRole;
      type: import('../../types').OrderType;
      status: import('../../types').OrderStatus;
      side: import('../../types').OrderSide;
      price: string | null;
      stopPrice: string | null;
      hedgeLevel: number;
      quantity: string;
    }>;
  }): Promise<void> {
    this.shortEntryPrice = state.shortEntryPrice;
    this.shortTpPrice = state.shortTpPrice;
    this.shortQuantity = state.shortQuantity;
    this.currentHedgeLevel = state.currentHedgeLevel;
    this.hedgeLevels = state.hedgeLevels.map((h) => ({
      ...h,
      previousLevelPrice: h.previousLevelPrice || h.stopPrice,
      stopPrice: h.previousLevelPrice || h.stopPrice,
      // Legacy ACTIVE (order resting) → PENDING
      status: (h.status as string) === 'ACTIVE' ? 'PENDING' : h.status,
    }));
    this.status = state.status;
    this.realizedPnl = new Decimal(state.realizedPnl);
    this.unrealizedPnl = new Decimal(state.unrealizedPnl);
    this.shortClientOrderId = state.shortClientOrderId;
    this.shortTpClientOrderId = state.shortTpClientOrderId;
    this.activeHedgeClientOrderId = state.activeHedgeClientOrderId;
    this.pendingOrders = new Set(state.pendingClientOrderIds);
    this.hedgeOrderIds = new Map(state.hedgeOrderIds.map((h) => [h.level, { tpClientId: h.tpClientId, slClientId: h.slClientId }]));
    if (state.orderViews != null) {
      this.orderViews = new Map(state.orderViews.map((o) => [o.clientOrderId, o]));
    }
    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    this.updateUnrealizedPnl();
    // If short TP already filled in DB, don't re-handle on rehydrate noise
    if (this.status === 'COMPLETING' || this.status === 'COMPLETED') {
      this.shortTpHandled = true;
    }
    log.info(`Trader ${this.id} restored for ${this.symbol}`, {
      shortQty: this.shortQuantity,
      hedgeLevels: this.hedgeLevels.length,
      pendingOrders: this.pendingOrders.size,
      status: this.status,
    });
  }

  /** Resume a crash mid-complete (COMPLETING status on restart). */
  async resumeCompleting(): Promise<void> {
    if (this.status !== 'COMPLETING' || this.isDestroyed) return;
    log.warn(`Resuming COMPLETING trader ${this.id} for ${this.symbol}`);
    await this.complete();
  }

  /** Full teardown — remove listeners after slot release. */
  destroy(): void {
    this.lifecycle('TRADER_DESTROYED');
    this.isDestroyed = true;
    this.removeAllListeners();
  }

  onPriceUpdate(price: string): void {
    if (this.isDestroyed || this.status !== 'ACTIVE') return;
    this.markPrice = price;
    this.updateUnrealizedPnl();

    const now = Date.now();
    // Emit aggressively so dashboard marks/PnL tick with the mark-price stream
    if (now - this.lastSnapshotAt >= 200) {
      this.lastSnapshotAt = now;
      this.emitSnapshot();
    }
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;
    if (!this.pendingOrders.has(update.clientOrderId)) return;

    log.debug(`Order update for trader ${this.id}`, {
      clientId: update.clientOrderId,
      status: update.status,
      filledQty: update.filledQuantity,
      avg: update.avgFillPrice,
    });

    // Non-fill working statuses — only TRIGGERED advances hedge phase (not NEW/PENDING)
    if (update.status === 'TRIGGERED' || update.status === 'NEW' || update.status === 'PENDING') {
      this.touchOrderView(update.clientOrderId, { status: update.status });
      await this.db.order.updateMany({
        where: { clientOrderId: update.clientOrderId },
        data: { status: update.status },
      });
      if (update.clientOrderId === this.activeHedgeClientOrderId) {
        const hl = this.hedgeLevels.find((h) => h.level === this.currentHedgeLevel);
        if (hl != null) {
          hl.entryOrderStatus = update.status;
          // STOP-LIMIT: only mark TRIGGERED when the stop is actually hit
          if (update.status === 'TRIGGERED' && (hl.status === 'PENDING')) {
            hl.status = 'TRIGGERED';
            this.lifecycle('HEDGE_STOP_TRIGGERED', {
              level: hl.level,
              entry: hl.entryPrice,
              mark: this.markPrice,
            });
            this.emitSnapshot();
          }
        }
      }
      return;
    }

    // Terminal non-fill statuses — release pending book
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

    // Partial fills: track qty only — state machine advances on FILLED
    if (update.status === 'PARTIALLY_FILLED') {
      if (update.clientOrderId === this.shortClientOrderId && update.filledQuantity) {
        this.shortQuantity = update.filledQuantity;
      }
      this.touchOrderView(update.clientOrderId, { status: 'PARTIALLY_FILLED' });
      await this.db.order.updateMany({
        where: { clientOrderId: update.clientOrderId },
        data: {
          status: 'PARTIALLY_FILLED',
          filledQuantity: update.filledQuantity,
          ...(update.avgFillPrice != null ? { avgFillPrice: update.avgFillPrice } : {}),
          ...(update.fee != null ? { fee: update.fee } : {}),
        },
      });
      this.emitSnapshot();
      return;
    }

    if (update.status !== 'FILLED') return;

    // Enrich null avg fill (common on ALGO_UPDATE FINISHED) before handlers
    const enriched = this.enrichFillUpdate(update);

    if (update.clientOrderId === this.shortClientOrderId) {
      await this.onShortFilled(enriched);
    } else if (update.clientOrderId === this.shortTpClientOrderId) {
      await this.onShortTpFilled(enriched);
    } else if (update.clientOrderId === this.activeHedgeClientOrderId) {
      await this.onHedgeFilled(enriched);
    } else {
      for (const [level, ids] of this.hedgeOrderIds) {
        if (update.clientOrderId === ids.tpClientId) {
          const hl = this.hedgeLevels.find((h) => h.level === level);
          if (hl != null) await this.onHedgeTpFilled(hl, enriched);
          break;
        }
        if (update.clientOrderId === ids.slClientId) {
          const hl = this.hedgeLevels.find((h) => h.level === level);
          if (hl != null) await this.onHedgeStopLossHit(hl, enriched);
          break;
        }
      }
    }
  }

  /**
   * ALGO_UPDATE often arrives FILLED with null avgPrice.
   * Fall back to known order price / stop / mark so lifecycle can advance.
   */
  private enrichFillUpdate(update: OrderUpdate): OrderUpdate {
    if (update.avgFillPrice != null && update.avgFillPrice !== '' && update.avgFillPrice !== '0') {
      return update;
    }
    const view = this.orderViews.get(update.clientOrderId);
    const fallbacks = [
      view?.price,
      view?.stopPrice,
      update.clientOrderId === this.shortTpClientOrderId ? this.shortTpPrice : null,
      this.markPrice !== '0' ? this.markPrice : null,
    ];
    for (const f of fallbacks) {
      if (f != null && f !== '' && f !== '0') {
        log.debug('Enriched null avgFillPrice from fallback', {
          clientId: update.clientOrderId,
          fill: f,
        });
        return { ...update, avgFillPrice: f };
      }
    }
    return update;
  }

  private async resolvePositionNotional(): Promise<Decimal> {
    const allocation = await this.accountLedger.getAllocation(
      this.traderConfig.maxTraders,
      this.traderConfig.leverage,
    );
    return allocation.positionNotional;
  }

  private async openShort(): Promise<void> {
    if (this.symbolInfo == null) throw new Error('Symbol info not loaded');

    const markPriceDecimal = new Decimal(this.markPrice);
    if (markPriceDecimal.isZero() || markPriceDecimal.isNaN() || markPriceDecimal.isNeg()) {
      throw new Error(`Cannot open short: invalid mark price '${this.markPrice}' for ${this.symbol}`);
    }

    const notional = await this.resolvePositionNotional();
    const qty = calcQuantityFromNotional(notional, this.markPrice, this.symbolInfo);

    const clientOrderId = `short_${this.id}_${Date.now()}`;
    this.shortClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    const result = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'MARKET',
          role: 'SHORT',
          hedgeLevel: 0,
          quantity: qty,
          positionSide: 'SHORT',
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    this.shortQuantity = result.quantity;
    // Persist before state-machine advance so restart never loses the short MARKET row
    await this.persistOrder(result, 'SHORT', 0);

    if (result.status === 'FILLED' && result.avgFillPrice != null) {
      await this.onShortFilled({
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

    log.info(`Short opened for ${this.symbol}`, {
      clientId: clientOrderId,
      qty,
      notional: notional.toFixed(4),
    });
  }

  private async onShortFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    // Idempotent — sync MARKET return + async sim/live event must not double-place TP/hedge
    if (this.shortEntryPrice != null) return;

    this.shortEntryPrice = update.avgFillPrice;
    if (update.filledQuantity) this.shortQuantity = update.filledQuantity;

    const openFee = calcFee(this.shortEntryPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.minus(openFee);
    await this.accountLedger.recordFee(openFee);
    this.pendingOrders.delete(update.clientOrderId);
    this.riskManager.releaseOrder(update.clientOrderId);
    await this.upsertPosition('SHORT', 'SHORT', 0, this.shortEntryPrice, this.shortQuantity ?? '0', true);
    await this.persistTrade(update, 'SHORT', 0, openFee.neg().toFixed(8));
    const shortTp = calcShortTp(this.shortEntryPrice, this.traderConfig.shortTpPercent);
    this.shortTpPrice = adjustPrice(shortTp, this.symbolInfo!);

    await this.persistTraderState();
    await this.placeShortTp();
    await this.placeInitialHedge();
    this.emitSnapshot();
  }

  private async placeShortTp(): Promise<void> {
    if (this.symbolInfo == null || this.shortEntryPrice == null || this.shortQuantity == null) return;

    const clientOrderId = `short_tp_${this.id}_${Date.now()}`;
    this.shortTpClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    const result = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: 'BUY',
          type: 'TAKE_PROFIT',
          role: 'SHORT',
          hedgeLevel: 0,
          quantity: this.shortQuantity!,
          price: this.shortTpPrice!,
          stopPrice: this.shortTpPrice!,
          positionSide: 'SHORT',
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    await this.persistOrder(result, 'SHORT', 0);
    log.info(`Short TP placed for ${this.symbol}`, { tp: this.shortTpPrice });
  }

  private async placeInitialHedge(): Promise<void> {
    if (this.symbolInfo == null || this.shortEntryPrice == null) return;

    // Strategy: Entry = short×(1+d), SL = short (previous level), TP = entry×(1+tp%)
    const previousLevel = adjustPrice(this.shortEntryPrice, this.symbolInfo);
    const hedgeEntry = calcHedgeEntry(this.shortEntryPrice, this.traderConfig.hedgeDistance);
    const hedgeTp = calcHedgeTp(hedgeEntry.toFixed(), this.traderConfig.hedgeTpPercent);
    const entryAdj = adjustPrice(hedgeEntry, this.symbolInfo);

    const notional = await this.resolvePositionNotional();
    const qty = calcQuantityFromNotional(notional, entryAdj, this.symbolInfo);

    const hedgeLevel: HedgeLevel = {
      level: 1,
      entryPrice: entryAdj,
      stopPrice: previousLevel,
      previousLevelPrice: previousLevel,
      tpPrice: adjustPrice(hedgeTp, this.symbolInfo),
      quantity: qty,
      status: 'PENDING',
      entryOrderStatus: null,
    };

    this.hedgeLevels.push(hedgeLevel);
    this.currentHedgeLevel = 1;

    this.lifecycle('HEDGE_CREATE', {
      level: 1,
      entry: hedgeLevel.entryPrice,
      stopLoss: hedgeLevel.stopPrice,
      previousLevel: hedgeLevel.previousLevelPrice,
      tp: hedgeLevel.tpPrice,
      qty: hedgeLevel.quantity,
    });

    await this.placeHedgeOrder(hedgeLevel);
  }

  private async placeHedgeOrder(hedgeLevel: HedgeLevel): Promise<void> {
    if (this.symbolInfo == null) return;

    // Re-size if quantity missing (restored legacy levels)
    if (!hedgeLevel.quantity || hedgeLevel.quantity === '0') {
      const notional = await this.resolvePositionNotional();
      hedgeLevel.quantity = calcQuantityFromNotional(notional, hedgeLevel.entryPrice, this.symbolInfo);
    }

    // Ensure SL anchor is never confused with STOP-LIMIT trigger
    if (!hedgeLevel.previousLevelPrice || hedgeLevel.previousLevelPrice === '0') {
      hedgeLevel.previousLevelPrice = hedgeLevel.stopPrice;
    }
    hedgeLevel.stopPrice = hedgeLevel.previousLevelPrice;

    const clientOrderId = `hedge_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.activeHedgeClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    // STOP-LIMIT trigger = entry (buy when mark >= entry). Position SL is separate (stopPrice).
    const result = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: 'BUY',
          type: 'STOP_LIMIT',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: hedgeLevel.quantity,
          price: hedgeLevel.entryPrice,
          stopPrice: hedgeLevel.entryPrice,
          positionSide: 'LONG',
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    // Stay PENDING until the stop is hit — do NOT mark TRIGGERED/ACTIVE on accept
    hedgeLevel.status = 'PENDING';
    hedgeLevel.entryOrderStatus = result.status === 'TRIGGERED' ? 'TRIGGERED' : 'PENDING';
    if (result.status === 'TRIGGERED') {
      hedgeLevel.status = 'TRIGGERED';
    }

    await this.persistOrder(result, 'HEDGE', hedgeLevel.level);
    await this.persistTraderState();
    this.emitSnapshot();

    this.lifecycle('HEDGE_STOP_LIMIT_PLACED', {
      level: hedgeLevel.level,
      entry: hedgeLevel.entryPrice,
      positionSl: hedgeLevel.stopPrice,
      previousLevel: hedgeLevel.previousLevelPrice,
      tp: hedgeLevel.tpPrice,
      qty: hedgeLevel.quantity,
      orderStatus: hedgeLevel.entryOrderStatus,
      hedgePhase: hedgeLevel.status,
      clientId: clientOrderId,
    });
  }

  private async onHedgeFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;

    const hedgeLevel = this.hedgeLevels.find((h) => h.level === this.currentHedgeLevel);
    if (hedgeLevel == null) return;
    if (hedgeLevel.status === 'OPEN' || hedgeLevel.status === 'HIT_TP' || hedgeLevel.status === 'HIT_SL') return;

    hedgeLevel.status = 'OPEN';
    hedgeLevel.entryOrderStatus = 'FILLED';
    if (update.filledQuantity) hedgeLevel.quantity = update.filledQuantity;
    this.lifecycle('HEDGE_FILLED_OPEN', {
      level: hedgeLevel.level,
      fill: update.avgFillPrice,
      qty: hedgeLevel.quantity,
      positionSl: hedgeLevel.stopPrice,
      tp: hedgeLevel.tpPrice,
    });

    const openFee = calcFee(update.avgFillPrice, hedgeLevel.quantity, this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.minus(openFee);
    await this.accountLedger.recordFee(openFee);

    const tpClientId = `hedge_tp_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.pendingOrders.add(tpClientId);

    const result = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId: tpClientId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: hedgeLevel.quantity,
          price: hedgeLevel.tpPrice,
          stopPrice: hedgeLevel.tpPrice,
          positionSide: 'LONG',
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    const slClientId = `hedge_sl_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.pendingOrders.add(slClientId);

    const slResult = await withRetry(
      () =>
        this.placeValidated({
          traderId: this.id,
          clientOrderId: slClientId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'STOP_MARKET',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: hedgeLevel.quantity,
          stopPrice: hedgeLevel.stopPrice,
          positionSide: 'LONG',
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    this.hedgeOrderIds.set(hedgeLevel.level, { tpClientId, slClientId });

    await this.persistOrder(result, 'HEDGE', hedgeLevel.level);
    await this.persistOrder(slResult, 'HEDGE', hedgeLevel.level);
    await this.upsertPosition('LONG', 'HEDGE', hedgeLevel.level, update.avgFillPrice, hedgeLevel.quantity, true);
    await this.persistTrade(update, 'HEDGE', hedgeLevel.level, '0');
    await this.persistTraderState();
    this.emitSnapshot();

    log.info(`Hedge L${hedgeLevel.level} FILLED for ${this.symbol}`, { fillPrice: update.avgFillPrice });
  }

  private async onHedgeStopLossHit(hedgeLevel: HedgeLevel, update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    const key = `${hedgeLevel.level}:SL`;
    if (this.handledHedgeEvents.has(key) || hedgeLevel.status === 'HIT_SL' || hedgeLevel.status === 'HIT_TP') return;
    this.handledHedgeEvents.add(key);

    log.info(`Hedge L${hedgeLevel.level} SL hit for ${this.symbol} — recreating same hedge`);
    hedgeLevel.status = 'HIT_SL';

    const qty = hedgeLevel.quantity;
    const loss = new Decimal(update.avgFillPrice).minus(hedgeLevel.entryPrice).mul(qty);
    const closeFee = calcFee(update.avgFillPrice, qty, this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(loss).minus(closeFee);
    await this.accountLedger.recordRealized(loss, closeFee);
    await this.upsertPosition('LONG', 'HEDGE', hedgeLevel.level, hedgeLevel.entryPrice, qty, false, loss.minus(closeFee).toFixed(8));
    await this.persistTrade(update, 'HEDGE', hedgeLevel.level, loss.minus(closeFee).toFixed(8));

    const ids = this.hedgeOrderIds.get(hedgeLevel.level);
    if (ids != null) {
      try {
        await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: ids.tpClientId });
      } catch (err) {
        log.debug('Cancel hedge TP after SL (may already be gone)', { error: String(err) });
      }
      this.pendingOrders.delete(ids.tpClientId);
      this.pendingOrders.delete(ids.slClientId);
      this.riskManager.releaseOrder(ids.tpClientId);
      this.riskManager.releaseOrder(ids.slClientId);
      this.hedgeOrderIds.delete(hedgeLevel.level);
    }

    const newLevel: HedgeLevel = {
      level: hedgeLevel.level,
      entryPrice: hedgeLevel.entryPrice,
      stopPrice: hedgeLevel.previousLevelPrice || hedgeLevel.stopPrice,
      previousLevelPrice: hedgeLevel.previousLevelPrice || hedgeLevel.stopPrice,
      tpPrice: hedgeLevel.tpPrice,
      quantity: hedgeLevel.quantity,
      status: 'PENDING',
      entryOrderStatus: null,
    };

    const idx = this.hedgeLevels.findIndex((h) => h.level === hedgeLevel.level);
    if (idx >= 0) this.hedgeLevels[idx] = newLevel;

    this.lifecycle('HEDGE_RECREATE_AFTER_SL', {
      level: newLevel.level,
      entry: newLevel.entryPrice,
      stopLoss: newLevel.stopPrice,
      previousLevel: newLevel.previousLevelPrice,
    });

    await this.placeHedgeOrder(newLevel);
    this.emitPnlUpdate();
    this.emitSnapshot();
  }

  private async onHedgeTpFilled(hedgeLevel: HedgeLevel, update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    const key = `${hedgeLevel.level}:TP`;
    if (this.handledHedgeEvents.has(key) || hedgeLevel.status === 'HIT_TP' || hedgeLevel.status === 'HIT_SL') return;
    this.handledHedgeEvents.add(key);

    log.info(`Hedge L${hedgeLevel.level} TP hit for ${this.symbol} — creating next hedge`);
    hedgeLevel.status = 'HIT_TP';

    const qty = hedgeLevel.quantity;
    const pnl = new Decimal(update.avgFillPrice).minus(hedgeLevel.entryPrice).mul(qty);
    const closeFee = calcFee(update.avgFillPrice, qty, this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(pnl).minus(closeFee);
    await this.accountLedger.recordRealized(pnl, closeFee);
    await this.upsertPosition('LONG', 'HEDGE', hedgeLevel.level, hedgeLevel.entryPrice, qty, false, pnl.minus(closeFee).toFixed(8));
    await this.persistTrade(update, 'HEDGE', hedgeLevel.level, pnl.minus(closeFee).toFixed(8));

    const ids = this.hedgeOrderIds.get(hedgeLevel.level);
    if (ids != null) {
      try {
        await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: ids.slClientId });
      } catch (err) {
        log.debug('Cancel hedge SL after TP (may already be gone)', { error: String(err) });
      }
      this.pendingOrders.delete(ids.slClientId);
      this.pendingOrders.delete(ids.tpClientId);
      this.riskManager.releaseOrder(ids.tpClientId);
      this.riskManager.releaseOrder(ids.slClientId);
      this.hedgeOrderIds.delete(hedgeLevel.level);
    }

    const nextEntry = calcNextHedgeEntry(update.avgFillPrice, this.traderConfig.hedgeDistance);
    const nextTp = calcHedgeTp(nextEntry.toFixed(), this.traderConfig.hedgeTpPercent);
    const entryAdj = adjustPrice(nextEntry, this.symbolInfo!);

    const notional = await this.resolvePositionNotional();
    const nextQty = calcQuantityFromNotional(notional, entryAdj, this.symbolInfo!);

    // Next hedge SL = previous completed level (this hedge's TP fill)
    const previousLevel = adjustPrice(update.avgFillPrice, this.symbolInfo!);
    const nextLevel: HedgeLevel = {
      level: hedgeLevel.level + 1,
      entryPrice: entryAdj,
      stopPrice: previousLevel,
      previousLevelPrice: previousLevel,
      tpPrice: adjustPrice(nextTp, this.symbolInfo!),
      quantity: nextQty,
      status: 'PENDING',
      entryOrderStatus: null,
    };

    this.hedgeLevels.push(nextLevel);
    this.currentHedgeLevel = nextLevel.level;

    this.lifecycle('HEDGE_PROGRESS', {
      level: nextLevel.level,
      entry: nextLevel.entryPrice,
      stopLoss: nextLevel.stopPrice,
      previousLevel: nextLevel.previousLevelPrice,
      tp: nextLevel.tpPrice,
    });

    await this.placeHedgeOrder(nextLevel);
    await this.persistTraderState();
    this.emitPnlUpdate();
    this.emitSnapshot();
  }

  private async onShortTpFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    // Idempotent — dual FILLED / ALGO+ORDER updates must not double-complete
    if (this.shortTpHandled || this.completing || this.isDestroyed) return;
    if (this.status === 'COMPLETED' || this.status === 'COMPLETING') return;
    this.shortTpHandled = true;

    log.info(`Short TP hit for ${this.symbol} — completing trader ${this.id}`);

    if (this.shortTpClientOrderId != null) {
      this.pendingOrders.delete(this.shortTpClientOrderId);
      this.touchOrderView(this.shortTpClientOrderId, { status: 'FILLED' });
    }

    await this.db.order.updateMany({
      where: { clientOrderId: update.clientOrderId },
      data: {
        status: 'FILLED',
        filledQuantity: update.filledQuantity,
        avgFillPrice: update.avgFillPrice,
        fee: update.fee ?? undefined,
        filledAt: new Date(),
      },
    });

    const pnl = new Decimal(this.shortEntryPrice ?? '0')
      .minus(update.avgFillPrice)
      .mul(this.shortQuantity ?? '0');
    const fee = calcFee(update.avgFillPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(pnl).minus(fee);
    await this.accountLedger.recordRealized(pnl, fee);
    await this.upsertPosition(
      'SHORT',
      'SHORT',
      0,
      this.shortEntryPrice ?? update.avgFillPrice,
      this.shortQuantity ?? '0',
      false,
      pnl.minus(fee).toFixed(8),
    );
    await this.persistTrade(update, 'SHORT', 0, pnl.minus(fee).toFixed(8));
    this.riskManager.releaseOrder(update.clientOrderId);

    await this.complete();
  }

  private async complete(): Promise<void> {
    if (this.status === 'COMPLETED') return;
    if (this.completePromise != null) return this.completePromise;
    this.completePromise = this.runComplete();
    return this.completePromise;
  }

  private async runComplete(): Promise<void> {
    this.completing = true;

    if (this.status !== 'COMPLETING') {
      await this.setStatus('COMPLETING');
    }

    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
      for (const [id, view] of this.orderViews) {
        if (view.status === 'PENDING' || view.status === 'NEW' || view.status === 'TRIGGERED' || view.status === 'PARTIALLY_FILLED') {
          this.touchOrderView(id, { status: 'CANCELED' });
        }
      }
    } catch (err) {
      log.warn(`Failed to cancel hedge orders for ${this.symbol}`, { error: String(err) });
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
        // Apply remaining hedge/short PnL immediately when force-closing
        if (closeResult.avgFillPrice != null) {
          const fill = new Decimal(closeResult.avgFillPrice);
          const entry = new Decimal(pos.entryPrice);
          const gross = pos.side === 'LONG'
            ? fill.minus(entry).mul(qty)
            : entry.minus(fill).mul(qty);
          const closeFee = new Decimal(closeResult.fee || '0');
          this.realizedPnl = this.realizedPnl.plus(gross).minus(closeFee);
          await this.accountLedger.recordRealized(gross, closeFee);
        }
      }
    } catch (err) {
      log.warn(`Failed to close positions for ${this.symbol}`, { error: String(err) });
    }

    this.unrealizedPnl = new Decimal(0);
    await this.persistFinalStatistics();
    await this.setStatus('COMPLETED');
    this.isDestroyed = true;
    this.pendingOrders.clear();

    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
    } satisfies TraderEvent);

    this.lifecycle('TRADER_COMPLETED', { realizedPnl: this.realizedPnl.toFixed(8) });
  }

  async pause(): Promise<void> {
    if (this.status === 'ACTIVE') await this.setStatus('PAUSED');
  }

  async resume(): Promise<void> {
    if (this.status === 'PAUSED') await this.setStatus('ACTIVE');
  }

  async emergencyStop(): Promise<void> {
    this.isDestroyed = true;
    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
      const positions = await this.executionProvider.getPositions(this.symbol);
      for (const pos of positions) {
        const qty = new Decimal(pos.quantity).abs().toFixed();
        await this.executionProvider.closePosition(
          this.symbol,
          pos.side as 'LONG' | 'SHORT',
          qty,
        );
      }
    } catch (err) {
      log.error(`Emergency stop partial failure for ${this.symbol}`, { error: String(err) });
    }
    await this.setStatus('FAILED');
  }

  private updateUnrealizedPnl(): void {
    if (this.shortEntryPrice == null || this.shortQuantity == null) return;

    let total = calcShortUnrealizedPnl(this.shortEntryPrice, this.markPrice, this.shortQuantity);

    for (const level of this.hedgeLevels) {
      if (level.status === 'OPEN') {
        total = total.plus(
          calcLongUnrealizedPnl(level.entryPrice, this.markPrice, level.quantity),
        );
      }
    }

    this.unrealizedPnl = total;
  }

  private emitPnlUpdate(): void {
    const realized = this.realizedPnl.toFixed(8);
    const unrealized = this.unrealizedPnl.toFixed(8);
    this.emit('traderEvent', {
      type: 'PNL_UPDATE',
      traderId: this.id,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
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
    const activeHedge = this.hedgeLevels.find(
      (h) => h.status === 'TRIGGERED' || h.status === 'OPEN' || h.status === 'PENDING',
    );

    await this.db.trader.update({
      where: { id: this.id },
      data: {
        shortEntryPrice: this.shortEntryPrice,
        shortTpPrice: this.shortTpPrice,
        currentHedgeLevel: this.currentHedgeLevel,
        // Persist actual short qty in positionSize (sizing is equity-driven; field reused for recovery)
        positionSize: this.shortQuantity ?? this.traderConfig.positionSize,
        hedgeEntryPrice: activeHedge?.entryPrice ?? null,
        hedgeTpPrice: activeHedge?.tpPrice ?? null,
        hedgeStopPrice: activeHedge?.stopPrice ?? null,
        realizedPnl: this.realizedPnl.toFixed(8),
        unrealizedPnl: this.unrealizedPnl.toFixed(8),
      },
    });
  }

  private async placeValidated(req: import('../../types').OrderRequest): Promise<import('../../types').OrderResult> {
    if (this.symbolInfo == null) throw new Error('Symbol info not loaded');
    const available = this.accountLedger.getBalance().toFixed();
    // Release before validate so withRetry can re-attempt the same clientOrderId
    this.riskManager.releaseOrder(req.clientOrderId);
    this.riskManager.validateOrder(req, this.symbolInfo, available);
    const result = await this.executionProvider.placeOrder(req);
    this.riskManager.trackOpenOrder(req.clientOrderId);
    return result;
  }

  private async persistOrder(
    result: import('../../types').OrderResult,
    role: import('../../types').HedgeRole,
    hedgeLevel: number,
  ): Promise<void> {
    this.orderViews.set(result.clientOrderId, {
      clientOrderId: result.clientOrderId,
      role,
      type: result.type,
      status: result.status,
      side: result.side,
      price: result.price,
      stopPrice: result.stopPrice,
      hedgeLevel,
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
        hedgeLevel,
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

  private touchOrderView(
    clientOrderId: string,
    patch: Partial<{ status: import('../../types').OrderStatus; quantity: string }>,
  ): void {
    const prev = this.orderViews.get(clientOrderId);
    if (prev == null) return;
    this.orderViews.set(clientOrderId, { ...prev, ...patch });
  }

  private async upsertPosition(
    side: 'LONG' | 'SHORT',
    role: import('../../types').HedgeRole,
    hedgeLevel: number,
    entryPrice: string,
    quantity: string,
    isOpen: boolean,
    realizedPnl = '0',
  ): Promise<void> {
    const existing = await this.db.position.findFirst({
      where: { traderId: this.id, side, role, hedgeLevel, isOpen: true },
    });
    if (existing != null) {
      await this.db.position.update({
        where: { id: existing.id },
        data: {
          entryPrice,
          quantity,
          unrealizedPnl: isOpen ? this.unrealizedPnl.toFixed(8) : '0',
          realizedPnl,
          markPrice: this.markPrice,
          isOpen,
          closedAt: isOpen ? null : new Date(),
        },
      });
      return;
    }
    if (!isOpen) return;
    await this.db.position.create({
      data: {
        traderId: this.id,
        symbol: this.symbol,
        side,
        role,
        hedgeLevel,
        entryPrice,
        quantity,
        leverage: this.traderConfig.leverage,
        unrealizedPnl: '0',
        realizedPnl: '0',
        markPrice: this.markPrice,
        isOpen: true,
      },
    });
  }

  private async persistTrade(
    update: OrderUpdate,
    role: import('../../types').HedgeRole,
    hedgeLevel: number,
    realizedPnl: string,
  ): Promise<void> {
    const view = this.orderViews.get(update.clientOrderId);
    const side = view?.side ?? (role === 'SHORT' && update.clientOrderId === this.shortClientOrderId ? 'SELL' : 'BUY');
    const orderRow = await this.db.order.findUnique({ where: { clientOrderId: update.clientOrderId } });
    await this.db.trade.create({
      data: {
        traderId: this.id,
        orderId: orderRow?.id ?? update.clientOrderId,
        symbol: this.symbol,
        side,
        role,
        hedgeLevel,
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
    const completedAt = new Date();

    await this.db.traderStatistics.upsert({
      where: { traderId: this.id },
      update: {
        shortExitPrice: this.shortTpPrice,
        totalHedgeLevels: this.currentHedgeLevel,
        hedgeWins: this.hedgeLevels.filter((h) => h.status === 'HIT_TP').length,
        hedgeLosses: this.hedgeLevels.filter((h) => h.status === 'HIT_SL').length,
        realizedPnl: this.realizedPnl.toFixed(8),
        durationMs: BigInt(0),
      },
      create: {
        traderId: this.id,
        symbol: this.symbol,
        mode: this.mode,
        shortEntryPrice: this.shortEntryPrice ?? '0',
        shortExitPrice: this.shortTpPrice,
        totalHedgeLevels: this.currentHedgeLevel,
        hedgeWins: this.hedgeLevels.filter((h) => h.status === 'HIT_TP').length,
        hedgeLosses: this.hedgeLevels.filter((h) => h.status === 'HIT_SL').length,
        realizedPnl: this.realizedPnl.toFixed(8),
        durationMs: BigInt(0),
      },
    });

    await this.db.trader.update({
      where: { id: this.id },
      data: { completedAt, realizedPnl: this.realizedPnl.toFixed(8) },
    });
  }

  toSummary(): TraderSummaryView {
    let shortUnrealized = new Decimal(0);
    if (this.shortEntryPrice != null && this.shortQuantity != null) {
      shortUnrealized = calcShortUnrealizedPnl(this.shortEntryPrice, this.markPrice, this.shortQuantity);
    }
    let hedgeUnrealized = new Decimal(0);
    for (const level of this.hedgeLevels) {
      if (level.status === 'OPEN') {
        hedgeUnrealized = hedgeUnrealized.plus(
          calcLongUnrealizedPnl(level.entryPrice, this.markPrice, level.quantity),
        );
      }
    }

    const orderList = [...this.orderViews.values()];
    const openStatuses = new Set(['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED']);
    const openOrders = orderList.filter((o) => openStatuses.has(o.status)).length;
    const closedOrders = orderList.filter((o) => !openStatuses.has(o.status)).length;
    const pendingOrders = this.hedgeLevels.filter((h) => h.status === 'PENDING' || h.status === 'TRIGGERED').length
      + (this.shortTpClientOrderId != null && this.status === 'ACTIVE' && this.pendingOrders.has(this.shortTpClientOrderId) ? 1 : 0);

    let distanceToTpPct: string | null = null;
    let distanceToTpAbs: string | null = null;
    if (this.shortTpPrice != null && this.markPrice !== '0') {
      const mark = new Decimal(this.markPrice);
      const tp = new Decimal(this.shortTpPrice);
      const abs = mark.minus(tp);
      distanceToTpAbs = abs.toFixed(8);
      if (this.shortEntryPrice != null) {
        distanceToTpPct = abs.div(this.shortEntryPrice).mul(100).toFixed(4);
      }
    }

    const hedgeLosses = this.hedgeLevels.filter((h) => h.status === 'HIT_SL').length;
    const totalPnl = this.realizedPnl.plus(this.unrealizedPnl);

    // Attach live entry-order status from order book (SSOT for ladder/orders consistency)
    const hedgeLevels = this.hedgeLevels.map((h) => {
      const entryOrder = [...this.orderViews.values()].find(
        (o) => o.role === 'HEDGE' && o.hedgeLevel === h.level && o.type === 'STOP_LIMIT',
      );
      return {
        ...h,
        previousLevelPrice: h.previousLevelPrice || h.stopPrice,
        stopPrice: h.previousLevelPrice || h.stopPrice,
        entryOrderStatus: entryOrder?.status ?? h.entryOrderStatus ?? null,
      };
    });

    return {
      id: this.id,
      symbol: this.symbol,
      status: this.status,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
      shortUnrealizedPnl: shortUnrealized.toFixed(8),
      hedgeUnrealizedPnl: hedgeUnrealized.toFixed(8),
      totalPnl: totalPnl.toFixed(8),
      hedgeLevel: this.currentHedgeLevel,
      hedgeLosses,
      hedgeWins: this.hedgeLevels.filter((h) => h.status === 'HIT_TP').length,
      hedgeRecreates: hedgeLosses,
      entryPrice: this.shortEntryPrice,
      tpPrice: this.shortTpPrice,
      shortSl: null,
      markPrice: this.markPrice,
      shortQuantity: this.shortQuantity,
      openOrders,
      pendingOrders,
      closedOrders,
      distanceToTpPct,
      distanceToTpAbs,
      orders: orderList,
      hedgeLevels,
    };
  }

  /** Structured lifecycle logs for end-to-end trader tracing. */
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
  getHedgeLevels(): HedgeLevel[] { return [...this.hedgeLevels]; }
  getCurrentHedgeLevel(): number { return this.currentHedgeLevel; }
  getShortEntryPrice(): string | null { return this.shortEntryPrice; }
  getShortTpPrice(): string | null { return this.shortTpPrice; }
  getMarkPrice(): string { return this.markPrice; }
  getShortQuantity(): string | null { return this.shortQuantity; }
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }

  generateClientOrderId(prefix: string): string {
    return `${prefix}_${this.id.slice(0, 8)}_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
  }
}
