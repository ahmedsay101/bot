const EventEmitter = require("events");

// Mock logger
jest.mock("../src/utils/logger", () => ({ log: jest.fn() }));

// Mock store
jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn()
}));

// Mock config (defaults match production config)
jest.mock("../src/utils/config", () => ({
  mode: "test",
  fixedNotional: 500,
  leverage: 2,
  gridLevels: 5,
  gapPercent: 1,
  takeProfitPercent: 5,
  feeRate: 0.0004,
  startingBalanceUSDT: 200
}));

const GridTrader = require("../src/core/gridTrader");
const store = require("../src/state/store");
const config = require("../src/utils/config");

function createMockApi() {
  const api = new EventEmitter();
  api.getMarkPrice = jest.fn().mockResolvedValue(100);
  api.placeStopLimitOrder = jest.fn().mockImplementation(async () => ({
    orderId: `order-${Date.now()}-${Math.random()}`
  }));
  api.placeMarketOrder = jest.fn().mockImplementation(async ({ symbol }) => ({
    orderId: `mkt-${Date.now()}`,
    price: api._lastMarkPrice || 100
  }));
  api.cancelOrder = jest.fn().mockResolvedValue({});
  api.cancelAllOpenOrders = jest.fn().mockResolvedValue({});
  api._lastMarkPrice = 100;
  return api;
}

function makeTrader(opts = {}) {
  const api = createMockApi();
  const onDestroy = jest.fn();
  const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy, ...opts });
  return { trader, api, onDestroy };
}

