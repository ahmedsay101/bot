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

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orders = [];
  }
  async getMarkPrice() { return this.price; }
  async getBalance() { return 1000; }
  async placeMarketOrder({ symbol, side, quantity, positionSide }) {
    this.orders.push({ symbol, side, quantity, positionSide, price: this.price });
    return { status: "FILLED", price: this.price, quantity };
  }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
}

describe("DCATrader (short + hedge)", () => {
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
      takeProfitPercent: 10,
      hedgeTriggerPercent: 5,
      hedgeStopLossPercent: 5
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("opens single market SHORT at start with TP set 10% below", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "X", api, onDestroy: jest.fn(), changePercent: 75 });
    await trader.start();

    expect(trader.entryPrice).toBe(100);
    expect(trader.tpPrice).toBeCloseTo(90, 6);
    expect(api.orders).toHaveLength(1);
    expect(api.orders[0]).toMatchObject({ side: "SELL", positionSide: "SHORT" });
  });

  test("destroys when SHORT hits 10% TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "X", api, onDestroy, changePercent: 75 });
    await trader.start();

    await trader._tick(90);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("X", expect.any(Number), "take-profit");
    // Short PnL = (100 - 90) * qty
    expect(trader.realizedPnl).toBeGreaterThan(0);
  });

  test("opens LONG hedge when short loses 5% and no hedge exists", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "X", api, onDestroy: jest.fn(), changePercent: 75 });
    await trader.start();
    expect(trader.hedge).toBeNull();

    api.price = 105; // +5% from entry → short losing 5%
    await trader._tick(105);

    expect(trader.hedge).not.toBeNull();
    expect(trader.hedge.entryPrice).toBe(105);
    expect(trader.hedge.slPrice).toBeCloseTo(105 * 0.95, 6); // -5% from hedge entry
    expect(trader.hedgeCount).toBe(1);
    const hedgeOrder = api.orders.find((o) => o.positionSide === "LONG");
    expect(hedgeOrder).toMatchObject({ side: "BUY" });
  });

  test("does NOT open a second hedge while one is active", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "X", api, onDestroy: jest.fn(), changePercent: 75 });
    await trader.start();

    api.price = 106;
    await trader._tick(106);
    expect(trader.hedgeCount).toBe(1);

    api.price = 110;
    await trader._tick(110);
    expect(trader.hedgeCount).toBe(1); // still one hedge
  });

  test("hedge SL closes hedge only; trader remains active", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "X", api, onDestroy, changePercent: 75 });
    await trader.start();

    api.price = 105;
    await trader._tick(105);
    expect(trader.hedge).not.toBeNull();
    const hedgeSl = trader.hedge.slPrice;

    api.price = hedgeSl - 0.01;
    await trader._tick(hedgeSl - 0.01);

    expect(trader.hedge).toBeNull();
    expect(trader.active).toBe(true);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  test("re-opens hedge after SL when short still losing", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "X", api, onDestroy: jest.fn(), changePercent: 75 });
    await trader.start();

    api.price = 105;
    await trader._tick(105);
    expect(trader.hedgeCount).toBe(1);
    const slBeforeBounce = trader.hedge.slPrice;

    // Hedge SL: price drops below hedge SL, hedge closes
    api.price = slBeforeBounce - 0.01;
    await trader._tick(slBeforeBounce - 0.01);
    expect(trader.hedge).toBeNull();

    // Price comes back up — short still losing >= 5% from entry (100)
    api.price = 106;
    await trader._tick(106);

    expect(trader.hedgeCount).toBe(2);
    expect(trader.hedge).not.toBeNull();
  });

  test("manual destroy closes hedge AND short", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "X", api, onDestroy, changePercent: 75 });
    await trader.start();

    api.price = 106;
    await trader._tick(106);
    expect(trader.hedge).not.toBeNull();

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(trader.hedge).toBeNull();
    expect(onDestroy).toHaveBeenCalledWith("X", expect.any(Number), "manual");
    // Should have placed: SELL short, BUY hedge, SELL hedge close, BUY short close
    const sides = api.orders.map((o) => `${o.side}:${o.positionSide}`);
    expect(sides).toEqual([
      "SELL:SHORT",
      "BUY:LONG",
      "SELL:LONG",
      "BUY:SHORT"
    ]);
  });

  test("does not open hedge below trigger threshold", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "X", api, onDestroy: jest.fn(), changePercent: 75 });
    await trader.start();

    api.price = 104; // +4% only
    await trader._tick(104);

    expect(trader.hedge).toBeNull();
  });
});
