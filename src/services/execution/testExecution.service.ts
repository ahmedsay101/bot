import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { CONFIG } from '../../core/config.js';
import { Side, OrderStatus, Channels, TradeReason } from '../../core/constants.js';
import { env } from '../../core/env.js';
import { scoped } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';
import { createRng, randomInRange, quantize } from '../../utils/math.js';
import { publish } from '../redis.service.js';
import { OrderModel, PositionModel, BalanceModel, TradeModel } from '../../models/index.js';
import { computeLiquidationPrice } from '../riskManager.service.js';
import { MarketDataService, type Candle } from '../marketData.service.js';
import type {
  IExecutionService,
  OrderRequest,
  OrderResult,
  FillEvent,
  FillHandler,
  Unsubscribe,
  PositionSnapshot,
  BalanceSnapshot,
} from './execution.interface.js';

const log = scoped('EXEC-TEST');

interface PendingOrder {
  req: OrderRequest;
  remaining: number;
  filled: number;
  avgFillPrice: number;
  fees: number;
  legPlan: { qty: number; atTs: number }[]; // for partial fills (LIMIT/STOP only)
  status: OrderStatus;
  createdAt: number;
}

interface InMemoryPosition extends PositionSnapshot {
  openedAt: number;
  entryOrderId: string;
}

/**
 * High-fidelity test execution. Reads live ticks from `MarketDataService`,
 * persists state in MongoDB. Fully deterministic given a fixed RNG seed.
 */
export class TestExecutionService extends EventEmitter implements IExecutionService {
  private readonly fills = new Set<FillHandler>();
  private readonly pending = new Map<string, PendingOrder>();
  private readonly positions = new Map<string, InMemoryPosition>();
  private readonly rng: () => number;

  private balance: number;
  private feesPaidLifetime = 0;

  private bookHandler: ((symbol: string) => void) | null = null;

  constructor(private readonly market: MarketDataService) {
    super();
    this.rng = createRng(env.RNG_SEED ?? 'test');
    this.balance = CONFIG().trading.totalBalance;
  }

  async start(): Promise<void> {
    // Restore balance + positions from DB if present
    const last = await BalanceModel.findOne({ mode: 'test' }).sort({ ts: -1 }).lean();
    if (last) {
      this.balance = last.balance;
      this.feesPaidLifetime = last.feesPaid;
    } else {
      await BalanceModel.create({
        mode: 'test',
        balance: this.balance,
        equity: this.balance,
        unrealizedPnl: 0,
        marginUsed: 0,
        feesPaid: 0,
      });
    }
    const persistedPositions = await PositionModel.find({ mode: 'test' }).lean();
    for (const p of persistedPositions) {
      this.positions.set(p.symbol, {
        symbol: p.symbol,
        side: p.side as Side,
        size: p.size,
        entryPrice: p.entryPrice,
        leverage: p.leverage,
        margin: p.margin,
        notional: p.notional,
        liquidationPrice: p.liquidationPrice,
        stopPrice: p.stopPrice,
        takeProfitPrice: p.takeProfitPrice,
        openedAt: p.openedAt.getTime(),
        entryOrderId: p.entryOrderId,
      });
    }

    // Listen for every book tick to drive matching, liquidation, SL/TP triggers.
    this.market.on('bookTicker', (e) => {
      this.onTick(e.symbol, e.bidPrice, e.askPrice).catch((err) =>
        log.error({ err: (err as Error).message }, 'tick error'),
      );
    });
    log.info({ balance: this.balance, positions: this.positions.size }, 'started');
  }

  async stop(): Promise<void> {
    /* nothing to do — state is in DB */
  }

  // -----------------------------------------------------------------------

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    await this.simulateLatency();
    const cfg = CONFIG();

    // Persist NEW order
    await OrderModel.create({
      clientOrderId: req.clientOrderId,
      exchangeOrderId: null,
      symbol: req.symbol,
      side: req.side,
      positionSide: req.positionSide,
      type: req.type,
      status: OrderStatus.NEW,
      mode: 'test',
      price: req.price ?? null,
      stopPrice: req.stopPrice ?? null,
      qty: req.qty,
      filledQty: 0,
      avgFillPrice: 0,
      fees: 0,
      reduceOnly: req.reduceOnly ?? false,
      purpose: req.purpose,
    });

