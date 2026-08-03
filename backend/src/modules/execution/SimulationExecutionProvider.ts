import { EventEmitter } from 'events';
import Decimal from 'decimal.js';
import type { IExecutionProvider } from './IExecutionProvider';
import type {
  OrderRequest,
  OrderResult,
  CancelOrderRequest,
  PositionInfo,
  SymbolInfo,
  OrderStatus,
  OrderUpdate,
} from '../../types';
import { createContextLogger } from '../logger';
import { sleep } from '../utils/retry';
import { calcFee, adjustPrice, adjustQuantity } from '../utils/precision';
import { config } from '../../config';

const log = createContextLogger('SimulationExecutionProvider');

/**
 * Binance-aligned conditional order phase:
 * PENDING   — waiting for stopPrice (not in book yet)
 * TRIGGERED — stop hit; LIMIT is active (STOP) or market fill imminent
 * FILLED / CANCELED / REJECTED — terminal
 */
type SimPhase = 'PENDING' | 'TRIGGERED' | 'FILLED' | 'CANCELED' | 'REJECTED';

interface SimOrder {
  req: OrderRequest;
  result: OrderResult;
  phase: SimPhase;
  /** Remaining qty for partial fills */
  remainingQty: string;
}

interface SimPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: string;
  quantity: string;
  leverage: number;
  notional: string;
}

/**
 * Binance Futures execution simulator.
 * Consumes REAL mark prices; only fills are simulated.
 *
 * STOP (STOP_LIMIT): stop → then LIMIT waits for executable price (NOT instant fill).
 * STOP_MARKET / TAKE_PROFIT_MARKET: stop → immediate MARKET with slippage.
 * TAKE_PROFIT: stop → then LIMIT at price.
 * MARKET: immediate fill with slippage + fee.
 *
 * Trigger rules (workingType = MARK_PRICE), per Binance docs:
 * STOP / STOP_MARKET:     BUY mark>=stop, SELL mark<=stop
 * TAKE_PROFIT / TP_MARKET: BUY mark<=stop, SELL mark>=stop
 * LIMIT BUY fills when mark <= price; LIMIT SELL when mark >= price
 */
export class SimulationExecutionProvider extends EventEmitter implements IExecutionProvider {
  readonly isSimulation = true;
  private hedgeMode = true;
  private orders = new Map<string, SimOrder>();
  private positions = new Map<string, SimPosition[]>();
  private symbolInfoCache = new Map<string, SymbolInfo>();
  private markPrices = new Map<string, string>();
  private readonly simLatencyMs = 40;
  /** When true, ~25% of fills go PARTIAL then complete (tests can disable). */
  enablePartialFills = true;
  /** If set (0–1), next fill uses this fraction then clears (for tests). */
  forcePartialFraction: number | null = null;

  constructor(
    private readonly exchangeInfoProvider: () => Promise<SymbolInfo[]>,
    private readonly restMarkPriceFetcher?: (symbol: string) => Promise<string>,
  ) {
    super();
  }

  get hedgeModeEnabled(): boolean {
    return this.hedgeMode;
  }

  async setHedgeMode(enabled: boolean): Promise<void> {
    this.hedgeMode = enabled;
    await sleep(5);
  }

