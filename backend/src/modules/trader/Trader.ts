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
} from '../../types';
import {
  calcShortTp,
  calcHedgeEntry,
  calcHedgeTp,
  calcNextHedgeEntry,
  calcFee,
  adjustPrice,
  adjustQuantity,
  validateNotional,
} from '../utils/precision';
import { createContextLogger } from '../logger';
import { withRetry } from '../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('Trader');

export type TraderEvent =
  | { type: 'STATUS_CHANGED'; traderId: string; status: TraderStatus }
  | { type: 'COMPLETED'; traderId: string; symbol: string }
  | { type: 'FAILED'; traderId: string; symbol: string; error: string }
  | { type: 'PNL_UPDATE'; traderId: string; realizedPnl: string; unrealizedPnl: string };

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
  private pendingOrders = new Set<string>();
  // tracks tpClientId/slClientId per hedge level to cancel counterpart when one fires
  private hedgeOrderIds = new Map<number, { tpClientId: string; slClientId: string }>();

  constructor(
    private readonly traderId: string,
    symbol: string,
    mode: TraderMode,
    private readonly executionProvider: IExecutionProvider,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
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
      () => this.executionProvider.setLeverage(this.symbol, this.traderConfig.leverage),
      { maxAttempts: 3, delayMs: 1000 },
    );

    await withRetry(
      () => this.executionProvider.setMarginMode(this.symbol, this.traderConfig.marginMode),
      { maxAttempts: 3, delayMs: 1000 },
    );

    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);

    await this.openShort();
    await this.setStatus('ACTIVE');
    log.info(`Trader ${this.id} initialized for ${this.symbol} at entry ${this.shortEntryPrice ?? '?'}`);
  }

  /** Restore a trader from persisted state (called on restart). */
  async restore(state: {
    shortEntryPrice: string | null;
    shortTpPrice: string | null;
    currentHedgeLevel: number;
    hedgeLevels: HedgeLevel[];
    status: TraderStatus;
    realizedPnl: string;
    unrealizedPnl: string;
  }): Promise<void> {
    this.shortEntryPrice = state.shortEntryPrice;
    this.shortTpPrice = state.shortTpPrice;
    this.currentHedgeLevel = state.currentHedgeLevel;
    this.hedgeLevels = state.hedgeLevels;
    this.status = state.status;
    this.realizedPnl = new Decimal(state.realizedPnl);
    this.unrealizedPnl = new Decimal(state.unrealizedPnl);
    this.symbolInfo = await this.executionProvider.getSymbolInfo(this.symbol);
    this.markPrice = await this.executionProvider.getMarkPrice(this.symbol);
    log.info(`Trader ${this.id} restored for ${this.symbol}`);
  }

  onPriceUpdate(price: string): void {
    if (this.isDestroyed || this.status !== 'ACTIVE') return;
    this.markPrice = price;
    this.updateUnrealizedPnl();
  }

  async onOrderUpdate(update: OrderUpdate): Promise<void> {
    if (this.isDestroyed) return;
    if (!this.pendingOrders.has(update.clientOrderId)) return;

    log.debug(`Order update for trader ${this.id}`, {
      clientId: update.clientOrderId,
      status: update.status,
      filledQty: update.filledQuantity,
    });

    if (update.status !== 'FILLED' && update.status !== 'PARTIALLY_FILLED') return;

    if (update.clientOrderId === this.shortClientOrderId) {
      await this.onShortFilled(update);
    } else if (update.clientOrderId === this.shortTpClientOrderId) {
      await this.onShortTpFilled(update);
    } else if (update.clientOrderId === this.activeHedgeClientOrderId) {
      await this.onHedgeFilled(update);
    } else {
      // Route hedge TP and SL fills via the tracked order ID map
      for (const [level, ids] of this.hedgeOrderIds) {
        if (update.clientOrderId === ids.tpClientId) {
          const hl = this.hedgeLevels.find((h) => h.level === level);
          if (hl != null) await this.onHedgeTpFilled(hl, update);
          break;
        }
        if (update.clientOrderId === ids.slClientId) {
          const hl = this.hedgeLevels.find((h) => h.level === level);
          if (hl != null) await this.onHedgeStopLossHit(hl, update);
          break;
        }
      }
    }
  }

  private async openShort(): Promise<void> {
    if (this.symbolInfo == null) throw new Error('Symbol info not loaded');

    const markPriceDecimal = new Decimal(this.markPrice);
    if (markPriceDecimal.isZero() || markPriceDecimal.isNaN() || markPriceDecimal.isNeg()) {
      throw new Error(`Cannot open short: invalid mark price '${this.markPrice}' for ${this.symbol}`);
    }

    const qty = adjustQuantity(
      new Decimal(this.traderConfig.positionSize)
        .div(this.markPrice)
        .toFixed(this.symbolInfo.quantityPrecision),
      this.symbolInfo,
    );

    validateNotional(this.markPrice, qty, this.symbolInfo);

    const clientOrderId = `short_${this.id}_${Date.now()}`;
    this.shortClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    const result = await withRetry(
      () =>
        this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'MARKET',
          role: 'SHORT',
          hedgeLevel: 0,
          quantity: qty,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    this.shortQuantity = result.quantity;

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

    await this.persistOrder(result, 'SHORT', 0);
    log.info(`Short opened for ${this.symbol}`, { clientId: clientOrderId, qty });
  }

  private async onShortFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;

    this.shortEntryPrice = update.avgFillPrice;
    // Deduct opening fee immediately — fee is a real cost paid on execution
    this.realizedPnl = this.realizedPnl.minus(
      calcFee(this.shortEntryPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate),
    );
    const shortTp = calcShortTp(this.shortEntryPrice, this.traderConfig.shortTpPercent);
    this.shortTpPrice = adjustPrice(shortTp, this.symbolInfo!);

    await this.persistTraderState();
    await this.placeShortTp();
    await this.placeInitialHedge();
  }

  private async placeShortTp(): Promise<void> {
    if (this.symbolInfo == null || this.shortEntryPrice == null || this.shortQuantity == null) return;

    const clientOrderId = `short_tp_${this.id}_${Date.now()}`;
    this.shortTpClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    const result = await withRetry(
      () =>
        this.executionProvider.placeOrder({
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
          reduceOnly: true,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    await this.persistOrder(result, 'SHORT', 0);
    log.info(`Short TP placed for ${this.symbol}`, { tp: this.shortTpPrice });
  }

  private async placeInitialHedge(): Promise<void> {
    if (this.symbolInfo == null || this.shortEntryPrice == null || this.shortQuantity == null) return;

    const hedgeEntry = calcHedgeEntry(this.shortEntryPrice, this.traderConfig.hedgeDistance);
    const hedgeTp = calcHedgeTp(hedgeEntry.toFixed(), this.traderConfig.hedgeTpPercent);
    const hedgeStop = new Decimal(this.shortEntryPrice);

    const hedgeLevel: HedgeLevel = {
      level: 1,
      entryPrice: adjustPrice(hedgeEntry, this.symbolInfo),
      stopPrice: adjustPrice(hedgeStop, this.symbolInfo),
      tpPrice: adjustPrice(hedgeTp, this.symbolInfo),
      status: 'PENDING',
    };

    this.hedgeLevels.push(hedgeLevel);
    this.currentHedgeLevel = 1;

    await this.placeHedgeOrder(hedgeLevel);
  }

  private async placeHedgeOrder(hedgeLevel: HedgeLevel): Promise<void> {
    if (this.symbolInfo == null || this.shortQuantity == null) return;

    const clientOrderId = `hedge_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.activeHedgeClientOrderId = clientOrderId;
    this.pendingOrders.add(clientOrderId);

    const result = await withRetry(
      () =>
        this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId,
          symbol: this.symbol,
          side: 'BUY',
          type: 'STOP_LIMIT',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: this.shortQuantity!,
          price: hedgeLevel.entryPrice,
          // trigger at entryPrice, NOT stopPrice — stopPrice is used only as the SL exit
          stopPrice: hedgeLevel.entryPrice,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    hedgeLevel.status = 'ACTIVE'; // order is live in exchange, position not yet open
    await this.persistOrder(result, 'HEDGE', hedgeLevel.level);
    await this.persistTraderState();

    log.info(`Hedge L${hedgeLevel.level} placed for ${this.symbol}`, {
      entry: hedgeLevel.entryPrice,
      stop: hedgeLevel.stopPrice,
      tp: hedgeLevel.tpPrice,
    });
  }

  private async onHedgeFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;

    const hedgeLevel = this.hedgeLevels.find((h) => h.level === this.currentHedgeLevel);
    if (hedgeLevel == null) return;

    hedgeLevel.status = 'OPEN'; // position is now actually open
    // Deduct hedge opening fee
    this.realizedPnl = this.realizedPnl.minus(
      calcFee(update.avgFillPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate),
    );

    // Place hedge take profit
    const tpClientId = `hedge_tp_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.pendingOrders.add(tpClientId);

    const result = await withRetry(
      () =>
        this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId: tpClientId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: this.shortQuantity!,
          price: hedgeLevel.tpPrice,
          stopPrice: hedgeLevel.tpPrice,
          reduceOnly: true,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    // Place hedge stop loss
    const slClientId = `hedge_sl_${this.id}_lvl${hedgeLevel.level}_${Date.now()}`;
    this.pendingOrders.add(slClientId);

    await withRetry(
      () =>
        this.executionProvider.placeOrder({
          traderId: this.id,
          clientOrderId: slClientId,
          symbol: this.symbol,
          side: 'SELL',
          type: 'STOP_MARKET',
          role: 'HEDGE',
          hedgeLevel: hedgeLevel.level,
          quantity: this.shortQuantity!,
          stopPrice: hedgeLevel.stopPrice,
          reduceOnly: true,
        }),
      { maxAttempts: this.traderConfig.retryLimit, delayMs: 500 },
    );

    // Track TP/SL pair so we can cancel the counterpart when one fires
    this.hedgeOrderIds.set(hedgeLevel.level, { tpClientId, slClientId });

    await this.persistOrder(result, 'HEDGE', hedgeLevel.level);
    await this.persistTraderState();

    log.info(`Hedge L${hedgeLevel.level} FILLED for ${this.symbol}`, { fillPrice: update.avgFillPrice });
  }

  private async onHedgeStopLossHit(hedgeLevel: HedgeLevel, update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    log.info(`Hedge L${hedgeLevel.level} SL hit for ${this.symbol} — recreating same hedge`);
    hedgeLevel.status = 'HIT_SL';

    // PnL: (exitPrice - entryPrice) * qty — negative since stopPrice < entryPrice
    // Close fee only; open fee was already subtracted when hedge filled
    const loss = new Decimal(update.avgFillPrice)
      .minus(hedgeLevel.entryPrice)
      .mul(this.shortQuantity ?? '0');
    const closeFee = calcFee(update.avgFillPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(loss).minus(closeFee);

    // Cancel the counterpart TP order
    const ids = this.hedgeOrderIds.get(hedgeLevel.level);
    if (ids != null) {
      try { await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: ids.tpClientId }); } catch { /* already gone */ }
      this.hedgeOrderIds.delete(hedgeLevel.level);
    }

    // Recreate exact same hedge
    const newLevel: HedgeLevel = {
      level: hedgeLevel.level,
      entryPrice: hedgeLevel.entryPrice,
      stopPrice: hedgeLevel.stopPrice,
      tpPrice: hedgeLevel.tpPrice,
      status: 'PENDING',
    };

    const idx = this.hedgeLevels.findIndex((h) => h.level === hedgeLevel.level);
    if (idx >= 0) this.hedgeLevels[idx] = newLevel;

    await this.placeHedgeOrder(newLevel);
    await this.emitPnlUpdate();
  }

  private async onHedgeTpFilled(hedgeLevel: HedgeLevel, update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    log.info(`Hedge L${hedgeLevel.level} TP hit for ${this.symbol} — creating next hedge`);
    hedgeLevel.status = 'HIT_TP';

    // PnL: close fee only; open fee already subtracted in onHedgeFilled
    const pnl = new Decimal(update.avgFillPrice)
      .minus(hedgeLevel.entryPrice)
      .mul(this.shortQuantity ?? '0');
    const closeFee = calcFee(update.avgFillPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(pnl).minus(closeFee);

    // Cancel the counterpart SL order
    const ids = this.hedgeOrderIds.get(hedgeLevel.level);
    if (ids != null) {
      try { await this.executionProvider.cancelOrder({ symbol: this.symbol, clientOrderId: ids.slClientId }); } catch { /* already gone */ }
      this.hedgeOrderIds.delete(hedgeLevel.level);
    }

    // Next hedge entry anchors to actual TP fill price
    const nextEntry = calcNextHedgeEntry(update.avgFillPrice, this.traderConfig.hedgeDistance);
    const nextTp = calcHedgeTp(nextEntry.toFixed(), this.traderConfig.hedgeTpPercent);

    const nextLevel: HedgeLevel = {
      level: hedgeLevel.level + 1,
      entryPrice: adjustPrice(nextEntry, this.symbolInfo!),
      stopPrice: update.avgFillPrice, // SL for next hedge = where this TP filled
      tpPrice: adjustPrice(nextTp, this.symbolInfo!),
      status: 'PENDING',
    };

    this.hedgeLevels.push(nextLevel);
    this.currentHedgeLevel = nextLevel.level;

    await this.placeHedgeOrder(nextLevel);
    await this.persistTraderState();
    await this.emitPnlUpdate();
  }

  private async onShortTpFilled(update: OrderUpdate): Promise<void> {
    if (update.avgFillPrice == null) return;
    log.info(`Short TP hit for ${this.symbol} — completing trader ${this.id}`);

    const pnl = new Decimal(this.shortEntryPrice ?? '0')
      .minus(update.avgFillPrice)
      .mul(this.shortQuantity ?? '0');
    const fee = calcFee(update.avgFillPrice, this.shortQuantity ?? '0', this.traderConfig.feeRate);
    this.realizedPnl = this.realizedPnl.plus(pnl).minus(fee);

    await this.complete();
  }

  private async complete(): Promise<void> {
    await this.setStatus('COMPLETING');

    // Cancel remaining hedge orders
    try {
      await this.executionProvider.cancelAllOrders(this.symbol);
    } catch (err) {
      log.warn(`Failed to cancel hedge orders for ${this.symbol}`, { error: String(err) });
    }

    // Close remaining positions
    try {
      const positions = await this.executionProvider.getPositions(this.symbol);
      for (const pos of positions) {
        await this.executionProvider.closePosition(this.symbol, pos.side as 'LONG' | 'SHORT', Math.abs(parseFloat(pos.quantity)).toString());
      }
    } catch (err) {
      log.warn(`Failed to close positions for ${this.symbol}`, { error: String(err) });
    }

    await this.persistFinalStatistics();
    await this.setStatus('COMPLETED');
    this.isDestroyed = true;

    this.emit('traderEvent', {
      type: 'COMPLETED',
      traderId: this.id,
      symbol: this.symbol,
    } satisfies TraderEvent);

    log.info(`Trader ${this.id} COMPLETED for ${this.symbol}`, {
      realizedPnl: this.realizedPnl.toFixed(4),
    });
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
        await this.executionProvider.closePosition(
          this.symbol,
          pos.side as 'LONG' | 'SHORT',
          Math.abs(parseFloat(pos.quantity)).toString(),
        );
      }
    } catch (err) {
      log.error(`Emergency stop partial failure for ${this.symbol}`, { error: String(err) });
    }
    await this.setStatus('FAILED');
  }

  private updateUnrealizedPnl(): void {
    if (this.shortEntryPrice == null || this.shortQuantity == null) return;
    const shortPnl = new Decimal(this.shortEntryPrice)
      .minus(this.markPrice)
      .mul(this.shortQuantity);

    // Only include hedge levels that are OPEN (STOP_LIMIT has actually filled)
    let hedgePnl = new Decimal(0);
    for (const level of this.hedgeLevels) {
      if (level.status === 'OPEN') {
        hedgePnl = hedgePnl.plus(
          new Decimal(this.markPrice).minus(level.entryPrice).mul(this.shortQuantity ?? '0'),
        );
      }
    }

    this.unrealizedPnl = shortPnl.plus(hedgePnl);
  }

  private async emitPnlUpdate(): Promise<void> {
    this.emit('traderEvent', {
      type: 'PNL_UPDATE',
      traderId: this.id,
      realizedPnl: this.realizedPnl.toFixed(8),
      unrealizedPnl: this.unrealizedPnl.toFixed(8),
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
  }

  private async persistTraderState(): Promise<void> {
    await this.db.trader.update({
      where: { id: this.id },
      data: {
        shortEntryPrice: this.shortEntryPrice,
        shortTpPrice: this.shortTpPrice,
        currentHedgeLevel: this.currentHedgeLevel,
        realizedPnl: this.realizedPnl.toFixed(8),
        unrealizedPnl: this.unrealizedPnl.toFixed(8),
      },
    });
  }

  private async persistOrder(
    result: import('../../types').OrderResult,
    role: import('../../types').HedgeRole,
    hedgeLevel: number,
  ): Promise<void> {
    await this.db.order.upsert({
      where: { clientOrderId: result.clientOrderId },
      update: {
        exchangeOrderId: result.exchangeOrderId,
        status: result.status,
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

  private async persistFinalStatistics(): Promise<void> {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - new Date().getTime();

    await this.db.traderStatistics.upsert({
      where: { traderId: this.id },
      update: {
        shortExitPrice: this.shortTpPrice,
        totalHedgeLevels: this.currentHedgeLevel,
        hedgeWins: this.hedgeLevels.filter((h) => h.status === 'HIT_TP').length,
        hedgeLosses: this.hedgeLevels.filter((h) => h.status === 'HIT_SL').length,
        realizedPnl: this.realizedPnl.toFixed(8),
        durationMs: BigInt(Math.max(0, durationMs)),
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
  isActive(): boolean { return this.status === 'ACTIVE' && !this.isDestroyed; }

  generateClientOrderId(prefix: string): string {
    return `${prefix}_${this.id.slice(0, 8)}_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
  }
}