describe("GridTrader", () => {
  beforeEach(() => jest.clearAllMocks());

  // ── Constructor ──
  test("sets correct defaults from config", () => {
    const { trader } = makeTrader();
    expect(trader.allocatedEquity).toBe(500);
    expect(trader.leverage).toBe(2);
    expect(trader.gridLevels).toBe(5);
    expect(trader.gapPercent).toBe(1);
    expect(trader.takeProfitPercent).toBe(5);
    expect(trader.totalOrders).toBe(10);
    // notionalPerOrder = (500 / 10) * 2 = 100
    expect(trader.notionalPerOrder).toBe(100);
    expect(trader.traderType).toBe("GRID");
  });

  // ── Start & order placement ──
  test("start() fetches mark price and places 2*N stop-limit orders", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    expect(api.getMarkPrice).toHaveBeenCalledWith("TESTUSDT");
    expect(trader.basePrice).toBe(100);
    // 5 longs + 5 shorts = 10 orders
    expect(api.placeStopLimitOrder).toHaveBeenCalledTimes(10);
    expect(trader.levels.size).toBe(10);
    expect(trader.pendingEntriesById.size).toBe(10);
  });

  test("long levels are above base, short levels below", async () => {
    const { trader } = makeTrader();
    await trader.start();

    for (const [idx, level] of trader.levels) {
      if (idx > 0) {
        expect(level.direction).toBe("LONG");
        expect(level.price).toBeGreaterThan(100);
      } else {
        expect(level.direction).toBe("SHORT");
        expect(level.price).toBeLessThan(100);
      }
    }
  });

  test("level prices follow half-gap + gap spacing", async () => {
    const { trader } = makeTrader();
    await trader.start();

    // gap = 1%, half = 0.5%
    // Long 1: 100 * 1.005 = 100.5
    // Long 2: 100 * 1.015 = 101.5
    const long1 = trader.levels.get(1);
    const long2 = trader.levels.get(2);
    expect(long1.price).toBeCloseTo(100.5, 4);
    expect(long2.price).toBeCloseTo(101.5, 4);

    // Short 1: 100 * 0.995 = 99.5
    // Short 2: 100 * 0.985 = 98.5
    const short1 = trader.levels.get(-1);
    const short2 = trader.levels.get(-2);
    expect(short1.price).toBeCloseTo(99.5, 4);
    expect(short2.price).toBeCloseTo(98.5, 4);
  });

  test("stop-limit orders use correct side and positionSide", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const calls = api.placeStopLimitOrder.mock.calls;
    const longCalls = calls.filter(([c]) => c.positionSide === "LONG");
    const shortCalls = calls.filter(([c]) => c.positionSide === "SHORT");

    expect(longCalls.length).toBe(5);
    expect(shortCalls.length).toBe(5);

    longCalls.forEach(([c]) => expect(c.side).toBe("BUY"));
    shortCalls.forEach(([c]) => expect(c.side).toBe("SELL"));
  });

  // ── Order fill handling ──
  test("entry fill creates position and updates counts", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    // Find a long order
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: trader.levels.get(levelIndex).price
    });

    expect(trader.positions.has(levelIndex)).toBe(true);
    expect(trader.filledLongCount).toBe(1);
    expect(trader.levels.get(levelIndex).status).toBe("FILLED");
    expect(store.upsertTrader).toHaveBeenCalled();
  });

  test("short entry fill increments filledShortCount", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx < 0
    );

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: trader.levels.get(levelIndex).price
    });

    expect(trader.filledShortCount).toBe(1);
  });

  test("ignores fill events for other symbols", async () => {
    const { trader, api } = makeTrader();
    await trader.start();
    const prevPositions = trader.positions.size;

    api.emit("orderFilled", {
      symbol: "OTHERUSDT",
      orderId: "fake-id",
      price: 100
    });

    expect(trader.positions.size).toBe(prevPositions);
  });

  test("ignores fill events for unknown order IDs", async () => {
    const { trader, api } = makeTrader();
    await trader.start();
    const prevPositions = trader.positions.size;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: "unknown-order-id",
      price: 100
    });

    expect(trader.positions.size).toBe(prevPositions);
  });

  // ── PnL calculations ──
  test("unrealized PnL for long position: price up = profit", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;
    const qty = trader.levels.get(levelIndex).quantity;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    // Price goes up = profit for long
    const unrealized = trader._calcUnrealizedPnl(entryPrice + 1);
    expect(unrealized).toBeCloseTo(qty * 1, 2);
  });

  test("unrealized PnL for short position: price down = profit", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx < 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;
    const qty = trader.levels.get(levelIndex).quantity;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    // Price goes down = profit for short
    const unrealized = trader._calcUnrealizedPnl(entryPrice - 1);
    expect(unrealized).toBeCloseTo(qty * 1, 2);
  });

  test("profit percent is relative to allocatedEquity", async () => {
    const { trader } = makeTrader();
    await trader.start();
    // With no positions, profit % = 0
    expect(trader._calcProfitPercent(100)).toBe(0);
  });

  // ── Base-price cross closes positions ──
  test("closes filled long positions when price returns to base", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    // Fill a long position (above base)
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    expect(trader.positions.size).toBe(1);

    // Price returns to base (100) — should close the long
    api.emit("markPrice", { symbol: "TESTUSDT", price: 100 });
    await new Promise((r) => setImmediate(r));

    expect(trader.positions.size).toBe(0);
    expect(trader.levels.get(levelIndex).status).toBe("CLOSED");
    expect(api.placeMarketOrder).toHaveBeenCalled();
    expect(store.recordTrade).toHaveBeenCalled();
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("base-cross");
  });

  test("closes filled short positions when price returns to base", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    // Fill a short position (below base)
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx < 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    expect(trader.positions.size).toBe(1);

    // Price returns to base (100) — should close the short
    api.emit("markPrice", { symbol: "TESTUSDT", price: 100 });
    await new Promise((r) => setImmediate(r));

    expect(trader.positions.size).toBe(0);
    expect(trader.levels.get(levelIndex).status).toBe("CLOSED");
    expect(trader.tradeHistory[0].reason).toBe("base-cross");
  });

  test("does not close positions when price is away from base", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    // Fill a long position
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: trader.levels.get(levelIndex).price
    });

    // Price goes higher, away from base — should NOT close
    api.emit("markPrice", { symbol: "TESTUSDT", price: 105 });
    await new Promise((r) => setImmediate(r));

    expect(trader.positions.size).toBe(1);
  });

  // ── Destroy conditions ──
  test("destroys when profit % >= takeProfitPercent", async () => {
    const { trader, api, onDestroy } = makeTrader();
    await trader.start();

    // Fill a long position
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;
    const qty = trader.levels.get(levelIndex).quantity;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    // Need profit >= 5% of 500 = $25 from unrealized
    // Unrealized = qty * priceDiff. qty = 100/100.5 ≈ 0.995
    // Need: 0.995 * priceDiff >= 25 -> priceDiff >= 25.125
    const neededPrice = entryPrice + 30;

    // Trigger markPrice update with high price
    api.emit("markPrice", { symbol: "TESTUSDT", price: neededPrice });

    // destroy() is async — flush the microtask queue
    await new Promise((r) => setImmediate(r));

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  // ── Destroy ──
  test("destroy cancels pending orders and closes positions", async () => {
    const { trader, api, onDestroy } = makeTrader();
    await trader.start();

    // Fill one long
    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: trader.levels.get(levelIndex).price
    });

    const pendingBefore = trader.pendingEntriesById.size;
    expect(pendingBefore).toBeGreaterThan(0);

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(api.cancelAllOpenOrders).toHaveBeenCalledWith("TESTUSDT");
    // Market order to close the filled position
    expect(api.placeMarketOrder).toHaveBeenCalled();
    expect(trader.positions.size).toBe(0);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
    expect(store.removeTrader).toHaveBeenCalled();
    expect(store.recordTrade).toHaveBeenCalled();
  });

  test("destroy is idempotent (second call does nothing)", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    await trader.destroy("manual");
    const callCount = api.cancelAllOpenOrders.mock.calls.length;

    await trader.destroy("manual");
    expect(api.cancelAllOpenOrders.mock.calls.length).toBe(callCount);
  });

  // ── Fee tracking ──
  test("entry fill tracks entry fee", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );
    const entryPrice = trader.levels.get(levelIndex).price;
    const qty = trader.levels.get(levelIndex).quantity;

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      price: entryPrice
    });

    const expectedFee = entryPrice * qty * 0.0004;
    expect(trader.feesPaid).toBeCloseTo(expectedFee, 6);
  });

  // ── Order cancelled ──
  test("order cancelled updates level status", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const [orderId, levelIndex] = [...trader.pendingEntriesById.entries()].find(
      ([, idx]) => idx > 0
    );

    api.emit("orderCancelled", {
      symbol: "TESTUSDT",
      orderId
    });

    expect(trader.levels.get(levelIndex).status).toBe("CANCELLED");
    expect(trader.pendingEntriesById.has(orderId)).toBe(false);
  });

  // ── Mark price & book ticker ──
  test("markPrice updates lastPrice", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    api.emit("markPrice", { symbol: "TESTUSDT", price: 105 });
    expect(trader.lastPrice).toBe(105);
  });

  test("bookTicker updates lastPrice from mid", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    api.emit("bookTicker", { symbol: "TESTUSDT", bid: 99, ask: 101 });
    expect(trader.lastPrice).toBe(100);
  });

  test("ignores markPrice from other symbols", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    api.emit("markPrice", { symbol: "OTHERUSDT", price: 999 });
    expect(trader.lastPrice).toBe(100); // still base
  });

  // ── Store updates ──
  test("_updateStore sends ladder data to store", async () => {
    const { trader, api } = makeTrader();
    await trader.start();

    const storeCall = store.upsertTrader.mock.calls.at(-1)[0];
    expect(storeCall.symbol).toBe("TESTUSDT");
    expect(storeCall.basePrice).toBe(100);
    expect(storeCall.ladder).toHaveLength(10);
    expect(storeCall.ladder[0].price).toBeGreaterThan(storeCall.ladder[9].price); // sorted desc
    expect(storeCall.traderType).toBe("GRID");
    expect(storeCall.totalOrders).toBe(10);
  });
});
