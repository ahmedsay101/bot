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

describe("DCATrader", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test",
      leverage: 2,
      fixedNotional: 50,
      equityFraction: 0.9,
      feeRate: 0,
      startingBalanceUSDT: 1000
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places a single market SHORT at start", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.startPrice).toBe(100);
    expect(trader.entryPrice).toBe(100);
    // equity=1000 >= fixedNotional=50, margin=50, notional=50*2=100, qty=100/100=1
    expect(trader.quantity).toBe(1);
  });

  test("TP and SL prices are set correctly", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // changePercent=60, TP% = round(60/10) = 6
    // TP = 100 * (1 - 6/100) = 94
    expect(trader.tpPrice).toBe(94);
    // changePercent=60 → TP%=6, SL%=50 → SL = 100 * (1 + 50/100) = 150
    expect(trader.slPrice).toBeCloseTo(150, 4);
  });

  test("quantity formula: fixedNotional path vs equity fraction fallback", async () => {
    // Path 1: equity >= fixedNotional → margin = fixedNotional
    config.fixedNotional = 100;
    config.leverage = 5;
    const api = new FakeApi({ price: 200 });
    // equity=1000 >= 100 → margin=100, notional=100*5=500, qty=500/200=2.5
    const t1 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60, equity: 1000 });
    await t1.start();
    expect(t1.margin).toBeCloseTo(100, 4);
    expect(t1.quantity).toBe(2.5);

    // Path 2: equity < fixedNotional → margin = equity * fraction
    config.fixedNotional = 200;
    config.equityFraction = 0.5;
    config.leverage = 5;
    // equity=150 < 200 → margin=150*0.5=75, notional=75*5=375, qty=375/200=1.875
    const t2 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60, equity: 150 });
    await t2.start();
    expect(t2.margin).toBeCloseTo(75, 4);
    expect(t2.quantity).toBe(1.875);
  });

  test("destroys on take-profit when price drops to TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // TP = 94 (changePercent=60, round(60/10)=6%)
    expect(trader.tpPrice).toBe(94);

    trader.lastPrice = 94;
    await trader._checkExits(94);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("destroys on stop-loss when price rises to SL", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // changePercent=60 → TP%=6, SL%=50 → SL = 100 * 1.50 = 150
    expect(trader.slPrice).toBeCloseTo(150, 4);

    trader.lastPrice = 151;
    await trader._checkExits(151);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "stop-loss");
  });

  test("PnL is correct on take-profit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // margin=50, notional=100, qty=100/100=1, TP=94
    trader.lastPrice = 94;
    await trader._checkExits(94);

    // Short PnL = (entry - exit) * qty = (100 - 94) * 1 = 6
    expect(trader.realizedPnl).toBeCloseTo(6, 2);
  });

  test("PnL is negative on stop-loss", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    trader.lastPrice = 151;
    await trader._checkExits(151);

    // Short PnL uses slPrice = 150 (capped to SL), so (100 - 150) * 1 = -50
    expect(trader.realizedPnl).toBeCloseTo(-50, 0);
  });

  test("does not trigger TP or SL in safe zone", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price at 95 → between TP(94) and SL(150), should stay active
    trader.lastPrice = 95;
    await trader._checkExits(95);
    expect(trader.active).toBe(true);

    // Price at 120 → still between TP and SL(150)
    trader.lastPrice = 120;
    await trader._checkExits(120);
    expect(trader.active).toBe(true);
  });

  test("unrealized PnL tracks price movement", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price drops to 95 → short is profitable
    const unrealized = trader._calcUnrealizedPnl(95);
    expect(unrealized).toBeCloseTo(5, 4); // (100-95)*1 = +5

    // Price rises to 110 → short is at a loss
    const unrealized2 = trader._calcUnrealizedPnl(110);
    expect(unrealized2).toBeCloseTo(-10, 4); // (100-110)*1 = -10
  });

  test("fees are tracked correctly", async () => {
    config.feeRate = 0.001; // 0.1%
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Entry fee: 100 * 1 * 0.001 = 0.1
    expect(trader.feesPaid).toBeCloseTo(0.1, 6);

    // Close at TP (94)
    trader.lastPrice = 94;
    await trader._checkExits(94);

    // Close fee: 94 * 1 * 0.001 = 0.094
    // Total fees: 0.1 + 0.094 = 0.194
    expect(trader.feesPaid).toBeCloseTo(0.194, 6);

    // PnL = gross - fees = (100-94)*1 - 0.194 = 5.806
    expect(trader.realizedPnl).toBeCloseTo(5.806, 2);
  });

  test("trade history is recorded on close", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    trader.lastPrice = 94;
    await trader._checkExits(94);

    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].entry).toBe(100);
    expect(trader.tradeHistory[0].exit).toBe(94);
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

  test("highestNetProfit tracks peak unrealized profit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price drops to 95 → short profit = (100-95)*1 = 5
    trader.lastPrice = 95;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(5, 4);

    // Price goes back to 98 → peak should stay at 5
    trader.lastPrice = 98;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(5, 4);
  });

  test("configurable parameters are respected", async () => {
    config.fixedNotional = 100;
    config.equityFraction = 0.1;
    config.leverage = 3;
    const api = new FakeApi({ price: 200 });
    // changePercent=80 → TP% = round(80/10) = 8, SL% = 16
    // equity=1000 >= fixedNotional=100 → margin=100, notional=100*3=300, qty=300/200=1.5
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 80, equity: 1000 });
    await trader.start();

    expect(trader.leverage).toBe(3);
    expect(trader.margin).toBeCloseTo(100, 4);
    expect(trader.notional).toBeCloseTo(300, 4);
    expect(trader.quantity).toBe(1.5);
    expect(trader.takeProfitPercent).toBe(8);
    expect(trader.stopLossPercent).toBe(50);
    // TP = 200 * (1 - 8/100) = 184
    expect(trader.tpPrice).toBeCloseTo(184, 4);
    // SL = 200 * (1 + 50/100) = 300
    expect(trader.slPrice).toBeCloseTo(300, 4);
  });

  test("markPrice event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Emit mark price at TP level (94)
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 94 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("bookTicker event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Emit book ticker with bid/ask averaging to SL level (SL=150)
    await trader._onBookTicker({ symbol: "TESTUSDT", bid: 149, ask: 151 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "stop-loss");
  });

  test("store is updated with correct fields", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(store.upsertTrader).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "TESTUSDT",
        traderType: "DCA",
        entryPrice: 100,
        tpPrice: 94,
        slPrice: expect.closeTo(150, 0),
        leverage: 2,
        quantity: 1,
        margin: 50,
        notional: 100,
        status: "ACTIVE"
      })
    );
  });

  test("TP% is derived from 24h changePercent / 10 rounded", async () => {
    const api = new FakeApi({ price: 100 });

    // changePercent=53 → round(53/10)=5 → TP=100*(1-5/100)=95
    const t1 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 53 });
    await t1.start();
    expect(t1.takeProfitPercent).toBe(5);
    expect(t1.tpPrice).toBeCloseTo(95, 4);

    // changePercent=127 → round(127/10)=13 → TP=100*(1-13/100)=87
    const t2 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 127 });
    await t2.start();
    expect(t2.takeProfitPercent).toBe(13);
    expect(t2.tpPrice).toBeCloseTo(87, 4);

    // changePercent=3 → round(3/10)=0 → clamped to 1 → TP=99
    const t3 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 3 });
    await t3.start();
    expect(t3.takeProfitPercent).toBe(1);
    expect(t3.tpPrice).toBeCloseTo(99, 4);
  });

  test("TP/SL exit uses target price, not gapped lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // TP=94, but price gaps down to 80 (far past TP)
    trader.lastPrice = 80;
    await trader._checkExits(80);

    // Exit should use tpPrice (94), not lastPrice (80)
    expect(trader.tradeHistory[0].exit).toBe(94);
    // PnL = (100 - 94) * 1 = 6, not (100 - 80) * 1 = 20
    expect(trader.realizedPnl).toBeCloseTo(6, 2);
  });

  test("SL exit uses slPrice, not gapped lastPrice", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // SL=150, but price gaps up to 170 (past SL)
    trader.lastPrice = 170;
    await trader._checkExits(170);

    // Exit should use slPrice (150), not lastPrice (170)
    expect(trader.tradeHistory[0].exit).toBeCloseTo(150, 0);
    // PnL = (100 - 150) * 1 = -50, not (100 - 170) * 1 = -70
    expect(trader.realizedPnl).toBeCloseTo(-50, 0);
  });

  test("trader is destroyed when max lifetime is reached", async () => {
    config.maxLifetimeMs = 1000; // 1 second
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Backdate createdAt so it appears expired
    trader.createdAt = new Date(Date.now() - 2000).toISOString();

    // Price in safe zone, but lifetime expired
    await trader._checkExits(98);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "expired");
  });
});
