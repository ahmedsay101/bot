const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  recordTraderResult: jest.fn()
}));

const MartingaleTrader = require("../src/core/martingaleTrader");
const config = require("../src/utils/config");
const store = require("../src/state/store");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orderSeq = 0;
  }

  async getMarkPrice() {
    return this.price;
  }

  async getBalance() {
    return 1000;
  }

  async placeMarketOrder() {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }

  async cancelAllOpenOrders() {
    return { status: "CANCELED" };
  }

  setPrice(p) {
    this.price = p;
  }
}

function makeTrader(overrides = {}) {
  const api = overrides.api || new FakeApi({ price: overrides.price || 100 });
  const onDestroy = overrides.onDestroy || jest.fn();
  return {
    trader: new MartingaleTrader({
      symbol: "TESTUSDT",
      api,
      onDestroy,
      leverage: overrides.leverage || 10,
      ...overrides.extra
    }),
    api,
    onDestroy
  };
}

describe("MartingaleTrader", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      leverage: 10,
      maxRounds: 3,
      feeRate: 0
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  // ── Initialization ────────────────────────────────────────────

  test("places initial SHORT market order on start", async () => {
    const { trader, api } = makeTrader();
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ side: "SELL", positionSide: "SHORT" })
    );
    expect(trader.currentRound).toBe(1);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.traderType).toBe("MARTINGALE");
    expect(trader.active).toBe(true);
    expect(store.upsertTrader).toHaveBeenCalled();
  });

  test("sets TP and SL prices correctly for SHORT", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.position;
    // SHORT: TP = entry * (1 - 1%) = 99, SL = entry * (1 + 1%) = 101
    expect(pos.tpPrice).toBeCloseTo(99, 4);
    expect(pos.slPrice).toBeCloseTo(101, 4);
  });

  test("sets TP and SL prices correctly for LONG", async () => {
    const { trader } = makeTrader({ price: 100 });
    trader.startDirection = "LONG";
    await trader.start();

    const pos = trader.position;
    // LONG: TP = entry * (1 + 1%) = 101, SL = entry * (1 - 1%) = 99
    expect(pos.tpPrice).toBeCloseTo(101, 4);
    expect(pos.slPrice).toBeCloseTo(99, 4);
  });

  // ── Take Profit ───────────────────────────────────────────────

  test("take profit destroys trader (win)", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    await trader.start();

    // SHORT position, TP at 99 → move price below 99
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();

    // Should have exactly 1 trade in history
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
  });

  test("take profit PnL is positive for SHORT", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Gross PnL: (exit - entry) * qty * direction
    // direction = -1 (SHORT), so (98.5 - 100) * qty * -1 = 1.5 * qty > 0
    expect(trader.realizedPnl).toBeGreaterThan(0);
  });

  // ── Stop Loss → Next Round ────────────────────────────────────

  test("stop loss opens opposite direction with doubled notional", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();

    const origNotional = trader.position.notional;

    // SHORT position, SL at 101 → move price above 101
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    // Should now be on round 2, LONG direction, doubled notional
    expect(trader.active).toBe(true);
    expect(trader.currentRound).toBe(2);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("LONG");
    expect(trader.position.notional).toBe(origNotional * 2);

    // Should have called placeMarketOrder 3 times: initial open, close, re-open
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test("round 2 trade has negative PnL in history", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    // Round 1 closed with stop-loss (loss)
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
    // SHORT entered at 100, exited at 101.5 → loss
    expect(trader.tradeHistory[0].grossPnl).toBeLessThan(0);
  });

  // ── Multiple Rounds ───────────────────────────────────────────

  test("multiple SL hits alternate direction and double notional", async () => {
    Object.assign(config, { maxRounds: 5 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const baseNotional = trader.position.notional;

    // Round 1: SHORT, SL hit
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.currentRound).toBe(2);
    expect(trader.position.direction).toBe("LONG");
    expect(trader.position.notional).toBe(baseNotional * 2);

    // Round 2: LONG, SL hit (SL = 101.5 * 0.99 ≈ 100.485)
    api.setPrice(100);
    await trader._checkPosition(100);
    expect(trader.currentRound).toBe(3);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.position.notional).toBe(baseNotional * 4);

    // Round 3: SHORT, TP hit (TP = 100 * 0.99 = 99)
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.active).toBe(false);
    expect(trader.tradeHistory.length).toBe(3);
  });

  // ── Max Rounds ────────────────────────────────────────────────

  test("max rounds reached destroys trader (loss)", async () => {
    Object.assign(config, { maxRounds: 2 });
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    await trader.start();

    // Round 1: SHORT, SL hit → goes to round 2
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.currentRound).toBe(2);
    expect(trader.active).toBe(true);

    // Round 2: LONG, SL hit (SL ≈ 100.485) → maxRounds reached → destroy
    api.setPrice(100);
    await trader._checkPosition(100);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(trader.tradeHistory.length).toBe(2);
  });

  // ── Destroy ───────────────────────────────────────────────────

  test("destroy closes open position and marks inactive", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();
    expect(trader.position).not.toBeNull();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();

    // Should have called placeMarketOrder for both entry and exit
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("destroy without open position does not place extra orders", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();

    // TP hit closes position, destroys
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Already destroyed with position closed
    expect(spy).toHaveBeenCalledTimes(2); // open + close(TP)
    expect(trader.active).toBe(false);
  });

  // ── Fee Calculations ──────────────────────────────────────────

  test("fees are tracked accurately with feeRate", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.position;
    const entryFee = pos.entryPrice * pos.quantity * 0.0004;
    expect(pos.entryFee).toBeCloseTo(entryFee, 8);

    // TP hit → close
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const exitFee = 98.5 * pos.quantity * 0.0004;
    const totalFees = entryFee + exitFee;

    expect(trader.feesPaid).toBeCloseTo(totalFees, 8);
    expect(trader.tradeHistory[0].fees).toBeCloseTo(totalFees, 8);
  });

  test("net PnL = gross PnL - fees", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const trade = trader.tradeHistory[0];
    const expectedNet = trade.grossPnl - trade.fees;
    expect(trade.netPnl).toBeCloseTo(expectedNet, 8);
    expect(trader.realizedPnl).toBeCloseTo(expectedNet, 8);
  });

  test("fees accumulate across multiple rounds", async () => {
    Object.assign(config, { feeRate: 0.0004, maxRounds: 3 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Round 1: SL hit
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    const feesAfterR1 = trader.feesPaid;
    expect(feesAfterR1).toBeGreaterThan(0);

    // Round 2: TP hit (LONG entered at ~101.5, TP ~102.515)
    api.setPrice(103);
    await trader._checkPosition(103);

    expect(trader.feesPaid).toBeGreaterThan(feesAfterR1);
    expect(trader.tradeHistory.length).toBe(2);

    // Total fees should equal sum of individual trade fees
    const totalFeesFromTrades = trader.tradeHistory.reduce((s, t) => s + t.fees, 0);
    expect(trader.feesPaid).toBeCloseTo(totalFeesFromTrades, 8);
  });

  // ── Unrealized PnL ────────────────────────────────────────────

  test("unrealized PnL calculation is accurate", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.position;
    // SHORT entered at 100, current price 99
    const unrealized = trader._calcUnrealizedPnl(99);
    const grossPnl = (99 - 100) * pos.quantity * -1; // positive for short
    const exitFee = 99 * pos.quantity * 0.0004;
    const expected = grossPnl - pos.entryFee - exitFee;
    expect(unrealized).toBeCloseTo(expected, 8);
  });

  test("unrealized PnL is 0 when no position", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader._calcUnrealizedPnl(98.5)).toBe(0);
  });

  // ── Store updates ─────────────────────────────────────────────

  test("store.recordTrade called on each position close", async () => {
    Object.assign(config, { maxRounds: 3 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Round 1: SL
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(store.recordTrade).toHaveBeenCalledTimes(1);

    // Round 2: TP (LONG entered at ~101.5, TP ~102.515)
    api.setPrice(103);
    await trader._checkPosition(103);
    expect(store.recordTrade).toHaveBeenCalledTimes(2);
  });

  test("store.upsertTrader includes correct martingale fields", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const calls = store.upsertTrader.mock.calls;
    const lastCall = calls[calls.length - 1][0];

    expect(lastCall).toMatchObject({
      id: trader.id,
      symbol: "TESTUSDT",
      traderType: "MARTINGALE",
      leverage: 10,
      currentRound: 1,
      maxRounds: 3,
      baseNotional: 100,
      status: "ACTIVE"
    });
    expect(lastCall.position).not.toBeNull();
    expect(lastCall.position.direction).toBe("SHORT");
    expect(lastCall.position.tpPrice).toBeDefined();
    expect(lastCall.position.slPrice).toBeDefined();
  });

  // ── Edge cases ────────────────────────────────────────────────

  test("does not process when already processing", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    trader._processing = true;
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Should not have closed (still in round 1 with position)
    expect(trader.active).toBe(true);
    expect(trader.position).not.toBeNull();
  });

  test("ignores price updates for other symbols", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Emit markPrice for a different symbol
    api.emit("markPrice", { symbol: "BTCUSDT", price: 50 });

    expect(trader.lastPrice).toBe(100);
    expect(trader.position).not.toBeNull();
    expect(trader.active).toBe(true);
  });

  test("leverage is stored on trader instance", async () => {
    const { trader } = makeTrader({ leverage: 125 });
    await trader.start();

    expect(trader.leverage).toBe(125);
  });
});
