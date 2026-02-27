const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn()
}));

const VolatilityTrader = require("../src/core/trader");
const ExpansionTrader = require("../src/core/expansionTrader");
const LadderTrader = require("../src/core/ladderTrader");
const FlipTrader = require("../src/core/flipTrader");
const config = require("../src/utils/config");
const store = require("../src/state/store");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orderSeq = 0;
    this.orders = new Map();
  }

  async getMarkPrice() {
    return this.price;
  }

  async getBalance() {
    return 1000;
  }

  async getAvailableBalance() {
    return 1000;
  }

  async placeMarketOrder() {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }

  async placeLimitOrder({ symbol, side, quantity, price }) {
    const orderId = `L-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, price });
    return { orderId };
  }

  async placeStopLimitOrder({ symbol, side, quantity, stopPrice, price }) {
    const orderId = `S-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, stopPrice, price });
    return { orderId };
  }

  async cancelAllOpenOrders() {
    return { status: "CANCELED" };
  }

  async closePositionMarket() {
    return { status: "NONE" };
  }
}

function emitFill(api, orderId) {
  const order = api.orders.get(orderId);
  if (!order) return;
  api.emit("orderFilled", {
    symbol: order.symbol,
    orderId,
    side: order.side,
    price: order.price,
    quantity: order.quantity
  });
}

describe("VolatilityTrader grid behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      levelCount: 2,
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      leverage: 1,
      feeRate: 0
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places two initial entry orders (limit)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new VolatilityTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.pendingEntriesById.size).toBe(2);
    expect(trader.traderType).toBe("VOLATILITY");
  });

  test("fills entry and closes on take profit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new VolatilityTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const firstPending = Array.from(trader.pendingEntriesById.values())[0];
    emitFill(api, firstPending.orderId);
    const initialCount = trader.positions.size;
    expect(initialCount).toBeGreaterThan(0);

    const firstPos = Array.from(trader.positions.values())[0];
    api.price = firstPos.takeProfitPrice;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: api.price });

    const exitOrder = Array.from(api.orders.values()).find((order) => order.price === firstPos.takeProfitPrice);
    expect(exitOrder).toBeTruthy();
    emitFill(api, exitOrder.orderId);

    expect(trader.positions.size).toBeLessThan(initialCount);
    expect(trader.tradeHistory.length).toBeGreaterThan(0);
  });
});

describe("ExpansionTrader grid behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      levelCount: 2,
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      leverage: 1,
      feeRate: 0
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places two initial entry orders (stop-limit)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new ExpansionTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.pendingEntriesById.size).toBe(2);
    expect(trader.traderType).toBe("EXPANSION");

    // Entries should use stop-limit (stored in api.orders with stopPrice)
    const orders = Array.from(api.orders.values());
    expect(orders.every((o) => o.stopPrice !== undefined)).toBe(true);
  });
});

