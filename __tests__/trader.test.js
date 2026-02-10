const EventEmitter = require("events");

jest.mock("../src/utils/logger", () => ({
  log: jest.fn()
}));

jest.mock("../src/state/store", () => ({
  upsertTrader: jest.fn(),
  removeTrader: jest.fn(),
  recordTrade: jest.fn()
}));

const Trader = require("../src/core/trader");
const config = require("../src/utils/config");

class FakeApi extends EventEmitter {
  constructor({ price }) {
    super();
    this.price = price;
    this.orderSeq = 0;
    this.orders = new Map();
  }

  async getMarkPrice() {
    return this.price;
  }

  async placeMarketOrder() {
    return { status: "FILLED", price: this.price, orderId: `M-${++this.orderSeq}` };
  }

  async placeLimitOrder({ symbol, side, quantity, price }) {
    const orderId = `L-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, price });
    return { orderId };
  }

  async placeStopLimitOrder({ symbol, side, quantity, stopPrice, price }) {
    const orderId = `S-${++this.orderSeq}`;
    this.orders.set(orderId, { orderId, symbol, side, quantity, stopPrice, price });
    return { orderId };
  }

  async cancelAllOpenOrders() {
    return { status: "CANCELED" };
  }

  async closePositionMarket() {
    return { status: "NONE" };
  }
}

function emitFill(api, orderId) {
  const order = api.orders.get(orderId);
  if (!order) return;
  api.emit("orderFilled", {
    symbol: order.symbol,
    orderId,
    side: order.side,
    price: order.price,
    quantity: order.quantity
  });
}

describe("Trader grid behavior", () => {
  const baseConfig = { ...config };

  beforeEach(() => {
    Object.assign(config, baseConfig, {
      mode: "test",
      levelSpacingPercent: 1,
      levelCount: 2,
      takeProfitPercent: 1,
      stopLossPercent: 1,
      positionNotionalUSDT: 100,
      leverage: 1,
      feeRate: 0
    });
  });

  afterEach(() => {
    Object.assign(config, baseConfig);
  });

  test("places two initial entry orders", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    expect(trader.pendingEntriesById.size).toBe(2);
  });

  test("fills entry and closes on take profit", async () => {
    const api = new FakeApi({ price: 100 });
    const trader = new Trader({ symbol: "TESTUSDT", api, onDestroy: jest.fn() });

    await trader.start();

    const firstPending = Array.from(trader.pendingEntriesById.values())[0];
    emitFill(api, firstPending.orderId);
    const initialCount = trader.positions.size;
    expect(initialCount).toBeGreaterThan(0);

    const firstPos = Array.from(trader.positions.values())[0];
    api.price = firstPos.takeProfitPrice;
    await trader._onMarkPrice({ symbol: "TESTUSDT", price: api.price });

    const exitOrder = Array.from(api.orders.values()).find((order) => order.price === firstPos.takeProfitPrice);
    expect(exitOrder).toBeTruthy();
    emitFill(api, exitOrder.orderId);

    expect(trader.positions.size).toBeLessThan(initialCount);
    expect(trader.tradeHistory.length).toBeGreaterThan(0);
  });
});
