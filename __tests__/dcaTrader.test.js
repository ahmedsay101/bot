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
    this.orders = new Map();
  }

  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }

  async placeMarketOrder({ side, quantity }) {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }

  async placeLimitOrder({ symbol, side, quantity, price }) {
    const orderId = `L-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, price });
    return { orderId };
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
      leverage: 1,
      numOrders: 5,
      distancePercent: 50,
      notionalPerOrder: 50,
      takeProfitPercent: 10,
      feeRate: 0,
      startingBalanceUSDT: 1000
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places market order at start and limit orders above", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.startPrice).toBe(100);
    expect(trader.orders.length).toBe(5);

    // First order filled via market
    expect(trader.orders[0].filled).toBe(true);
    expect(trader.orders[0].fillPrice).toBe(100);

    // Remaining 4 are pending limit orders
    for (let i = 1; i < 5; i++) {
      expect(trader.orders[i].filled).toBe(false);
      expect(trader.orders[i].orderId).toBeTruthy();
    }

    expect(trader.pendingOrdersById.size).toBe(4);
    expect(trader.filledCount).toBe(1);
  });

  test("order prices follow distance formula", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // startPrice * (1 + i * 50/100) → 100, 150, 200, 250, 300
    expect(trader.orders[0].targetPrice).toBe(100);
    expect(trader.orders[1].targetPrice).toBe(150);
    expect(trader.orders[2].targetPrice).toBe(200);
    expect(trader.orders[3].targetPrice).toBe(250);
    expect(trader.orders[4].targetPrice).toBe(300);
  });

  test("quantities are notional * leverage / price", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // notional=50, leverage=1 → qty = 50 / targetPrice
    expect(trader.orders[0].quantity).toBeCloseTo(50 / 100, 4);   // 0.5
    expect(trader.orders[1].quantity).toBeCloseTo(50 / 150, 4);   // 0.3333
    expect(trader.orders[2].quantity).toBeCloseTo(50 / 200, 4);   // 0.25
    expect(trader.orders[3].quantity).toBeCloseTo(50 / 250, 4);   // 0.2
    expect(trader.orders[4].quantity).toBeCloseTo(50 / 300, 4);   // 0.1667
  });

  test("average price is correct with one fill", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Only first order filled at 100 → average = 100
    expect(trader.averagePrice).toBe(100);
    // TP = 100 * (1 - 10/100) = 90
    expect(trader.tpPrice).toBe(90);
  });

  test("fills limit orders in test mode when price rises", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Simulate price rising to 150 → should fill order #1 (target 150)
    api.price = 150;
    trader.lastPrice = 150;
    await trader._simulateFills(150);

    expect(trader.orders[1].filled).toBe(true);
    expect(trader.filledCount).toBe(2);

    // Orders #2-4 should remain unfilled
    expect(trader.orders[2].filled).toBe(false);
    expect(trader.orders[3].filled).toBe(false);
    expect(trader.orders[4].filled).toBe(false);
  });

  test("recalculates average and TP after additional fills", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Fill order #1 at 150
    api.price = 150;
    trader.lastPrice = 150;
    await trader._simulateFills(150);

    // Weighted average: (100*0.5 + 150*0.3333) / (0.5 + 0.3333)
    const qty0 = trader.orders[0].quantity;
    const qty1 = trader.orders[1].quantity;
    const expectedAvg = (100 * qty0 + 150 * qty1) / (qty0 + qty1);
    expect(trader.averagePrice).toBeCloseTo(expectedAvg, 4);

    const expectedTp = expectedAvg * 0.9;
    expect(trader.tpPrice).toBeCloseTo(expectedTp, 4);
  });

  test("destroys on take-profit when price drops to TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // With only first order filled: avg=100, TP=90
    expect(trader.tpPrice).toBe(90);

    // Price drops to TP
    api.price = 90;
    trader.lastPrice = 90;
    await trader._checkTakeProfit(90);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("PnL is correct on take-profit close", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Only order #0 filled at 100, qty = 0.5
    const qty = trader.orders[0].quantity;
    expect(qty).toBeCloseTo(0.5, 4);

    // Price drops to TP (90)
    api.price = 90;
    trader.lastPrice = 90;
    await trader._checkTakeProfit(90);

    // Short PnL = (entry - exit) * qty = (100 - 90) * 0.5 = 5
    expect(trader.realizedPnl).toBeCloseTo(5, 2);
    expect(store.recordTrade).toHaveBeenCalledWith(
      expect.objectContaining({ pnl: expect.any(Number), fees: 0 })
    );
  });

  test("manual destroy closes positions and cancels orders", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    expect(trader.filledCount).toBe(1);
    expect(trader.pendingOrdersById.size).toBe(4);

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(store.removeTrader).toHaveBeenCalled();
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
  });

  test("unrealized PnL tracks price movement", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price drops to 95 → short is profitable
    const qty = trader.orders[0].quantity;
    const unrealized = trader._calcUnrealizedPnl(95);
    expect(unrealized).toBeCloseTo((100 - 95) * qty, 4);

    // Price rises to 110 → short is at a loss
    const unrealized2 = trader._calcUnrealizedPnl(110);
    expect(unrealized2).toBeCloseTo((100 - 110) * qty, 4);
  });

  test("multiple fills and TP with correct weighted average", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Fill orders #1 and #2 (price rises to 200)
    api.price = 200;
    trader.lastPrice = 200;
    await trader._simulateFills(200);

    expect(trader.filledCount).toBe(3); // #0, #1, #2
    expect(trader.orders[0].filled).toBe(true);
    expect(trader.orders[1].filled).toBe(true);
    expect(trader.orders[2].filled).toBe(true);

    // Weighted average: (100*0.5 + 150*0.3333 + 200*0.25) / (0.5 + 0.3333 + 0.25)
    const q0 = trader.orders[0].quantity;
    const q1 = trader.orders[1].quantity;
    const q2 = trader.orders[2].quantity;
    const expectedAvg = (100 * q0 + 150 * q1 + 200 * q2) / (q0 + q1 + q2);
    expect(trader.averagePrice).toBeCloseTo(expectedAvg, 2);

    // TP = average * 0.9
    const expectedTp = expectedAvg * 0.9;
    expect(trader.tpPrice).toBeCloseTo(expectedTp, 2);

    // Price drops to TP
    api.price = expectedTp;
    trader.lastPrice = expectedTp;
    await trader._checkTakeProfit(expectedTp);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
    expect(trader.realizedPnl).toBeGreaterThan(0);
  });

  test("fees are tracked correctly", async () => {
    config.feeRate = 0.001; // 0.1%
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Entry fee for order #0: 100 * 0.5 * 0.001 = 0.05
    const qty = trader.orders[0].quantity;
    const expectedEntryFee = 100 * qty * 0.001;
    expect(trader.feesPaid).toBeCloseTo(expectedEntryFee, 6);

    // Fill order #1 at 150
    api.price = 150;
    trader.lastPrice = 150;
    await trader._simulateFills(150);

    const qty1 = trader.orders[1].quantity;
    const expectedFees = expectedEntryFee + 150 * qty1 * 0.001;
    expect(trader.feesPaid).toBeCloseTo(expectedFees, 6);
  });

  test("trade history is recorded on close", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    api.price = 90;
    trader.lastPrice = 90;
    await trader._checkTakeProfit(90);

    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].entry).toBe(100); // average price
    expect(trader.tradeHistory[0].exit).toBe(90);
  });

  test("live mode fills via orderFilled event", async () => {
    config.mode = "live";
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Get the pending order #1
    const order1 = trader.orders[1];
    expect(order1.filled).toBe(false);
    const orderId = order1.orderId;

    // Emit fill for order #1
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId,
      side: "SELL",
      price: 150,
      quantity: order1.quantity
    });

    expect(order1.filled).toBe(true);
    expect(order1.fillPrice).toBe(150);
    expect(trader.filledCount).toBe(2);

    // Average should be recalculated
    const q0 = trader.orders[0].quantity;
    const q1 = order1.quantity;
    const expectedAvg = (100 * q0 + 150 * q1) / (q0 + q1);
    expect(trader.averagePrice).toBeCloseTo(expectedAvg, 4);
  });

  test("configurable parameters are respected", async () => {
    config.numOrders = 3;
    config.distancePercent = 100;
    config.notionalPerOrder = 100;
    config.leverage = 2;
    config.takeProfitPercent = 20;

    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    expect(trader.numOrders).toBe(3);
    expect(trader.orders.length).toBe(3);

    // Prices: 100, 200, 300
    expect(trader.orders[0].targetPrice).toBe(100);
    expect(trader.orders[1].targetPrice).toBe(200);
    expect(trader.orders[2].targetPrice).toBe(300);

    // Qty: notional*leverage / price = 200 / price
    expect(trader.orders[0].quantity).toBeCloseTo(200 / 100, 4);
    expect(trader.orders[1].quantity).toBeCloseTo(200 / 200, 4);

    // TP: average * (1 - 20/100) = 100 * 0.8 = 80
    expect(trader.tpPrice).toBeCloseTo(80, 4);
  });

  test("highestNetProfit tracks peak unrealized profit", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Price drops to 90 → short profit
    trader.lastPrice = 90;
    trader._trackHighestProfit();
    const qty = trader.orders[0].quantity;
    expect(trader.highestNetProfit).toBeCloseTo((100 - 90) * qty, 4);

    // Price goes back to 95 → peak should stay
    const peak = trader.highestNetProfit;
    trader.lastPrice = 95;
    trader._trackHighestProfit();
    expect(trader.highestNetProfit).toBeCloseTo(peak, 4);
  });
});
