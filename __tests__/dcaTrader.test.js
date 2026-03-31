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
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
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
      notionalPerOrder: 50,
      takeProfitPercent: 10,
      stopLossPercent: 50,
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
    // qty = notional * leverage / price = 50 * 2 / 100 = 1
    expect(trader.quantity).toBe(1);
  });

  test("TP and SL prices are set correctly", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // TP = 100 * (1 - 10/100) = 90
    expect(trader.tpPrice).toBe(90);
    // SL = 100 * (1 + 50/100) = 150
    expect(trader.slPrice).toBe(150);
  });

  test("quantity formula: notional * leverage / price", async () => {
    config.notionalPerOrder = 100;
    config.leverage = 5;
    const api = new FakeApi({ price: 200 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // qty = 100 * 5 / 200 = 2.5
    expect(trader.quantity).toBe(2.5);
  });

  test("destroys on take-profit when price drops to TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    expect(trader.tpPrice).toBe(90);

    trader.lastPrice = 90;
    await trader._checkExits(90);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("destroys on stop-loss when price rises to SL", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    expect(trader.slPrice).toBe(150);

    trader.lastPrice = 150;
    await trader._checkExits(150);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "stop-loss");
  });

  test("PnL is correct on take-profit", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // qty = 50 * 2 / 100 = 1
    trader.lastPrice = 90;
    await trader._checkExits(90);

    // Short PnL = (entry - exit) * qty = (100 - 90) * 1 = 10
    expect(trader.realizedPnl).toBeCloseTo(10, 2);
  });

  test("PnL is negative on stop-loss", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    trader.lastPrice = 150;
    await trader._checkExits(150);

    // Short PnL = (100 - 150) * 1 = -50
    expect(trader.realizedPnl).toBeCloseTo(-50, 2);
  });

  test("does not trigger TP or SL in safe zone", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price at 95 → between TP(90) and SL(150), should stay active
    trader.lastPrice = 95;
    await trader._checkExits(95);
    expect(trader.active).toBe(true);

    // Price at 120 → still between TP and SL
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
    expect(unrealized).toBeCloseTo((100 - 95) * 1, 4); // +5

    // Price rises to 110 → short is at a loss
    const unrealized2 = trader._calcUnrealizedPnl(110);
    expect(unrealized2).toBeCloseTo((100 - 110) * 1, 4); // -10
  });

  test("fees are tracked correctly", async () => {
    config.feeRate = 0.001; // 0.1%
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Entry fee: 100 * 1 * 0.001 = 0.1
    expect(trader.feesPaid).toBeCloseTo(0.1, 6);

    // Close at TP
    trader.lastPrice = 90;
    await trader._checkExits(90);

    // Close fee: 90 * 1 * 0.001 = 0.09
    // Total fees: 0.1 + 0.09 = 0.19
    expect(trader.feesPaid).toBeCloseTo(0.19, 6);

    // PnL = gross - fees = (100-90)*1 - 0.19 = 9.81
    expect(trader.realizedPnl).toBeCloseTo(9.81, 2);
  });

  test("trade history is recorded on close", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    trader.lastPrice = 90;
    await trader._checkExits(90);

    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].entry).toBe(100);
    expect(trader.tradeHistory[0].exit).toBe(90);
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

    // Price drops to 90 → short profit = 10
    trader.lastPrice = 90;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(10, 4);

    // Price goes back to 95 → peak should stay at 10
    trader.lastPrice = 95;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(10, 4);
  });

  test("configurable parameters are respected", async () => {
    config.notionalPerOrder = 100;
    config.leverage = 3;
    config.takeProfitPercent = 20;
    config.stopLossPercent = 30;

    const api = new FakeApi({ price: 200 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.leverage).toBe(3);
    // qty = 100 * 3 / 200 = 1.5
    expect(trader.quantity).toBe(1.5);
    // TP = 200 * 0.8 = 160
    expect(trader.tpPrice).toBeCloseTo(160, 4);
    // SL = 200 * 1.3 = 260
    expect(trader.slPrice).toBeCloseTo(260, 4);
  });

  test("markPrice event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Emit mark price at TP level
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 90 });

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("bookTicker event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Emit book ticker with bid/ask averaging to SL level
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
        tpPrice: 90,
        slPrice: 150,
        leverage: 2,
        quantity: 1,
        status: "ACTIVE"
      })
    );
  });
});
