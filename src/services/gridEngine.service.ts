import { CONFIG } from '../core/config.js';
import { Side, OrderType } from '../core/constants.js';
import {
  BotState,
  type GridLevel,
  type GridPosition,
  type HedgePosition,
  type GridEvent,
  type GridEventType,
  type DebugSnapshot,
} from '../core/gridState.js';
import { quantize } from '../utils/math.js';
import { scoped } from '../utils/logger.js';
import type { Candle } from './marketData.service.js';

const log = scoped('GRID');

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, no time. Imported by tests.
// ---------------------------------------------------------------------------

export interface RangeBands {
  upperRaw: number;
  lowerRaw: number;
  upperBand: number;
  lowerBand: number;
  rangePercent: number;
  /** True if range was clamped to min or max. */
  clamped: 'NONE' | 'EXPANDED' | 'SHRUNK';
}

/** STEP 1+2+3 — derive bands from last `lookback` candles, no indicators. */
export function buildRange(candles: Candle[], referencePrice: number): RangeBands | null {
  const cfg = CONFIG().grid;
  if (candles.length < cfg.lookback) return null;
  const recent = candles.slice(-cfg.lookback);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of recent) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || referencePrice <= 0) return null;

  const upperRaw = hi * cfg.upperBuffer;
  const lowerRaw = lo * cfg.lowerBuffer;
  let upper = upperRaw;
  let lower = lowerRaw;
  let rangePct = (upper - lower) / referencePrice;

  let clamped: RangeBands['clamped'] = 'NONE';
  // STEP 3 — validate / clamp range size
  if (rangePct < cfg.minRangePercent) {
    const half = (cfg.minRangePercent * referencePrice) / 2;
    const mid = (upper + lower) / 2;
    upper = mid + half;
    lower = mid - half;
    rangePct = cfg.minRangePercent;
    clamped = 'EXPANDED';
  } else if (rangePct > cfg.maxRangePercent) {
    const half = (cfg.maxRangePercent * referencePrice) / 2;
    const mid = (upper + lower) / 2;
    upper = mid + half;
    lower = mid - half;
    rangePct = cfg.maxRangePercent;
    clamped = 'SHRUNK';
  }

  return { upperRaw, lowerRaw, upperBand: upper, lowerBand: lower, rangePercent: rangePct, clamped };
}

/** STEP 4 — generate evenly spaced levels strictly between lower and upper.
 * Spacing is relative (cfg.grid.spacing).
 */
export function generateLevels(
  lower: number,
  upper: number,
  spacingFraction: number,
): number[] {
  if (upper <= lower || spacingFraction <= 0) return [];
  const mid = (upper + lower) / 2;
  const step = mid * spacingFraction;
  if (step <= 0) return [];
  const levels: number[] = [];
  // Start at lower + step (no level on the band itself).
  for (let p = lower + step; p < upper; p += step) {
    levels.push(p);
  }
  return levels;
}

export interface CandleSlice {
  high: number;
  low: number;
  close: number;
  openTime: number;
}

/** RULE — breakout if last `holdCandles` closes are all past the band by ≥ pct. */
export function detectBreakout(
  recent: CandleSlice[],
  upperBand: number,
  lowerBand: number,
  breakoutPct: number,
  holdCandles: number,
): { breakout: true; direction: 'UP' | 'DOWN' } | { breakout: false } {
  if (recent.length < holdCandles) return { breakout: false };
  const tail = recent.slice(-holdCandles);
  const upTriggered = tail.every((c) => c.close > upperBand * (1 + breakoutPct));
  if (upTriggered) return { breakout: true, direction: 'UP' };
  const downTriggered = tail.every((c) => c.close < lowerBand * (1 - breakoutPct));
  if (downTriggered) return { breakout: true, direction: 'DOWN' };
  return { breakout: false };
}

/** Count band-touches in a window — separately for upper and lower. Chop is
 * declared by the caller when *both* sides see touches and the total count
 * exceeds the chop threshold (one-sided escapes are breakouts, not chop).
 */
export function countBoundaryCrosses(
  recent: CandleSlice[],
  upperBand: number,
  lowerBand: number,
): { up: number; down: number; total: number } {
  let up = 0;
  let down = 0;
  for (const c of recent) {
    if (c.high > upperBand) up += 1;
    if (c.low < lowerBand) down += 1;
  }
  return { up, down, total: up + down };
}

