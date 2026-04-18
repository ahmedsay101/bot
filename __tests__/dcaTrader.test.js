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
    this.orderSeq = 0;
  }

  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }

  async placeMarketOrder({ side, quantity }) {
    return { status: "FILLED", price: this.price, quantity };
  }

  async cancelOrder() { return { status: "CANCELED" }; }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
}

describe("DCATrader (Hedge Strategy)", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test",
      leverage: 2,
      fixedNotional: 50,
      equityFraction: 0.9,
      feeRate: 0,
      startingBalanceUSDT: 1000,
      takeProfitPercent: 1,
      stopLossPercent: 10
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("starts with both LONG and SHORT positions", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    expect(trader.long.active).toBe(true);
    expect(trader.short.active).toBe(true);
    expect(trader.long.entryPrice).toBe(100);
    expect(trader.short.entryPrice).toBe(100);
    expect(trader.long.quantity).toBe(1); // margin=50, notional=100, qty=100/100=1
    expect(trader.short.quantity).toBe(1);
  });

  test("sets correct TP/SL for both legs", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // LONG: TP = 100 * 1.01 = 101, SL = 100 * 0.90 = 90
    expect(trader.long.tpPrice).toBe(101);
    expect(trader.long.slPrice).toBe(90);
    // SHORT: TP = 100 * 0.99 = 99, SL = 100 * 1.10 = 110
    expect(trader.short.tpPrice).toBe(99);
    expect(trader.short.slPrice).toBe(110);
  });

  test("destroys with take-profit when both TPs hit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    // SHORT TP hit at price 99
    trader.lastPrice = 99;
    await trader._checkExits(99);
    expect(trader.short.active).toBe(false);
    expect(trader.long.active).toBe(true);
    expect(trader.active).toBe(true); // still active, waiting for long TP

    // LONG TP hit at price 101
    trader.lastPrice = 101;
    await trader._checkExits(101);
    expect(trader.long.active).toBe(false);
    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("destroys with stop-loss when LONG SL hit, closes SHORT too", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    // LONG SL = 90
    api.price = 90;
    trader.lastPrice = 90;
    await trader._checkExits(90);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("destroys with stop-loss when SHORT SL hit, closes LONG too", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    // SHORT SL = 110
    api.price = 110;
    trader.lastPrice = 110;
    await trader._checkExits(110);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("SL closes the hit leg and destroy closes the other", async () => {
    const api = new FakeApi({ price: 100 });
    const placeOrder = jest.spyOn(api, "placeMarketOrder");
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // 2 calls for opening LONG + SHORT
    expect(placeOrder).toHaveBeenCalledTimes(2);

    // SHORT SL hit at 110 → _closeLeg(short) + destroy → _closeLeg(long)
    api.price = 110;
    trader.lastPrice = 110;
    await trader._checkExits(110);

    // 2 opens + 1 close short SL + 1 close long in destroy = 4
    expect(placeOrder).toHaveBeenCalledTimes(4);
    expect(trader.totalTrades).toBe(2);
  });

  test("PnL is correct on both TPs hit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // SHORT TP = 99
    trader.lastPrice = 99;
    await trader._checkExits(99);

    // LONG TP = 101
    trader.lastPrice = 101;
    await trader._checkExits(101);

    // SHORT PnL = (100 - 99) * 1 = 1
    // LONG PnL = (101 - 100) * 1 = 1
    expect(trader.realizedPnl).toBeCloseTo(2, 2);
  });

  test("PnL on SL: one loss, one partial gain", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // LONG SL = 90 → LONG loses, SHORT gains
    api.price = 90;
    trader.lastPrice = 90;
    await trader._checkExits(90);

    // LONG closed at SL=90: (90 - 100) * 1 = -10
    // SHORT closed at market=90: (100 - 90) * 1 = +10
    expect(trader.realizedPnl).toBeCloseTo(0, 2);
  });

  test("unrealized PnL tracks both legs", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // Price goes up: LONG gains, SHORT loses (cancel out for same entry)
    expect(trader._calcUnrealizedPnl(105)).toBeCloseTo(0, 4);
    expect(trader._calcUnrealizedPnl(95)).toBeCloseTo(0, 4);
  });

  test("unrealized PnL after one leg closed", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // SHORT TP hit
    trader.lastPrice = 99;
    await trader._checkExits(99);

    // Only LONG active now
    expect(trader._calcUnrealizedPnl(105)).toBeCloseTo(5, 4); // (105-100)*1
    expect(trader._calcUnrealizedPnl(95)).toBeCloseTo(-5, 4);  // (95-100)*1
  });

  test("fees are tracked correctly", async () => {
    config.feeRate = 0.001; // 0.1%
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // LONG entry fee: 100 * 1 * 0.001 = 0.1
    // SHORT entry fee: 100 * 1 * 0.001 = 0.1
    expect(trader.feesPaid).toBeCloseTo(0.2, 6);
  });

  test("markPrice event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    // SHORT SL = 110
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 110 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("bookTicker event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    // mid = (109 + 111)/2 = 110 >= SHORT SL (110) → SL
    await trader._onBookTicker({ symbol: "TESTUSDT", bid: 109, ask: 111 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("store is updated with hedge fields", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    expect(store.upsertTrader).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "TESTUSDT",
        traderType: "HEDGE",
        longActive: true,
        shortActive: true,
        longEntry: 100,
        shortEntry: 100,
        longTp: 101,
        shortTp: 99,
        longSl: 90,
        shortSl: 110,
        leverage: 2,
        quantity: 1,
        margin: 50,
        notional: 100,
        takeProfitPercent: 1,
        stopLossPercent: 10,
        status: "ACTIVE"
      })
    );
  });

  test("manual destroy closes both positions", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 0 });
    await trader.start();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(trader.long.active).toBe(false);
    expect(trader.short.active).toBe(false);
    expect(store.removeTrader).toHaveBeenCalled();
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
  });

  test("trader is destroyed when max lifetime is reached", async () => {
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

  test("quantity formula: fixedNotional vs equity fraction", async () => {
    config.fixedNotional = 100;
    config.leverage = 5;
    const api = new FakeApi({ price: 200 });
    const t1 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0, equity: 1000 });
    await t1.start();
    expect(t1.margin).toBeCloseTo(100, 4);
    expect(t1.long.quantity).toBe(2.5); // 100*5/200

    config.fixedNotional = 200;
    config.equityFraction = 0.5;
    const t2 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0, equity: 150 });
    await t2.start();
    expect(t2.margin).toBeCloseTo(75, 4);
    expect(t2.long.quantity).toBe(1.875); // 75*5/200
  });

  test("highestNetProfit tracks peak unrealized profit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 0 });
    await trader.start();

    // Close short TP first so unrealized only comes from LONG
    trader.lastPrice = 99;
    await trader._checkExits(99);

    // Now only LONG is active
    trader.lastPrice = 110;
    trader._trackHighestProfit();
    // unrealized LONG = (110-100)*1 = 10, realized short = 1
    const peak = trader.realizedPnl + 10;
    expect(trader.highestNetProfit).toBeCloseTo(peak, 4);

    trader.lastPrice = 105;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(peak, 4); // stays at peak
  });
});
