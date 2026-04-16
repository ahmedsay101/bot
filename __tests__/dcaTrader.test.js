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

describe("DCATrader (Flip Strategy)", () => {
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
      takeProfitPercent: 30,
      stopLossPercent: 5
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("starts with a SHORT position", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.direction).toBe("SHORT");
    expect(trader.startPrice).toBe(100);
    expect(trader.entryPrice).toBe(100);
    expect(trader.quantity).toBe(1); // margin=50, notional=100, qty=100/100=1
  });

  test("TP and SL use config percentages (not derived from changePercent)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.takeProfitPercent).toBe(30);
    expect(trader.stopLossPercent).toBe(5);
    // SHORT: TP = 100 * (1 - 30/100) = 70
    expect(trader.tpPrice).toBe(70);
    // SHORT: SL = 100 * (1 + 5/100) = 105
    expect(trader.slPrice).toBe(105);
  });

  test("destroys on take-profit when price drops to TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    trader.lastPrice = 70;
    await trader._checkExits(70);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("flips direction on first SL hit (accSL=5 < TP=30)", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    expect(trader.slPrice).toBe(105);

    // Simulate SL hit
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // Should flip to LONG, not destroy
    expect(trader.active).toBe(true);
    expect(trader.direction).toBe("LONG");
    expect(trader.flipCount).toBe(1);
    expect(trader.accumulatedSlPercent).toBe(5);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  test("LONG position sets correct TP/SL", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Flip to LONG
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // LONG: TP = 105 * (1 + 30/100) = 136.5
    expect(trader.tpPrice).toBe(136.5);
    // LONG: SL = 105 * (1 - 5/100) = 99.75
    expect(trader.slPrice).toBe(99.75);
  });

  test("destroys when accumulated SL% >= TP%", async () => {
    config.takeProfitPercent = 10;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // First SL: accSL = 5 < TP = 10 → flip to LONG
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);
    expect(trader.direction).toBe("LONG");
    expect(trader.accumulatedSlPercent).toBe(5);

    // Second SL: accSL = 10 >= TP = 10 → destroy
    const slPrice = trader.slPrice; // 105 * 0.95 = 99.75
    api.price = slPrice;
    trader.lastPrice = slPrice;
    await trader._checkExits(slPrice);

    expect(trader.active).toBe(false);
    expect(trader.accumulatedSlPercent).toBe(10);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("multiple flips SHORT→LONG→SHORT→...", async () => {
    config.takeProfitPercent = 30;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // SL #1: SHORT → LONG (accSL=5)
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);
    expect(trader.direction).toBe("LONG");
    expect(trader.flipCount).toBe(1);

    // SL #2: LONG → SHORT (accSL=10)
    const sl2 = trader.slPrice;
    api.price = sl2;
    trader.lastPrice = sl2;
    await trader._checkExits(sl2);
    expect(trader.direction).toBe("SHORT");
    expect(trader.flipCount).toBe(2);
    expect(trader.accumulatedSlPercent).toBe(10);

    // SL #3: SHORT → LONG (accSL=15)
    const sl3 = trader.slPrice;
    api.price = sl3;
    trader.lastPrice = sl3;
    await trader._checkExits(sl3);
    expect(trader.direction).toBe("LONG");
    expect(trader.flipCount).toBe(3);
    expect(trader.accumulatedSlPercent).toBe(15);
  });

  test("PnL is correct on take-profit SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // TP=70
    trader.lastPrice = 70;
    await trader._checkExits(70);

    // Short PnL = (100 - 70) * 1 = 30
    expect(trader.realizedPnl).toBeCloseTo(30, 2);
  });

  test("PnL tracks across flips", async () => {
    config.takeProfitPercent = 30;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // SL #1: SHORT @ 100, exit @ 105 → PnL = (100-105)*1 = -5
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    expect(trader.realizedPnl).toBeCloseTo(-5, 2);
    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
  });

  test("unrealized PnL tracks price movement for SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader._calcUnrealizedPnl(95)).toBeCloseTo(5, 4);   // (100-95)*1
    expect(trader._calcUnrealizedPnl(110)).toBeCloseTo(-10, 4); // (100-110)*1
  });

  test("unrealized PnL tracks price movement for LONG", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Flip to LONG
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // qty recalculated at 105: notional/105 = 100/105 ≈ 0.9524
    const qty = trader.quantity;
    expect(trader._calcUnrealizedPnl(110)).toBeCloseTo((110 - 105) * qty, 2);
    expect(trader._calcUnrealizedPnl(100)).toBeCloseTo((100 - 105) * qty, 2);
  });

  test("fees are tracked correctly across flips", async () => {
    config.feeRate = 0.001; // 0.1%
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Entry fee: 100 * 1 * 0.001 = 0.1
    expect(trader.feesPaid).toBeCloseTo(0.1, 6);

    // SL hit → close + open new position
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // Close fee: 105*1*0.001=0.105
    // New open fee: 105*qty*0.001 (qty recalculated for notional/105)
    const newQty = Number((100 / 105).toFixed(4));
    const expectedFees = 0.1 + 0.105 + 105 * newQty * 0.001;
    expect(trader.feesPaid).toBeCloseTo(expectedFees, 3);
  });

  test("manual destroy closes position", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(store.removeTrader).toHaveBeenCalled();
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
  });

  test("max-loss destroy does not try to close position again", async () => {
    config.takeProfitPercent = 5;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const placeOrder = jest.spyOn(api, "placeMarketOrder");
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // 1 call for opening SHORT
    expect(placeOrder).toHaveBeenCalledTimes(1);

    // SL hit: accSL=5 >= TP=5 → destroy with "max-loss"
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // _handleStopLoss closes (1 call) + max-loss destroy skips closing = 2 total
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-loss");
  });

  test("markPrice event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 70 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("bookTicker event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    await trader._onBookTicker({ symbol: "TESTUSDT", bid: 104, ask: 106 });

    // mid = 105 >= SL (105) → SL hit → flip
    expect(trader.direction).toBe("LONG");
    expect(trader.flipCount).toBe(1);
  });

  test("store is updated with flip fields", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(store.upsertTrader).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "TESTUSDT",
        traderType: "FLIP",
        direction: "SHORT",
        flipCount: 0,
        accumulatedSlPercent: 0,
        entryPrice: 100,
        tpPrice: 70,
        slPrice: 105,
        leverage: 2,
        quantity: 1,
        margin: 50,
        notional: 100,
        takeProfitPercent: 30,
        stopLossPercent: 5,
        status: "ACTIVE"
      })
    );
  });

  test("TP exit uses tpPrice, not gapped lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // TP=70, but price gaps to 50
    trader.lastPrice = 50;
    await trader._checkExits(50);

    expect(trader.tradeHistory[0].exit).toBe(70);
    // PnL = (100 - 70) * 1 = 30, not (100 - 50) = 50
    expect(trader.realizedPnl).toBeCloseTo(30, 2);
  });

  test("SL exit uses slPrice, not gapped lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // SL=105, but price gaps to 120
    api.price = 120;
    trader.lastPrice = 120;
    await trader._checkExits(120);

    expect(trader.tradeHistory[0].exit).toBe(105);
    // PnL = (100 - 105) * 1 = -5, not (100 - 120) = -20
    expect(trader.tradeHistory[0].grossPnl).toBeCloseTo(-5, 2);
  });

  test("trader is destroyed when max lifetime is reached", async () => {
    config.maxLifetimeMs = 1000;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    trader.createdAt = new Date(Date.now() - 2000).toISOString();
    await trader._checkExits(98);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "expired");
  });

  test("quantity formula: fixedNotional vs equity fraction", async () => {
    config.fixedNotional = 100;
    config.leverage = 5;
    const api = new FakeApi({ price: 200 });
    const t1 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60, equity: 1000 });
    await t1.start();
    expect(t1.margin).toBeCloseTo(100, 4);
    expect(t1.quantity).toBe(2.5); // 100*5/200

    config.fixedNotional = 200;
    config.equityFraction = 0.5;
    const t2 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60, equity: 150 });
    await t2.start();
    expect(t2.margin).toBeCloseTo(75, 4);
    expect(t2.quantity).toBe(1.875); // 75*5/200
  });

  test("highestNetProfit tracks peak unrealized profit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    trader.lastPrice = 95;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(5, 4);

    trader.lastPrice = 98;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(5, 4); // peak stays at 5
  });
});