// ---------------------------------------------------------------------------
// IExecutionAdapter — minimal interface the engine uses, easy to mock in tests
// ---------------------------------------------------------------------------

export interface PlaceOrderArgs {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: Side;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  qty: number;
  price?: number;
  reduceOnly?: boolean;
  purpose: 'GRID' | 'GRID_TP' | 'HEDGE' | 'HEDGE_CLOSE';
}

export interface IGridExecutionAdapter {
  placeOrder(args: PlaceOrderArgs): Promise<void>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<void>;
  /** Settle realized PnL on a closed leg (engine→balance). */
  creditRealizedPnl(args: {
    symbol: string;
    side: Side;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    fees: number;
    leverage: number;
    reason: string;
    openedAt: number;
  }): Promise<void>;
  /** Returns symbol's tickSize and stepSize (or sensible defaults). */
  symbolFilters(symbol: string): { tickSize: number; stepSize: number; minNotional: number };
}

// ---------------------------------------------------------------------------
// FillRecord — the engine consumes fills via onFill().
// ---------------------------------------------------------------------------

export interface FillRecord {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  fee: number;
  ts: number;
  purpose: 'GRID' | 'GRID_TP' | 'HEDGE' | 'HEDGE_CLOSE';
}

// ---------------------------------------------------------------------------
// GridEngine — per-symbol state machine
// ---------------------------------------------------------------------------

export interface GridEngineDeps {
  symbol: string;
  exec: IGridExecutionAdapter;
  /** Provide current price (mid). May return null when book not yet seen. */
  getCurrentPrice: () => number | null;
  /** Provide the closed candles used for range build + breakout detection. */
  getCandles: () => Candle[];
  /** Persist snapshot (no-op in tests). */
  persist?: (snap: DebugSnapshot) => Promise<void>;
}

const MAX_EVENT_HISTORY = 50;

export class GridEngine {
  readonly symbol: string;
  private readonly exec: IGridExecutionAdapter;
  private readonly getCurrentPrice: () => number | null;
  private readonly getCandles: () => Candle[];
  private readonly persist?: (snap: DebugSnapshot) => Promise<void>;

  private state: BotState = BotState.RESET;
  private upperBand = 0;
  private lowerBand = 0;
  private rangePercent = 0;

  private levels: GridLevel[] = [];
  private positions: GridPosition[] = [];
  private hedge: HedgePosition | null = null;

  private breakoutDetected = false;
  private breakoutDirection: 'UP' | 'DOWN' | null = null;
  private breakoutAt = 0;
  private breakoutCandleTime = 0;

  /** monotonic counter used in clientOrderId suffix. */
  private orderSeq = 0;
  private cooldownUntil = 0;
  private lastTransitionAt = 0;
  private events: GridEvent[] = [];

  /** Lookup: clientOrderId -> level (for grid entries) or 'HEDGE'. */
  private orderIndex = new Map<string, { kind: 'GRID_ENTRY' | 'GRID_TP' | 'HEDGE_OPEN' | 'HEDGE_CLOSE'; levelPrice?: number }>();

  /** Lookup: levelPrice -> level. */
  private levelByPrice = new Map<number, GridLevel>();

  constructor(deps: GridEngineDeps) {
    this.symbol = deps.symbol;
    this.exec = deps.exec;
    this.getCurrentPrice = deps.getCurrentPrice;
    this.getCandles = deps.getCandles;
    this.persist = deps.persist;
    this.lastTransitionAt = Date.now();
  }

  // ------- Public API ----------------------------------------------------

  getState(): BotState {
    return this.state;
  }

  /** Test/inspection helper. */
  snapshot(): DebugSnapshot {
    const price = this.getCurrentPrice() ?? 0;
    const longs = this.positions.filter((p) => p.side === 'LONG');
    const shorts = this.positions.filter((p) => p.side === 'SHORT');
    const longSize = longs.reduce((s, p) => s + p.size, 0);
    const shortSize = shorts.reduce((s, p) => s + p.size, 0);
    return {
      symbol: this.symbol,
      state: this.state,
      upperBand: this.upperBand,
      lowerBand: this.lowerBand,
      currentPrice: price,
      rangePercent: this.rangePercent,
      breakoutDetected: this.breakoutDetected,
      breakoutDirection: this.breakoutDirection,
      hedgeActive: this.hedge !== null,
      netPosition: longSize - shortSize,
      openLongPositions: longs.length,
      openShortPositions: shorts.length,
      totalOpenPositions: this.positions.length,
      hedge: this.hedge,
      positions: [...this.positions],
      levels: [...this.levels],
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
      lastTransitionAt: this.lastTransitionAt,
      recentEvents: this.events.slice(-MAX_EVENT_HISTORY),
    };
  }

