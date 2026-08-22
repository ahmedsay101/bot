/**
 * Hold-to-exhaustion two-sided grid lifecycle tests.
 */
import { GridDirectionalTrader } from '../../src/modules/trader/grid/GridDirectionalTrader';
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import type { TraderConfig, SymbolInfo } from '../../src/types';
import type { AccountLedger } from '../../src/modules/calc/AccountLedger';
import Decimal from 'decimal.js';

jest.setTimeout(120000);

const symbolInfo: SymbolInfo = {
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
  positionSize: '1000',
  leverage: 10,
  marginMode: 'ISOLATED',
  traderLifetimeHours: 24,
  takeProfitPercent: '0.10',
  stopLossPercent: '0.10',
  startingSide: 'LONG',
  capitalSteps: 5,
  switchPositionOnTakeProfit: false,
  traderBehavior: 'grid_directional',
  gridLevelsPerSide: 10,
  gridDistancePercent: '5',
  traderTakeProfitPercent: '999',
  traderMaxLifetimeHours: 12,
  trendDetectionEnabled: false,
  refreshInterval: 60000,
  retryLimit: 5,
  feeRate: '0.0005',
  makerFeeRate: '0.0002',
  takerFeeRate: '0.0005',
  slippage: '0.0001',
  mode: 'SIMULATION',
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mockDb(): any {
  const traders = new Map<string, any>();
  const levels = new Map<string, any>();
  const orders = new Map<string, any>();
  const positions: any[] = [];
  return {
    trader: {
      update: jest.fn(async ({ where, data }: any) => {
        const cur = traders.get(where.id) ?? { id: where.id };
        Object.assign(cur, data);
        traders.set(where.id, cur);
        return cur;
      }),
    },
    gridLevel: {
      create: jest.fn(async ({ data }: any) => {
        const id = `gl-${data.direction}-${data.level}`;
        const row = { id, ...data };
        levels.set(id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = levels.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      findMany: jest.fn(async () => [...levels.values()]),
    },
    order: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const cur = orders.get(where.clientOrderId) ?? create;
        Object.assign(cur, update ?? {});
        orders.set(where.clientOrderId, cur);
        return cur;
      }),
    },
    position: {
      create: jest.fn(async ({ data }: any) => {
        positions.push({ ...data, id: `p-${positions.length}` });
        return positions[positions.length - 1];
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    _levels: levels,
    _orders: orders,
    _traders: traders,
  };
}

function mockLedger(): AccountLedger {
  let balance = new Decimal(2000);
  return {
    getAllocation: async () => ({
      totalEquity: new Decimal(1000),
      traderEquity: new Decimal(1000),
      positionAllocation: new Decimal(1000),
      positionNotional: new Decimal(10000),
      maxTraders: 1,
      leverage: 10,
    }),
    getBalance: () => balance,
    recordFee: async (fee: Decimal) => { balance = balance.minus(fee); },
    recordRealized: async (gross: Decimal, fee: Decimal) => {
      balance = balance.plus(gross).minus(fee);
    },
  } as any;
}

describe('Hold-to-exhaustion GridDirectionalTrader', () => {
  let provider: SimulationExecutionProvider;
  let db: ReturnType<typeof mockDb>;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [symbolInfo]);
    provider.enablePartialFills = false;
    provider.onPriceUpdate('BTCUSDT', '100');
    db = mockDb();
  });

  async function boot(cfg: TraderConfig = baseConfig): Promise<GridDirectionalTrader> {
    const trader = new GridDirectionalTrader(
      't1',
      'BTCUSDT',
      'SIMULATION',
      provider,
      cfg,
      db as any,
      mockLedger(),
    );
    provider.on('orderUpdate', (u) => {
      void trader.onOrderUpdate(u);
    });
    provider.onPriceUpdate('BTCUSDT', '100');
    await trader.initialize();
    return trader;
  }

  async function tick(price: string, trader: GridDirectionalTrader, ms = 600): Promise<void> {
    provider.onPriceUpdate('BTCUSDT', price);
    trader.onPriceUpdate(price);
    await wait(ms);
  }

  it('no TP or SL orders are created', async () => {
    const trader = await boot();
    await tick('105', trader, 800);
    const types = [...db._orders.values()].map((o: any) => o.type);
    expect(types.some((t: string) => t.includes('TAKE_PROFIT'))).toBe(false);
    expect([...db._orders.values()].some((o: any) => String(o.clientOrderId).includes('-tp'))).toBe(false);
    expect([...db._orders.values()].some((o: any) => String(o.clientOrderId).includes('-sl'))).toBe(false);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(1);
    // Position stays open — no close from price move alone
    await tick('120', trader, 800);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('side pools and multi-open: multiple LONGs can be active', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    await tick('110', trader, 700);
    await tick('115', trader, 700);
    const g = trader.toSummary().grid!;
    expect(parseFloat(g.longSideCapital!)).toBeCloseTo(500, 4);
    expect(parseFloat(g.shortSideCapital!)).toBeCloseTo(500, 4);
    expect(g.longActive ?? g.longFilled).toBeGreaterThanOrEqual(2);
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(2);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('does NOT destroy on large unrealized PnL (no trader TP)', async () => {
    const trader = await boot({
      ...baseConfig,
      gridDistancePercent: '8', // L2 at 116 — keep only L1 open below that
    });
    await tick('108', trader, 700);
    await tick('114', trader, 700);
    expect(trader.getOpenLegCount()).toBe(1);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    expect(parseFloat(trader.toSummary().unrealizedPnl)).toBeGreaterThan(1);
    trader.destroy();
  });

  it('GRID_EXHAUSTED only after final level + one spacing buffer', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
    });
    // L1=105, L2=110, L3=115; upper destroy = 115 * 1.05 = 120.75
    const g0 = trader.toSummary().grid!;
    expect(parseFloat(g0.lastLongLevel!)).toBeCloseTo(115, 1);
    expect(parseFloat(g0.upperDestroyPrice!)).toBeCloseTo(120.75, 2);

    await tick('105', trader, 800);
    await tick('110', trader, 800);
    await tick('115', trader, 1000);
    await wait(500);
    // Final level ACTIVE — still alive (buffer)
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    expect(trader.toSummary().grid!.longActive).toBe(3);

    await tick('120', trader, 700); // below 120.75
    expect(trader.getStatus()).toBe('ACTIVE');

    await tick('120.75', trader, 700); // exact threshold — alive (strict >)
    expect(trader.getStatus()).toBe('ACTIVE');

    await tick('120.76', trader, 1000); // past buffer
    await wait(800);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('GRID_EXHAUSTED');
    expect(trader.getOpenLegCount()).toBe(0);
  });

  it('price gap across upper buffer still exhausts', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 700);
    await tick('110', trader, 700);
    await tick('115', trader, 900);
    await wait(400);
    expect(trader.getStatus()).toBe('ACTIVE');
    // Jump past 120.75 in one update
    await tick('130', trader, 1000);
    await wait(600);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('GRID_EXHAUSTED');
  });

  it('MAX_LIFETIME destroys trader', async () => {
    const trader = await boot({
      ...baseConfig,
      traderMaxLifetimeHours: 0.0001, // ~0.36s
    });
    await tick('101', trader, 200);
    let status = trader.getStatus();
    for (let i = 0; i < 30 && status !== 'COMPLETED'; i++) {
      await wait(200);
      trader.onPriceUpdate('101');
      status = trader.getStatus();
    }
    expect(status).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('MAX_LIFETIME');
  });

  it('exactly one COMPLETED event on exit race', async () => {
    const trader = await boot();
    let completed = 0;
    trader.on('traderEvent', (e: any) => {
      if (e?.type === 'COMPLETED') completed += 1;
    });
    await tick('105', trader, 500);
    await Promise.all([
      (trader as any).beginExit('GRID_EXHAUSTED'),
      (trader as any).beginExit('MAX_LIFETIME'),
    ]);
    expect(completed).toBe(1);
    expect(trader.toSummary().grid!.exitReason).toBe('GRID_EXHAUSTED');
  });
});
