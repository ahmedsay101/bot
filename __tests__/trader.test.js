const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({ log: jest.fn() }));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  recordFee: jest.fn(),
  getPerformance: jest.fn(() => ({ netProfit: 0 })),
  getStatus: jest.fn(() => ({ equity: 1000, balance: 1000 }))
}));

const Trader = require("../src/core/trader");
const config = require("../src/utils/config");
const store = require("../src/state/store");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orders = [];
  }
  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }
  async placeMarketOrder({ side, quantity }) {
    this.orders.push({ side, quantity, price: this.price });
    return { status: "FILLED", price: this.price, quantity };
  }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
}

describe("Trader (Reversed Strategy: TP=5/SL=1, SL→same, TP→opposite)", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test",
      leverage: 1,
      equityFraction: 0.1,
      feeRate: 0,
      startingBalanceUSDT: 1000,
      takeProfitPercent: 5,
      stopLossPercent: 1,
      profitTargetPercent: 5,
      consecutiveSlFlipCount: 5,
      maxLifetimeMs: 24 * 60 * 60 * 1000
    });
  });

  afterEach(() => { Object.assign(config, baseConfig); });

  test("starts with a SHORT position at config sizing", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    expect(trader.direction).toBe("SHORT");
    expect(trader.startPrice).toBe(100);
    expect(trader.entryPrice).toBe(100);
    expect(trader.leverage).toBe(1);
    expect(trader.margin).toBeCloseTo(100, 4);
    expect(trader.notional).toBeCloseTo(100, 4);
    expect(trader.quantity).toBe(1);
    expect(trader.transactionCount).toBe(1);
    expect(trader.consecutiveSl).toBe(0);
  });

  test("computes TP/SL prices for SHORT (TP=5%, SL=1%)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    expect(trader.tpPrice).toBeCloseTo(95, 6);
    expect(trader.slPrice).toBeCloseTo(101, 6);
  });

  test("on SL: opens SAME-side position and consecutiveSl increments", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 101; trader.lastPrice = 101;
    await trader._checkExits(101);

    expect(trader.direction).toBe("SHORT");
    expect(trader.accumulatedSlPercent).toBeCloseTo(1, 6);
    expect(trader.consecutiveSl).toBe(1);
    expect(trader.transactionCount).toBe(2);
    expect(trader.entryPrice).toBe(101);
  });

  test("on TP: opens OPPOSITE-side position and resets consecutiveSl", async () => {
    config.profitTargetPercent = 100; // disable destroy for this test
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 101; trader.lastPrice = 101; await trader._checkExits(101);
    expect(trader.consecutiveSl).toBe(1);

    const tp = trader.tpPrice;
    api.price = tp; trader.lastPrice = tp;
    await trader._checkExits(tp);

    expect(trader.direction).toBe("LONG");
    expect(trader.consecutiveSl).toBe(0);
    expect(trader.accumulatedTpPercent).toBeCloseTo(5, 6);
  });

  test("after 5 consecutive SLs flips to opposite side and resets streak", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    for (let i = 0; i < 4; i++) {
      const sl = trader.slPrice;
      api.price = sl; trader.lastPrice = sl;
      await trader._checkExits(sl);
    }
    expect(trader.direction).toBe("SHORT");
    expect(trader.consecutiveSl).toBe(4);

    const sl5 = trader.slPrice;
    api.price = sl5; trader.lastPrice = sl5;
    await trader._checkExits(sl5);

    expect(trader.direction).toBe("LONG");
    expect(trader.consecutiveSl).toBe(0);
    expect(trader.accumulatedSlPercent).toBeCloseTo(5, 6);
  });

  test("respects config.consecutiveSlFlipCount", async () => {
    config.consecutiveSlFlipCount = 3;
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    for (let i = 0; i < 2; i++) {
      const sl = trader.slPrice;
      api.price = sl; trader.lastPrice = sl;
      await trader._checkExits(sl);
    }
    expect(trader.direction).toBe("SHORT");

    const sl3 = trader.slPrice;
    api.price = sl3; trader.lastPrice = sl3;
    await trader._checkExits(sl3);
    expect(trader.direction).toBe("LONG");
    expect(trader.consecutiveSl).toBe(0);
  });

  test("destroys with reason 'profit-target' when first TP already meets target (5% net)", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();

    const tp = trader.tpPrice;
    api.price = tp; trader.lastPrice = tp;
    await trader._checkExits(tp);

    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "profit-target");
    expect(trader.active).toBe(false);
  });

  test("does NOT destroy when net is below target", async () => {
    config.takeProfitPercent = 2;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();

    const tp = trader.tpPrice;
    api.price = tp; trader.lastPrice = tp;
    await trader._checkExits(tp);
    expect(onDestroy).not.toHaveBeenCalled();
    expect(trader.active).toBe(true);
  });

  test("PnL math: SHORT TP at exit < entry yields positive grossPnl", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 95; trader.lastPrice = 95;
    await trader._checkExits(95);

    const calls = store.recordTrade.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].pnl).toBeCloseTo(5, 6);
  });

  test("PnL math: SHORT SL at exit > entry yields negative grossPnl", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 101; trader.lastPrice = 101;
    await trader._checkExits(101);

    const calls = store.recordTrade.mock.calls;
    expect(calls[0][0].pnl).toBeCloseTo(-1, 6);
  });

  test("uses actual market fill price (not the SL line) when price overshoots", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 105; trader.lastPrice = 105;
    await trader._checkExits(105);

    const slCall = store.recordTrade.mock.calls[0][0];
    expect(slCall.pnl).toBeCloseTo(-5, 6);
  });

  test("fees recorded on entry and on every close", async () => {
    config.feeRate = 0.0004;
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    expect(store.recordFee).toHaveBeenCalledTimes(1);
    expect(store.recordFee.mock.calls[0][0]).toBeCloseTo(0.04, 8);

    api.price = 101; trader.lastPrice = 101;
    await trader._checkExits(101);
    const tradeCall = store.recordTrade.mock.calls[0][0];
    expect(tradeCall.fees).toBeCloseTo(101 * 1 * 0.0004, 8);
  });

  test("manual destroy closes any open position at lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    trader.lastPrice = 102;
    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    const tradeCall = store.recordTrade.mock.calls[0][0];
    expect(tradeCall.pnl).toBeCloseTo(-2, 6);
  });

  test("expired (max lifetime) destroys the trader", async () => {
    config.maxLifetimeMs = 1;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();
    await new Promise((r) => setTimeout(r, 5));
    await trader._checkExits(100);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "expired");
  });
});
