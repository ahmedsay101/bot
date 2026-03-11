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

const StepTrader = require("../src/core/stepTrader");
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

describe("StepTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      stepStopLossPercent: 10,
      stepTakeProfitPercent: 10,
      stepPercent: 10,
      leverage: 2,
      feeRate: 0,
      startingBalanceUSDT: 100
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("opens a SHORT market order on start", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new StepTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.position).not.toBeNull();
    expect(trader.position.entryPrice).toBe(100);
    expect(trader.position.stopLossPrice).toBeCloseTo(110); // 10% above
    expect(trader.position.takeProfitPrice).toBeCloseTo(90); // 10% below start
    expect(trader.stepCount).toBe(0);
  });

  test("destroys on take profit hit (price drops to TP)", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new StepTrader({ symbol: "TESTUSDT", api, onDestroy });

    await trader.start();

    // Price drops to 90 → TP hit
    api.price = 90;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 90 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
  });

  test("steps up TP on stop loss, re-enters", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new StepTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // Price rises to 111 → SL hit (above 110)
    api.price = 111;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 111 });

    expect(trader.stepCount).toBe(1);
    expect(trader.currentTakeProfitPercent).toBe(20); // 10 + 10
    expect(trader.position).not.toBeNull();
    expect(trader.position.entryPrice).toBe(111); // re-entered at 111
    expect(trader.position.stopLossPrice).toBeCloseTo(122.1); // 10% above 111
    expect(trader.position.takeProfitPrice).toBeCloseTo(88.8); // 20% below entry (111)
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
  });

  test("multiple steps then TP hit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new StepTrader({ symbol: "TESTUSDT", api, onDestroy });

    await trader.start();

    // Step 1: SL at ~110, trigger above it
    api.price = 111;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 111 });
    expect(trader.stepCount).toBe(1);
    expect(trader.currentTakeProfitPercent).toBe(20);

    // Step 2: SL at ~122.1, trigger above it
    api.price = 123;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 123 });
    expect(trader.stepCount).toBe(2);
    expect(trader.currentTakeProfitPercent).toBe(30);
    // TP should be 30% below entry (123) = 86.1
    expect(trader.position.takeProfitPrice).toBeCloseTo(86.1);

    // Price drops to 86.1 → TP hit
    api.price = 86;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 86 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalled();
    expect(trader.tradeHistory.length).toBe(3);
    expect(trader.tradeHistory[2].reason).toBe("take-profit");
  });

  test("SL always stays at stepStopLossPercent from entry", async () => {
    config.stepStopLossPercent = 5;
    const api = new FakeApi({ price: 200 });
    const trader = new StepTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.position.stopLossPrice).toBe(210); // 5% of 200

    // Hit SL
    api.price = 210;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 210 });

    expect(trader.position.stopLossPrice).toBeCloseTo(220.5); // 5% of 210
  });
});
