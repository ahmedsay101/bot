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

const TrapTrader = require("../src/core/trapTrader");
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

  async placeStopLimitOrder({ symbol, side, quantity, stopPrice, price, reduceOnly, positionSide }) {
    const orderId = `S-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, stopPrice, price, reduceOnly, positionSide });
    return { orderId };
  }

  async cancelOrder() { return { status: "CANCELED" }; }
  async cancelAllOpenOrders() { return { status: "CANCELED" }; }
}

function emitFill(api, orderId, overrides = {}) {
  const order = api.orders.get(orderId);
  if (!order) return;
  api.emit("orderFilled", {
    symbol: order.symbol,
    orderId,
    side: order.side,
    price: order.price || order.stopPrice,
    quantity: order.quantity,
    ...overrides
  });
}

describe("TrapTrader", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config, baseConfig, {
      mode: "test",
      leverage: 10,
      equityFraction: 0.10,
      feeRate: 0,
      destroyAfterSL: 0,
      startingBalanceUSDT: 1000
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places two stop-limit entry orders on start", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    expect(trader.startPrice).toBe(100);
    expect(trader.longEntryPrice).toBeCloseTo(101, 6);
    expect(trader.shortEntryPrice).toBeCloseTo(99, 6);
    expect(trader.pendingEntriesById.size).toBe(2);

    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    const shortEntry = entries.find(e => e.direction === "SHORT");
    expect(longEntry).toBeDefined();
    expect(shortEntry).toBeDefined();
    expect(longEntry.price).toBeCloseTo(101, 6);
    expect(shortEntry.price).toBeCloseTo(99, 6);
  });

  test("creates position with SL at startPrice when entry fills", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill the LONG entry — price must be at entry level so SL doesn't trigger immediately
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    await new Promise(r => setTimeout(r, 0)); // let async SL placement complete

    // Should have one position now
    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];
    expect(pos.direction).toBe("LONG");
    expect(pos.entryPrice).toBeCloseTo(101, 6);
    expect(pos.stopLossPrice).toBe(100); // SL = startPrice

    // SL order should be placed
    expect(trader.pendingExitsById.size).toBe(1);
  });

  test("closes position on SL hit in test mode and re-places entry", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill the LONG entry at entry price
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);

    expect(trader.positions.size).toBe(1);

    // Price drops to SL (startPrice = 100)
    api.price = 100;
    await trader._maybeForceClose(100);

    // Position should be closed
    expect(trader.positions.size).toBe(0);
    expect(trader.totalTrades).toBe(1);
    expect(trader.slCount).toBe(1);

    // Should have re-placed the LONG entry order
    const newEntries = Array.from(trader.pendingEntriesById.values());
    const newLong = newEntries.find(e => e.direction === "LONG");
    expect(newLong).toBeDefined();
    expect(newLong.price).toBeCloseTo(101, 6);
  });

  test("SHORT entry fills and SL triggers correctly", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill the SHORT entry at entry price
    const entries = Array.from(trader.pendingEntriesById.values());
    const shortEntry = entries.find(e => e.direction === "SHORT");
    api.price = 99;
    trader.lastPrice = 99;
    emitFill(api, shortEntry.orderId);

    expect(trader.positions.size).toBe(1);
    const pos = Array.from(trader.positions.values())[0];
    expect(pos.direction).toBe("SHORT");
    expect(pos.stopLossPrice).toBe(100);

    // Price rises to SL (startPrice = 100)
    api.price = 100;
    await trader._maybeForceClose(100);

    expect(trader.positions.size).toBe(0);
    expect(trader.slCount).toBe(1);

    // Should have re-placed the SHORT entry
    const newEntries = Array.from(trader.pendingEntriesById.values());
    const newShort = newEntries.find(e => e.direction === "SHORT");
    expect(newShort).toBeDefined();
    expect(newShort.price).toBeCloseTo(99, 6);
  });

  test("tracks PnL correctly after SL hit", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill LONG at 101
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);

    const pos = Array.from(trader.positions.values())[0];
    const qty = pos.quantity;

    // Price drops to SL=100 → PnL = (100-101)*qty*1 = -1*qty
    api.price = 100;
    await trader._maybeForceClose(100);

    const expectedPnl = -1 * qty;
    expect(trader.realizedPnl).toBeCloseTo(expectedPnl, 2);
    expect(store.recordTrade).toHaveBeenCalledWith(
      expect.objectContaining({ pnl: expect.any(Number) })
    );
  });

  test("tracks highestNetProfit", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill LONG at 101
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);

    // Price goes up to 105 → unrealized profit on LONG
    api.price = 105;
    trader.lastPrice = 105;
    trader._trackHighestProfit();

    const pos = Array.from(trader.positions.values())[0];
    const qty = pos.quantity;
    const expectedUnrealized = (105 - 101) * qty;
    expect(trader.highestNetProfit).toBeCloseTo(expectedUnrealized, 4);

    // Price drops back
    api.price = 102;
    trader.lastPrice = 102;
    trader._trackHighestProfit();

    // highestNetProfit should stay at peak
    expect(trader.highestNetProfit).toBeCloseTo(expectedUnrealized, 4);
  });

  test("both entries can fill simultaneously", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    const shortEntry = entries.find(e => e.direction === "SHORT");

    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    api.price = 99;
    trader.lastPrice = 99;
    emitFill(api, shortEntry.orderId);

    expect(trader.positions.size).toBe(2);
    const positions = Array.from(trader.positions.values());
    expect(positions.find(p => p.direction === "LONG")).toBeDefined();
    expect(positions.find(p => p.direction === "SHORT")).toBeDefined();
  });

  test("destroy cancels all orders and closes positions", async () => {
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 10 });
    await trader.start();

    // Fill LONG
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    expect(trader.positions.size).toBe(1);

    await trader.destroy("manual");

    expect(trader.active).toBe(false);
    expect(trader.positions.size).toBe(0);
    expect(store.removeTrader).toHaveBeenCalled();
    expect(onDestroy).toHaveBeenCalledWith("TESTUSDT", expect.any(Number), "manual");
  });

  test("live mode: SL order fill triggers close and re-entry", async () => {
    config.mode = "live";
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill the LONG entry
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    await new Promise(r => setTimeout(r, 0));

    expect(trader.positions.size).toBe(1);
    expect(trader.pendingExitsById.size).toBe(1);
    const slOrderId = Array.from(trader.pendingExitsById.keys())[0];

    // Simulate SL fill via orderFilled event
    api.price = 100;
    api.emit("orderFilled", {
      symbol: "TESTUSDT",
      orderId: slOrderId,
      side: "SELL",
      price: 100,
      quantity: Array.from(trader.positions.values())[0].quantity
    });
    await new Promise(r => setTimeout(r, 0)); // let async finalize complete

    // Position closed, re-entry placed
    expect(trader.positions.size).toBe(0);
    expect(trader.slCount).toBe(1);

    // A new LONG entry should be pending
    const newEntries = Array.from(trader.pendingEntriesById.values());
    const newLong = newEntries.find(e => e.direction === "LONG");
    expect(newLong).toBeDefined();
    expect(newLong.price).toBeCloseTo(101, 6);
  });

  test("SL rejected triggers market close", async () => {
    config.mode = "live";
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill LONG entry
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    await new Promise(r => setTimeout(r, 0));

    expect(trader.pendingExitsById.size).toBe(1);
    const slOrderId = Array.from(trader.pendingExitsById.keys())[0];

    // Simulate SL rejection
    api.emit("orderCancelled", {
      symbol: "TESTUSDT",
      orderId: slOrderId,
      status: "REJECTED"
    });
    await new Promise(r => setTimeout(r, 0)); // let async close complete

    // Position should be closed via market order
    expect(trader.positions.size).toBe(0);
    expect(trader.slCount).toBe(1);
  });

  test("trade history is recorded", async () => {
    config.feeRate = 0;
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 10 });
    await trader.start();

    // Fill and SL LONG
    const entries = Array.from(trader.pendingEntriesById.values());
    const longEntry = entries.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry.orderId);
    api.price = 100;
    await trader._maybeForceClose(100);

    expect(trader.tradeHistory.length).toBe(1);
    expect(trader.tradeHistory[0].direction).toBe("LONG");
    expect(trader.tradeHistory[0].reason).toBe("stop-loss");
    expect(trader.tradeHistory[0].entry).toBeCloseTo(101, 6);
    expect(trader.tradeHistory[0].exit).toBe(100);
  });

  test("trapPercent is derived from changePercent (24h change / 10, rounded)", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 53 });
    expect(trader.trapPercent).toBe(5); // Math.round(53/10) = 5

    const trader2 = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy: jest.fn(), changePercent: 100 });
    expect(trader2.trapPercent).toBe(10); // Math.round(100/10) = 10
  });

  test("destroys when net profit >= trapPercent% of equity", async () => {
    config.feeRate = 0;
    config.leverage = 10;
    config.equityFraction = 1;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    // changePercent=50 → trapPercent=5 → target = 1000 * 5/100 = $50
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 50 });
    await trader.start();
    expect(trader.trapPercent).toBe(5);

    // SHORT entry price = 100 * (1 - 5/100) = 95
    const entries = Array.from(trader.pendingEntriesById.values());
    const shortEntry = entries.find(e => e.direction === "SHORT");
    api.price = 95;
    trader.lastPrice = 95;
    emitFill(api, shortEntry.orderId);
    const pos = Array.from(trader.positions.values())[0];
    const qty = pos.quantity;

    // Price drops so unrealized >= $50: PnL = (95 - price) * qty >= 50
    const targetPrice = 95 - (50 / qty) - 0.01;
    api.price = targetPrice;
    trader.lastPrice = targetPrice;
    await trader._checkTakeProfit(targetPrice);

    // trader should have self-destroyed
    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalled();
  });

  test("destroys after configured number of stop losses", async () => {
    config.feeRate = 0;
    config.destroyAfterSL = 2;
    const api = new FakeApi({ price: 100 });
    const onDestroy = jest.fn();
    const trader = new TrapTrader({ symbol: "TESTUSDT", api, onDestroy, changePercent: 10 });
    await trader.start();

    // First SL: fill LONG at 101, SL at 100
    const entries1 = Array.from(trader.pendingEntriesById.values());
    const longEntry1 = entries1.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry1.orderId);
    api.price = 100;
    await trader._maybeForceClose(100);

    // After 1 SL, trader should still be active
    expect(trader.slCount).toBe(1);
    expect(trader.active).toBe(true);

    // Second SL: fill the re-placed LONG at 101, SL at 100
    const entries2 = Array.from(trader.pendingEntriesById.values());
    const longEntry2 = entries2.find(e => e.direction === "LONG");
    api.price = 101;
    trader.lastPrice = 101;
    emitFill(api, longEntry2.orderId);
    api.price = 100;
    await trader._maybeForceClose(100);

    // After 2 SLs, trader should be destroyed
    expect(trader.slCount).toBe(2);
    expect(trader.active).toBe(false);
    expect(onDestroy).toHaveBeenCalled();
  });
});
