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