  /** Call on every market tick / loop iteration. Fully reentrant; serial per
   * symbol because the orchestrator awaits it. */
  async tick(): Promise<void> {
    try {
      switch (this.state) {
        case BotState.RESET:
          await this.tickReset();
          break;
        case BotState.GRID:
          await this.tickGrid();
          break;
        case BotState.HEDGE:
          await this.tickHedge();
          break;
      }
      await this.maybePersist();
    } catch (e) {
      this.event('ERROR', `tick error: ${(e as Error).message}`);
      log.error({ symbol: this.symbol, err: (e as Error).message }, 'tick error');
    }
  }

  /** Routes a fill back into the engine. */
  async onFill(f: FillRecord): Promise<void> {
    const idx = this.orderIndex.get(f.clientOrderId);
    if (!idx) return; // not ours (or already settled)
    if (idx.kind === 'GRID_ENTRY') {
      await this.handleGridEntryFill(f, idx.levelPrice!);
    } else if (idx.kind === 'GRID_TP') {
      await this.handleGridTpFill(f, idx.levelPrice!);
    } else if (idx.kind === 'HEDGE_OPEN') {
      await this.handleHedgeOpenFill(f);
    } else if (idx.kind === 'HEDGE_CLOSE') {
      await this.handleHedgeCloseFill(f);
    }
  }

  /** Force-flatten everything (kill switch / shutdown). */
  async flattenAll(reason: string): Promise<void> {
    await this.cancelAllOpenOrders();
    // Close grid positions at market.
    for (const pos of [...this.positions]) {
      const closeSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
      const cid = this.newOrderId('flat');
      this.orderIndex.set(cid, { kind: 'GRID_TP', levelPrice: pos.levelPrice });
      await this.exec
        .placeOrder({
          clientOrderId: cid,
          symbol: this.symbol,
          side: closeSide,
          positionSide: pos.side as Side,
          type: OrderType.MARKET,
          qty: pos.size,
          reduceOnly: true,
          purpose: 'GRID_TP',
        })
        .catch((e) => log.error({ err: (e as Error).message }, 'flatten grid pos failed'));
    }
    if (this.hedge) {
      const closeSide: 'BUY' | 'SELL' = this.hedge.side === 'LONG' ? 'SELL' : 'BUY';
      const cid = this.newOrderId('flat-h');
      this.orderIndex.set(cid, { kind: 'HEDGE_CLOSE' });
      await this.exec
        .placeOrder({
          clientOrderId: cid,
          symbol: this.symbol,
          side: closeSide,
          positionSide: this.hedge.side as Side,
          type: OrderType.MARKET,
          qty: this.hedge.size,
          reduceOnly: true,
          purpose: 'HEDGE_CLOSE',
        })
        .catch((e) => log.error({ err: (e as Error).message }, 'flatten hedge failed'));
    }
    this.event('STATE_CHANGE', `flatten: ${reason}`);
    this.transitionTo(BotState.RESET);
    this.cooldownUntil = Date.now() + CONFIG().grid.cooldownMs;
  }

  // ------- Per-state tick logic -----------------------------------------

  private async tickReset(): Promise<void> {
    if (Date.now() < this.cooldownUntil) return;
    if (this.cooldownUntil > 0) {
      this.event('COOLDOWN_DONE', 'cooldown expired');
      this.cooldownUntil = 0;
    }
    // Need price + enough candles to build range.
    const price = this.getCurrentPrice();
    if (price == null) return;
    const candles = this.getCandles();
    const range = buildRange(candles, price);
    if (!range) return;

    this.upperBand = range.upperBand;
    this.lowerBand = range.lowerBand;
    this.rangePercent = range.rangePercent;
    this.event('RANGE_BUILT', 'range built', {
      upperBand: range.upperBand,
      lowerBand: range.lowerBand,
      rangePercent: range.rangePercent,
      clamped: range.clamped,
    });
    await this.placeGrid(price);
    this.transitionTo(BotState.GRID);
  }

