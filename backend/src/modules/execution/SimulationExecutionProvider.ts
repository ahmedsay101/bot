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

interface SimOrder {
  req: OrderRequest;
  result: OrderResult;
  isOpen: boolean;
}

interface SimPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: string;
  quantity: string;
  leverage: number;
}

/**
 * Simulates Binance Futures execution using real mark prices from WebSocket.
 * Identical calculations to live — only execution differs.
 */
export class SimulationExecutionProvider extends EventEmitter implements IExecutionProvider {
  readonly isSimulation = true;
  private orders = new Map<string, SimOrder>();
  private positions = new Map<string, SimPosition[]>();
  private symbolInfoCache = new Map<string, SymbolInfo>();
  private markPrices = new Map<string, string>();
  private readonly simLatencyMs = 50;

  constructor(
    private readonly exchangeInfoProvider: () => Promise<SymbolInfo[]>,
    private readonly restMarkPriceFetcher?: (symbol: string) => Promise<string>,
  ) {
    super();
  }

  /** Called by the WebSocket manager when mark prices arrive. */
  onPriceUpdate(symbol: string, price: string): void {
    this.markPrices.set(symbol, price);
    this.checkTriggers(symbol, price);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    await sleep(this.simLatencyMs + Math.random() * 50);

    const symbolInfo = await this.getSymbolInfo(req.symbol);
    const adjustedQty = adjustQuantity(req.quantity, symbolInfo);

    let fillPrice: string | undefined;
    let status: OrderStatus = 'NEW';

    const markPrice = this.markPrices.get(req.symbol) ?? req.price;

    if (req.type === 'MARKET' && markPrice != null) {
      const slip = new Decimal(config.trading.slippage);
      const mark = new Decimal(markPrice);
      fillPrice = req.side === 'BUY'
        ? mark.mul(new Decimal(1).plus(slip)).toFixed(symbolInfo.pricePrecision)
        : mark.mul(new Decimal(1).minus(slip)).toFixed(symbolInfo.pricePrecision);
      status = 'FILLED';

      this.updatePosition(
        req.symbol,
        req.side === 'BUY' ? 'LONG' : 'SHORT',
        fillPrice,
        adjustedQty,
        req.reduceOnly ?? false,
      );
    } else {
      status = 'NEW';
    }

    const fee = fillPrice != null
      ? calcFee(fillPrice, adjustedQty, config.trading.feeRate).toFixed(8)
      : '0';

    const result: OrderResult = {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      status,
      quantity: adjustedQty,
      price: req.price != null ? adjustPrice(req.price, symbolInfo) : null,
      stopPrice: req.stopPrice != null ? adjustPrice(req.stopPrice, symbolInfo) : null,
      filledQuantity: status === 'FILLED' ? adjustedQty : '0',
      avgFillPrice: fillPrice ?? null,
      fee,
      feeCurrency: 'USDT',
      createdAt: new Date(),
      filledAt: status === 'FILLED' ? new Date() : null,
    };

    this.orders.set(req.clientOrderId, { req, result, isOpen: status === 'NEW' });
    log.debug('Sim order placed', { clientId: req.clientOrderId, status, fillPrice });

    if (status === 'FILLED') {
      setTimeout(() => this.emitOrderFill(result), this.simLatencyMs);
    }

    return result;
  }