  /** Event-driven: every mark tick evaluates the pending/triggered book. */
  onPriceUpdate(symbol: string, price: string): void {
    this.markPrices.set(symbol, price);
    this.evaluateBook(symbol, price);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    await sleep(this.simLatencyMs + Math.random() * 40);

    const symbolInfo = await this.getSymbolInfo(req.symbol);
    const adjustedQty = adjustQuantity(req.quantity, symbolInfo);
    const normalized: OrderRequest = {
      ...req,
      quantity: adjustedQty,
      price: req.price != null ? adjustPrice(req.price, symbolInfo) : undefined,
      stopPrice: req.stopPrice != null ? adjustPrice(req.stopPrice, symbolInfo) : undefined,
    };

    const exchangeOrderId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const baseResult: OrderResult = {
      clientOrderId: normalized.clientOrderId,
      exchangeOrderId,
      symbol: normalized.symbol,
      side: normalized.side,
      type: normalized.type,
      status: 'PENDING',
      quantity: adjustedQty,
      price: normalized.price ?? null,
      stopPrice: normalized.stopPrice ?? null,
      filledQuantity: '0',
      avgFillPrice: null,
      fee: '0',
      feeCurrency: 'USDT',
      createdAt: new Date(),
      filledAt: null,
    };

    if (normalized.type === 'MARKET') {
      const mark = this.requireMark(normalized.symbol, normalized.price);
      const fillPrice = this.applySlippage(mark, normalized.side, symbolInfo);
      const order: SimOrder = {
        req: normalized,
        result: baseResult,
        phase: 'TRIGGERED',
        remainingQty: adjustedQty,
      };
      this.orders.set(normalized.clientOrderId, order);
      this.finalizeFill(normalized.clientOrderId, order, fillPrice, symbolInfo);
      return { ...order.result };
    }

    // Conditional / limit — enter PENDING (or NEW for plain LIMIT)
    const isPlainLimit = normalized.type === 'LIMIT';
    const order: SimOrder = {
      req: normalized,
      result: {
        ...baseResult,
        status: isPlainLimit ? 'NEW' : 'PENDING',
      },
      phase: isPlainLimit ? 'TRIGGERED' : 'PENDING',
      remainingQty: adjustedQty,
    };
    this.orders.set(normalized.clientOrderId, order);
    log.debug('Sim order accepted', {
      clientId: normalized.clientOrderId,
      type: normalized.type,
      phase: order.phase,
      stop: normalized.stopPrice,
      price: normalized.price,
    });

    // Evaluate immediately against current mark (gap / already-through)
    const mark = this.markPrices.get(normalized.symbol);
    if (mark != null) this.evaluateBook(normalized.symbol, mark);

    return { ...order.result };
  }

  async cancelOrder(req: CancelOrderRequest): Promise<void> {
    await sleep(this.simLatencyMs);
    const order = this.orders.get(req.clientOrderId);
    if (order == null || order.phase === 'FILLED' || order.phase === 'CANCELED') return;
    order.phase = 'CANCELED';
    order.result.status = 'CANCELED';
    this.emitOrderUpdate(order.result);
    log.debug('Sim order cancelled', { clientId: req.clientOrderId });
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await sleep(this.simLatencyMs);
    for (const [, order] of this.orders) {
      if (order.req.symbol === symbol && (order.phase === 'PENDING' || order.phase === 'TRIGGERED')) {
        order.phase = 'CANCELED';
        order.result.status = 'CANCELED';
        this.emitOrderUpdate(order.result);
      }
    }
  }

  async getPositions(symbol: string): Promise<PositionInfo[]> {
    const positions = this.positions.get(symbol) ?? [];
    const markPrice = this.markPrices.get(symbol) ?? '0';
    return positions.map((p) => {
      const pnl = p.side === 'LONG'
        ? new Decimal(markPrice).minus(p.entryPrice).mul(p.quantity).toFixed(8)
        : new Decimal(p.entryPrice).minus(markPrice).mul(p.quantity).toFixed(8);
      return {
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        quantity: p.quantity,
        unrealizedPnl: pnl,
        leverage: p.leverage,
        liquidationPrice: '0',
        markPrice,
      };
    });
  }

  getOpenNotionals(): string[] {
    const out: string[] = [];
    for (const positions of this.positions.values()) {
      for (const p of positions) out.push(p.notional);
    }
    return out;
  }

  getPendingOrders(symbol?: string): OrderResult[] {
    return [...this.orders.values()]
      .filter((o) => (symbol == null || o.req.symbol === symbol) && (o.phase === 'PENDING' || o.phase === 'TRIGGERED'))
      .map((o) => ({ ...o.result }));
  }