  private async tickGrid(): Promise<void> {
    const price = this.getCurrentPrice();
    if (price == null) return;
    const candles = this.getCandles();

    // 1. CHOP detection — touches on BOTH sides of the band inside short window.
    //    A one-sided escape is a breakout, not chop.
    const cfg = CONFIG().grid;
    const window = candles.slice(-cfg.chopWindowCandles);
    const cr = countBoundaryCrosses(window, this.upperBand, this.lowerBand);
    if (
      cr.up > 0 &&
      cr.down > 0 &&
      cr.total >= cfg.chopCrosses &&
      candles.length >= cfg.chopWindowCandles
    ) {
      this.event('CHOP_DETECTED', `chop: up=${cr.up} down=${cr.down} in ${cfg.chopWindowCandles} candles`);
      await this.flattenAll('chop');
      return;
    }

    // 2. Breakout detection (uses last N closed candles).
    const recent = candles.slice(-cfg.breakoutHoldCandles);
    const br = detectBreakout(
      recent,
      this.upperBand,
      this.lowerBand,
      cfg.breakoutPercent,
      cfg.breakoutHoldCandles,
    );
    if (br.breakout) {
      this.breakoutDetected = true;
      this.breakoutDirection = br.direction;
      this.breakoutAt = Date.now();
      this.breakoutCandleTime = candles[candles.length - 1]?.openTime ?? 0;
      this.event('BREAKOUT_DETECTED', `breakout ${br.direction}`, {
        price,
        upperBand: this.upperBand,
        lowerBand: this.lowerBand,
      });
      await this.cancelAllOpenOrders(); // disable grid
      await this.openHedge(price);
      this.transitionTo(BotState.HEDGE);
      return;
    }

    // 3. Refill any levels whose entry/TP is missing (no-op if at caps).
    await this.maintainGridOrders(price);
  }

  private async tickHedge(): Promise<void> {
    if (!this.hedge) {
      // Hedge pending — wait for fill.
      return;
    }
    const price = this.getCurrentPrice();
    if (price == null) return;
    const cfg = CONFIG().grid;
    const candles = this.getCandles();

    // CASE C — chop: touches on both sides of band — full reset.
    const window = candles.slice(-cfg.chopWindowCandles);
    const cr = countBoundaryCrosses(window, this.upperBand, this.lowerBand);
    if (cr.up > 0 && cr.down > 0 && cr.total >= cfg.chopCrosses) {
      this.event('CHOP_DETECTED', `chop in hedge: up=${cr.up} down=${cr.down}`);
      await this.flattenAll('chop_in_hedge');
      return;
    }

    // CASE A — TREND CONFIRMED: price extended further past band.
    if (this.breakoutDirection === 'UP' && price > this.upperBand * (1 + cfg.breakoutPercent + cfg.trendConfirmPercent)) {
      this.event('TREND_CONFIRMED', 'trend up confirmed');
      await this.flattenAll('trend_up_confirmed');
      return;
    }
    if (this.breakoutDirection === 'DOWN' && price < this.lowerBand * (1 - cfg.breakoutPercent - cfg.trendConfirmPercent)) {
      this.event('TREND_CONFIRMED', 'trend down confirmed');
      await this.flattenAll('trend_down_confirmed');
      return;
    }

    // CASE B — FAKE BREAKOUT: price returned inside range within N candles
    // of breakout.
    const insideRange = price >= this.lowerBand && price <= this.upperBand;
    const lastCandle = candles[candles.length - 1];
    if (insideRange && lastCandle) {
      // Count timeframe-candles since breakout
      const tfMs = candleIntervalMs(cfg.timeframe);
      const candlesSinceBreakout =
        tfMs > 0 ? Math.floor((lastCandle.openTime - this.breakoutCandleTime) / tfMs) : 0;
      if (candlesSinceBreakout <= cfg.fakeBreakoutCandles) {
        this.event('FAKE_BREAKOUT', `fake breakout — back inside in ${candlesSinceBreakout} candles`);
        await this.closeHedge('fake_breakout', price);
        // Re-enable grid (reuse same range).
        await this.placeGrid(price);
        this.breakoutDetected = false;
        this.breakoutDirection = null;
        this.transitionTo(BotState.GRID);
        return;
      }
    }
  }

  // ------- Helpers: range / orders --------------------------------------

