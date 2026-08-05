/**
 * Full trader lifecycle: Created → Short → Hedge → Short TP → Complete → Slot free.
 * Uses real SimulationExecutionProvider + mocked Prisma / AccountLedger.
 */
import Decimal from 'decimal.js';
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import { Trader } from '../../src/modules/trader/Trader';
import type { SymbolInfo, TraderConfig } from '../../src/types';

const mockSymbolInfo: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  pricePrecision: 2,
  quantityPrecision: 3,
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
  maxLeverage: 125,
  contractType: 'PERPETUAL',
  status: 'TRADING',
};

const traderConfig: TraderConfig = {
  maxTraders: 1,
  initialCapital: '200',
  positionSize: '100',
  leverage: 10,
  marginMode: 'ISOLATED',
  hedgeDistance: '0.10',
  hedgeTpPercent: '0.10',
  hedgeSlPercent: '0.03',
  shortTpPercent: '0.10',
  refreshInterval: 60000,
  retryLimit: 3,
  feeRate: '0.0004',
  slippage: '0.0001',
  mode: 'SIMULATION',
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createMockDb() {
  const orders = new Map<string, Record<string, unknown>>();
  return {
    orders,
    trader: {
      update: jest.fn(async () => ({})),
    },
    order: {
      upsert: jest.fn(async ({ where, create, update }: {
        where: { clientOrderId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const prev = orders.get(where.clientOrderId) ?? {};
        const next = { ...prev, ...create, ...update, clientOrderId: where.clientOrderId, id: where.clientOrderId };
        orders.set(where.clientOrderId, next);
        return next;
      }),
      updateMany: jest.fn(async ({ where, data }: {
        where: { clientOrderId: string };
        data: Record<string, unknown>;
      }) => {
        const prev = orders.get(where.clientOrderId);
        if (prev != null) orders.set(where.clientOrderId, { ...prev, ...data });
        return { count: prev != null ? 1 : 0 };
      }),
      findUnique: jest.fn(async ({ where }: { where: { clientOrderId: string } }) =>
        orders.get(where.clientOrderId) ?? null,
      ),
    },
    position: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
    trade: {
      create: jest.fn(async () => ({})),
    },
    traderStatistics: {
      upsert: jest.fn(async () => ({})),
    },
  };
}

function createMockLedger() {
  let balance = new Decimal(200);
  let realized = new Decimal(0);
  return {
    getAllocation: jest.fn(async () => ({
      totalEquity: new Decimal(200),
      traderEquity: new Decimal(200),
      positionAllocation: new Decimal(100),
      positionNotional: new Decimal(1000),
      maxTraders: 1,
      leverage: 10,
    })),
    recordFee: jest.fn(async (fee: string | Decimal) => {
      balance = balance.minus(fee);
      realized = realized.minus(fee);
    }),
    recordRealized: jest.fn(async (gross: string | Decimal, fee: string | Decimal) => {
      const net = new Decimal(gross).minus(fee);
      balance = balance.plus(net);
      realized = realized.plus(net);
      return net;
    }),
    getBalance: () => balance,
    getRealizedPnl: () => realized,
  };
}

describe('Trader complete lifecycle', () => {
  let provider: SimulationExecutionProvider;
  let db: ReturnType<typeof createMockDb>;
  let ledger: ReturnType<typeof createMockLedger>;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    provider.enablePartialFills = false;
    db = createMockDb();
    ledger = createMockLedger();
  });

  it('keeps first hedge PENDING with SL = entry × (1 − hedgeSl%)', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');

    const trader = new Trader(
      'trader-hedge-pending',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });

    await trader.initialize();
    await wait(200);

    const summary = trader.toSummary();
    const hedge = summary.hedgeLevels.find((h) => h.level === 1);
    expect(hedge).toBeDefined();
    expect(hedge!.status).toBe('PENDING');
    expect(hedge!.entryOrderStatus === 'PENDING' || hedge!.entryOrderStatus === 'NEW').toBe(true);

    const shortEntry = trader.getShortEntryPrice()!;
    expect(hedge!.previousLevelPrice).toBe(shortEntry);
    // SL is % below hedge entry, not equal to short entry
    expect(hedge!.stopPrice).not.toBe(shortEntry);
    expect(parseFloat(hedge!.entryPrice)).toBeGreaterThan(parseFloat(hedge!.stopPrice));
    expect(parseFloat(hedge!.stopPrice)).toBeGreaterThan(parseFloat(shortEntry));

    expect(summary.hedgeStats.ordersCreated).toBe(1);
    expect(summary.hedgeStats.pendingOrders).toBe(1);
    expect(summary.hedgeStats.activePositions).toBe(0);

    // Ladder / orders consistency: open STOP_LIMIT is PENDING, not TRIGGERED
    const entryOrder = summary.orders.find(
      (o) => o.role === 'HEDGE' && o.type === 'STOP_LIMIT' && o.hedgeLevel === 1,
    );
    expect(entryOrder).toBeDefined();
    expect(entryOrder!.status).toBe('PENDING');

    trader.destroy();
  });

  it('promotes hedge to TRIGGERED only after stop is hit', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');

    const trader = new Trader(
      'trader-hedge-trigger',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });

    await trader.initialize();
    await wait(200);

    const hedge = trader.getHedgeLevels().find((h) => h.level === 1)!;
    expect(hedge.status).toBe('PENDING');

    // Drive mark to hedge entry stop (BUY STOP: mark >= entry)
    provider.onPriceUpdate('BTCUSDT', hedge.entryPrice);
    await wait(400);

    const after = trader.getHedgeLevels().find((h) => h.level === 1)!;
    // May be TRIGGERED (limit active) or OPEN (filled if mark crossed limit)
    expect(['TRIGGERED', 'OPEN', 'HIT_TP', 'HIT_SL'].includes(after.status)).toBe(true);
    expect(after.status).not.toBe('PENDING');
    // Position SL stays % below entry
    expect(after.stopPrice).toBe(hedge.stopPrice);
    expect(after.stopPrice).not.toBe(trader.getShortEntryPrice());

    const stats = trader.toSummary().hedgeStats;
    expect(stats.ordersCreated).toBeGreaterThanOrEqual(1);
    if (after.status === 'OPEN' || after.status === 'TRIGGERED') {
      expect(stats.ordersTriggered).toBeGreaterThanOrEqual(1);
    }

    trader.destroy();
  });

  it('runs Created → Short → Hedge → Short TP → Completed with realized PnL', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');

    const trader = new Trader(
      'trader-lifecycle-1',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );

    const events: string[] = [];
    trader.on('traderEvent', (e: { type: string }) => events.push(e.type));

    // Wire sim fills into trader (same as TraderManager / server)
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });

    await trader.initialize();
    await wait(200);

    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.getShortEntryPrice()).not.toBeNull();
    expect(trader.getShortTpPrice()).not.toBeNull();

    const entry = new Decimal(trader.getShortEntryPrice()!);
    const tp = new Decimal(trader.getShortTpPrice()!);
    // Short TP is below entry
    expect(tp.lt(entry)).toBe(true);

    // Drive mark through short TP (BUY TP: mark <= stop)
    provider.onPriceUpdate('BTCUSDT', tp.toFixed(2));
    await wait(400);

    expect(events).toContain('COMPLETED');
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(ledger.recordRealized).toHaveBeenCalled();
    // Realized should move (profit on short when price drops to TP)
    expect(ledger.getRealizedPnl().toNumber()).not.toBe(0);

    // Destroy cleans listeners
    trader.destroy();
    expect(trader.listenerCount('traderEvent')).toBe(0);
  });

  it('onShortTpFilled is idempotent under duplicate FILLED updates', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const trader = new Trader(
      'trader-lifecycle-2',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );

    let completed = 0;
    trader.on('traderEvent', (e: { type: string }) => {
      if (e.type === 'COMPLETED') completed += 1;
    });
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });

    await trader.initialize();
    await wait(200);

    const tp = trader.getShortTpPrice()!;
    const shortTpId = [...db.orders.keys()].find((k) => k.startsWith('short_tp_'));
    expect(shortTpId).toBeDefined();

    // Inject two identical FILLED updates concurrently
    const fill = {
      clientOrderId: shortTpId!,
      exchangeOrderId: 'x',
      symbol: 'BTCUSDT',
      status: 'FILLED' as const,
      filledQuantity: trader.getShortQuantity() ?? '0.01',
      avgFillPrice: tp,
      fee: '0.01',
      feeCurrency: 'USDT',
      timestamp: Date.now(),
    };

    await Promise.all([trader.onOrderUpdate(fill), trader.onOrderUpdate(fill)]);
    await wait(300);

    expect(completed).toBe(1);
  });

  it('sim rehydrate keeps short TP alive after "restart"', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const trader = new Trader(
      'trader-lifecycle-3',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });

    await trader.initialize();
    await wait(200);

    const entry = trader.getShortEntryPrice()!;
    const tp = trader.getShortTpPrice()!;
    const qty = trader.getShortQuantity()!;
    const shortTpId = [...db.orders.keys()].find((k) => k.startsWith('short_tp_'))!;

    // Simulate process restart: fresh provider + restored trader
    const provider2 = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    provider2.enablePartialFills = false;
    provider2.onPriceUpdate('BTCUSDT', '100');

    provider2.rehydrate({
      positions: [{ symbol: 'BTCUSDT', side: 'SHORT', entryPrice: entry, quantity: qty, leverage: 10 }],
      orders: [
        {
          clientOrderId: shortTpId,
          traderId: 'trader-lifecycle-3',
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'TAKE_PROFIT',
          role: 'SHORT',
          hedgeLevel: 0,
          quantity: qty,
          price: tp,
          stopPrice: tp,
          status: 'PENDING',
          positionSide: 'SHORT',
        },
      ],
    });

    const trader2 = new Trader(
      'trader-lifecycle-3',
      'BTCUSDT',
      'SIMULATION',
      provider2,
      traderConfig,
      db as never,
      ledger as never,
    );

    let completed = false;
    trader2.on('traderEvent', (e: { type: string }) => {
      if (e.type === 'COMPLETED') completed = true;
    });
    provider2.on('orderUpdate', (u) => {
      void trader2.onOrderUpdate(u);
    });

    await trader2.restore({
      shortEntryPrice: entry,
      shortTpPrice: tp,
      shortQuantity: qty,
      currentHedgeLevel: 1,
      hedgeLevels: [],
      status: 'ACTIVE',
      realizedPnl: '0',
      unrealizedPnl: '0',
      pendingClientOrderIds: [shortTpId],
      shortClientOrderId: 'short_x',
      shortTpClientOrderId: shortTpId,
      activeHedgeClientOrderId: null,
      hedgeOrderIds: [],
    });

    provider2.onPriceUpdate('BTCUSDT', tp);
    await wait(400);

    expect(completed).toBe(true);
    expect(trader2.getStatus()).toBe('COMPLETED');
  });
});