  async closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult> {
    return this.placeOrder({
      traderId: '',
      clientOrderId: `simclose_${symbol}_${Date.now()}`,
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      role: side === 'LONG' ? 'HEDGE' : 'SHORT',
      hedgeLevel: 0,
      quantity,
      positionSide: this.hedgeMode ? side : 'BOTH',
      reduceOnly: !this.hedgeMode,
    });
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {
    await sleep(5);
  }

  async setMarginMode(_symbol: string, _marginMode: string): Promise<void> {
    await sleep(5);
  }

  async getMarkPrice(symbol: string): Promise<string> {
    const cached = this.markPrices.get(symbol);
    if (cached != null) return cached;
    if (this.restMarkPriceFetcher == null) throw new Error(`No mark price for ${symbol}`);
    const price = await this.restMarkPriceFetcher(symbol);
    this.markPrices.set(symbol, price);
    return price;
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    if (this.symbolInfoCache.has(symbol)) return this.symbolInfoCache.get(symbol)!;
    const infos = await this.exchangeInfoProvider();
    for (const info of infos) this.symbolInfoCache.set(info.symbol, info);
    const found = this.symbolInfoCache.get(symbol);
    if (found == null) throw new Error(`Symbol ${symbol} not found`);
    return found;
  }

  // ── Book evaluation (event-driven) ───────────────────────────────────────

  private evaluateBook(symbol: string, markPrice: string): void {
    const mark = new Decimal(markPrice);

    for (const [clientId, order] of this.orders) {
      if (order.req.symbol !== symbol) continue;
      if (order.phase === 'FILLED' || order.phase === 'CANCELED' || order.phase === 'REJECTED') continue;

      const { type, side, price, stopPrice } = order.req;

      // Phase 1: PENDING → TRIGGERED when stop condition met
      if (order.phase === 'PENDING' && stopPrice != null) {
        if (this.isStopTriggered(type, side, mark, new Decimal(stopPrice))) {
          if (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET') {
            // Immediate market execution
            const symbolInfo = this.symbolInfoCache.get(symbol);
            if (symbolInfo == null) continue;
            const fillPrice = this.applySlippage(markPrice, side, symbolInfo);
            this.finalizeFill(clientId, order, fillPrice, symbolInfo);
            continue;
          }

          // STOP_LIMIT (STOP) / TAKE_PROFIT → activate limit, do NOT fill yet
          order.phase = 'TRIGGERED';
          order.result.status = 'TRIGGERED';
          this.emitOrderUpdate(order.result);
          log.debug('Sim order TRIGGERED (limit now active)', {
            clientId,
            type,
            stop: stopPrice,
            limit: price,
            mark: markPrice,
          });
        }
      }

      // Phase 2: TRIGGERED limit — wait until limit is executable
      if (order.phase === 'TRIGGERED') {
        const limitPrice = price ?? stopPrice;
        if (limitPrice == null) continue;
        if (this.isLimitExecutable(side, mark, new Decimal(limitPrice))) {
          const symbolInfo = this.symbolInfoCache.get(symbol);
          if (symbolInfo == null) continue;
          // Fill at limit (price improvement: BUY min(mark,limit), SELL max)
          const fillAt = side === 'BUY'
            ? Decimal.min(mark, new Decimal(limitPrice)).toFixed()
            : Decimal.max(mark, new Decimal(limitPrice)).toFixed();
          this.finalizeFill(clientId, order, fillAt, symbolInfo);
        }
      }
    }
  }

  /** Binance STOP / STOP_MARKET vs TAKE_PROFIT / TAKE_PROFIT_MARKET trigger. */
  private isStopTriggered(type: OrderRequest['type'], side: OrderRequest['side'], mark: Decimal, stop: Decimal): boolean {
    const isTakeProfit = type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET';
    if (isTakeProfit) {
      // BUY TP: mark <= stop; SELL TP: mark >= stop
      return side === 'BUY' ? mark.lte(stop) : mark.gte(stop);
    }
    // STOP / STOP_LIMIT / STOP_MARKET: BUY mark >= stop; SELL mark <= stop
    return side === 'BUY' ? mark.gte(stop) : mark.lte(stop);
  }

  private isLimitExecutable(side: OrderRequest['side'], mark: Decimal, limit: Decimal): boolean {
    return side === 'BUY' ? mark.lte(limit) : mark.gte(limit);
  }

  private finalizeFill(clientId: string, order: SimOrder, fillPrice: string, symbolInfo: SymbolInfo): void {
    const remaining = new Decimal(order.remainingQty);
    if (remaining.lte(0)) return;

    // Partial fill: leave remainder for next tick
    let fillFraction: number | null = null;
    if (this.forcePartialFraction != null && remaining.gt(symbolInfo.minQty)) {
      fillFraction = this.forcePartialFraction;
      this.forcePartialFraction = null;
    } else if (
      this.enablePartialFills &&
      remaining.gt(symbolInfo.minQty) &&
      Math.random() < 0.25
    ) {
      fillFraction = 0.5;
    }

    let fillQty = remaining;
    if (fillFraction != null) {
      fillQty = remaining.mul(fillFraction);
      fillQty = new Decimal(adjustQuantity(fillQty.toFixed(), symbolInfo));
      if (fillQty.lte(0) || fillQty.gte(remaining)) fillQty = remaining;
    }

    const prevFilled = new Decimal(order.result.filledQuantity || '0');
    const newFilledTotal = prevFilled.plus(fillQty);
    const fee = calcFee(fillPrice, fillQty.toFixed(), config.trading.feeRate);
    const prevFee = new Decimal(order.result.fee || '0');
    const avgPx = new Decimal(fillPrice)
      .toDecimalPlaces(symbolInfo.pricePrecision)
      .toFixed(symbolInfo.pricePrecision);

    const isComplete = newFilledTotal.gte(new Decimal(order.req.quantity).mul('0.999'));
    const status: OrderStatus = isComplete ? 'FILLED' : 'PARTIALLY_FILLED';

    order.remainingQty = Decimal.max(new Decimal(0), remaining.minus(fillQty)).toFixed(symbolInfo.quantityPrecision);
    order.result = {
      ...order.result,
      status,
      filledQuantity: newFilledTotal.toFixed(symbolInfo.quantityPrecision),
      avgFillPrice: avgPx,
      fee: prevFee.plus(fee).toFixed(8),
      filledAt: isComplete ? new Date() : order.result.filledAt,
    };
    order.phase = isComplete ? 'FILLED' : 'TRIGGERED';

    this.updatePosition(
      order.req.symbol,
      order.req.side === 'BUY' ? 'LONG' : 'SHORT',
      avgPx,
      fillQty.toFixed(symbolInfo.quantityPrecision),
      order.req.reduceOnly ?? false,
      order.req.positionSide,
    );

    log.debug(`Sim order ${status}`, {
      clientId,
      fillPrice,
      fillQty: fillQty.toFixed(),
      remaining: order.remainingQty,
      type: order.req.type,
    });

    setTimeout(() => this.emitOrderUpdate({ ...order.result }), this.simLatencyMs);

    // Complete remainder shortly after (liquidity catches up)
    if (!isComplete) {
      setTimeout(() => {
        if (order.phase !== 'FILLED' && order.phase !== 'CANCELED') {
          this.finalizeFill(clientId, order, fillPrice, symbolInfo);
        }
      }, this.simLatencyMs + 80);
    }
  }

  private applySlippage(markPrice: string, side: OrderRequest['side'], symbolInfo: SymbolInfo): string {
    const slip = new Decimal(config.trading.slippage);
    const mark = new Decimal(markPrice);
    const raw = side === 'BUY'
      ? mark.mul(new Decimal(1).plus(slip))
      : mark.mul(new Decimal(1).minus(slip));
    return raw.toDecimalPlaces(symbolInfo.pricePrecision, Decimal.ROUND_HALF_UP).toFixed(symbolInfo.pricePrecision);
  }

  private requireMark(symbol: string, fallback?: string): string {
    const mark = this.markPrices.get(symbol) ?? fallback;
    if (mark == null) throw new Error(`No mark price for ${symbol}`);
    return mark;
  }

  private emitOrderUpdate(result: OrderResult): void {
    this.emit('orderFill', result);
    const update: OrderUpdate = {
      clientOrderId: result.clientOrderId,
      exchangeOrderId: result.exchangeOrderId,
      symbol: result.symbol,
      status: result.status,
      filledQuantity: result.filledQuantity,
      avgFillPrice: result.avgFillPrice,
      fee: result.fee,
      feeCurrency: result.feeCurrency,
      timestamp: Date.now(),
    };
    this.emit('orderUpdate', update);
  }

  private updatePosition(
    symbol: string,
    orderSide: 'LONG' | 'SHORT',
    fillPrice: string,
    quantity: string,
    reduceOnly: boolean,
    positionSide?: 'LONG' | 'SHORT' | 'BOTH',
  ): void {
    const positions = this.positions.get(symbol) ?? [];

    // Hedge mode: positionSide identifies the leg; BUY/SELL increases or decreases it
    if (this.hedgeMode && (positionSide === 'LONG' || positionSide === 'SHORT')) {
      const isIncrease =
        (positionSide === 'LONG' && orderSide === 'LONG') ||
        (positionSide === 'SHORT' && orderSide === 'SHORT');
      const existing = positions.find((p) => p.side === positionSide);
      if (isIncrease) {
        if (existing != null) {
          const totalQty = new Decimal(existing.quantity).plus(quantity);
          const avgEntry = new Decimal(existing.entryPrice)
            .mul(existing.quantity)
            .plus(new Decimal(fillPrice).mul(quantity))
            .div(totalQty);
          existing.quantity = totalQty.toFixed(8);
          existing.entryPrice = avgEntry.toFixed(8);
          existing.notional = totalQty.mul(avgEntry).toFixed(8);
        } else {
          positions.push({
            symbol,
            side: positionSide,
            entryPrice: fillPrice,
            quantity,
            leverage: config.trading.leverage,
            notional: new Decimal(fillPrice).mul(quantity).toFixed(8),
          });
        }
      } else if (existing != null) {
        const newQty = new Decimal(existing.quantity).minus(quantity);
        if (newQty.lte(0)) {
          const idx = positions.indexOf(existing);
          positions.splice(idx, 1);
        } else {
          existing.quantity = newQty.toFixed(8);
          existing.notional = newQty.mul(existing.entryPrice).toFixed(8);
        }
      }
      this.positions.set(symbol, positions);
      return;
    }

    if (reduceOnly) {
      const closeSide: 'LONG' | 'SHORT' = orderSide === 'LONG' ? 'SHORT' : 'LONG';
      const idx = positions.findIndex((p) => p.side === closeSide);
      if (idx >= 0) {
        const pos = positions[idx]!;
        const newQty = new Decimal(pos.quantity).minus(quantity);
        if (newQty.lte(0)) positions.splice(idx, 1);
        else {
          pos.quantity = newQty.toFixed(8);
          pos.notional = newQty.mul(pos.entryPrice).toFixed(8);
        }
      }
    } else {
      const existing = positions.find((p) => p.side === orderSide);
      if (existing != null) {
        const totalQty = new Decimal(existing.quantity).plus(quantity);
        const avgEntry = new Decimal(existing.entryPrice)
          .mul(existing.quantity)
          .plus(new Decimal(fillPrice).mul(quantity))
          .div(totalQty);
        existing.quantity = totalQty.toFixed(8);
        existing.entryPrice = avgEntry.toFixed(8);
        existing.notional = totalQty.mul(avgEntry).toFixed(8);
      } else {
        positions.push({
          symbol,
          side: orderSide,
          entryPrice: fillPrice,
          quantity,
          leverage: config.trading.leverage,
          notional: new Decimal(fillPrice).mul(quantity).toFixed(8),
        });
      }
    }

    this.positions.set(symbol, positions);
  }
}