  private async placeGrid(currentPrice: number): Promise<void> {
    const cfg = CONFIG().grid;
    const filters = this.exec.symbolFilters(this.symbol);
    const raw = generateLevels(this.lowerBand, this.upperBand, cfg.spacing);
    const sorted = raw
      .map((p) => quantize(p, filters.tickSize))
      .filter((p) => p > 0)
      .sort((a, b) => a - b);

    this.levels = [];
    this.levelByPrice.clear();
    for (let i = 0; i < sorted.length; i++) {
      const price = sorted[i] as number;
      const isBuy = price < currentPrice;
      // STEP 6: TP is next level in profit direction.
      const tpPrice = isBuy
        ? (sorted[i + 1] as number | undefined) ?? price * (1 + cfg.spacing)
        : (sorted[i - 1] as number | undefined) ?? price * (1 - cfg.spacing);
      const lvl: GridLevel = {
        price,
        side: isBuy ? 'BUY' : 'SELL',
        entryOrderId: null,
        tpOrderId: null,
        tpPrice,
        filled: false,
        filledPrice: 0,
        filledQty: 0,
      };
      this.levels.push(lvl);
      this.levelByPrice.set(price, lvl);
    }

    this.event('GRID_PLACED', `placed ${this.levels.length} grid levels`, {
      buys: this.levels.filter((l) => l.side === 'BUY').length,
      sells: this.levels.filter((l) => l.side === 'SELL').length,
    });

    await this.maintainGridOrders(currentPrice);
  }

  /** Place / replace any missing entry orders, respecting position caps.
   * Caps include in-flight entry orders + already-open positions so we never
   * over-commit if multiple grid levels fill simultaneously. */
  private async maintainGridOrders(currentPrice: number): Promise<void> {
    const cfg = CONFIG().grid;
    const filters = this.exec.symbolFilters(this.symbol);
    let openLongs = this.positions.filter((p) => p.side === 'LONG').length;
    let openShorts = this.positions.filter((p) => p.side === 'SHORT').length;
    let pendingBuys = this.levels.filter((l) => l.side === 'BUY' && l.entryOrderId !== null).length;
    let pendingSells = this.levels.filter((l) => l.side === 'SELL' && l.entryOrderId !== null).length;

    for (const lvl of this.levels) {
      if (lvl.filled) continue;          // already in a position from this level
      if (lvl.entryOrderId !== null) continue; // already has an open order
      // Per-side and total caps — include pending entry orders.
      const totalCommitted = openLongs + openShorts + pendingBuys + pendingSells;
      if (totalCommitted >= cfg.maxTotalPositions) continue;
      if (lvl.side === 'BUY' && openLongs + pendingBuys >= cfg.maxOpenPositionsPerSide) continue;
      if (lvl.side === 'SELL' && openShorts + pendingSells >= cfg.maxOpenPositionsPerSide) continue;
      // Don't place an order on the wrong side of the current price (it would
      // fill instantly and skip the grid premise).
      if (lvl.side === 'BUY' && lvl.price >= currentPrice) continue;
      if (lvl.side === 'SELL' && lvl.price <= currentPrice) continue;

      // Quantize qty so notional ≈ orderNotionalUsdt and ≥ minNotional.
      const targetQty = cfg.orderNotionalUsdt / lvl.price;
      const qty = quantize(targetQty, filters.stepSize);
      if (qty <= 0) continue;
      if (qty * lvl.price < filters.minNotional) continue;

      const cid = this.newOrderId('g');
      lvl.entryOrderId = cid;
      this.orderIndex.set(cid, { kind: 'GRID_ENTRY', levelPrice: lvl.price });
      if (lvl.side === 'BUY') pendingBuys += 1;
      else pendingSells += 1;
      await this.exec
        .placeOrder({
          clientOrderId: cid,
          symbol: this.symbol,
          side: lvl.side,
          positionSide: lvl.side === 'BUY' ? Side.LONG : Side.SHORT,
          type: 'LIMIT',
          qty,
          price: lvl.price,
          purpose: 'GRID',
        })
        .catch((e) => {
          lvl.entryOrderId = null;
          this.orderIndex.delete(cid);
          if (lvl.side === 'BUY') pendingBuys -= 1;
          else pendingSells -= 1;
          log.error({ symbol: this.symbol, level: lvl.price, err: (e as Error).message }, 'grid entry failed');
        });
    }
    void openLongs; void openShorts; // referenced via captured locals above
  }

