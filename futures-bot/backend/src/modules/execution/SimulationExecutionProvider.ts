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

  constructor(private readonly exchangeInfoProvider: () => Promise<SymbolInfo[]>) {
    super();
  }

  /** Called by the WebSocket manager when mark prices arrive. */
  onPriceUpdate(symbol: string, price: string): void {
    this.markPrices.set(symbol, price);
    this.checkTriggers(symbol, price);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    // Simulate network latency
    await sleep(this.simLatencyMs + Math.random() * 50);

    const symbolInfo = await this.getSymbolInfo(req.symbol);
    const adjustedQty = adjustQuantity(req.quantity, symbolInfo);

    let fillPrice: string | undefined;
    let status: OrderStatus = 'NEW';

    const markPrice = this.markPrices.get(req.symbol) ?? req.price ?? '0';

    if (req.type === 'MARKET') {
      // Apply slippage
      const slip = new Decimal(config.trading.slippage);
      const mark = new Decimal(markPrice);
      fillPrice = req.side === 'BUY'
        ? mark.mul(new Decimal(1).plus(slip)).toFixed(symbolInfo.pricePrecision)
        : mark.mul(new Decimal(1).minus(slip)).toFixed(symbolInfo.pricePrecision);
      status = 'FILLED';

      // Track position
      this.updatePosition(req.symbol, req.side === 'BUY' ? 'LONG' : 'SHORT', fillPrice, adjustedQty, req.reduceOnly ?? false);
    } else {
      // LIMIT / STOP_LIMIT / TAKE_PROFIT — will be triggered when price crosses
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
      price: req.price != null ? adjustPrice(req.price, symbolInfo) : undefined,
      stopPrice: req.stopPrice != null ? adjustPrice(req.stopPrice, symbolInfo) : undefined,
      filledQuantity: status === 'FILLED' ? adjustedQty : '0',
      avgFillPrice: fillPrice,
      fee,
      feeCurrency: 'USDT',
      createdAt: new Date(),
      filledAt: status === 'FILLED' ? new Date() : undefined,
    };

    this.orders.set(req.clientOrderId, { req, result, isOpen: status === 'NEW' });
    log.debug('Sim order placed', { clientId: req.clientOrderId, status, fillPrice });

    if (status === 'FILLED') {
      // Emit fill event to simulate user data stream
      setTimeout(() => {
        this.emit('orderFill', result);
      }, this.simLatencyMs);
    }

    return result;
  }

  async cancelOrder(req: CancelOrderRequest): Promise<void> {
    await sleep(this.simLatencyMs);
    const order = this.orders.get(req.clientOrderId);
    if (order == null) throw new Error(`Sim order ${req.clientOrderId} not found`);
    if (!order.isOpen) throw new Error(`Sim order ${req.clientOrderId} is not open`);
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
    this.removePosition(symbol, side);
    return result;
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {
    await sleep(10);
  }

  async setMarginMode(_symbol: string, _marginMode: string): Promise<void> {
    await sleep(10);
  }

  async getMarkPrice(symbol: string): Promise<string> {
    return this.markPrices.get(symbol) ?? '0';
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

      if (order.req.type === 'STOP_LIMIT' && order.req.stopPrice != null) {
        const stop = new Decimal(order.req.stopPrice);
        if (order.req.side === 'BUY' && mark.gte(stop)) triggered = true;
        if (order.req.side === 'SELL' && mark.lte(stop)) triggered = true;
      } else if (order.req.type === 'TAKE_PROFIT' && order.req.price != null) {
        const tp = new Decimal(order.req.price);
        if (order.req.side === 'SELL' && mark.lte(tp)) triggered = true;
        if (order.req.side === 'BUY' && mark.gte(tp)) triggered = true;
      } else if (order.req.type === 'LIMIT' && order.req.price != null) {
        const price = new Decimal(order.req.price);
        if (order.req.side === 'BUY' && mark.lte(price)) triggered = true;
        if (order.req.side === 'SELL' && mark.gte(price)) triggered = true;
      }

      if (triggered) {
        this.fillOrder(clientId, order, mark.toFixed(8));
      }
    }
  }

  private fillOrder(clientId: string, order: SimOrder, fillPrice: string): void {
    const symbolInfo = this.symbolInfoCache.get(order.req.symbol);
    if (symbolInfo == null) return;

    // Simulate partial fill randomly (5% chance)
    const isPartial = Math.random() < 0.05;
    const filledQty = isPartial
      ? new Decimal(order.req.quantity).mul(0.5).toFixed(symbolInfo.quantityPrecision)
      : order.req.quantity;

    const fee = calcFee(fillPrice, filledQty, config.trading.feeRate).toFixed(8);

    order.result.status = isPartial ? 'PARTIALLY_FILLED' : 'FILLED';
    order.result.filledQuantity = filledQty;
    order.result.avgFillPrice = fillPrice;
    order.result.fee = fee;
    order.result.filledAt = new Date();
    order.isOpen = isPartial;

    log.debug('Sim order triggered', { clientId, fillPrice, filledQty, isPartial });

    this.updatePosition(
      order.req.symbol,
      order.req.side === 'BUY' ? 'LONG' : 'SHORT',
      fillPrice,
      filledQty,
      order.req.reduceOnly ?? false,
    );

    setTimeout(() => {
      this.emit('orderFill', { ...order.result });
    }, this.simLatencyMs);

    // Handle partial fill remainder
    if (isPartial) {
      setTimeout(() => {
        const remainQty = new Decimal(order.req.quantity).minus(filledQty).toFixed(symbolInfo.quantityPrecision);
        order.result.status = 'FILLED';
        order.result.filledQuantity = order.req.quantity;
        order.isOpen = false;
        this.updatePosition(order.req.symbol, order.req.side === 'BUY' ? 'LONG' : 'SHORT', fillPrice, remainQty, order.req.reduceOnly ?? false);
        this.emit('orderFill', { ...order.result });
      }, this.simLatencyMs + 200);
    }
  }

  private updatePosition(symbol: string, side: 'LONG' | 'SHORT', fillPrice: string, quantity: string, reduceOnly: boolean): void {
    const positions = this.positions.get(symbol) ?? [];

    if (reduceOnly) {
      const idx = positions.findIndex((p) => p.side === side);
      if (idx >= 0) {
        const pos = positions[idx];
        const newQty = new Decimal(pos.quantity).minus(quantity);
        if (newQty.lte(0)) {
          positions.splice(idx, 1);
        } else {
          pos.quantity = newQty.toFixed(8);
        }
      }
    } else {
      const existing = positions.find((p) => p.side === side);
      if (existing != null) {
        const totalQty = new Decimal(existing.quantity).plus(quantity);
        const avgEntry = new Decimal(existing.entryPrice)
          .mul(existing.quantity)
          .plus(new Decimal(fillPrice).mul(quantity))
          .div(totalQty);
        existing.quantity = totalQty.toFixed(8);
        existing.entryPrice = avgEntry.toFixed(8);
      } else {
        positions.push({ symbol, side, entryPrice: fillPrice, quantity, leverage: config.trading.leverage });
      }
    }

    this.positions.set(symbol, positions);
  }

  private removePosition(symbol: string, side: 'LONG' | 'SHORT'): void {
    const positions = (this.positions.get(symbol) ?? []).filter((p) => p.side !== side);
    this.positions.set(symbol, positions);
  }
}
