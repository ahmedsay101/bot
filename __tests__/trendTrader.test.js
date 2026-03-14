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

const TrendTrader = require("../src/core/trendTrader");
const config = require("../src/utils/config");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orderSeq = 0;
  }

  async getMarkPrice() {
    return this.price;
  }

  async getBalance() {
    return 200;
  }

  async placeMarketOrder({ side, quantity }) {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }

  async cancelAllOpenOrders() {
    return { status: "CANCELED" };
  }
}

describe("TrendTrader behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      tpPercent: 5,
      slPercent: 5,
      leverage: 2,
      feeRate: 0,
      startingBalanceUSDT: 200
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("opens a SHORT position on start", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.direction).toBe("SHORT");
    expect(trader.entryPrice).toBe(100);
    expect(trader.quantity).toBeGreaterThan(0);
  });

  test("SL and TP prices are correct for SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    // SHORT: SL = 100 * 1.05 = 105, TP = 100 * 0.95 = 95
    expect(trader.stopLossPrice).toBeCloseTo(105);
    expect(trader.takeProfitPrice).toBeCloseTo(95);
  });

  test("on TP hit, opens same direction (SHORT → SHORT)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Price drops to TP (95)
    api.price = 94;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 94 });

    expect(trader.direction).toBe("SHORT");
    expect(trader.entryPrice).toBe(94); // new entry at current price
    expect(trader.tradeHistory).toHaveLength(1);
    expect(trader.tradeHistory[0].reason).toBe("take-profit");
    expect(trader.tradeHistory[0].direction).toBe("SHORT");
    expect(trader.wins).toBe(1);
  });

  test("on SL hit, flips direction (SHORT → LONG)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Price rises to SL (105)
    api.price = 106;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 106 });

    expect(trader.direction).toBe("LONG");
    expect(trader.entryPrice).toBe(106);
    expect(trader.tradeHistory).toHaveLength(1);
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
    expect(trader.losses).toBe(1);
  });

  test("LONG TP/SL prices are correct after flip", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Flip to LONG at 106
    api.price = 106;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 106 });

    // LONG: SL = 106 * 0.95 = 100.7, TP = 106 * 1.05 = 111.3
    expect(trader.direction).toBe("LONG");
    expect(trader.stopLossPrice).toBeCloseTo(100.7);
    expect(trader.takeProfitPrice).toBeCloseTo(111.3);
  });

  test("LONG TP hit keeps same direction (LONG → LONG)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Flip to LONG
    api.price = 106;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 106 });
    expect(trader.direction).toBe("LONG");

    // TP at 111.3 → price hits 112
    api.price = 112;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 112 });

    expect(trader.direction).toBe("LONG");
    expect(trader.entryPrice).toBe(112);
    expect(trader.tradeHistory).toHaveLength(2);
    expect(trader.tradeHistory[1].reason).toBe("take-profit");
  });

  test("LONG SL hit flips to SHORT", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Flip to LONG at 106
    api.price = 106;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 106 });
    expect(trader.direction).toBe("LONG");

    // SL at 100.7 → price drops to 100
    api.price = 100;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 100 });

    expect(trader.direction).toBe("SHORT");
    expect(trader.tradeHistory).toHaveLength(2);
    expect(trader.tradeHistory[1].reason).toBe("stop-loss");
  });

  test("destroy closes position and calls onDestroy", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy });
    await trader.start();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number));
    expect(trader.tradeHistory).toHaveLength(1);
    expect(trader.tradeHistory[0].reason).toBe("destroy");
  });

  test("consecutive win/loss streaks are tracked", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrendTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });
    await trader.start();

    // Win 1: SHORT TP hit at 94
    api.price = 94;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 94 });
    expect(trader.consecutiveWins).toBe(1);

    // Win 2: SHORT TP hit at ~89
    api.price = 88;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 88 });
    expect(trader.consecutiveWins).toBe(2);
    expect(trader.maxConsecutiveWins).toBe(2);

    // Loss: SHORT SL hit
    const slPrice = trader.stopLossPrice;
    api.price = slPrice + 1;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: slPrice + 1 });
    expect(trader.consecutiveWins).toBe(0);
    expect(trader.consecutiveLosses).toBe(1);
  });
});