  private async cancelAllOpenOrders(): Promise<void> {
    for (const lvl of this.levels) {
      if (lvl.entryOrderId) {
        const id = lvl.entryOrderId;
        lvl.entryOrderId = null;
        this.orderIndex.delete(id);
        await this.exec.cancelOrder(this.symbol, id).catch(() => undefined);
      }
      if (lvl.tpOrderId) {
        const id = lvl.tpOrderId;
        lvl.tpOrderId = null;
        this.orderIndex.delete(id);
        await this.exec.cancelOrder(this.symbol, id).catch(() => undefined);
      }
    }
  }

  // ------- Hedge management ---------------------------------------------

  private async openHedge(price: number): Promise<void> {
    const longSize = this.positions.filter((p) => p.side === 'LONG').reduce((s, p) => s + p.size, 0);
    const shortSize = this.positions.filter((p) => p.side === 'SHORT').reduce((s, p) => s + p.size, 0);
    const net = longSize - shortSize;
    if (Math.abs(net) <= 0) {
      this.event('HEDGE_OPENED', 'no net exposure — hedge skipped');
      return;
    }
    const filters = this.exec.symbolFilters(this.symbol);
    const qty = quantize(Math.abs(net), filters.stepSize);
    if (qty <= 0) return;
    if (qty * price < filters.minNotional) {
      this.event('HEDGE_OPENED', 'hedge below minNotional — skipped');
      return;
    }

    const hedgeSide: 'LONG' | 'SHORT' = net < 0 ? 'LONG' : 'SHORT';
    const orderSide: 'BUY' | 'SELL' = hedgeSide === 'LONG' ? 'BUY' : 'SELL';
    const cid = this.newOrderId('h');
    this.orderIndex.set(cid, { kind: 'HEDGE_OPEN' });
    // Set hedge placeholder so subsequent ticks know one is in flight.
    this.hedge = {
      side: hedgeSide,
      size: 0, // updated on fill
      entryPrice: 0,
      openedAt: Date.now(),
      orderId: cid,
    };
    await this.exec
      .placeOrder({
        clientOrderId: cid,
        symbol: this.symbol,
        side: orderSide,
        positionSide: hedgeSide as Side,
        type: OrderType.MARKET,
        qty,
        purpose: 'HEDGE',
      })
      .catch((e) => {
        this.hedge = null;
        this.orderIndex.delete(cid);
        log.error({ err: (e as Error).message }, 'hedge open failed');
      });
    this.event('HEDGE_OPENED', `hedge ${hedgeSide} qty=${qty} (net=${net.toFixed(6)})`);
  }

  private async closeHedge(reason: string, price: number): Promise<void> {
    const h = this.hedge;
    if (!h || h.size <= 0) {
      this.hedge = null;
      return;
    }
    const closeSide: 'BUY' | 'SELL' = h.side === 'LONG' ? 'SELL' : 'BUY';
    const cid = this.newOrderId('hc');
    this.orderIndex.set(cid, { kind: 'HEDGE_CLOSE' });
    await this.exec
      .placeOrder({
        clientOrderId: cid,
        symbol: this.symbol,
        side: closeSide,
        positionSide: h.side as Side,
        type: OrderType.MARKET,
        qty: h.size,
        reduceOnly: true,
        purpose: 'HEDGE_CLOSE',
      })
      .catch((e) => log.error({ err: (e as Error).message }, 'hedge close failed'));
    this.event('HEDGE_CLOSED', `closing hedge: ${reason}`, { price });
  }

  // ------- Fill handlers ------------------------------------------------

