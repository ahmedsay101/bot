const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({ log: jest.fn() }));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  recordTraderResult: jest.fn(),
  getStatus: jest.fn(() => ({ equity: 80 }))
}));

const PerpetualTrader = require("../src/core/perpetualTrader");
const config = require("../src/utils/config");
const store = require("../src/state/store");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orderSeq = 0;
  }
  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }
  async placeMarketOrder() {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
  async placeLimitOrder() {
    return { orderId: `L-${++this.orderSeq}` };
  }
  async placeStopLimitOrder() {
    return { orderId: `S-${++this.orderSeq}` };
  }
  async cancelOrder() { return { orderId: "x", status: "CANCELED" }; }
  setPrice(p) { this.price = p; }
}

function makeTrader(overrides = {}) {
  const api = overrides.api || new FakeApi({ price: overrides.price || 100 });
  const onDestroy = overrides.onDestroy || jest.fn();
  const trader = new PerpetualTrader({
    symbol: "TESTUSDT",
    api,
    onDestroy,
    leverage: overrides.leverage || 10,
    ...overrides.extra
  });
  trader._minTradeIntervalMs = 0; // disable rate limiter in tests
  return { trader, api, onDestroy };
}

describe("PerpetualTrader (Independent Dual-Position)", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      takeProfitPercent: 1,
      stopLossPercent: 2,
      createNewPositionAt: 1,
      leverage: 10,
      feeRate: 0
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  // ── Initialization ────────────────────────────────────────────

  test("opens initial SHORT position on start", async () => {
    const { trader, api } = makeTrader();
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ side: "SELL", positionSide: "SHORT" })
    );
    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.direction).toBe("SHORT");
    expect(trader.shortPosition.openReason).toBe("initial");
    expect(trader.longPosition).toBeNull();
    expect(trader.traderType).toBe("PERPETUAL");
    expect(trader.active).toBe(true);
    expect(store.upsertTrader).toHaveBeenCalled();
  });

  test("sets TP and SL correctly for SHORT", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.shortPosition;
    // SHORT: TP = 99 (1% below), SL = 102 (2% above)
    expect(pos.tpPrice).toBeCloseTo(99, 4);
    expect(pos.slPrice).toBeCloseTo(102, 4);
  });

  test("sets TP and SL correctly for LONG", async () => {
    const { trader } = makeTrader({ price: 100 });
    trader.startDirection = "LONG";
    await trader.start();

    const pos = trader.longPosition;
    // LONG: TP = 101 (1% above), SL = 98 (2% below)
    expect(pos.tpPrice).toBeCloseTo(101, 4);
    expect(pos.slPrice).toBeCloseTo(98, 4);
  });

  // ── Solo Take Profit ─────────────────────────────────────────

  test("solo SHORT TP closes and re-opens same direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");
    await trader.start();

    // SHORT TP at 99 → price drops below
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.direction).toBe("SHORT");
    expect(trader.shortPosition.openReason).toBe("take-profit");
    expect(trader.longPosition).toBeNull();
    expect(trader.wins).toBe(1);
    expect(trader.losses).toBe(0);
    expect(trader.totalTrades).toBe(1);
    // 2 orders: open + re-open (TP exit handled by exchange order)
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("solo TP PnL is positive", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.realizedPnl).toBeGreaterThan(0);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].grossPnl).toBeGreaterThan(0);
  });

  test("multiple solo TPs continue same direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.wins).toBe(1);
    expect(trader.consecutiveSameDir).toBe(1);

    api.setPrice(97);
    await trader._checkPosition(97);
    expect(trader.wins).toBe(2);
    expect(trader.consecutiveSameDir).toBe(2);

    api.setPrice(95.5);
    await trader._checkPosition(95.5);
    expect(trader.wins).toBe(3);
    expect(trader.consecutiveSameDir).toBe(3);
    expect(trader.totalTrades).toBe(3);
  });

  // ── Hedge Trigger ─────────────────────────────────────────────

  test("position losing by TP% opens counter-position", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");
    await trader.start();

    // SHORT at 100, loses 1% at 101 → opens LONG
    api.setPrice(101);
    await trader._checkPosition(101);

    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.direction).toBe("SHORT");
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.direction).toBe("LONG");
    expect(trader.longPosition.openReason).toBe("hedge");

    // No trades closed
    expect(trader.totalTrades).toBe(0);
    expect(trader.wins).toBe(0);
    expect(trader.losses).toBe(0);

    // 2 orders: initial short + hedge long
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("hedge LONG has correct TP and SL", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101);
    await trader._checkPosition(101);

    const long = trader.longPosition;
    // LONG at 101: TP = 102.01, SL = 98.98
    expect(long.tpPrice).toBeCloseTo(102.01, 4);
    expect(long.slPrice).toBeCloseTo(98.98, 4);
  });

  test("hedge does not trigger before TP% threshold", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(100.5);
    await trader._checkPosition(100.5);

    expect(trader.longPosition).toBeNull();
    expect(trader.shortPosition.direction).toBe("SHORT");
  });

  test("hedge does not trigger when counter-slot already occupied", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Open hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    expect(trader.longPosition).not.toBeNull();

    const longEntry = trader.longPosition.entryPrice;

    // Price moves more against SHORT — but LONG already exists, no second LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    expect(trader.longPosition.entryPrice).toBe(longEntry); // unchanged
  });

  // ── TP While Hedged (independent close) ───────────────────────

  test("LONG TP while SHORT open → close LONG only, reopen LONG, SHORT stays", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger LONG hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    expect(trader.longPosition).not.toBeNull();
    const shortEntry = trader.shortPosition.entryPrice;

    // LONG TP at 102.01 → price 103
    api.setPrice(103);
    await trader._checkPosition(103);

    // SHORT untouched
    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.entryPrice).toBe(shortEntry);
    // LONG reopened (new entry at 103)
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.entryPrice).toBe(103);
    expect(trader.longPosition.openReason).toBe("take-profit");

    expect(trader.wins).toBe(1);
    expect(trader.losses).toBe(0);
    expect(trader.totalTrades).toBe(1);
  });

  test("SHORT TP while LONG open → close SHORT only, reopen SHORT, LONG stays", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    const longEntry = trader.longPosition.entryPrice;

    // SHORT TP at 99 → price 98.5
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // LONG untouched
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.entryPrice).toBe(longEntry);
    // SHORT reopened
    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.entryPrice).toBe(98.5);
    expect(trader.shortPosition.openReason).toBe("take-profit");

    expect(trader.wins).toBe(1);
    expect(trader.losses).toBe(0);
  });

  // ── SL While Hedged (independent close) ───────────────────────

  test("SHORT SL while LONG open → close SHORT only, LONG stays", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    const longEntry = trader.longPosition.entryPrice;

    // SHORT SL at 102
    api.setPrice(102);
    await trader._checkPosition(102);

    expect(trader.shortPosition).toBeNull();
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.entryPrice).toBe(longEntry);

    expect(trader.losses).toBe(1);
    expect(trader.wins).toBe(0);
    expect(trader.totalTrades).toBe(1);
  });

  test("LONG SL after being left alone → close LONG (loss)", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger LONG hedge at 101
    api.setPrice(101);
    await trader._checkPosition(101);
    expect(trader.longPosition).not.toBeNull();

    // SHORT SL at 102 → close SHORT, only LONG remains
    api.setPrice(102);
    await trader._checkPosition(102);
    expect(trader.shortPosition).toBeNull();
    expect(trader.longPosition).not.toBeNull();
    expect(trader.losses).toBe(1);

    // LONG at 101 loses by 1% at ~99.99 → hedge trigger opens SHORT
    api.setPrice(99.98);
    await trader._checkPosition(99.98);
    expect(trader.shortPosition).not.toBeNull();

    // LONG SL at 98.98
    api.setPrice(98.98);
    await trader._checkPosition(98.98);

    // SHORT TP (at ~98.98) fires before LONG SL (at 98.98)
    // so TP fires first as a win, then LONG SL on next tick
    await trader._checkPosition(98.98);

    expect(trader.longPosition).toBeNull();
    expect(trader.losses).toBe(2);
  });

  test("SL loss PnL is negative", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge so SL can fire
    api.setPrice(101);
    await trader._checkPosition(101);

    // SHORT SL at 102
    api.setPrice(102);
    await trader._checkPosition(102);

    const trade = trader.tradeHistory[0];
    expect(trade.reason).toBe("stop-loss");
    expect(trade.grossPnl).toBeLessThan(0);
    expect(trader.realizedPnl).toBeLessThan(0);
  });

  // ── Full Cycle ────────────────────────────────────────────────

  test("solo TP → hedge → SL → remaining continues", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // 1. Solo SHORT TP
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.wins).toBe(1);
    expect(trader.shortPosition.direction).toBe("SHORT");
    expect(trader.longPosition).toBeNull();

    // 2. Hedge trigger (SHORT at 98.5, loses 1% at ~99.485)
    const hedgeTrigger = trader.shortPosition.entryPrice * 1.01;
    api.setPrice(hedgeTrigger + 0.01);
    await trader._checkPosition(hedgeTrigger + 0.01);
    expect(trader.longPosition).not.toBeNull();

    // 3. SHORT SL hits
    api.setPrice(trader.shortPosition.slPrice);
    await trader._checkPosition(trader.shortPosition.slPrice);
    expect(trader.shortPosition).toBeNull();
    expect(trader.longPosition).not.toBeNull();
    expect(trader.losses).toBe(1);

    // 4. LONG continues — can TP
    api.setPrice(trader.longPosition.tpPrice + 0.01);
    await trader._checkPosition(trader.longPosition.tpPrice + 0.01);
    expect(trader.wins).toBe(2);
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.openReason).toBe("take-profit");
  });

  test("hedge → both TP and SL fire in sequence", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Hedge trigger
    api.setPrice(101);
    await trader._checkPosition(101);
    // SHORT(100, TP=99, SL=102) + LONG(101, TP=102.01, SL=98.98)

    // SHORT SL at 102 fires first (before LONG TP at 102.01)
    api.setPrice(102);
    await trader._checkPosition(102);
    expect(trader.shortPosition).toBeNull();
    expect(trader.longPosition).not.toBeNull();
    expect(trader.losses).toBe(1);

    // Then LONG TP at 102.01
    api.setPrice(102.01);
    await trader._checkPosition(102.01);
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.openReason).toBe("take-profit");
    expect(trader.wins).toBe(1);
  });

  // ── After SL Solo, Hedge Trigger Still Works ──────────────────

  test("after SL leaves one position, that position can trigger counter", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge
    api.setPrice(101);
    await trader._checkPosition(101);

    // SHORT SL at 102
    api.setPrice(102);
    await trader._checkPosition(102);
    expect(trader.shortPosition).toBeNull();
    expect(trader.longPosition).not.toBeNull();

    // LONG at 101, losing by 1% at 99.99 → hedge trigger → SHORT opens
    api.setPrice(99.99);
    await trader._checkPosition(99.99);
    expect(trader.shortPosition).not.toBeNull();
    expect(trader.shortPosition.openReason).toBe("hedge");
  });

  // ── Destroy ───────────────────────────────────────────────────

  test("destroy closes single position", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");
    await trader.start();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(2); // open + close
  });

  test("destroy closes both positions when hedged", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");
    await trader.start();

    api.setPrice(101);
    await trader._checkPosition(101);

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    // open short + open long + close long + close short = 4
    expect(spy).toHaveBeenCalledTimes(4);
  });

  // ── Never Auto-Destroys ───────────────────────────────────────

  test("never auto-destroys through many cycles", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    await trader.start();

    for (let i = 0; i < 5; i++) {
      // Trigger hedge
      const shortPos = trader.shortPosition || trader.longPosition;
      if (!shortPos) break;

      if (trader.shortPosition && !trader.longPosition) {
        const trigger = trader.shortPosition.entryPrice * 1.01;
        api.setPrice(trigger);
        await trader._checkPosition(trigger);
      } else if (trader.longPosition && !trader.shortPosition) {
        const trigger = trader.longPosition.entryPrice * 0.99;
        api.setPrice(trigger);
        await trader._checkPosition(trigger);
      }

      // Hit SL on original position
      if (trader.shortPosition && trader.longPosition) {
        const sl = trader.shortPosition.slPrice;
        api.setPrice(sl);
        await trader._checkPosition(sl);
      }

      // TP the remaining position
      const rem = trader.longPosition || trader.shortPosition;
      if (rem) {
        if (rem.direction === "LONG") {
          api.setPrice(rem.tpPrice + 0.01);
          await trader._checkPosition(rem.tpPrice + 0.01);
        } else {
          api.setPrice(rem.tpPrice - 0.01);
          await trader._checkPosition(rem.tpPrice - 0.01);
        }
      }
    }

    expect(trader.active).toBe(true);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  // ── Notional Constant ─────────────────────────────────────────

  test("notional stays constant across all positions", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const n = trader.shortPosition.notional;

    // Solo TP
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.shortPosition.notional).toBe(n);

    // Hedge trigger (add 0.1 to avoid floating-point edge)
    const trigger = trader.shortPosition.entryPrice * 1.01 + 0.1;
    api.setPrice(trigger);
    await trader._checkPosition(trigger);
    expect(trader.longPosition).not.toBeNull();
    expect(trader.longPosition.notional).toBe(n);

    // LONG TP → new LONG
    api.setPrice(trader.longPosition.tpPrice + 0.01);
    await trader._checkPosition(trader.longPosition.tpPrice + 0.01);
    expect(trader.longPosition.notional).toBe(n);
  });

  // ── Fee Calculations ──────────────────────────────────────────

  test("fees tracked for solo TP", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.shortPosition;
    const entryFee = pos.entryPrice * pos.quantity * 0.0004;
    expect(pos.entryFee).toBeCloseTo(entryFee, 8);

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const trade = trader.tradeHistory[0];
    expect(trade.fees).toBeGreaterThan(0);
  });

  test("fees tracked for both positions in hedge", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101);
    await trader._checkPosition(101);

    const feesAfterHedge = trader.feesPaid;
    expect(feesAfterHedge).toBeGreaterThan(0);

    // SL closes SHORT
    api.setPrice(102);
    await trader._checkPosition(102);

    expect(trader.feesPaid).toBeGreaterThan(feesAfterHedge);
    expect(trader.tradeHistory[0].fees).toBeGreaterThan(0);
  });

  test("net PnL = gross PnL - fees", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const trade = trader.tradeHistory[0];
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.fees, 8);
  });

  // ── Unrealized PnL ────────────────────────────────────────────

  test("unrealized PnL includes both positions when hedged", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101);
    await trader._checkPosition(101);

    const unrealized = trader._calcUnrealizedPnl(102);
    expect(Number.isFinite(unrealized)).toBe(true);
  });

  test("unrealized PnL is 0 when no positions", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();
    trader.shortPosition = null;
    expect(trader._calcUnrealizedPnl(100)).toBe(0);
  });

  // ── Streak Tracking ──────────────────────────────────────────

  test("win streak tracks consecutive TPs", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.currentStreak).toBe(1);

    api.setPrice(97);
    await trader._checkPosition(97);
    expect(trader.currentStreak).toBe(2);

    api.setPrice(95.5);
    await trader._checkPosition(95.5);
    expect(trader.currentStreak).toBe(3);
    expect(trader.longestWinStreak).toBe(3);
  });

  test("loss streak tracks SL hits", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge, then SL
    api.setPrice(101);
    await trader._checkPosition(101);
    api.setPrice(102); // SHORT SL
    await trader._checkPosition(102);
    expect(trader.currentStreak).toBe(-1);
    expect(trader.longestLossStreak).toBe(1);
  });

  test("streak resets on win after losses", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Loss: trigger hedge, then SL
    api.setPrice(101);
    await trader._checkPosition(101);
    api.setPrice(102); // SHORT SL
    await trader._checkPosition(102);
    expect(trader.currentStreak).toBe(-1);

    // Win: LONG TP
    api.setPrice(trader.longPosition.tpPrice + 0.01);
    await trader._checkPosition(trader.longPosition.tpPrice + 0.01);
    expect(trader.currentStreak).toBe(1);
  });

  // ── Store Updates ─────────────────────────────────────────────

  test("store.recordTrade called for each close", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Solo TP → 1 close
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(store.recordTrade).toHaveBeenCalledTimes(1);

    // Hedge trigger (no trade close)
    const trigger = trader.shortPosition.entryPrice * 1.01 + 0.1;
    api.setPrice(trigger);
    await trader._checkPosition(trigger);
    expect(store.recordTrade).toHaveBeenCalledTimes(1); // unchanged

    // SHORT SL — at SL price, hedge fires first (hedge check is before SL)
    // so we need two calls: first opens hedge, second fires SL
    api.setPrice(trader.shortPosition.slPrice);
    await trader._checkPosition(trader.shortPosition.slPrice);
    // This tick might be the SHORT SL or another hedge trigger
    // Call again to ensure SL fires
    await trader._checkPosition(trader.shortPosition ? trader.shortPosition.slPrice : api.price);
    expect(store.recordTrade).toHaveBeenCalledTimes(2);
  });

  test("store.upsertTrader includes longPosition/shortPosition", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101);
    await trader._checkPosition(101);

    const calls = store.upsertTrader.mock.calls;
    const lastCall = calls[calls.length - 1][0];

    expect(lastCall.longPosition).not.toBeNull();
    expect(lastCall.longPosition.direction).toBe("LONG");
    expect(lastCall.shortPosition).not.toBeNull();
    expect(lastCall.shortPosition.direction).toBe("SHORT");
    expect(lastCall.openPositions).toBe(2);
  });

  // ── Edge Cases ────────────────────────────────────────────────

  test("does not process when already processing", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    trader._processing = true;
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.totalTrades).toBe(0);
  });

  test("ignores price updates for other symbols", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.emit("markPrice", { symbol: "BTCUSDT", price: 50 });

    expect(trader.lastPrice).toBe(100);
  });

  test("leverage is stored on trader instance", async () => {
    const { trader } = makeTrader({ leverage: 125 });
    await trader.start();
    expect(trader.leverage).toBe(125);
  });

  test("trade history includes openReason field", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.tradeHistory[0].openReason).toBe("initial");
    expect(trader.tradeHistory[0].closedAt).toBeDefined();
  });

  test("tradeNumber increments across positions", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    expect(trader.shortPosition.tradeNumber).toBe(1);

    // Trigger hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    expect(trader.longPosition.tradeNumber).toBe(2);

    // SHORT SL → trade #1 closed
    api.setPrice(102);
    await trader._checkPosition(102);

    // LONG TP → trade #2 closed, new LONG #3
    api.setPrice(trader.longPosition.tpPrice + 0.01);
    await trader._checkPosition(trader.longPosition.tpPrice + 0.01);
    expect(trader.longPosition.tradeNumber).toBe(3);
  });

  // ── Max 1 per direction constraint ────────────────────────────

  test("cannot have two positions of the same direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge → SHORT + LONG
    api.setPrice(101);
    await trader._checkPosition(101);

    expect(trader.shortPosition).not.toBeNull();
    expect(trader.longPosition).not.toBeNull();

    // Price goes more against SHORT but LONG exists, no second LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    // Still exactly 1 LONG and 1 SHORT
    expect(trader.longPosition.openReason).toBe("hedge");
    expect(trader.shortPosition.openReason).toBe("initial");
  });

  // ── SL closes at SL price ────────────────────────────────────

  test("SL closes at SL price, not market price", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trigger hedge
    api.setPrice(101);
    await trader._checkPosition(101);
    expect(trader.longPosition).not.toBeNull();

    // At 102: SHORT SL fires (before LONG TP at 102.01)
    api.setPrice(102);
    await trader._checkPosition(102);

    const trade = trader.tradeHistory[0];
    expect(trade.reason).toBe("stop-loss");
    expect(trade.exit).toBeCloseTo(102, 4); // SL price, not market
    expect(trade.direction).toBe("SHORT");
  });

  // ── No hedge-close reason exists ──────────────────────────────

  test("only take-profit, stop-loss, destroy reasons exist", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Solo TP
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Hedge + SL
    api.setPrice(trader.shortPosition.entryPrice * 1.01);
    await trader._checkPosition(trader.shortPosition.entryPrice * 1.01);
    api.setPrice(trader.shortPosition.slPrice);
    await trader._checkPosition(trader.shortPosition.slPrice);

    // LONG TP
    api.setPrice(trader.longPosition.tpPrice + 0.01);
    await trader._checkPosition(trader.longPosition.tpPrice + 0.01);

    await trader.destroy("manual");

    const reasons = trader.tradeHistory.map(t => t.reason);
    const validReasons = new Set(["take-profit", "stop-loss", "destroy"]);
    for (const r of reasons) {
      expect(validReasons.has(r)).toBe(true);
    }
    expect(reasons).not.toContain("hedge-close");
  });

  // ── Scenario Tests (TP=2%, SL=4%, createNewPositionAt=2%) ─────

  describe("Scenario: TP=2%, SL=4%, createNewPositionAt=2%", () => {
    beforeEach(() => {
      Object.assign(config, {
        takeProfitPercent: 2,
        stopLossPercent: 4,
        createNewPositionAt: 2,
        feeRate: 0
      });
    });

    /*
     * Scenario 1: SHORT at 100 → price drops 1% → rises 5%
     *
     * SHORT@100  TP=98  SL=104  hedgeTrigger=102
     *
     * Step 1: Price → 99 (1% down). No TP hit (needs 98). SHORT stays.
     * Step 2: Price → 102 (2% above entry). LONG hedge opens at 102.
     *         LONG@102  TP=104.04
     * Step 3: Price → 104. SHORT SL hit (104 ≥ 104). SHORT closed (loss).
     * Step 4: Price → 104.05. LONG TP hit (104.05 ≥ 104.04). LONG closed
     *         (win), new LONG opens at 104.05.
     *
     * End state: 1 LONG position.  Trades: 1 win + 1 loss.
     */
    test("scenario 1: short → 1% dip → 5% rally → hedge → SL + TP", async () => {
      const { trader, api } = makeTrader({ price: 100 });
      await trader.start();

      const short = trader.shortPosition;
      expect(short.entryPrice).toBe(100);
      expect(short.tpPrice).toBeCloseTo(98, 4);    // 2% below
      expect(short.slPrice).toBeCloseTo(104, 4);    // 4% above

      // 1. Price drops 1% → no TP
      api.setPrice(99);
      await trader._checkPosition(99);
      expect(trader.shortPosition).not.toBeNull();
      expect(trader.longPosition).toBeNull();
      expect(trader.totalTrades).toBe(0);

      // 2. Price rises to 102 → LONG hedge opens (2% above 100)
      api.setPrice(102);
      await trader._checkPosition(102);
      expect(trader.longPosition).not.toBeNull();
      expect(trader.longPosition.direction).toBe("LONG");
      expect(trader.longPosition.openReason).toBe("hedge");
      expect(trader.longPosition.entryPrice).toBe(102);
      expect(trader.longPosition.tpPrice).toBeCloseTo(104.04, 4); // 2% above 102
      expect(trader.shortPosition).not.toBeNull(); // SHORT still open

      // 3. Price rises to 104 → SHORT SL fires (104 ≥ 104)
      api.setPrice(104);
      await trader._checkPosition(104);
      expect(trader.shortPosition).toBeNull(); // SHORT closed (SL)
      expect(trader.longPosition).not.toBeNull();
      expect(trader.losses).toBe(1);

      // 4. Price rises to 104.05 → LONG TP fires (104.05 ≥ 104.04)
      api.setPrice(104.05);
      await trader._checkPosition(104.05);
      expect(trader.longPosition).not.toBeNull();
      expect(trader.longPosition.openReason).toBe("take-profit"); // reopened
      expect(trader.longPosition.entryPrice).toBe(104.05);
      expect(trader.shortPosition).toBeNull();
      expect(trader.wins).toBe(1);

      // Verify trade history
      expect(trader.totalTrades).toBe(2);
      const slTrade = trader.tradeHistory.find(t => t.reason === "stop-loss");
      const tpTrade = trader.tradeHistory.find(t => t.reason === "take-profit");
      expect(slTrade.direction).toBe("SHORT");
      expect(slTrade.grossPnl).toBeLessThan(0);
      expect(tpTrade.direction).toBe("LONG");
      expect(tpTrade.grossPnl).toBeGreaterThan(0);
    });

    /*
     * Scenario 2: Continuing from scenario 1's end state (LONG@104.05),
     *             price drops 5% straight.
     *
     * LONG@104.05  TP≈106.13  SL≈99.888
     *
     * Step 1: Price → ~101.97 (2% below 104.05). SHORT hedge opens.
     *         SHORT@101.97  TP≈99.93  SL≈106.05
     * Step 2: Price → 99.93. SHORT TP fires → close, reopen SHORT.
     *         (LONG SL at 99.888 not yet hit)
     * Step 3: Price → 99.88. LONG SL fires → close LONG (loss).
     *
     * End state: 1 SHORT position.  Trades: 1 win + 1 loss.
     */
    test("scenario 2: long → 5% drop → hedge → SHORT TP + LONG SL", async () => {
      // Start with LONG at 104.05 (end state of scenario 1)
      const { trader, api } = makeTrader({ price: 104.05 });
      trader.startDirection = "LONG";
      await trader.start();

      const long = trader.longPosition;
      expect(long.entryPrice).toBe(104.05);
      // TP = 104.05 * 1.02 = 106.131
      expect(long.tpPrice).toBeCloseTo(106.131, 2);
      // SL = 104.05 * 0.96 = 99.888
      expect(long.slPrice).toBeCloseTo(99.888, 2);

      // 1. Price drops 2% → SHORT hedge opens
      const hedgePrice = 104.05 * 0.98; // = 101.969
      api.setPrice(hedgePrice);
      await trader._checkPosition(hedgePrice);
      expect(trader.shortPosition).not.toBeNull();
      expect(trader.shortPosition.direction).toBe("SHORT");
      expect(trader.shortPosition.openReason).toBe("hedge");
      expect(trader.longPosition).not.toBeNull(); // LONG still open

      const shortTP = trader.shortPosition.tpPrice;
      const longSL = trader.longPosition.slPrice;

      // SHORT TP should fire before LONG SL (short TP > long SL)
      expect(shortTP).toBeGreaterThan(longSL);

      // 2. Price drops to SHORT TP → SHORT closes (TP), reopens SHORT
      api.setPrice(shortTP - 0.01);
      await trader._checkPosition(shortTP - 0.01);
      expect(trader.shortPosition).not.toBeNull();
      expect(trader.shortPosition.openReason).toBe("take-profit"); // reopened
      expect(trader.wins).toBe(1);
      expect(trader.longPosition).not.toBeNull(); // LONG still open

      // 3. Price drops to LONG SL → LONG closes (SL)
      api.setPrice(longSL);
      await trader._checkPosition(longSL);
      expect(trader.longPosition).toBeNull(); // LONG gone
      expect(trader.shortPosition).not.toBeNull(); // SHORT still alive
      expect(trader.losses).toBe(1);

      // End state
      expect(trader.totalTrades).toBe(2);
      expect(trader.shortPosition.direction).toBe("SHORT");
    });

    test("createNewPositionAt can differ from takeProfitPercent", async () => {
      Object.assign(config, { createNewPositionAt: 3 }); // 3% trigger, 2% TP

      const { trader, api } = makeTrader({ price: 100 });
      await trader.start();

      // 2% loss → no hedge yet (needs 3%)
      api.setPrice(102);
      await trader._checkPosition(102);
      expect(trader.longPosition).toBeNull();

      // 3% loss → hedge triggers
      api.setPrice(103);
      await trader._checkPosition(103);
      expect(trader.longPosition).not.toBeNull();
      expect(trader.longPosition.openReason).toBe("hedge");
    });
  });
});
