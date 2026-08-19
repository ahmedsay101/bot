/**
 * Single-position directional grid lifecycle tests.
 */
import Decimal from 'decimal.js';
import { EventEmitter } from 'events';
import { GridDirectionalTrader } from '../../src/modules/trader/grid/GridDirectionalTrader';
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import type { TraderConfig, SymbolInfo } from '../../src/types';
import type { AccountLedger } from '../../src/modules/calc/AccountLedger';

jest.setTimeout(60000);

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
  initialCapital: '500',
  positionSize: '500',
  leverage: 5,
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
    _traders: traders,
  };
}

function mockLedger(): AccountLedger {
  let balance = new Decimal(2000);
  return {
    getAllocation: async () => ({
      totalEquity: new Decimal(500),
      traderEquity: new Decimal(500),
      positionAllocation: new Decimal(500),
      positionNotional: new Decimal(2500),
      maxTraders: 1,
      leverage: 5,
    }),
    getBalance: () => balance,
    recordFee: async (fee: Decimal) => { balance = balance.minus(fee); },
    recordRealized: async (gross: Decimal, fee: Decimal) => {
      balance = balance.plus(gross).minus(fee);
    },
  } as any;
}

describe('Single-position GridDirectionalTrader', () => {
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
    // Seed mark before init so startPrice ≈ 100
    provider.onPriceUpdate('BTCUSDT', '100');
    await trader.initialize();
    return trader;
  }

  async function tick(price: string, trader: GridDirectionalTrader, ms = 500): Promise<void> {
    provider.onPriceUpdate('BTCUSDT', price);
    trader.onPriceUpdate(price);
    await wait(ms);
  }

  it('TEST 1: at 105 LONG L1 opens — exactly one active position', async () => {
    const trader = await boot();
    expect(trader.toSummary().grid!.startPrice).toBe('100.00');
    await tick('105', trader, 700);
    const s = trader.toSummary();
    expect(trader.getOpenLegCount()).toBe(1);
    expect(s.currentPosition?.side).toBe('LONG');
    expect(s.currentPosition?.number).toBe(1);
    // TP = fill ± gridDistance (5); SL always start
    const entry = parseFloat(s.currentPosition!.entryPrice);
    expect(parseFloat(s.currentPosition!.tpPrice)).toBeCloseTo(entry + 5, 1);
    expect(s.currentPosition?.slPrice).toBe('100.00');
    trader.destroy();
  });

  it('mandatory path: 105→110→115→120→100→95→90', async () => {
    const trader = await boot();

    async function tickThroughTp(label: string): Promise<void> {
      const pos = trader.toSummary().currentPosition;
      expect(pos).not.toBeNull();
      const tp = parseFloat(pos!.tpPrice);
      // nudge past TP so TAKE_PROFIT triggers despite fill slippage
      const past = pos!.side === 'LONG' ? (tp + 0.05).toFixed(2) : (tp - 0.05).toFixed(2);
      await tick(past, trader, 900);
      await wait(300);
    }

    await tick('105', trader, 700);
    expect(trader.getOpenLegCount()).toBe(1);
    expect(trader.toSummary().currentPosition?.number).toBe(1);

    await tickThroughTp('L1');
    let s = trader.toSummary();
    const l1 = s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1);
    expect(l1?.status).toBe('TP_HIT');
    expect(trader.getOpenLegCount()).toBe(1);
    expect(s.currentPosition?.number).toBe(2);

    await tickThroughTp('L2');
    s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 2)?.status).toBe('TP_HIT');
    expect(s.currentPosition?.number).toBe(3);

    await tickThroughTp('L3');
    s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 3)?.status).toBe('TP_HIT');
    expect(s.currentPosition?.number).toBe(4);

    const capitalAfterLongs = parseFloat(s.grid!.currentCapital ?? '0');
    expect(capitalAfterLongs).toBeGreaterThan(500); // TPs added capital

    // SL at start for L4 LONG
    await tick('100', trader, 900);
    await wait(300);
    s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 4)?.status).toBe('SL_HIT');
    expect(trader.getOpenLegCount()).toBe(0);
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 4)?.status).not.toBe('PENDING');

    const capitalAfterSl = parseFloat(s.grid!.currentCapital ?? '0');
    expect(capitalAfterSl).not.toBe(500); // must not reset

    await tick('95', trader, 900);
    await wait(300);
    s = trader.toSummary();
    expect(s.currentPosition?.side).toBe('SHORT');
    expect(s.currentPosition?.number).toBe(1);
    expect(trader.getOpenLegCount()).toBe(1);
    expect(parseFloat(s.capital.currentStepAmount)).toBe(capitalAfterSl);

    await tickThroughTp('S1');
    s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)?.status).toBe('TP_HIT');
    expect(s.currentPosition?.number).toBe(2);

    trader.destroy();
  }, 90000);

  it('never more than one open position', async () => {
    const trader = await boot();
    await tick('105', trader, 600);
    await tick('110', trader, 200); // mid-flight
    expect(trader.getOpenLegCount()).toBeLessThanOrEqual(1);
    trader.destroy();
  });

  it('L1 weight is largest (display plan)', async () => {
    const trader = await boot();
    const g = trader.toSummary().grid!;
    const l1 = g.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    const l10 = g.levels.find((l) => l.direction === 'LONG' && l.level === 10)!;
    expect(l1.weight).toBe(10);
    expect(l10.weight).toBe(1);
    trader.destroy();
  });
});