  private async handleGridEntryFill(f: FillRecord, levelPrice: number): Promise<void> {
    const lvl = this.levelByPrice.get(levelPrice);
    if (!lvl) return;
    lvl.entryOrderId = null;
    this.orderIndex.delete(f.clientOrderId);
    lvl.filled = true;
    lvl.filledPrice = f.price;
    lvl.filledQty = f.qty;

    const pos: GridPosition = {
      levelPrice,
      side: lvl.side === 'BUY' ? 'LONG' : 'SHORT',
      size: f.qty,
      entryPrice: f.price,
      tpPrice: lvl.tpPrice,
      openedAt: f.ts,
    };
    this.positions.push(pos);
    this.event('GRID_FILLED', `level ${levelPrice} ${lvl.side} filled @ ${f.price}`);

    // Place TP immediately.
    const tpSide: 'BUY' | 'SELL' = lvl.side === 'BUY' ? 'SELL' : 'BUY';
    const tpId = this.newOrderId('gtp');
    lvl.tpOrderId = tpId;
    this.orderIndex.set(tpId, { kind: 'GRID_TP', levelPrice });
    await this.exec
      .placeOrder({
        clientOrderId: tpId,
        symbol: this.symbol,
        side: tpSide,
        positionSide: pos.side as Side,
        type: 'LIMIT',
        qty: f.qty,
        price: lvl.tpPrice,
        reduceOnly: true,
        purpose: 'GRID_TP',
      })
      .catch((e) => {
        lvl.tpOrderId = null;
        this.orderIndex.delete(tpId);
        log.error({ err: (e as Error).message }, 'tp place failed');
      });
  }

  private async handleGridTpFill(f: FillRecord, levelPrice: number): Promise<void> {
    const lvl = this.levelByPrice.get(levelPrice);
    if (!lvl) return;
    const posIdx = this.positions.findIndex((p) => p.levelPrice === levelPrice);
    if (posIdx === -1) return;
    const pos = this.positions[posIdx] as GridPosition;
    this.positions.splice(posIdx, 1);
    lvl.filled = false;
    lvl.tpOrderId = null;
    lvl.filledPrice = 0;
    lvl.filledQty = 0;
    this.orderIndex.delete(f.clientOrderId);

    await this.exec.creditRealizedPnl({
      symbol: this.symbol,
      side: pos.side === 'LONG' ? Side.LONG : Side.SHORT,
      entryPrice: pos.entryPrice,
      exitPrice: f.price,
      qty: f.qty,
      fees: f.fee,
      leverage: CONFIG().trading.leverage,
      reason: 'grid_tp',
      openedAt: pos.openedAt,
    });
    this.event('GRID_TP_FILLED', `level ${levelPrice} TP @ ${f.price}`);
  }

  private async handleHedgeOpenFill(f: FillRecord): Promise<void> {
    if (!this.hedge) return;
    this.hedge.size = f.qty;
    this.hedge.entryPrice = f.price;
    this.orderIndex.delete(f.clientOrderId);
  }

  private async handleHedgeCloseFill(f: FillRecord): Promise<void> {
    const h = this.hedge;
    this.orderIndex.delete(f.clientOrderId);
    if (!h) return;
    await this.exec.creditRealizedPnl({
      symbol: this.symbol,
      side: h.side === 'LONG' ? Side.LONG : Side.SHORT,
      entryPrice: h.entryPrice,
      exitPrice: f.price,
      qty: f.qty,
      fees: f.fee,
      leverage: CONFIG().trading.leverage,
      reason: 'hedge_close',
      openedAt: h.openedAt,
    });
    this.hedge = null;
  }

  // ------- Misc helpers --------------------------------------------------

  private transitionTo(next: BotState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.lastTransitionAt = Date.now();
    this.event('STATE_CHANGE', `${prev} → ${next}`);
    log.info({ symbol: this.symbol, from: prev, to: next }, 'state_change');
  }

  private event(type: GridEventType, msg: string, data?: Record<string, unknown>): void {
    const ev: GridEvent = { ts: Date.now(), symbol: this.symbol, type, msg, ...(data && { data }) };
    this.events.push(ev);
    if (this.events.length > MAX_EVENT_HISTORY * 2) {
      this.events.splice(0, this.events.length - MAX_EVENT_HISTORY);
    }
    if (CONFIG().debug) log.info({ symbol: this.symbol, type, msg, data }, 'grid_event');
  }

  private newOrderId(prefix: string): string {
    this.orderSeq += 1;
    const sym = this.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
    return `${prefix}-${sym}-${Date.now()}-${this.orderSeq}`.slice(0, 36);
  }

  private async maybePersist(): Promise<void> {
    if (!this.persist) return;
    try {
      await this.persist(this.snapshot());
    } catch (e) {
      log.debug({ err: (e as Error).message }, 'persist failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Local: very small interval parser, intentionally not importing time util to
// avoid a cycle.
// ---------------------------------------------------------------------------
function candleIntervalMs(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  if (unit === 'd') return n * 86_400_000;
  return 0;
}
