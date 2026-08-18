/**
 * Grid directional lifecycle + scenarios A–E / exits.
 */
import Decimal from 'decimal.js';
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import { GridDirectionalTrader } from '../../src/modules/trader/grid/GridDirectionalTrader';
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
  minNotional: '1',
  maxLeverage: 125,
  contractType: 'PERPETUAL',
  status: 'TRADING',
};

const baseConfig: TraderConfig = {
  maxTraders: 1,
  initialCapital: '1000',
  positionSize: '100',
  leverage: 10,
  marginMode: 'ISOLATED',
  traderLifetimeHours: 24,
  takeProfitPercent: '0.10',
  stopLossPercent: '0.10',
  startingSide: 'SHORT',
  capitalSteps: 5,
  switchPositionOnTakeProfit: false,
  traderBehavior: 'grid_directional',
  gridLevelsPerSide: 10,
  gridDistancePercent: '5',
  traderTakeProfitPercent: '10',
  traderMaxLifetimeHours: 12,
  refreshInterval: 60000,
  retryLimit: 3,
  feeRate: '0.0005',
  makerFeeRate: '0.0002',
  takerFeeRate: '0.0005',
  slippage: '0.0001',
  mode: 'SIMULATION',
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createMockDb() {
  const gridLevels = new Map<string, Record<string, unknown>>();
  const orders = new Map<string, Record<string, unknown>>();
  return {
    trader: { update: jest.fn(async () => ({})) },
    gridLevel: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `${data.direction}-${data.level}`;
        const row = { ...data, id };
        gridLevels.set(id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const next = { ...(gridLevels.get(where.id) ?? {}), ...data };
        gridLevels.set(where.id, next);
        return next;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => [...gridLevels.values()]),
      _store: gridLevels,
    },
    order: {
      upsert: jest.fn(async ({ where, create, update }: {
        where: { clientOrderId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const next = { ...orders.get(where.clientOrderId), ...create, ...update, clientOrderId: where.clientOrderId };
        orders.set(where.clientOrderId, next);
        return next;
      }),
    },
    position: {
      create: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
}

function createMockLedger() {
  let balance = new Decimal(2000);
  let realized = new Decimal(0);
  return {
    getAllocation: jest.fn(async () => ({
      totalEquity: new Decimal(2000),
      traderEquity: new Decimal(1000),
      positionAllocation: new Decimal(1000),
      positionNotional: new Decimal(10000),
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

describe('GridDirectionalTrader lifecycle', () => {
  let provider: SimulationExecutionProvider;
  let db: ReturnType<typeof createMockDb>;
  let ledger: ReturnType<typeof createMockLedger>;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    provider.enablePartialFills = false;
    db = createMockDb();
    ledger = createMockLedger();
  });

  async function boot(cfg: TraderConfig = baseConfig, id = 'grid-1'): Promise<GridDirectionalTrader> {
    provider.onPriceUpdate('BTCUSDT', '100');
    const trader = new GridDirectionalTrader(
      id,
      'BTCUSDT',
      'SIMULATION',
      provider,
      cfg,
      db as never,
      ledger as never,
    );
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });
    await trader.initialize();
    await wait(250);
    return trader;
  }

  async function tick(price: string, trader: GridDirectionalTrader, ms = 450): Promise<void> {
    provider.onPriceUpdate('BTCUSDT', price);
    trader.onPriceUpdate(price);
    await wait(ms);
  }

  it('places 20 pending grid levels around start 100', async () => {
    const trader = await boot();
    const g = trader.toSummary().grid!;
    expect(g.startPrice).toBe('100.00');
    expect(g.levels).toHaveLength(20);
    expect(g.levels.find((l) => l.direction === 'LONG' && l.level === 1)?.triggerPrice).toBe('105.00');
    expect(g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)?.triggerPrice).toBe('95.00');
    trader.destroy();
  });

  it('LONG #1 fills at 105 and stays open; LONG #2 still pending', async () => {
    const trader = await boot();
    await tick('105', trader, 600);
    const g = trader.toSummary().grid!;
    expect(g.longFilled).toBe(1);
    expect(g.levels.find((l) => l.direction === 'LONG' && l.level === 1)?.status).toBe('FILLED');
    expect(g.levels.find((l) => l.direction === 'LONG' && l.level === 2)?.status).toBe('PENDING');
    expect(trader.hasOpenPosition()).toBe(true);
    trader.destroy();
  });

  it('LONG #1 remains open when LONG #2 fills at 110', async () => {
    const trader = await boot();
    await tick('105', trader);
    await tick('110', trader);
    const g = trader.toSummary().grid!;
    expect(g.longFilled).toBe(2);
    expect(g.levels.find((l) => l.direction === 'LONG' && l.level === 1)?.status).toBe('FILLED');
    expect(g.levels.find((l) => l.direction === 'LONG' && l.level === 2)?.status).toBe('FILLED');
    trader.destroy();
  });

  it('SHORT #1 fills at 95', async () => {
    const trader = await boot();
    await tick('95', trader, 600);
    const g = trader.toSummary().grid!;
    expect(g.shortFilled).toBe(1);
    expect(g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)?.status).toBe('FILLED');
    expect(g.longFilled).toBe(0);
    trader.destroy();
  });

  it('Scenario C: partial up 105/110/115 keeps 3 LONGs open', async () => {
    const trader = await boot();
    for (const p of ['105', '110', '115']) await tick(p, trader);
    const g = trader.toSummary().grid!;
    expect(g.longFilled).toBe(3);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.hasOpenPosition()).toBe(true);
    trader.destroy();
  });

  it('Scenario D: deep up then reverse — filled LONGs stay open', async () => {
    const trader = await boot();
    for (const p of ['105', '110', '115', '120']) await tick(p, trader);
    expect(trader.toSummary().grid!.longFilled).toBe(4);
    for (const p of ['115', '110', '105', '100']) await tick(p, trader, 350);
    const g = trader.toSummary().grid!;
    expect(g.longFilled).toBe(4);
    expect(g.levels.filter((l) => l.direction === 'LONG' && l.status === 'FILLED')).toHaveLength(4);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('Scenario E: LONG then SHORT both sides open', async () => {
    const trader = await boot();
    await tick('105', trader);
    await tick('110', trader);
    await tick('100', trader, 350);
    await tick('95', trader);
    await tick('90', trader);
    const g = trader.toSummary().grid!;
    expect(g.longFilled).toBe(2);
    expect(g.shortFilled).toBe(2);
    expect(trader.hasOpenPosition()).toBe(true);
    trader.destroy();
  });

  it('Scenario A (3 levels): full LONG side exits FULL_LONG_GRID', async () => {
    const cfg = { ...baseConfig, gridLevelsPerSide: 3, traderTakeProfitPercent: '999' };
    const trader = await boot(cfg);
    let completedReason: string | undefined;
    trader.on('traderEvent', (e: { type: string; reason?: string }) => {
      if (e.type === 'COMPLETED') completedReason = e.reason;
    });
    for (const p of ['105', '110', '115']) await tick(p, trader, 550);
    await wait(400);
    expect(completedReason).toBe('FULL_LONG_GRID');
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.hasOpenPosition()).toBe(false);
    trader.destroy();
  }, 20000);

  it('Scenario B (3 levels): full SHORT side exits FULL_SHORT_GRID', async () => {
    const cfg = { ...baseConfig, gridLevelsPerSide: 3, traderTakeProfitPercent: '999' };
    const trader = await boot(cfg, 'grid-short');
    let completedReason: string | undefined;
    trader.on('traderEvent', (e: { type: string; reason?: string }) => {
      if (e.type === 'COMPLETED') completedReason = e.reason;
    });
    for (const p of ['95', '90', '85']) await tick(p, trader, 550);
    await wait(400);
    expect(completedReason).toBe('FULL_SHORT_GRID');
    expect(trader.getStatus()).toBe('COMPLETED');
    trader.destroy();
  }, 20000);

  it('exits on MAX_LIFETIME', async () => {
    const cfg = { ...baseConfig, traderMaxLifetimeHours: 0.001, gridLevelsPerSide: 3 };
    const trader = await boot(cfg, 'grid-life');
    let completedReason: string | undefined;
    trader.on('traderEvent', (e: { type: string; reason?: string }) => {
      if (e.type === 'COMPLETED') completedReason = e.reason;
    });
    await wait(4200);
    expect(completedReason).toBe('MAX_LIFETIME');
    expect(trader.getStatus()).toBe('COMPLETED');
    trader.destroy();
  }, 12000);

  it('exits on TRADER_TP when combined profit hits target', async () => {
    const cfg = { ...baseConfig, traderTakeProfitPercent: '0.01', gridLevelsPerSide: 5 };
    const trader = await boot(cfg, 'grid-tp');
    let completedReason: string | undefined;
    trader.on('traderEvent', (e: { type: string; reason?: string }) => {
      if (e.type === 'COMPLETED') completedReason = e.reason;
    });
    await tick('105', trader);
    await tick('120', trader, 700);
    await wait(500);
    expect(completedReason).toBe('TRADER_TP');
    expect(trader.getStatus()).toBe('COMPLETED');
    trader.destroy();
  }, 15000);

  it('duplicate exit requests complete only once', async () => {
    const cfg = { ...baseConfig, gridLevelsPerSide: 3, traderTakeProfitPercent: '999' };
    const trader = await boot(cfg, 'grid-dup');
    let completions = 0;
    trader.on('traderEvent', (e: { type: string }) => {
      if (e.type === 'COMPLETED') completions += 1;
    });
    for (const p of ['105', '110', '115']) await tick(p, trader, 550);
    await wait(300);
    await trader.emergencyStop();
    await wait(300);
    expect(completions).toBe(1);
    trader.destroy();
  }, 20000);

  it('restores startPrice and filled levels after restart', async () => {
    const trader = await boot(baseConfig, 'grid-restore');
    await tick('105', trader, 600);
    const snap = trader.toSummary().grid!;
    expect(snap.longFilled).toBe(1);
    const levels = await db.gridLevel.findMany();
    trader.destroy();

    const restored = new GridDirectionalTrader(
      'grid-restore',
      'BTCUSDT',
      'SIMULATION',
      provider,
      baseConfig,
      db as never,
      ledger as never,
    );
    await restored.restore({
      status: 'ACTIVE',
      realizedPnl: '0',
      unrealizedPnl: '0',
      startedAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
      startPrice: snap.startPrice,
      traderAllocatedAmount: '1000',
      gridLevelsPerSide: 10,
      gridDistancePercent: '5',
      traderTakeProfitPercent: '10',
      totalFees: '0',
      gridLevels: levels,
    });
    const g = restored.toSummary().grid!;
    expect(g.startPrice).toBe(snap.startPrice);
    expect(g.longFilled).toBe(1);
    restored.destroy();
  });
});
