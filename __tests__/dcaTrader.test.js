const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn(),
  recordFee: jest.fn(),
  getPerformance: jest.fn(() => ({ netProfit: 0 })),
  getStatus: jest.fn(() => ({ equity: 1000, balance: 1000 }))
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
      leverage: 1,
      fixedNotional: 50,
      // base equity fraction; trader starts at base/8 (=0.1) and doubles each flip up to base.
      equityFraction: 0.8,
      feeRate: 0,
      startingBalanceUSDT: 1000,
      dynamicTp: true,
      takeProfitPercent: 3,
      stopLossPercent: 5,
      maxAccumulatedSlPercent: 30
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
    // flip 0 → ef=0.1, lev=1, margin=100, notional=100, qty=100/100=1
    expect(trader.quantity).toBe(1);
    expect(trader.leverage).toBe(1);
    expect(trader.margin).toBeCloseTo(100, 4);
    expect(trader.notional).toBeCloseTo(100, 4);
  });

  test("TP is dynamic: accSL + baseTpPercent", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Initially accSL=0, so TP% = 0 + 3 = 3
    expect(trader.takeProfitPercent).toBe(3);
    expect(trader.stopLossPercent).toBe(5);
    // SHORT: TP = 100 * (1 - 3/100) = 97
    expect(trader.tpPrice).toBe(97);
    // SHORT: SL = 100 * (1 + 5/100) = 105
    expect(trader.slPrice).toBe(105);
  });

  test("destroys on take-profit when price drops to TP", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // TP = 97 (accSL=0, base=3%)
    trader.lastPrice = 97;
    await trader._checkExits(97);

    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "take-profit");
  });

  test("flips direction on first SL hit (accSL=5 < maxAccSL=30)", async () => {
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

  test("LONG position sets correct TP/SL (dynamic TP after flip)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Flip to LONG
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // After flip: accSL=5, TP% = 5 + 3 = 8
    expect(trader.takeProfitPercent).toBe(8);
    // LONG: TP = 105 * (1 + 8/100) = 113.4
    expect(trader.tpPrice).toBeCloseTo(113.4, 4);
    // LONG: SL = 105 * (1 - 5/100) = 99.75
    expect(trader.slPrice).toBe(99.75);
  });

  test("destroys with max-doubles after the 7th flip (lev=16 exhausted)", async () => {
    config.takeProfitPercent = 3;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // Trigger 8 SL hits in a row: the first 7 should flip; the 8th must destroy.
    for (let i = 0; i < 8; i++) {
      const sl = trader.slPrice;
      api.price = sl;
      trader.lastPrice = sl;
      await trader._checkExits(sl);
    }

    expect(trader.active).toBe(false);
    expect(trader.flipCount).toBe(7);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-doubles");
  });

  test("leverage and equity-fraction doubling progression", async () => {
    config.takeProfitPercent = 3;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // Expected (ef, lev) per flip count
    const expected = [
      [0.1, 1], [0.2, 1], [0.4, 1], [0.8, 1],
      [0.8, 2], [0.8, 4], [0.8, 8], [0.8, 16]
    ];
    expect(trader.leverage).toBe(expected[0][1]);
    expect(trader.margin / 1000).toBeCloseTo(expected[0][0], 6);

    for (let i = 1; i < expected.length; i++) {
      const sl = trader.slPrice;
      api.price = sl;
      trader.lastPrice = sl;
      await trader._checkExits(sl);
      // store mock returns netProfit=0 → liveBalance always = startingBalance
      const liveBalance = 1000;
      expect(trader.leverage).toBe(expected[i][1]);
      expect(trader.margin / liveBalance).toBeCloseTo(expected[i][0], 6);
    }
  });

  test("multiple flips SHORT→LONG→SHORT→...", async () => {
    config.takeProfitPercent = 3;
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

    // TP=97 (accSL=0, base=3%)
    trader.lastPrice = 97;
    await trader._checkExits(97);

    // Short PnL = (100 - 97) * 1 = 3
    expect(trader.realizedPnl).toBeCloseTo(3, 2);
  });

  test("PnL tracks across flips", async () => {
    config.takeProfitPercent = 3;
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

    // After flip 1: ef doubles to 0.2, liveBalance ≈ 995, qty = (995*0.2)/105
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

    // SL hit → close + open new position with DOUBLED equity fraction (0.1 → 0.2)
    api.price = 105;
    trader.lastPrice = 105;
    await trader._checkExits(105);

    // After SL: store mock keeps netProfit=0 → liveBalance=1000, ef=0.2, lev=1 → notional=200
    // qty = (200 / 105).toFixed(4)
    const newQty = Number((200 / 105).toFixed(4));
    // Close fee: 105*1*0.001=0.105; new open fee: 105*newQty*0.001
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

  test("max-doubles destroy does not try to close position again", async () => {
    config.takeProfitPercent = 3;
    config.stopLossPercent = 5;
    const api = new FakeApi({ price: 100 });
    const placeOrder = jest.spyOn(api, "placeMarketOrder");
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    // 1 call for opening SHORT (flip 0)
    expect(placeOrder).toHaveBeenCalledTimes(1);

    // Trigger 8 SL hits: flips 0–6 each close+open (2 calls each = 14), flip 7 closes once
    // and destroys without re-opening.
    for (let i = 0; i < 8; i++) {
      const sl = trader.slPrice;
      api.price = sl;
      trader.lastPrice = sl;
      await trader._checkExits(sl);
    }

    // 1 (initial open) + 7 flips * 2 (close+open) + 1 (final close) = 16
    expect(placeOrder).toHaveBeenCalledTimes(16);
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "max-doubles");
  });

  test("markPrice event triggers exit check", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 60 });
    await trader.start();

    await trader._onMarkPrice({ symbol: "TESTUSDT", price: 97 });

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
        tpPrice: 97,
        slPrice: 105,
        leverage: 1,
        quantity: 1,
        margin: 100,
        notional: 100,
        takeProfitPercent: 3,
        stopLossPercent: 5,
        status: "ACTIVE"
      })
    );
  });

  test("TP exit uses actual market fill price (mimics live market-order close)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // TP=97, but price gaps to 50 — live market close fills at 50, not 97
    trader.lastPrice = 50;
    await trader._checkExits(50);

    expect(trader.tradeHistory[0].exit).toBe(50);
    // PnL = (100 - 50) * 1 = 50
    expect(trader.tradeHistory[0].grossPnl).toBeCloseTo(50, 2);
  });

  test("SL exit uses actual market fill price (mimics live market-order close)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await trader.start();

    // SL=105, but price gaps to 120 — live market close fills at 120, not 105
    api.price = 120;
    trader.lastPrice = 120;
    await trader._checkExits(120);

    expect(trader.tradeHistory[0].exit).toBe(120);
    // PnL = (100 - 120) * 1 = -20
    expect(trader.tradeHistory[0].grossPnl).toBeCloseTo(-20, 2);
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

  test("quantity formula: equity fraction from store (flip 0 = base/8)", async () => {
    config.leverage = 5;
    config.equityFraction = 0.8;
    config.startingBalanceUSDT = 1000;
    // flip 0: ef=0.8/8=0.1, liveBalance=1000, margin=100, notional=500, qty=500/200=2.5
    const api = new FakeApi({ price: 200 });
    const t1 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await t1.start();
    expect(t1.margin).toBeCloseTo(100, 4);
    expect(t1.quantity).toBe(2.5);

    config.equityFraction = 0.4;
    // flip 0 ef = 0.4/8 = 0.05; simulate prior loss of 850 → liveBalance = 150
    store.getPerformance.mockReturnValueOnce({ netProfit: -850 });
    const t2 = new DCATrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 60 });
    await t2.start();
    expect(t2.margin).toBeCloseTo(7.5, 4);   // 150 * 0.05
    expect(t2.quantity).toBe(0.1875);        // 7.5*5/200 = 0.1875
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
