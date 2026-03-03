const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({ log: jest.fn() }));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  getStatus: jest.fn(() => ({ equity: 1000 }))
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
  async placeLimitOrder() { return { orderId: `L-${++this.orderSeq}` }; }
  async placeStopLimitOrder() { return { orderId: `S-${++this.orderSeq}` }; }
  async cancelOrder() { return { orderId: "x", status: "CANCELED" }; }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
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
  });
  trader._minTradeIntervalMs = 0; // disable rate limiter in tests
  return { trader, api, onDestroy };
}

describe("PerpetualTrader", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      takeProfitPercent: 1,
      stopLossPercent: 2,
      leverage: 10,
      equityFraction: 0.1,
      feeRate: 0,
      startingBalanceUSDT: 1000
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

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ side: "SELL", positionSide: "SHORT" })
    );
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.position.openReason).toBe("initial");
    expect(trader.active).toBe(true);
    expect(trader.traderType).toBe("PERPETUAL");
  });

  test("calculates notional as (equityFraction * equity) * leverage", async () => {
    // equity=1000, fraction=0.1, leverage=10 → notional=1000
    const { trader } = makeTrader();
    await trader.start();
    expect(trader.baseNotional).toBe(100);  // 0.1 * 1000
    expect(trader.notional).toBe(1000);     // 100 * 10
  });

  test("sets TP and SL correctly for SHORT", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();
    // SHORT@100: TP = 99 (1% below), SL = 102 (2% above)
    expect(trader.position.tpPrice).toBeCloseTo(99, 4);
    expect(trader.position.slPrice).toBeCloseTo(102, 4);
  });

  test("sets TP and SL correctly for LONG", async () => {
    const { trader } = makeTrader({ price: 100 });
    trader.startDirection = "LONG";
    await trader.start();
    // LONG@100: TP = 101 (1% above), SL = 98 (2% below)
    expect(trader.position.tpPrice).toBeCloseTo(101, 4);
    expect(trader.position.slPrice).toBeCloseTo(98, 4);
  });

  // ── Take Profit → same direction ─────────────────────────────

  test("TP opens opposite direction (SHORT → LONG)", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // SHORT@100, TP=99
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.wins).toBe(1);
    expect(trader.totalTrades).toBe(1);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("LONG");
    expect(trader.position.openReason).toBe("take-profit");
  });

  test("TP on LONG opens SHORT", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    trader.startDirection = "LONG";
    await trader.start();

    // LONG@100, TP=101
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    expect(trader.wins).toBe(1);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.position.openReason).toBe("take-profit");
  });

  test("TP PnL is positive", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const trade = trader.tradeHistory[0];
    expect(trade.grossPnl).toBeGreaterThan(0);
    expect(trade.reason).toBe("take-profit");
  });

  test("multiple TPs alternate directions", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    expect(trader.position.direction).toBe("SHORT");

    // First TP: SHORT → LONG
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.position.direction).toBe("LONG");

    // Second TP: LONG → SHORT
    const tp2 = trader.position.tpPrice;
    api.setPrice(tp2 + 0.01);
    await trader._checkPosition(tp2 + 0.01);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.wins).toBe(2);
  });

  // ── Stop Loss → opposite direction ────────────────────────────

  test("SL re-opens same direction (SHORT → SHORT)", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // SHORT@100, SL=102
    api.setPrice(102.5);
    await trader._checkPosition(102.5);

    expect(trader.losses).toBe(1);
    expect(trader.totalTrades).toBe(1);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.position.openReason).toBe("stop-loss");
  });

  test("SL on LONG re-opens LONG", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    trader.startDirection = "LONG";
    await trader.start();

    // LONG@100, SL=98
    api.setPrice(97.5);
    await trader._checkPosition(97.5);

    expect(trader.losses).toBe(1);
    expect(trader.position.direction).toBe("LONG");
    expect(trader.position.openReason).toBe("stop-loss");
  });

  test("SL PnL is negative", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(102.5);
    await trader._checkPosition(102.5);

    const trade = trader.tradeHistory[0];
    expect(trade.grossPnl).toBeLessThan(0);
    expect(trade.reason).toBe("stop-loss");
  });

  // ── Full cycle: TP then SL then TP ───────────────────────────

  test("full cycle: SHORT TP → LONG → SL → LONG → TP → SHORT", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    expect(trader.position.direction).toBe("SHORT");

    // 1. SHORT TP (price drops) → flips to LONG
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.position.direction).toBe("LONG"); // flips to opposite
    expect(trader.wins).toBe(1);

    // 2. LONG SL (price drops) → re-opens LONG
    const sl = trader.position.slPrice;
    api.setPrice(sl - 0.01);
    await trader._checkPosition(sl - 0.01);
    expect(trader.position.direction).toBe("LONG"); // re-opens same
    expect(trader.losses).toBe(1);

    // 3. LONG TP (price rises) → flips to SHORT
    const longTp = trader.position.tpPrice;
    api.setPrice(longTp + 0.01);
    await trader._checkPosition(longTp + 0.01);
    expect(trader.position.direction).toBe("SHORT"); // flips to opposite
    expect(trader.wins).toBe(2);
    expect(trader.totalTrades).toBe(3);
  });

  // ── SL closes at SL price, not market ─────────────────────────

  test("SL closes at SL price, not market price", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    const slPrice = trader.position.slPrice;

    api.setPrice(slPrice + 5);
    await trader._checkPosition(slPrice + 5);

    const trade = trader.tradeHistory[0];
    expect(trade.exit).toBeCloseTo(slPrice, 4);
  });

  test("TP closes at TP price, not market price", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    const tpPrice = trader.position.tpPrice;

    api.setPrice(tpPrice - 5);
    await trader._checkPosition(tpPrice - 5);

    const trade = trader.tradeHistory[0];
    expect(trade.exit).toBeCloseTo(tpPrice, 4);
  });

  // ── Destroy ───────────────────────────────────────────────────

  test("destroy closes position and deactivates", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");
    await trader.start();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(trader.position).toBeNull();
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
    // open + close = 2 market orders
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("destroy cancels pending orders", async () => {
    config.mode = "live";
    const { trader, api } = makeTrader({ price: 100 });
    const cancelSpy = jest.spyOn(api, "cancelOrder");
    await trader.start();
    // Should have TP + SL pending
    expect(trader.pendingExitsById.size).toBe(2);

    await trader.destroy("manual");

    expect(cancelSpy).toHaveBeenCalled();
    expect(trader.pendingExitsById.size).toBe(0);
  });

  // ── Never auto-destroys ───────────────────────────────────────

  test("never auto-destroys through many cycles", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    await trader.start();

    for (let i = 0; i < 5; i++) {
      // SL to flip direction
      const slPrice = trader.position.slPrice;
      if (trader.position.direction === "SHORT") {
        api.setPrice(slPrice + 0.01);
      } else {
        api.setPrice(slPrice - 0.01);
      }
      await trader._checkPosition(api.price);

      // TP
      const tpPrice = trader.position.tpPrice;
      if (trader.position.direction === "SHORT") {
        api.setPrice(tpPrice - 0.01);
      } else {
        api.setPrice(tpPrice + 0.01);
      }
      await trader._checkPosition(api.price);
    }

    expect(trader.active).toBe(true);
    expect(onDestroy).not.toHaveBeenCalled();
    expect(trader.totalTrades).toBe(10);
  });

  // ── Notional stays constant ───────────────────────────────────

  test("notional stays constant across positions", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    const n = trader.position.notional;

    // TP
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.position.notional).toBe(n);

    // SL
    const sl = trader.position.slPrice;
    api.setPrice(sl + 0.01);
    await trader._checkPosition(sl + 0.01);
    expect(trader.position.notional).toBe(n);
  });

  // ── Fees ──────────────────────────────────────────────────────

  test("fees tracked when feeRate > 0", async () => {
    config.feeRate = 0.0004;
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.feesPaid).toBeGreaterThan(0);
    const trade = trader.tradeHistory[0];
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.netPnl).toBeLessThan(trade.grossPnl);
  });

  // ── Streaks ───────────────────────────────────────────────────

  test("win streak tracks consecutive TPs", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    // SHORT@100, TP=99

    // TP 1: SHORT → LONG
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.currentStreak).toBe(1);
    expect(trader.position.direction).toBe("LONG");

    // TP 2: LONG → SHORT (LONG TP is above entry)
    const tp2 = trader.position.tpPrice;
    api.setPrice(tp2 + 0.01);
    await trader._checkPosition(tp2 + 0.01);
    expect(trader.currentStreak).toBe(2);
    expect(trader.longestWinStreak).toBe(2);
  });

  test("loss streak tracks consecutive SLs", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // SL 1: SHORT stays SHORT (SL is above entry)
    api.setPrice(102.5);
    await trader._checkPosition(102.5);
    expect(trader.currentStreak).toBe(-1);
    expect(trader.position.direction).toBe("SHORT");

    // SL 2: SHORT stays SHORT again
    const sl2 = trader.position.slPrice;
    api.setPrice(sl2 + 0.01);
    await trader._checkPosition(sl2 + 0.01);
    expect(trader.currentStreak).toBe(-2);
    expect(trader.longestLossStreak).toBe(2);
  });

  test("streak resets on direction change (win after loss)", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    // SHORT@100

    // SL: SHORT stays SHORT
    api.setPrice(102.5);
    await trader._checkPosition(102.5);
    expect(trader.currentStreak).toBe(-1);
    expect(trader.position.direction).toBe("SHORT");

    // TP: SHORT → LONG (SHORT TP is below entry)
    const tp = trader.position.tpPrice;
    api.setPrice(tp - 0.01);
    await trader._checkPosition(tp - 0.01);
    expect(trader.currentStreak).toBe(1);
  });

  // ── Store updates ─────────────────────────────────────────────

  test("store.recordTrade called on each close", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // TP: SHORT → LONG
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(store.recordTrade).toHaveBeenCalledTimes(1);

    // SL on LONG (SL is below entry for LONG)
    const sl = trader.position.slPrice;
    api.setPrice(sl - 0.01);
    await trader._checkPosition(sl - 0.01);
    expect(store.recordTrade).toHaveBeenCalledTimes(2);
  });

  test("store.upsertTrader includes position data", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const lastCall = store.upsertTrader.mock.calls.at(-1)[0];
    expect(lastCall.position).not.toBeNull();
    expect(lastCall.position.direction).toBe("SHORT");
    expect(lastCall.position.tpPrice).toBeDefined();
    expect(lastCall.position.slPrice).toBeDefined();
    expect(lastCall.leverage).toBe(10);
    expect(lastCall.notional).toBe(1000);
  });

  // ── Guards ────────────────────────────────────────────────────

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

    // Simulate mark price for different symbol
    await trader._onMarkPrice({ symbol: "OTHERUSDT", price: 90 });
    expect(trader.lastPrice).toBe(100);
  });

  // ── Trade history ─────────────────────────────────────────────

  test("trade history records all fields", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const trade = trader.tradeHistory[0];
    expect(trade.tradeNumber).toBe(1);
    expect(trade.direction).toBe("SHORT");
    expect(trade.openReason).toBe("initial");
    expect(trade.entry).toBe(100);
    expect(trade.exit).toBeCloseTo(99, 4);
    expect(trade.quantity).toBeGreaterThan(0);
    expect(trade.notional).toBe(1000);
    expect(trade.reason).toBe("take-profit");
    expect(trade.closedAt).toBeDefined();
  });

  test("tradeNumber increments across positions", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    api.setPrice(102);
    await trader._checkPosition(102);

    expect(trader.tradeHistory[0].tradeNumber).toBe(1);
    expect(trader.tradeHistory[1].tradeNumber).toBe(2);
    expect(trader.position.tradeNumber).toBe(3);
  });

  // ── Scenario: TP=2%, SL=4% ───────────────────────────────────

  describe("Scenario: TP=2%, SL=4%", () => {
    beforeEach(() => {
      config.takeProfitPercent = 2;
      config.stopLossPercent = 4;
    });

    test("SHORT at 100 → TP at 98 → LONG → SL → LONG → TP → SHORT", async () => {
      const { trader, api } = makeTrader({ price: 100 });
      await trader.start();

      expect(trader.position.tpPrice).toBeCloseTo(98, 4);
      expect(trader.position.slPrice).toBeCloseTo(104, 4);

      // TP: SHORT → LONG
      api.setPrice(97.5);
      await trader._checkPosition(97.5);
      expect(trader.position.direction).toBe("LONG");
      expect(trader.wins).toBe(1);

      // SL on LONG → re-open LONG
      const sl = trader.position.slPrice;
      api.setPrice(sl - 0.01);
      await trader._checkPosition(sl - 0.01);
      expect(trader.position.direction).toBe("LONG");
      expect(trader.losses).toBe(1);

      // LONG TP → SHORT
      const longTp = trader.position.tpPrice;
      api.setPrice(longTp + 0.01);
      await trader._checkPosition(longTp + 0.01);
      expect(trader.position.direction).toBe("SHORT");
      expect(trader.wins).toBe(2);
      expect(trader.totalTrades).toBe(3);
    });
  });

  // ── Exit order placement ──────────────────────────────────────

  test("places TP limit order and SL stop order on position open (live mode)", async () => {
    config.mode = "live";
    const { trader, api } = makeTrader({ price: 100 });
    const limitSpy = jest.spyOn(api, "placeLimitOrder");
    const stopSpy = jest.spyOn(api, "placeStopLimitOrder");
    await trader.start();

    expect(limitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "BUY",           // close SHORT = BUY
        reduceOnly: true,
        positionSide: "SHORT"
      })
    );
    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "BUY",
        reduceOnly: true,
        positionSide: "SHORT"
      })
    );
    expect(trader.pendingExitsById.size).toBe(2);
  });

  test("exit orders cleaned up after TP fill (live mode)", async () => {
    config.mode = "live";
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    const cancelSpy = jest.spyOn(api, "cancelOrder");
    expect(trader.pendingExitsById.size).toBe(2);

    // Simulate exchange filling the TP order
    const tpOrderId = trader.position.tpOrderId;
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: tpOrderId,
      price: trader.position.tpPrice,
      side: "BUY"
    });

    // SL order should have been cancelled
    expect(cancelSpy).toHaveBeenCalled();
    // New exit orders placed for the re-opened position
    expect(trader.pendingExitsById.size).toBe(2);
    expect(trader.wins).toBe(1);
  });
});