describe("LadderTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      positionNotionalUSDT: 100,
      ladderInitialLevels: 3,
      ladderRefillThreshold: 1,
      feeRate: 0
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places 3 long and 3 short initial stop-limit entries", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.pendingEntriesById.size).toBe(6);
    expect(trader.traderType).toBe("LADDER");

    const entries = Array.from(trader.pendingEntriesById.values());
    const longs = entries.filter((e) => e.direction === "LONG");
    const shorts = entries.filter((e) => e.direction === "SHORT");
    expect(longs.length).toBe(3);
    expect(shorts.length).toBe(3);

    // All should be stop-limit orders
    const orders = Array.from(api.orders.values());
    expect(orders.every((o) => o.stopPrice !== undefined)).toBe(true);
  });

  test("fills an entry and creates a position without TP/SL orders", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const orderCountBefore = api.orders.size;
    const firstLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    emitFill(api, firstLong.orderId);

    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];
    expect(pos.direction).toBe("LONG");
    expect(pos.entryPrice).toBeDefined();

    // No TP/SL orders should have been placed (order count only grows from refill)
    // All new orders after fill should be entry orders (refill), not exit orders
    const newOrders = Array.from(api.orders.values()).filter(
      (o) => !trader.pendingEntriesById.has(o.orderId) || o.orderId > `S-${orderCountBefore}`
    );
    for (const o of newOrders) {
      // Refill orders are stop-limit entries, not reduce-only exits
      if (api.orders.has(o.orderId)) {
        expect(o.stopPrice).toBeDefined();
      }
    }
  });

  test("refills long ladder when pending drops to threshold", async () => {
    Object.assign(config, { ladderInitialLevels: 3, ladderRefillThreshold: 1 });
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Fill long levels 1 and 2 → only 1 long pending left → triggers refill
    const longs = Array.from(trader.pendingEntriesById.values())
      .filter((e) => e.direction === "LONG")
      .sort((a, b) => a.levelIndex - b.levelIndex);

    emitFill(api, longs[0].orderId);
    // Allow async refill to settle
    await new Promise((r) => setTimeout(r, 10));

    emitFill(api, longs[1].orderId);
    // Allow async refill to settle
    await new Promise((r) => setTimeout(r, 10));

    // After filling 2, only 1 was left which hit threshold → 3 more added
    const pendingLongs = Array.from(trader.pendingEntriesById.values()).filter((e) => e.direction === "LONG");
    expect(pendingLongs.length).toBeGreaterThan(1);
  });

  test("closes all positions when price returns to basePrice (long)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Fill a long entry
    const firstLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    emitFill(api, firstLong.orderId);
    expect(trader.positions.size).toBe(1);

    // Price drops back to base → positions should be closed
    api.price = 100;
    await trader._checkBaseStop(100);

    expect(trader.positions.size).toBe(0);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("base-stop");
  });

  test("closes all positions when price returns to basePrice (short)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Fill a short entry
    const firstShort = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");
    emitFill(api, firstShort.orderId);
    expect(trader.positions.size).toBe(1);

    // Price rises back to base → positions should be closed
    api.price = 100;
    await trader._checkBaseStop(100);

    expect(trader.positions.size).toBe(0);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("base-stop");
  });

  test("trader stays active after base-stop close", async () => {
    const api = new FakeApi({ price: 100 });
    const destroyFn = jest.fn();
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    const firstLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    emitFill(api, firstLong.orderId);

    api.price = 100;
    await trader._checkBaseStop(100);

    // Trader must still be active — NOT destroyed
    expect(trader.active).toBe(true);
    expect(destroyFn).not.toHaveBeenCalled();

    // Pending entries should still exist (ladder continues)
    expect(trader.pendingEntriesById.size).toBeGreaterThan(0);
  });

  test("does not close positions when price is away from base", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const firstLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    emitFill(api, firstLong.orderId);

    // Price goes further up — should NOT trigger base-stop
    await trader._checkBaseStop(105);

    expect(trader.positions.size).toBe(1);
    expect(trader.tradeHistory.length).toBe(0);
  });

  test("destroy closes all positions and marks inactive", async () => {
    const api = new FakeApi({ price: 100 });
    const destroyFn = jest.fn();
    const trader = new LadderTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    const firstLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    emitFill(api, firstLong.orderId);

    await trader.destroy("manual", { closePositions: true });

    expect(trader.active).toBe(false);
    expect(trader.positions.size).toBe(0);
    expect(destroyFn).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
  });
});