    const legPlan = this.planLegs(req);
    const pending: PendingOrder = {
      req,
      remaining: req.qty,
      filled: 0,
      avgFillPrice: 0,
      fees: 0,
      legPlan,
      status: OrderStatus.NEW,
      createdAt: Date.now(),
    };
    this.pending.set(req.clientOrderId, pending);

    // MARKET fills immediately at top-of-book.
    if (req.type === 'MARKET') {
      const bt = this.market.getBookTicker(req.symbol);
      if (!bt) {
        await this.failOrder(pending, 'no book ticker');
        return this.toOrderResult(pending);
      }
      await this.fillMarket(pending, bt.bidPrice, bt.askPrice);
      return this.toOrderResult(pending);
    }

    // LIMIT/STOP/TP wait for ticks. Return NEW immediately.
    return this.toOrderResult(pending);
  }

  async cancelOrder(_symbol: string, clientOrderId: string): Promise<void> {
    await this.simulateLatency();
    const p = this.pending.get(clientOrderId);
    if (!p) return;
    if (p.status === OrderStatus.FILLED) return;
    p.status = p.filled > 0 ? OrderStatus.CANCELED : OrderStatus.CANCELED;
    this.pending.delete(clientOrderId);
    await OrderModel.updateOne(
      { clientOrderId },
      { $set: { status: p.status, filledQty: p.filled, avgFillPrice: p.avgFillPrice, fees: p.fees } },
    );
  }

  async getPosition(symbol: string): Promise<PositionSnapshot | null> {
    return this.positions.get(symbol) ?? null;
  }
  async getAllPositions(): Promise<PositionSnapshot[]> {
    return [...this.positions.values()];
  }

  async getBalance(): Promise<BalanceSnapshot> {
    let unrealized = 0;
    let marginUsed = 0;
    for (const p of this.positions.values()) {
      const bt = this.market.getBookTicker(p.symbol);
      if (!bt) continue;
      const mid = (bt.bidPrice + bt.askPrice) / 2;
      const direction = p.side === Side.LONG ? 1 : -1;
      unrealized += (mid - p.entryPrice) * p.size * direction;
      marginUsed += p.margin;
    }
    return {
      balance: this.balance,
      equity: this.balance + unrealized,
      marginUsed,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaidLifetime,
    };
  }

  async reconcile(): Promise<void> {
    /* test mode is always self-consistent */
  }

  onFill(handler: FillHandler): Unsubscribe {
    this.fills.add(handler);
    return () => this.fills.delete(handler);
  }

  // -----------------------------------------------------------------------
  // Internal: fill engine
  // -----------------------------------------------------------------------

  private async onTick(symbol: string, bid: number, ask: number): Promise<void> {
    // Process pending orders for this symbol
    const ordersForSymbol = [...this.pending.values()].filter((p) => p.req.symbol === symbol);
    for (const p of ordersForSymbol) {
      if (p.status !== OrderStatus.NEW && p.status !== OrderStatus.PARTIALLY_FILLED) continue;
      await this.tryFillTriggered(p, bid, ask);
    }

    // Liquidation + SL/TP check on open position
    const pos = this.positions.get(symbol);
    if (pos) {
      const triggerPrice = pos.side === Side.LONG ? bid : ask;
      // Liquidation
      if (
        (pos.side === Side.LONG && triggerPrice <= pos.liquidationPrice) ||
        (pos.side === Side.SHORT && triggerPrice >= pos.liquidationPrice)
      ) {
        await this.forceClose(pos, pos.liquidationPrice, TradeReason.LIQUIDATION);
        return;
      }
      // SL
      if (
        (pos.side === Side.LONG && triggerPrice <= pos.stopPrice) ||
        (pos.side === Side.SHORT && triggerPrice >= pos.stopPrice)
      ) {
        await this.forceClose(pos, pos.stopPrice, TradeReason.SL);
        return;
      }
      // TP
      if (
        (pos.side === Side.LONG && triggerPrice >= pos.takeProfitPrice) ||
        (pos.side === Side.SHORT && triggerPrice <= pos.takeProfitPrice)
      ) {
        await this.forceClose(pos, pos.takeProfitPrice, TradeReason.TP);
        return;
      }
    }
  }

  private async tryFillTriggered(p: PendingOrder, bid: number, ask: number): Promise<void> {
    const r = p.req;
    let triggered = false;
    let triggerPrice = 0;

    if (r.type === 'LIMIT' && r.price !== undefined) {
      // BUY limit fills if ask <= price; SELL limit fills if bid >= price
      if (r.side === 'BUY' && ask <= r.price) {
        triggered = true;
        triggerPrice = r.price; // post-only-ish; conservative
      } else if (r.side === 'SELL' && bid >= r.price) {
        triggered = true;
        triggerPrice = r.price;
      }
    } else if ((r.type === 'STOP_MARKET' || r.type === 'TAKE_PROFIT_MARKET') && r.stopPrice !== undefined) {
      const last = (bid + ask) / 2;
      if (r.side === 'BUY' && last >= r.stopPrice) {
        triggered = true;
        triggerPrice = ask;
      } else if (r.side === 'SELL' && last <= r.stopPrice) {
        triggered = true;
        triggerPrice = bid;
      }
    }

    if (!triggered) return;

    // Execute next leg(s) whose `atTs` is due.
    const now = Date.now();
    const dueLegs = p.legPlan.filter((l) => l.atTs <= now);
    if (dueLegs.length === 0) return;
    p.legPlan = p.legPlan.filter((l) => l.atTs > now);

    for (const leg of dueLegs) {
      const slipped = this.slip(triggerPrice, r.side, p.req.symbol);
      const fee = leg.qty * slipped * (r.type === 'LIMIT' ? CONFIG().simulator.makerFeeRate : CONFIG().simulator.takerFeeRate);
      this.applyFill(p, leg.qty, slipped, fee, false);
    }
    if (p.legPlan.length === 0 && p.remaining <= 0) {
      await this.finalizeFill(p);
    } else {
      p.status = OrderStatus.PARTIALLY_FILLED;
      await OrderModel.updateOne(
        { clientOrderId: p.req.clientOrderId },
        { $set: { status: p.status, filledQty: p.filled, avgFillPrice: p.avgFillPrice, fees: p.fees } },
      );
    }
  }

  private async fillMarket(p: PendingOrder, bid: number, ask: number): Promise<void> {
    const r = p.req;
    const ref = r.side === 'BUY' ? ask : bid;
    for (const leg of p.legPlan) {
      const slipped = this.slip(ref, r.side, r.symbol);
      const fee = leg.qty * slipped * CONFIG().simulator.takerFeeRate;
      // Apply latency between partial-fill legs
      if (leg.atTs > Date.now()) await sleep(leg.atTs - Date.now());
      this.applyFill(p, leg.qty, slipped, fee, false);
    }
    await this.finalizeFill(p);
  }

  private applyFill(p: PendingOrder, qty: number, price: number, fee: number, isFinal: boolean): void {
    p.filled += qty;
    p.remaining = Math.max(0, p.req.qty - p.filled);
    p.avgFillPrice = (p.avgFillPrice * (p.filled - qty) + price * qty) / p.filled;
    p.fees += fee;
    this.feesPaidLifetime += fee;
    this.balance -= fee;

    const ev: FillEvent = {
      clientOrderId: p.req.clientOrderId,
      symbol: p.req.symbol,
      side: p.req.side,
      positionSide: p.req.positionSide,
      qty,
      price,
      fee,
      ts: Date.now(),
      isFinal,
      purpose: p.req.purpose,
    };
    for (const h of this.fills) h(ev);
    void publish(Channels.ORDER_PARTIAL, ev);
  }

  private async finalizeFill(p: PendingOrder): Promise<void> {
    p.status = OrderStatus.FILLED;
    this.pending.delete(p.req.clientOrderId);
    await OrderModel.updateOne(
      { clientOrderId: p.req.clientOrderId },
      {
        $set: {
          status: OrderStatus.FILLED,
          filledQty: p.filled,
          avgFillPrice: p.avgFillPrice,
          fees: p.fees,
        },
      },
    );

    // Apply to position
    if (p.req.purpose === 'ENTRY') {
      await this.openOrAddPosition(p);
    } else {
      await this.reduceOrClosePosition(p);
    }

    void publish(Channels.ORDER_FILLED, {
      clientOrderId: p.req.clientOrderId,
      symbol: p.req.symbol,
      qty: p.filled,
      avgPrice: p.avgFillPrice,
      fees: p.fees,
    });
  }

  private async failOrder(p: PendingOrder, reason: string): Promise<void> {
    p.status = OrderStatus.REJECTED;
    this.pending.delete(p.req.clientOrderId);
    await OrderModel.updateOne(
      { clientOrderId: p.req.clientOrderId },
      { $set: { status: OrderStatus.REJECTED, error: reason } },
    );
    log.warn({ clientOrderId: p.req.clientOrderId, reason }, 'order rejected');
  }

  // -----------------------------------------------------------------------
  // Position management
  // -----------------------------------------------------------------------

  private async openOrAddPosition(p: PendingOrder): Promise<void> {
    const cfg = CONFIG();
    const symbol = p.req.symbol;
    const side = p.req.positionSide;
    const existing = this.positions.get(symbol);

    if (existing) {
      // Average in (rare with maxOpenPositionsPerSymbol = 1)
      const newSize = existing.size + p.filled;
      const newEntry = (existing.entryPrice * existing.size + p.avgFillPrice * p.filled) / newSize;
      existing.size = newSize;
      existing.entryPrice = newEntry;
      existing.notional = newSize * newEntry;
      existing.margin = existing.notional / existing.leverage;
      existing.liquidationPrice = computeLiquidationPrice(side, newEntry, existing.leverage);
      await PositionModel.updateOne(
        { symbol, mode: 'test' },
        { $set: existing },
      );
      return;
    }

    const leverage = cfg.trading.leverage;
    const entryPrice = p.avgFillPrice;
    const notional = entryPrice * p.filled;
    const margin = notional / leverage;
    const slDist = entryPrice * 0; // placeholder; will be set immediately by strategy via SL order
    const stopPrice =
      p.req.purpose === 'ENTRY' && (p.req as OrderRequest & { stopPriceHint?: number }).stopPriceHint
        ? (p.req as OrderRequest & { stopPriceHint?: number }).stopPriceHint!
        : side === Side.LONG
        ? entryPrice * 0.97
        : entryPrice * 1.03;
    const tpPrice =
      side === Side.LONG ? entryPrice * 1.05 : entryPrice * 0.95;
    const liq = computeLiquidationPrice(side, entryPrice, leverage);

    const pos: InMemoryPosition = {
      symbol,
      side,
      size: p.filled,
      entryPrice,
      leverage,
      margin,
      notional,
      liquidationPrice: liq,
      stopPrice,
      takeProfitPrice: tpPrice,
      openedAt: Date.now(),
      entryOrderId: p.req.clientOrderId,
    };
    this.positions.set(symbol, pos);

    await PositionModel.updateOne(
      { symbol, mode: 'test' },
      {
        $set: {
          ...pos,
          openedAt: new Date(pos.openedAt),
          mode: 'test',
        },
      },
      { upsert: true },
    );
    void slDist; // silence unused
    void publish(Channels.POSITION_UPDATED, pos);
  }

  /** Public hook for orchestrator to attach SL/TP after entry. */
  async attachStops(symbol: string, stopPrice: number, takeProfitPrice: number): Promise<void> {
    const pos = this.positions.get(symbol);
    if (!pos) return;
    pos.stopPrice = stopPrice;
    pos.takeProfitPrice = takeProfitPrice;
    await PositionModel.updateOne({ symbol, mode: 'test' }, { $set: { stopPrice, takeProfitPrice } });
  }

  private async reduceOrClosePosition(p: PendingOrder): Promise<void> {
    const pos = this.positions.get(p.req.symbol);
    if (!pos) return;
    const closeQty = Math.min(p.filled, pos.size);
    const direction = pos.side === Side.LONG ? 1 : -1;
    const pnl = (p.avgFillPrice - pos.entryPrice) * closeQty * direction;
    this.balance += pnl;

    await TradeModel.create({
      symbol: pos.symbol,
      side: pos.side,
      mode: 'test',
      entryPrice: pos.entryPrice,
      exitPrice: p.avgFillPrice,
      qty: closeQty,
      notional: closeQty * pos.entryPrice,
      pnl,
      fees: p.fees,
      leverage: pos.leverage,
      reason: TradeReason.MANUAL,
      openedAt: new Date(pos.openedAt),
      closedAt: new Date(),
    });

    pos.size -= closeQty;
    if (pos.size <= 0) {
      this.positions.delete(pos.symbol);
      await PositionModel.deleteOne({ symbol: pos.symbol, mode: 'test' });
    } else {
      await PositionModel.updateOne({ symbol: pos.symbol, mode: 'test' }, { $set: { size: pos.size } });
    }
    void publish(Channels.TRADE_CLOSED, { symbol: pos.symbol, pnl, reason: 'reduce' });
  }

  /** Forced exit (SL/TP/liquidation) at a known price. */
  private async forceClose(pos: InMemoryPosition, exitPrice: number, reason: string): Promise<void> {
    const direction = pos.side === Side.LONG ? 1 : -1;
    const fee = pos.size * exitPrice * CONFIG().simulator.takerFeeRate;
    const pnl = (exitPrice - pos.entryPrice) * pos.size * direction - fee;
    this.balance += pnl;
    this.feesPaidLifetime += fee;

    await TradeModel.create({
      symbol: pos.symbol,
      side: pos.side,
      mode: 'test',
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.size,
      notional: pos.size * pos.entryPrice,
      pnl,
      fees: fee,
      leverage: pos.leverage,
      reason,
      openedAt: new Date(pos.openedAt),
      closedAt: new Date(),
    });
    this.positions.delete(pos.symbol);
    await PositionModel.deleteOne({ symbol: pos.symbol, mode: 'test' });
    void publish(Channels.TRADE_CLOSED, { symbol: pos.symbol, pnl, reason, exitPrice });
    log.info({ symbol: pos.symbol, reason, pnl: pnl.toFixed(4) }, 'forced close');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private planLegs(req: OrderRequest): { qty: number; atTs: number }[] {
    const cfg = CONFIG();
    const candles = this.market.getCandles(req.symbol, cfg.timeframes.strategy);
    const lastVol = candles.length ? (candles[candles.length - 1] as Candle).volume : Infinity;
    const threshold = cfg.simulator.partialFillVolumeThreshold * lastVol;
    if (req.qty <= threshold || lastVol === 0) {
      return [{ qty: req.qty, atTs: Date.now() }];
    }
    const legCount = Math.min(cfg.simulator.partialFillMaxLegs, Math.max(2, Math.ceil(req.qty / threshold)));
    const stepSize = this.market.getSymbolInfo(req.symbol)?.filters.stepSize ?? 0.001;
    const baseLeg = quantize(req.qty / legCount, stepSize);
    const legs: { qty: number; atTs: number }[] = [];
    let remaining = req.qty;
    const spread = cfg.simulator.partialFillSpreadMs;
    for (let i = 0; i < legCount - 1; i++) {
      legs.push({
        qty: baseLeg,
        atTs: Date.now() + Math.floor(randomInRange(this.rng, 0, spread / legCount) * (i + 1)),
      });
      remaining -= baseLeg;
    }
    legs.push({ qty: remaining, atTs: Date.now() + spread });
    return legs;
  }

  private slip(price: number, side: 'BUY' | 'SELL', symbol: string): number {
    const cfg = CONFIG();
    const candles = this.market.getCandles(symbol, cfg.timeframes.strategy);
    const lastClose = candles.length ? (candles[candles.length - 1] as Candle).close : price;
    const atrEst = lastClose * 0.001; // fallback: use indicator value; for simplicity, 0.1% of price
    const noise = randomInRange(this.rng, 0, atrEst * cfg.simulator.maxSlippageAtrFraction);
    const sign = side === 'BUY' ? 1 : -1;
    return price + sign * noise;
  }

  private async simulateLatency(): Promise<void> {
    const cfg = CONFIG();
    await sleep(Math.floor(randomInRange(this.rng, cfg.simulator.minLatencyMs, cfg.simulator.maxLatencyMs)));
  }

  private toOrderResult(p: PendingOrder): OrderResult {
    return {
      clientOrderId: p.req.clientOrderId,
      exchangeOrderId: null,
      status: p.status,
      filledQty: p.filled,
      avgFillPrice: p.avgFillPrice,
      fees: p.fees,
    };
  }
}

// helper to generate clientOrderId
export function newClientOrderId(prefix = 't'): string {
  return `${prefix}-${uuid()}`.slice(0, 36);
}
