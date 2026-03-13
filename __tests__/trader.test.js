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

const LevelTrader = require("../src/core/levelTrader");
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

  async getPosition(symbol) {
    return { qty: 0, entryPrice: 0 };
  }
}

describe("LevelTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      numLevels: 5,
      levelGapPercent: 10,
      levelStopLossPercent: 10,
      levelTakeProfitPercent: 20,
      leverage: 2,
      feeRate: 0,
      startingBalanceUSDT: 100
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("fills level 0 immediately and places 4 pending limit orders", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.levels).toHaveLength(5);
    expect(trader.levels[0].status).toBe("filled");
    expect(trader.levels[0].entryPrice).toBe(100);
    for (let i = 1; i < 5; i++) {
      expect(trader.levels[i].status).toBe("pending");
    }
    // 4 limit orders placed
    expect(api.orders.size).toBe(4);
  });

  test("level prices are spaced by gapPercent", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.levels[0].price).toBeCloseTo(100);
    expect(trader.levels[1].price).toBeCloseTo(110);
    expect(trader.levels[2].price).toBeCloseTo(120);
    expect(trader.levels[3].price).toBeCloseTo(130);
    expect(trader.levels[4].price).toBeCloseTo(140);
  });

  test("stop loss is above the highest level", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Highest level = 140, SL = 140 * 1.10 = 154
    expect(trader.stopLossPrice).toBeCloseTo(154);
  });

  test("take profit is below average entry of filled levels", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Only L0 filled at 100, TP = 100 * (1 - 0.20) = 80
    expect(trader.takeProfitPrice).toBeCloseTo(80);

    // Fill L1 at 110
    const l1Order = trader.levels[1].orderId;
    const l1Qty = trader.levels[1].quantity;
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: l1Order,
      side: "SELL",
      price: 110,
      quantity: l1Qty
    });

    // Quantities differ per level (equity/levels/price), so average is weighted
    const l0Qty = trader.levels[0].quantity;
    const expectedAvg = (100 * l0Qty + 110 * l1Qty) / (l0Qty + l1Qty);
    expect(trader.averageEntry).toBeCloseTo(expectedAvg, 4);
    expect(trader.takeProfitPrice).toBeCloseTo(expectedAvg * 0.80, 4);
  });

  test("destroys on stop loss hit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy });

    await trader.start();

    // SL at 154, price goes above it
    api.price = 155;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 155 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
  });

  test("destroys on take profit hit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy });

    await trader.start();

    // Only L0 filled, TP at 80
    api.price = 79;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 79 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalled();
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
  });

  test("filling additional levels recalculates average and TP", async () => {
    config.numLevels = 3;
    config.levelGapPercent = 10;
    const api = new FakeApi({ price: 100 });
    const trader = new LevelTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();
    const qty = trader.levels[0].quantity;

    // Fill L1 at 110
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: trader.levels[1].orderId,
      side: "SELL",
      price: 110,
      quantity: qty
    });

    // Fill L2 at 120
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: trader.levels[2].orderId,
      side: "SELL",
      price: 120,
      quantity: qty
    });

    // Average = (100 + 110 + 120) / 3 = 110
    expect(trader.averageEntry).toBeCloseTo(110);
    // TP = 110 * 0.80 = 88
    expect(trader.takeProfitPrice).toBeCloseTo(88);
    expect(trader.totalQuantity).toBeCloseTo(qty * 3);
  });
});