describe("FlipTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      maxDoubles: 5,
      feeRate: 0
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places one LONG and one SHORT initial stop-limit entry", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.pendingEntriesById.size).toBe(2);
    expect(trader.traderType).toBe("FLIP");

    const entries = Array.from(trader.pendingEntriesById.values());
    const longs = entries.filter((e) => e.direction === "LONG");
    const shorts = entries.filter((e) => e.direction === "SHORT");
    expect(longs.length).toBe(1);
    expect(shorts.length).toBe(1);

    // Both should be stop-limit orders
    const orders = Array.from(api.orders.values());
    expect(orders.every((o) => o.stopPrice !== undefined)).toBe(true);

    // Both at base notional
    expect(longs[0].notional).toBe(100);
    expect(shorts[0].notional).toBe(100);
  });

  test("filling LONG places TP/SL and doubles the SHORT entry", async () => {
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const longEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    const shortEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");

    // Fill the LONG
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: longEntry.orderId,
      side: "BUY",
      price: longEntry.price,
      quantity: longEntry.quantity
    });

    // Position should exist
    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];
    expect(pos.direction).toBe("LONG");

    // TP and SL exit orders should be placed
    expect(trader.pendingExitsById.size).toBe(2);
    const exits = Array.from(trader.pendingExitsById.values());
    expect(exits.some((e) => e.type === "TP")).toBe(true);
    expect(exits.some((e) => e.type === "SL")).toBe(true);

    // Old SHORT entry should have been cancelled
    expect(api.cancelOrder).toHaveBeenCalledWith({ symbol: "TESTUSDT", orderId: shortEntry.orderId });

    // New SHORT entry should exist with 2x notional
    const newShort = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");
    expect(newShort).toBeTruthy();
    expect(newShort.notional).toBe(200);

    expect(trader.doubleCount).toBe(1);
    expect(trader.currentMultiplier).toBe(2);
  });

  test("filling SHORT places TP/SL and doubles the LONG entry", async () => {
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const shortEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");

    // Fill the SHORT
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: shortEntry.orderId,
      side: "SELL",
      price: shortEntry.price,
      quantity: shortEntry.quantity
    });

    // New LONG entry should exist with 2x notional
    const newLong = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    expect(newLong).toBeTruthy();
    expect(newLong.notional).toBe(200);
    expect(trader.doubleCount).toBe(1);
  });

  test("take profit hit destroys the trader", async () => {
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const destroyFn = jest.fn();
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    const longEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");

    // Fill the LONG entry
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: longEntry.orderId,
      side: "BUY",
      price: longEntry.price,
      quantity: longEntry.quantity
    });

    // Find the TP exit order
    const tpExit = Array.from(trader.pendingExitsById.values()).find((e) => e.type === "TP");
    expect(tpExit).toBeTruthy();

    // Fill the TP
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: tpExit.orderId,
      side: "SELL",
      price: tpExit.price,
      quantity: longEntry.quantity
    });

    // Trader should be destroyed
    expect(trader.active).toBe(false);
    expect(destroyFn).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
  });

  test("stop loss hit keeps trader alive, opposite entry remains", async () => {
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const destroyFn = jest.fn();
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    const longEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");

    // Fill the LONG
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: longEntry.orderId,
      side: "BUY",
      price: longEntry.price,
      quantity: longEntry.quantity
    });

    // Find the SL exit order
    const slExit = Array.from(trader.pendingExitsById.values()).find((e) => e.type === "SL");
    expect(slExit).toBeTruthy();

    // Fill the SL
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: slExit.orderId,
      side: "SELL",
      price: slExit.price,
      quantity: longEntry.quantity
    });

    // Trader should still be alive
    expect(trader.active).toBe(true);
    expect(destroyFn).not.toHaveBeenCalled();

    // Position should be closed
    expect(trader.positions.size).toBe(0);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");

    // Doubled SHORT entry should still be pending
    const pendingShort = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");
    expect(pendingShort).toBeTruthy();
    expect(pendingShort.notional).toBe(200);
  });

  test("maxDoubles reached destroys the trader", async () => {
    Object.assign(config, { maxDoubles: 1 });
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const destroyFn = jest.fn();
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    // Fill LONG → doubles to 1 (within limit)
    const longEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: longEntry.orderId,
      side: "BUY",
      price: longEntry.price,
      quantity: longEntry.quantity
    });

    expect(trader.doubleCount).toBe(1);
    expect(trader.active).toBe(true);

    // SL fills → position closes
    const slExit = Array.from(trader.pendingExitsById.values()).find((e) => e.type === "SL");
    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: slExit.orderId,
      side: "SELL",
      price: slExit.price,
      quantity: longEntry.quantity
    });

    // Doubled SHORT should fill → triggers another double which exceeds maxDoubles
    const shortEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");
    expect(shortEntry).toBeTruthy();

    await trader._onOrderFilled({
      symbol: "TESTUSDT",
      orderId: shortEntry.orderId,
      side: "SELL",
      price: shortEntry.price,
      quantity: shortEntry.quantity
    });

    // doubleCount is now 2, which exceeds maxDoubles=1 → destroyed
    expect(trader.active).toBe(false);
    expect(destroyFn).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
  });

  test("multiplier doubles correctly through multiple flips", async () => {
    Object.assign(config, { maxDoubles: 10 });
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Flip 1: LONG fills → SHORT becomes 2x
    const long1 = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    await trader._onOrderFilled({
      symbol: "TESTUSDT", orderId: long1.orderId,
      side: "BUY", price: long1.price, quantity: long1.quantity
    });
    expect(trader.currentMultiplier).toBe(2);

    // SL on LONG → position closed
    const sl1 = Array.from(trader.pendingExitsById.values()).find((e) => e.type === "SL");
    await trader._onOrderFilled({
      symbol: "TESTUSDT", orderId: sl1.orderId,
      side: "SELL", price: sl1.price, quantity: long1.quantity
    });

    // Flip 2: SHORT fills → LONG becomes 4x
    const short1 = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "SHORT");
    await trader._onOrderFilled({
      symbol: "TESTUSDT", orderId: short1.orderId,
      side: "SELL", price: short1.price, quantity: short1.quantity
    });
    expect(trader.currentMultiplier).toBe(4);
    expect(trader.doubleCount).toBe(2);

    // Verify the new LONG entry has 4x notional
    const long2 = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    expect(long2.notional).toBe(400);
  });

  test("destroy closes positions and marks inactive", async () => {
    const api = new FakeApi({ price: 100 });
    api.cancelOrder = jest.fn().mockResolvedValue({});
    const destroyFn = jest.fn();
    const trader = new FlipTrader({ symbol: "TESTUSDT", api, onDestroy: destroyFn });

    await trader.start();

    // Fill an entry to have an open position
    const longEntry = Array.from(trader.pendingEntriesById.values()).find((e) => e.direction === "LONG");
    await trader._onOrderFilled({
      symbol: "TESTUSDT", orderId: longEntry.orderId,
      side: "BUY", price: longEntry.price, quantity: longEntry.quantity
    });

    await trader.destroy("manual", { closePositions: true });

    expect(trader.active).toBe(false);
    expect(trader.positions.size).toBe(0);
    expect(destroyFn).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(store.removeTrader).toHaveBeenCalled();
  });
});