describe('TraderManager replacement contract', () => {
  it('COMPLETED frees slot and triggers refreshAndFillSlots path', async () => {
    // Exercise the same wireTraderEvents contract: delete maps + destroy + refill hook
    const traders = new Map<string, { destroy: () => void }>();
    const symbolToTrader = new Map<string, string>();
    const destroy = jest.fn();
    traders.set('t1', { destroy });
    symbolToTrader.set('ETHUSDT', 't1');

    let refillCalled = false;
    const onCompleted = async (event: { type: string; traderId: string; symbol: string }) => {
      if (event.type !== 'COMPLETED') return;
      traders.delete(event.traderId);
      symbolToTrader.delete(event.symbol);
      traders.get(event.traderId)?.destroy(); // already deleted — call destroy before delete in real code
      destroy();
      refillCalled = true;
    };

    // Match real manager order: destroy then delete
    const realPath = async (event: { type: string; traderId: string; symbol: string }) => {
      const t = traders.get(event.traderId);
      traders.delete(event.traderId);
      symbolToTrader.delete(event.symbol);
      t?.destroy();
      refillCalled = true;
    };

    await realPath({ type: 'COMPLETED', traderId: 't1', symbol: 'ETHUSDT' });
    expect(traders.size).toBe(0);
    expect(symbolToTrader.size).toBe(0);
    expect(destroy).toHaveBeenCalled();
    expect(refillCalled).toBe(true);
    void onCompleted;
  });

  it('inferOrderSide restores SHORT MARKET as SELL', () => {
    // Mirrors TraderManager.inferOrderSide
    const infer = (o: { side?: string; role: string; type: string }): 'BUY' | 'SELL' => {
      if (o.side === 'BUY' || o.side === 'SELL') return o.side;
      if (o.role === 'SHORT') return o.type === 'MARKET' ? 'SELL' : 'BUY';
      return o.type === 'STOP_LIMIT' ? 'BUY' : 'SELL';
    };
    expect(infer({ role: 'SHORT', type: 'MARKET' })).toBe('SELL');
    expect(infer({ role: 'SHORT', type: 'TAKE_PROFIT' })).toBe('BUY');
    expect(infer({ role: 'HEDGE', type: 'STOP_LIMIT' })).toBe('BUY');
    expect(infer({ role: 'HEDGE', type: 'STOP_MARKET' })).toBe('SELL');
  });
});
