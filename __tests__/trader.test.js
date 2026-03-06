const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  getPerformance: jest.fn(() => ({ netProfit: 0 }))
}));

const GridTrader = require("../src/core/gridTrader");
const config = require("../src/utils/config");

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
    return 100;
  }

  async placeMarketOrder({ side, quantity }) {
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

  async cancelOrder() {
    return {};
  }

  async cancelAllOpenOrders() {
    return { status: "CANCELED" };
  }

  async closePositionMarket() {
    return { status: "NONE" };
  }
}

describe("GridTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      maxFilledLevels: 5,
      destroyPercent: 20,
      equityFraction: 0.25,
      leverage: 10,
      feeRate: 0,
      startingBalanceUSDT: 100
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places initial stop-limit entry orders below price", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Should have 5 pending entries below price
    expect(trader.pendingEntriesById.size).toBe(5);

    // All entries should be below start price
    for (const entry of trader.pendingEntriesById.values()) {
      expect(entry.price).toBeLessThan(100);
    }
  });

  test("fills entry on orderFilled event", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const firstPending = Array.from(trader.pendingEntriesById.values())[0];
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: firstPending.orderId,
      side: "SELL",
      price: firstPending.price,
      quantity: firstPending.quantity
    });

    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];
    expect(pos.direction).toBe("SHORT");
    expect(pos.stopLossPrice).toBeGreaterThan(pos.entryPrice);
  });

  test("destroys trader when price drops by destroyPercent", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy });

    await trader.start();

    // Price drops 20% → should trigger destroy
    api.price = 80;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 80 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
  });

  test("stop loss closes position when price rises above SL", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Fill a position
    const firstPending = Array.from(trader.pendingEntriesById.values())[0];
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: firstPending.orderId,
      side: "SELL",
      price: firstPending.price,
      quantity: firstPending.quantity
    });

    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];

    // Price rises above SL
    api.price = pos.stopLossPrice + 1;
    await trader._maybeForceClose(api.price);

    expect(trader.positions.size).toBe(0);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
  });

  test("level spacing is correct", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const entries = Array.from(trader.pendingEntriesById.values())
      .sort((a, b) => b.price - a.price);

    // With 1% spacing from price 100: 99, 98, 97, 96, 95
    expect(entries).toHaveLength(5);
    expect(entries[0].price).toBeCloseTo(99, 1);
    expect(entries[1].price).toBeCloseTo(98, 1);
    expect(entries[2].price).toBeCloseTo(97, 1);
    expect(entries[3].price).toBeCloseTo(96, 1);
    expect(entries[4].price).toBeCloseTo(95, 1);
  });

  test("SL percent equals 100/leverage", async () => {
    config.leverage = 20; // SL should be 5%
    const api = new FakeApi({ price: 100 });
    const trader = new GridTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Fill a position at price 99
    const firstPending = Array.from(trader.pendingEntriesById.values())
      .sort((a, b) => b.price - a.price)[0];

    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: firstPending.orderId,
      side: "SELL",
      price: firstPending.price,
      quantity: firstPending.quantity
    });

    const pos = Array.from(trader.positions.values())[0];
    const expectedSL = firstPending.price * (1 + 5 / 100);
    expect(pos.stopLossPrice).toBeCloseTo(expectedSL, 4);
  });
});
