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

const DCATrader = require("../src/core/dcaTrader");
const config = require("../src/utils/config");
const store = require("../src/state/store");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
  }
  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }
  async placeMarketOrder({ side, quantity }) {
    return { status: "FILLED", price: this.price, quantity };
  }
  async cancelOrder() { return { status: "CANCELED" }; }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
}

describe("DCATrader (Ladder Strategy)", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test", leverage: 2, fixedNotional: 100, equityFraction: 0.9,
      feeRate: 0, startingBalanceUSDT: 1000, takeProfitPercent: 1,
      stopLossPercent: 1, ladderLevels: 3, ladderGapPercent: 1
    });
  });

  afterEach(() => { Object.assign(config, baseConfig); });

  test("builds correct number of orders on each side", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    expect(trader.longs).toHaveLength(3);
    expect(trader.shorts).toHaveLength(3);
    expect(trader.longs.every(o => o.status === "pending")).toBe(true);
    expect(trader.shorts.every(o => o.status === "pending")).toBe(true);
  });

  test("long stop prices are spaced 1% above start price", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    expect(trader.longs[0].stopPrice).toBeCloseTo(101, 4);
    expect(trader.longs[1].stopPrice).toBeCloseTo(102, 4);
    expect(trader.longs[2].stopPrice).toBeCloseTo(103, 4);
  });

  test("short stop prices are spaced 1% below start price", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    expect(trader.shorts[0].stopPrice).toBeCloseTo(99, 4);
    expect(trader.shorts[1].stopPrice).toBeCloseTo(98, 4);
    expect(trader.shorts[2].stopPrice).toBeCloseTo(97, 4);
  });

  test("TP/SL prices correct for pending long orders", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    const l0 = trader.longs[0];
    expect(l0.tpPrice).toBeCloseTo(101 * 1.01, 4);
    expect(l0.slPrice).toBeCloseTo(101 * 0.99, 4);
  });

  test("TP/SL prices correct for pending short orders", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    const s0 = trader.shorts[0];
    expect(s0.tpPrice).toBeCloseTo(99 * 0.99, 4);
    expect(s0.slPrice).toBeCloseTo(99 * 1.01, 4);
  });

  test("pending long fills when price reaches stop", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    expect(trader.longs[0].status).toBe("active");
    expect(trader.longs[1].status).toBe("pending");
  });

  test("pending short fills when price drops to stop", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 99;
    await trader._checkExits(99);
    expect(trader.shorts[0].status).toBe("active");
    expect(trader.shorts[1].status).toBe("pending");
  });

  test("multiple orders fill when price jumps past several levels", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 103;
    await trader._checkExits(103);
    expect(trader.longs[0].status).toBe("active");
    expect(trader.longs[1].status).toBe("active");
    expect(trader.longs[2].status).toBe("active");
  });

  test("long order closes with TP", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    api.price = 102.01;
    await trader._checkExits(102.01);
    expect(trader.longs[0].status).toBe("tp");
    expect(trader.accumulatedTpCount).toBe(1);
  });

  test("long order closes with SL", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    api.price = 99.99;
    await trader._checkExits(99.99);
    expect(trader.longs[0].status).toBe("sl");
    expect(trader.accumulatedSlCount).toBe(1);
  });

  test("short order closes with TP", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 99;
    await trader._checkExits(99);
    api.price = 98.01;
    await trader._checkExits(98.01);
    expect(trader.shorts[0].status).toBe("tp");
    expect(trader.accumulatedTpCount).toBe(1);
  });

  test("short order closes with SL", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 99;
    await trader._checkExits(99);
    api.price = 99.99;
    await trader._checkExits(99.99);
    expect(trader.shorts[0].status).toBe("sl");
    expect(trader.accumulatedSlCount).toBe(1);
  });

  test("destroys when all orders on one side are closed", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();
    api.price = 103;
    await trader._checkExits(103);
    api.price = 104.04;
    await trader._checkExits(104.04);
    expect(trader.longs.every(o => o.status === "tp")).toBe(true);
    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalled();
  });

  test("does NOT destroy while orders remain pending on both sides", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    api.price = 102.01;
    await trader._checkExits(102.01);
    expect(trader.longs[0].status).toBe("tp");
    expect(trader.active).toBe(true);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  test("accumulated TP PnL tracked correctly", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    const qty = trader.longs[0].quantity;
    api.price = 102.01;
    await trader._checkExits(102.01);
    expect(trader.accumulatedTpCount).toBe(1);
    expect(trader.accumulatedTpPnl).toBeCloseTo(1.01 * qty, 2);
  });

  test("accumulated SL PnL tracked correctly", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    const qty = trader.longs[0].quantity;
    api.price = 99.99;
    await trader._checkExits(99.99);
    expect(trader.accumulatedSlCount).toBe(1);
    expect(trader.accumulatedSlPnl).toBeCloseTo(-1.01 * qty, 2);
  });

  test("unrealized PnL tracks active orders only", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    expect(trader._calcUnrealizedPnl(105)).toBe(0);
    api.price = 101;
    await trader._checkExits(101);
    const qty = trader.longs[0].quantity;
    expect(trader._calcUnrealizedPnl(102)).toBeCloseTo(qty, 4);
  });

  test("entry and close fees are tracked", async () => {
    config.feeRate = 0.001;
    config.ladderLevels = 1; // single level to avoid extra fills
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    const qty = trader.longs[0].quantity;
    const entryFee = 101 * qty * 0.001;
    expect(trader.feesPaid).toBeCloseTo(entryFee, 6);
    api.price = 102.01;
    await trader._checkExits(102.01);
    const closeFee = 102.01 * qty * 0.001;
    expect(trader.feesPaid).toBeCloseTo(entryFee + closeFee, 5);
  });

  test("markPrice event triggers checks", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 101 });
    expect(trader.longs[0].status).toBe("active");
  });

  test("bookTicker event triggers checks", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 99;
    await trader._onBookTicker({ symbol: "TESTUSDT", bid: 98.5, ask: 99.5 });
    expect(trader.shorts[0].status).toBe("active");
  });

  test("ignores events for other symbols", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    await trader._onMarkPrice({ symbol: "OTHER", price: 101 });
    expect(trader.longs[0].status).toBe("pending");
  });

  test("store is updated with ladder fields", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    expect(store.upsertTrader).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "TESTUSDT", traderType: "LADDER", ladderLevels: 3,
        ladderGapPercent: 1, takeProfitPercent: 1, stopLossPercent: 1,
        accumulatedTpCount: 0, accumulatedSlCount: 0, status: "ACTIVE"
      })
    );
  });

  test("manual destroy closes active orders", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    await trader.destroy("manual");
    expect(trader.active).toBe(false);
    expect(trader.longs[0].status).not.toBe("active");
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
  });

  test("max lifetime triggers destroy", async () => {
    config.maxLifetimeMs = 1000;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();
    trader.createdAt = new Date(Date.now() - 2000).toISOString();
    await trader._checkExits(100);
    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "expired");
  });

  test("uses fixedNotional when equity >= fixedNotional", async () => {
    config.fixedNotional = 100;
    config.leverage = 5;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0, equity: 1000 });
    await trader.start();
    expect(trader.margin).toBeCloseTo(100, 4);
    expect(trader.notional).toBeCloseTo(500, 4);
  });

  test("uses equity fraction when equity < fixedNotional", async () => {
    config.fixedNotional = 200;
    config.equityFraction = 0.5;
    config.leverage = 2;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0, equity: 150 });
    await trader.start();
    expect(trader.margin).toBeCloseTo(75, 4);
    expect(trader.notional).toBeCloseTo(150, 4);
  });

  test("highestNetProfit tracks peak", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    trader.lastPrice = 105;
    trader._trackHighestProfit();
    const peak = trader.highestNetProfit;
    expect(peak).toBeGreaterThan(0);
    trader.lastPrice = 101.5;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(peak, 4);
  });

  test("trade history records level number", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    api.price = 102.01;
    await trader._checkExits(102.01);
    expect(trader.tradeHistory).toHaveLength(1);
    expect(trader.tradeHistory[0].level).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("LONG");
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
  });

  test("recordTrade is called on store for each closed order", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();
    api.price = 101;
    await trader._checkExits(101);
    api.price = 102.01;
    await trader._checkExits(102.01);
    expect(store.recordTrade).toHaveBeenCalledTimes(1);
    expect(store.recordTrade).toHaveBeenCalledWith(
      expect.objectContaining({ pnl: expect.any(Number), fees: expect.any(Number) })
    );
  });
});