  async cancelOrder(req: CancelOrderRequest): Promise<void> {
    await sleep(this.simLatencyMs);
    const order = this.orders.get(req.clientOrderId);
    if (order == null) {
      // Idempotent cancel — already gone is fine for strategy code
      log.debug('Sim cancel ignored — order not found', { clientId: req.clientOrderId });
      return;
    }
    if (!order.isOpen) {
      log.debug('Sim cancel ignored — order not open', { clientId: req.clientOrderId });
      return;
    }
    order.isOpen = false;
    order.result.status = 'CANCELED';
    log.debug('Sim order cancelled', { clientId: req.clientOrderId });
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await sleep(this.simLatencyMs);
    for (const [, order] of this.orders) {
      if (order.req.symbol === symbol && order.isOpen) {
        order.isOpen = false;
        order.result.status = 'CANCELED';
      }
    }
    log.debug('Sim all orders cancelled', { symbol });
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

  async closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult> {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const result = await this.placeOrder({
      traderId: '',
      clientOrderId: `simclose_${symbol}_${Date.now()}`,
      symbol,
      side: closeSide,
      type: 'MARKET',
      role: 'HEDGE',
      hedgeLevel: 0,
      quantity,
      reduceOnly: true,
    });
    return result;
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {
    await sleep(10);
  }

  async setMarginMode(_symbol: string, _marginMode: string): Promise<void> {
    await sleep(10);
  }

  async getMarkPrice(symbol: string): Promise<string> {
    const cached = this.markPrices.get(symbol);
    if (cached != null) return cached;
    if (this.restMarkPriceFetcher == null) {
      throw new Error(`No mark price available for ${symbol}`);
    }
    const price = await this.restMarkPriceFetcher(symbol);
    this.markPrices.set(symbol, price);
    return price;
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    if (this.symbolInfoCache.has(symbol)) {
      return this.symbolInfoCache.get(symbol)!;
    }
    const infos = await this.exchangeInfoProvider();
    for (const info of infos) this.symbolInfoCache.set(info.symbol, info);
    const found = this.symbolInfoCache.get(symbol);
    if (found == null) throw new Error(`Symbol ${symbol} not found`);
    return found;
  }

  private checkTriggers(symbol: string, markPrice: string): void {
    const mark = new Decimal(markPrice);

    for (const [clientId, order] of this.orders) {
      if (!order.isOpen || order.req.symbol !== symbol) continue;

      let triggered = false;
      let fillAt = markPrice;

      const { type, side, price, stopPrice } = order.req;

      if (type === 'STOP_LIMIT' && stopPrice != null) {
        const stop = new Decimal(stopPrice);
        if (side === 'BUY' && mark.gte(stop)) {
          triggered = true;
          // Limit is worst-case: BUY fills at min(mark, limit)
          if (price != null) {
            const limit = new Decimal(price);
            fillAt = Decimal.min(mark, limit).toFixed();
          }
        }
        if (side === 'SELL' && mark.lte(stop)) {
          triggered = true;
          if (price != null) {
            const limit = new Decimal(price);
            fillAt = Decimal.max(mark, limit).toFixed();
          }
        }
      } else if (type === 'STOP_MARKET' && stopPrice != null) {
        const stop = new Decimal(stopPrice);
        if (side === 'BUY' && mark.gte(stop)) triggered = true;
        if (side === 'SELL' && mark.lte(stop)) triggered = true;
      } else if ((type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET') && stopPrice != null) {
        const tp = new Decimal(stopPrice);
        if (side === 'BUY' && mark.lte(tp)) {
          triggered = true;
          if (type === 'TAKE_PROFIT' && price != null) fillAt = price;
        }
        if (side === 'SELL' && mark.gte(tp)) {
          triggered = true;
          if (type === 'TAKE_PROFIT' && price != null) fillAt = price;
        }
      } else if (type === 'LIMIT' && price != null) {
        const lp = new Decimal(price);
        if (side === 'BUY' && mark.lte(lp)) { triggered = true; fillAt = price; }
        if (side === 'SELL' && mark.gte(lp)) { triggered = true; fillAt = price; }
      }

      if (triggered) {
        this.fillOrder(clientId, order, fillAt);
      }
    }
  }

  private fillOrder(clientId: string, order: SimOrder, fillPrice: string): void {
    const symbolInfo = this.symbolInfoCache.get(order.req.symbol);
    if (symbolInfo == null) return;

    const filledQty = order.req.quantity;
    const fee = calcFee(fillPrice, filledQty, config.trading.feeRate).toFixed(8);

    order.result.status = 'FILLED';
    order.result.filledQuantity = filledQty;
    order.result.avgFillPrice = fillPrice;
    order.result.fee = fee;
    order.result.filledAt = new Date();
    order.isOpen = false;

    log.debug('Sim order triggered', { clientId, fillPrice, filledQty });

    this.updatePosition(
      order.req.symbol,
      order.req.side === 'BUY' ? 'LONG' : 'SHORT',
      fillPrice,
      filledQty,
      order.req.reduceOnly ?? false,
    );

    setTimeout(() => this.emitOrderFill({ ...order.result }), this.simLatencyMs);
  }

  private emitOrderFill(result: OrderResult): void {
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

  /**
   * Update simulated positions.
   * reduceOnly closes the OPPOSING position side (BUY reduce closes SHORT, SELL reduce closes LONG).
   */
  private updatePosition(
    symbol: string,
    orderSide: 'LONG' | 'SHORT',
    fillPrice: string,
    quantity: string,
    reduceOnly: boolean,
  ): void {
    const positions = this.positions.get(symbol) ?? [];

    if (reduceOnly) {
      const closeSide: 'LONG' | 'SHORT' = orderSide === 'LONG' ? 'SHORT' : 'LONG';
      const idx = positions.findIndex((p) => p.side === closeSide);
      if (idx >= 0) {
        const pos = positions[idx]!;
        const newQty = new Decimal(pos.quantity).minus(quantity);
        if (newQty.lte(0)) {
          positions.splice(idx, 1);
        } else {
          pos.quantity = newQty.toFixed(8);
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
      } else {
        positions.push({
          symbol,
          side: orderSide,
          entryPrice: fillPrice,
          quantity,
          leverage: config.trading.leverage,
        });
      }
    }

    this.positions.set(symbol, positions);
  }
}
