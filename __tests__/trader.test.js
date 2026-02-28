const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

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
    trader: new PerpetualTrader({
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

describe("PerpetualTrader", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      leverage: 10,
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
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.traderType).toBe("PERPETUAL");
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

  // ── Take Profit → Same Direction ─────────────────────────────

  test("take profit opens new position in SAME direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();
    expect(trader.position.direction).toBe("SHORT");

    // SHORT position, TP at 99 → move price below 99
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Trader should still be active with a NEW SHORT position
    expect(trader.active).toBe(true);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("SHORT"); // same direction
    expect(trader.totalTrades).toBe(1);
    expect(trader.wins).toBe(1);
    expect(trader.losses).toBe(0);

    // 3 orders: initial open, close TP, re-open same direction
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test("take profit PnL is positive for SHORT", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.realizedPnl).toBeGreaterThan(0);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].grossPnl).toBeGreaterThan(0);
  });

  test("multiple TPs keep same direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // TP 1: SHORT at 100, TP at 99
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.wins).toBe(1);
    expect(trader.consecutiveSameDir).toBe(1);

    // TP 2: SHORT at 98.5, TP ≈ 97.515
    api.setPrice(97);
    await trader._checkPosition(97);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.wins).toBe(2);
    expect(trader.consecutiveSameDir).toBe(2);

    // TP 3: SHORT at 97, TP ≈ 96.03
    api.setPrice(95.5);
    await trader._checkPosition(95.5);
    expect(trader.position.direction).toBe("SHORT");
    expect(trader.wins).toBe(3);
    expect(trader.consecutiveSameDir).toBe(3);
    expect(trader.totalTrades).toBe(3);
  });

  // ── Stop Loss → Opposite Direction ────────────────────────────

  test("stop loss opens new position in OPPOSITE direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();
    expect(trader.position.direction).toBe("SHORT");

    // SHORT position, SL at 101 → move price above 101
    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    // Trader should be active with a LONG position (flipped)
    expect(trader.active).toBe(true);
    expect(trader.position).not.toBeNull();
    expect(trader.position.direction).toBe("LONG"); // opposite
    expect(trader.totalTrades).toBe(1);
    expect(trader.wins).toBe(0);
    expect(trader.losses).toBe(1);
    expect(trader.consecutiveSameDir).toBe(0);

    // 3 orders: initial open, close SL, re-open opposite
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test("stop loss PnL is negative", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(101.5);
    await trader._checkPosition(101.5);

    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
    expect(trader.tradeHistory[0].grossPnl).toBeLessThan(0);
  });

  // ── Mixed TP/SL sequence ──────────────────────────────────────

  test("SL flips direction, then TP continues in new direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trade 1: SHORT at 100, SL hit → flip to LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.position.direction).toBe("LONG");
    expect(trader.losses).toBe(1);

    // Trade 2: LONG at 101.5, TP at ≈102.515 → TP hit → stay LONG
    api.setPrice(103);
    await trader._checkPosition(103);
    expect(trader.position.direction).toBe("LONG");
    expect(trader.wins).toBe(1);
    expect(trader.consecutiveSameDir).toBe(1);

    // Trade 3: LONG at 103, TP at ≈104.03 → TP hit → stay LONG
    api.setPrice(105);
    await trader._checkPosition(105);
    expect(trader.position.direction).toBe("LONG");
    expect(trader.wins).toBe(2);
    expect(trader.consecutiveSameDir).toBe(2);
    expect(trader.totalTrades).toBe(3);
  });

  test("alternating SL hits keep flipping direction", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trade 1: SHORT at 100, SL → LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.position.direction).toBe("LONG");

    // Trade 2: LONG at 101.5, SL ≈ 100.485 → SHORT
    api.setPrice(100);
    await trader._checkPosition(100);
    expect(trader.position.direction).toBe("SHORT");

    // Trade 3: SHORT at 100, SL ≈ 101 → LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.position.direction).toBe("LONG");

    expect(trader.totalTrades).toBe(3);
    expect(trader.losses).toBe(3);
    expect(trader.wins).toBe(0);
  });

  // ── Never auto-destroys ───────────────────────────────────────

  test("trader never auto-destroys after many trades", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    await trader.start();

    // Run 10 stop-loss cycles — trader should stay alive
    for (let i = 0; i < 10; i++) {
      const pos = trader.position;
      if (pos.direction === "SHORT") {
        api.setPrice(pos.slPrice + 0.5);
        await trader._checkPosition(pos.slPrice + 0.5);
      } else {
        api.setPrice(pos.slPrice - 0.5);
        await trader._checkPosition(pos.slPrice - 0.5);
      }
    }

    expect(trader.active).toBe(true);
    expect(trader.totalTrades).toBe(10);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  // ── Manual Destroy ────────────────────────────────────────────

  test("destroy closes open position and marks inactive", async () => {
    const { trader, api, onDestroy } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();
    expect(trader.position).not.toBeNull();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(2); // open + close
  });

  test("destroy without open position does not place extra orders", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    const spy = jest.spyOn(api, "placeMarketOrder");

    await trader.start();

    // TP closes position and opens new one
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    // Now destroy — should close the new position
    await trader.destroy("manual");

    // open + close(TP) + re-open + close(destroy) = 4
    expect(spy).toHaveBeenCalledTimes(4);
    expect(trader.active).toBe(false);
  });

  // ── Constant Notional ─────────────────────────────────────────

  test("notional stays constant across trades (no doubling)", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const origNotional = trader.position.notional;

    // SL → flip
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.position.notional).toBe(origNotional);

    // TP → same dir
    api.setPrice(103);
    await trader._checkPosition(103);
    expect(trader.position.notional).toBe(origNotional);

    // SL → flip
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.position.notional).toBe(origNotional);
  });

  // ── Fee Calculations ──────────────────────────────────────────

  test("fees are tracked accurately with feeRate", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    const pos = trader.position;
    const entryFee = pos.entryPrice * pos.quantity * 0.0004;
    expect(pos.entryFee).toBeCloseTo(entryFee, 8);

    // TP hit → close + re-open
    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    const exitFee = 98.5 * pos.quantity * 0.0004;
    const totalRound1Fees = entryFee + exitFee;

    expect(trader.tradeHistory[0].fees).toBeCloseTo(totalRound1Fees, 8);
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
  });

  test("fees accumulate across multiple trades", async () => {
    Object.assign(config, { feeRate: 0.0004 });
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trade 1: SL
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    const feesAfterT1 = trader.feesPaid;
    expect(feesAfterT1).toBeGreaterThan(0);

    // Trade 2: TP (LONG entered at ~101.5, TP ~102.515)
    api.setPrice(103);
    await trader._checkPosition(103);
    expect(trader.feesPaid).toBeGreaterThan(feesAfterT1);
    expect(trader.tradeHistory.length).toBe(2);

    const totalFeesFromTrades = trader.tradeHistory.reduce((s, t) => s + t.fees, 0);
    // feesPaid also includes entry fee for the still-open position
    expect(trader.feesPaid).toBeGreaterThanOrEqual(totalFeesFromTrades);
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
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    // Manually clear position to test edge case
    trader.position = null;
    expect(trader._calcUnrealizedPnl(98.5)).toBe(0);
  });

  // ── Streak tracking ──────────────────────────────────────────

  test("win streak tracks correctly", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // 3 consecutive TPs
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

  test("loss streak tracks correctly", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // SL 1: SHORT → LONG
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(trader.currentStreak).toBe(-1);

    // SL 2: LONG SL ≈ 100.485 → SHORT
    api.setPrice(100);
    await trader._checkPosition(100);
    expect(trader.currentStreak).toBe(-2);
    expect(trader.longestLossStreak).toBe(2);
  });

  test("streak resets on direction change", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // 2 wins
    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    api.setPrice(97);
    await trader._checkPosition(97);
    expect(trader.currentStreak).toBe(2);

    // 1 loss
    api.setPrice(98);
    await trader._checkPosition(98);
    expect(trader.currentStreak).toBe(-1);
    expect(trader.longestWinStreak).toBe(2);
  });

  // ── Store updates ─────────────────────────────────────────────

  test("store.recordTrade called on each position close", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    // Trade 1: SL
    api.setPrice(101.5);
    await trader._checkPosition(101.5);
    expect(store.recordTrade).toHaveBeenCalledTimes(1);

    // Trade 2: TP (LONG at 101.5, TP ≈ 102.515)
    api.setPrice(103);
    await trader._checkPosition(103);
    expect(store.recordTrade).toHaveBeenCalledTimes(2);
  });

  test("store.upsertTrader includes correct perpetual fields", async () => {
    const { trader } = makeTrader({ price: 100 });
    await trader.start();

    const calls = store.upsertTrader.mock.calls;
    const lastCall = calls[calls.length - 1][0];

    expect(lastCall).toMatchObject({
      id: trader.id,
      symbol: "TESTUSDT",
      traderType: "PERPETUAL",
      leverage: 10,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      currentStreak: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      consecutiveSameDir: 0,
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

    // Should not have closed (still has original SHORT position)
    expect(trader.active).toBe(true);
    expect(trader.totalTrades).toBe(0);
  });

  test("ignores price updates for other symbols", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

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

  test("trade history records closedAt timestamp", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();

    api.setPrice(98.5);
    await trader._checkPosition(98.5);

    expect(trader.tradeHistory[0].closedAt).toBeDefined();
    expect(typeof trader.tradeHistory[0].closedAt).toBe("string");
  });

  test("tradeNumber increments correctly", async () => {
    const { trader, api } = makeTrader({ price: 100 });
    await trader.start();
    expect(trader.position.tradeNumber).toBe(1);

    api.setPrice(98.5);
    await trader._checkPosition(98.5);
    expect(trader.tradeHistory[0].tradeNumber).toBe(1);
    expect(trader.position.tradeNumber).toBe(2);

    api.setPrice(97);
    await trader._checkPosition(97);
    expect(trader.tradeHistory[1].tradeNumber).toBe(2);
    expect(trader.position.tradeNumber).toBe(3);
  });
});
