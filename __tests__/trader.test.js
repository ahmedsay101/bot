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

describe("Trader (Top-Gainer Sequential Strategy)", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test",
      leverage: 1,
      equityFraction: 0.1,
      feeRate: 0,
      startingBalanceUSDT: 1000,
      takeProfitPercent: 1,
      stopLossPercent: 5,
      profitTargetPercent: 5,
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
    expect(trader.margin).toBeCloseTo(100, 4);   // 1000 * 0.1
    expect(trader.notional).toBeCloseTo(100, 4); // margin * leverage
    expect(trader.quantity).toBe(1);             // 100 / 100
    expect(trader.transactionCount).toBe(1);
  });

  test("computes TP/SL prices for SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    expect(trader.tpPrice).toBeCloseTo(99, 6);   // 100 * (1 - 1/100)
    expect(trader.slPrice).toBeCloseTo(105, 6);  // 100 * (1 + 5/100)
  });

  test("computes TP/SL prices for LONG", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    // Force a flip to LONG via SL
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);
    expect(trader.direction).toBe("LONG");
    expect(trader.entryPrice).toBe(105);
    expect(trader.tpPrice).toBeCloseTo(105 * 1.01, 6);
    expect(trader.slPrice).toBeCloseTo(105 * 0.95, 6);
  });

  test("on TP: opens another SAME-side position and accumulatedTp grows", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    // SHORT, TP=99 → drop to 99
    api.price = 99;
    trader.lastPrice = 99;
    await trader._checkExits(99);

    expect(trader.direction).toBe("SHORT");                  // same side
    expect(trader.accumulatedTpPercent).toBeCloseTo(1, 6);
    expect(trader.accumulatedSlPercent).toBe(0);
    expect(trader.transactionCount).toBe(2);
    expect(trader.entryPrice).toBe(99);                      // new entry
    expect(trader.tpPrice).toBeCloseTo(99 * 0.99, 6);
  });

  test("on SL: opens OPPOSITE-side position and accumulatedSl grows", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    expect(trader.direction).toBe("LONG");                   // flipped
    expect(trader.accumulatedSlPercent).toBeCloseTo(5, 6);
    expect(trader.accumulatedTpPercent).toBe(0);
    expect(trader.transactionCount).toBe(2);
  });

  test("does NOT destroy until accTp - accSl >= profitTargetPercent", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();

    // Hit TP four times in a row → accTp = 4%, still less than target 5%
    for (let i = 0; i < 4; i++) {
      const newPrice = trader.tpPrice;
      api.price = newPrice;
      trader.lastPrice = newPrice;
      await trader._checkExits(newPrice);
    }
    expect(onDestroy).not.toHaveBeenCalled();
    expect(trader.active).toBe(true);
    expect(trader.accumulatedTpPercent).toBeCloseTo(4, 6);
  });

  test("destroys with reason 'profit-target' when accTp - accSl >= profitTargetPercent", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();

    // Five TP hits → accTp = 5% ≥ target 5%
    for (let i = 0; i < 5; i++) {
      const newPrice = trader.tpPrice;
      api.price = newPrice;
      trader.lastPrice = newPrice;
      await trader._checkExits(newPrice);
    }
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "profit-target");
    expect(trader.active).toBe(false);
  });

  test("net = accTp - accSl reaches target after mixed TP/SL", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    // Lower target so the test stays small
    config.profitTargetPercent = 2;
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();

    // SL hit (accSl=5)
    let p = trader.slPrice; api.price = p; trader.lastPrice = p; await trader._checkExits(p);
    // Now LONG. Hit TP seven times → accTp = 7, net = 7 - 5 = 2 ≥ 2
    for (let i = 0; i < 7; i++) {
      const np = trader.tpPrice;
      api.price = np; trader.lastPrice = np;
      await trader._checkExits(np);
    }
    expect(trader.accumulatedTpPercent).toBeCloseTo(7, 6);
    expect(trader.accumulatedSlPercent).toBeCloseTo(5, 6);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "profit-target");
  });

  test("PnL math: SHORT close at exit < entry yields positive grossPnl", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    // entry=100, qty=1. TP at 99 → grossPnl = (100 - 99) * 1 = 1
    api.price = 99; trader.lastPrice = 99;
    await trader._checkExits(99);

    const calls = store.recordTrade.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].pnl).toBeCloseTo(1, 6);
    expect(calls[0][0].fees).toBeCloseTo(0, 6); // feeRate=0
  });

  test("PnL math: LONG close at exit > entry yields positive grossPnl", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    // SL → flip to LONG at 105
    api.price = 105; trader.lastPrice = 105;
    await trader._checkExits(105);
    // Now LONG entry=105, qty = (100/105).toFixed(4)
    const expectedQty = Number((100 / 105).toFixed(4));
    expect(trader.direction).toBe("LONG");
    expect(trader.quantity).toBe(expectedQty);

    // Hit LONG TP at 105 * 1.01 = 106.05
    const tp = trader.tpPrice;
    api.price = tp; trader.lastPrice = tp;
    await trader._checkExits(tp);

    const slCall = store.recordTrade.mock.calls[0][0]; // SL close
    const tpCall = store.recordTrade.mock.calls[1][0]; // TP close
    expect(slCall.pnl).toBeCloseTo((100 - 105) * 1, 6); // -5
    expect(tpCall.pnl).toBeCloseTo((tp - 105) * expectedQty, 6);
  });

  test("PnL math: fees are recorded on entry and on every close", async () => {
    config.feeRate = 0.0004;
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    // Entry fee = 100 * 1 * 0.0004 = 0.04
    expect(store.recordFee).toHaveBeenCalledTimes(1);
    expect(store.recordFee.mock.calls[0][0]).toBeCloseTo(0.04, 8);

    // TP close → close fee = 99 * 1 * 0.0004 = 0.0396
    api.price = 99; trader.lastPrice = 99;
    await trader._checkExits(99);
    const tradeCall = store.recordTrade.mock.calls[0][0];
    expect(tradeCall.fees).toBeCloseTo(99 * 1 * 0.0004, 8);
  });

  test("uses actual market fill price (not the SL line) for PnL when price overshoots", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    // SHORT entry=100, SL=105. Price spikes to 110 → exit should be 110, not 105.
    api.price = 110; trader.lastPrice = 110;
    await trader._checkExits(110);

    const slCall = store.recordTrade.mock.calls[0][0];
    expect(slCall.pnl).toBeCloseTo((100 - 110) * 1, 6); // -10, not -5
  });

  test("manual destroy closes any open position at lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();
    trader.lastPrice = 102;
    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    const tradeCall = store.recordTrade.mock.calls[0][0];
    // SHORT entry=100, exit=102, qty=1 → grossPnl = -2
    expect(tradeCall.pnl).toBeCloseTo(-2, 6);
  });

  test("expired (max lifetime) destroys the trader", async () => {
    config.maxLifetimeMs = 1; // expire immediately
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();
    // Wait a moment so Date.now() > createdAt + 1ms
    await new Promise((r) => setTimeout(r, 5));
    await trader._checkExits(100);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "expired");
  });

  test("sequential same-side reopen does not flip direction", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    // Two TPs in a row
    api.price = 99; trader.lastPrice = 99; await trader._checkExits(99);
    api.price = 99 * 0.99; trader.lastPrice = api.price; await trader._checkExits(api.price);

    expect(trader.direction).toBe("SHORT");
    expect(trader.transactionCount).toBe(3);
  });

  test("multiple SLs alternate direction SHORT→LONG→SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 50 });
    await trader.start();

    // SHORT SL at 105 → LONG
    api.price = 105; trader.lastPrice = 105; await trader._checkExits(105);
    expect(trader.direction).toBe("LONG");
    // LONG SL at 105 * 0.95
    const longSl = trader.slPrice;
    api.price = longSl; trader.lastPrice = longSl; await trader._checkExits(longSl);
    expect(trader.direction).toBe("SHORT");
    expect(trader.accumulatedSlPercent).toBeCloseTo(10, 6);
    expect(trader.transactionCount).toBe(3);
  });
});
