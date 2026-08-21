/**
 * No-SL max-2 directional grid lifecycle tests.
 */
import { GridDirectionalTrader } from '../../src/modules/trader/grid/GridDirectionalTrader';
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import type { TraderConfig, SymbolInfo } from '../../src/types';
import type { AccountLedger } from '../../src/modules/calc/AccountLedger';
import Decimal from 'decimal.js';

jest.setTimeout(90000);

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
    _orders: orders,
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

describe('No-SL max-2 GridDirectionalTrader', () => {
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

  async function tick(price: string, trader: GridDirectionalTrader, ms = 500): Promise<void> {
    provider.onPriceUpdate('BTCUSDT', price);
    trader.onPriceUpdate(price);
    await wait(ms);
  }

  async function tickThroughTp(trader: GridDirectionalTrader, posNumber?: number): Promise<void> {
    const positions = trader.toSummary().currentPositions
      ?? (trader.toSummary().currentPosition != null ? [trader.toSummary().currentPosition!] : []);
    const pos = posNumber != null
      ? positions.find((p) => p.number === posNumber) ?? positions[0]
      : positions[0];
    expect(pos).toBeTruthy();
    const tp = parseFloat(pos!.tpPrice);
    const past = pos!.side === 'LONG' ? (tp + 0.05).toFixed(2) : (tp - 0.05).toFixed(2);
    await tick(past, trader, 900);
    await wait(300);
  }

  it('TEST 1: no SL order is created', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    const types = [...db._orders.values()].map((o: any) => o.type);
    expect(types).toContain('TAKE_PROFIT_MARKET');
    expect(types.some((t: string) => t === 'STOP_MARKET' && String(t).includes('SL'))).toBe(false);
    // No STOP_MARKET exit at start — only entry STOP_MARKET/MARKET + TAKE_PROFIT_MARKET
    const stopMarkets = [...db._orders.values()].filter((o: any) => o.type === 'STOP_MARKET');
    for (const o of stopMarkets) {
      expect(o.stopPrice).not.toBe('100.00'); // would be SL at start
    }
    const tpOnlyExits = [...db._orders.values()].filter((o: any) =>
      String(o.clientOrderId).includes('-tp') || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT',
    );
    expect(tpOnlyExits.length).toBeGreaterThanOrEqual(1);
    const slIds = [...db._orders.values()].filter((o: any) => String(o.clientOrderId).includes('-sl'));
    expect(slIds).toHaveLength(0);
    trader.destroy();
  });

  it('TEST 2–3: LONG stays open when price falls through start to 95', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    expect(trader.getOpenLegCount()).toBe(1);
    await tick('100', trader, 600);
    expect(trader.getOpenLegCount()).toBe(1);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('95', trader, 700);
    // LONG still open; SHORT L1 may also open (max 2)
    const s = trader.toSummary();
    const longs = (s.currentPositions ?? []).filter((p) => p.side === 'LONG');
    expect(longs.length).toBe(1);
    expect(trader.getOpenLegCount()).toBeLessThanOrEqual(2);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('TEST 4–5: TP completes level permanently; no reopen at 105', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    await tickThroughTp(trader);
    let s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)?.status).toBe('TP_HIT');
    await tick('105', trader, 700);
    s = trader.toSummary();
    expect(s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)?.status).toBe('TP_HIT');
    const l1Active = (s.currentPositions ?? []).some((p) => p.side === 'LONG' && p.number === 1);
    expect(l1Active).toBe(false);
    trader.destroy();
  });

  it('TEST 6–8: one per side; same-side stack blocked; LONG+SHORT allowed', async () => {
    const trader = await boot();
    // Gap through L1 and L2 — only one LONG may open (per-side)
    await tick('112', trader, 1000);
    await wait(400);
    expect(trader.getOpenLegCount()).toBe(1);
    expect(trader.toSummary().grid!.longOpen).toBe(1);
    expect(trader.toSummary().grid!.shortOpen).toBe(0);

    // Drop through start — LONG stays open (no SL); SHORT may open
    await tick('95', trader, 900);
    await wait(400);
    const s = trader.toSummary();
    expect(s.grid!.longOpen).toBe(1);
    expect(s.grid!.shortOpen).toBe(1);
    expect(trader.getOpenLegCount()).toBe(2);

    // Still cannot open a second LONG
    await tick('112', trader, 800);
    await wait(300);
    expect(trader.toSummary().grid!.longOpen).toBe(1);
    expect(trader.getOpenLegCount()).toBeLessThanOrEqual(2);

    trader.destroy();
  });

  it('TEST 9–11: L1 margin ≈ 5% of capital', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    const s = trader.toSummary();
    const margin = parseFloat(s.currentPosition!.stepAmount);
    expect(margin).toBeGreaterThan(20);
    expect(margin).toBeLessThan(35);
    expect(s.grid!.maxPerSide).toBe(1);
    expect(s.grid!.longOpen).toBe(1);
    expect(s.grid!.shortOpen).toBe(0);
    trader.destroy();
  });

  it('§47: L4 stays open when price returns to start (no SL)', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    await tickThroughTp(trader); // L1 TP → L2
    await tickThroughTp(trader); // L2 TP → L3
    await tickThroughTp(trader); // L3 TP → L4
    let s = trader.toSummary();
    expect(s.currentPosition?.number).toBe(4);
    const capitalBefore = parseFloat(s.grid!.currentCapital!);
    // Small early TPs — capital should still move (fees/net), not reset
    expect(capitalBefore).not.toBe(500);

    await tick('115', trader, 600);
    await tick('110', trader, 600);
    await tick('105', trader, 600);
    await tick('100', trader, 700);
    s = trader.toSummary();
    expect(trader.getStatus()).toBe('ACTIVE');
    const l4 = s.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 4);
    expect(l4?.status).toBe('ACTIVE');
    expect(l4?.status).not.toBe('SL_HIT');
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(1);
    trader.destroy();
  }, 120000);

  it('L1 weight is smallest; L10 is largest', async () => {
    const trader = await boot();
    const g = trader.toSummary().grid!;
    const l1 = g.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    const l10 = g.levels.find((l) => l.direction === 'LONG' && l.level === 10)!;
    expect(l1.weight).toBe(1);
    expect(l10.weight).toBe(10);
    trader.destroy();
  });

  describe('TRADER_TP restored', () => {
    it('exposes frozen TP target from initial capital', async () => {
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '10' });
      const g = trader.toSummary().grid!;
      expect(parseFloat(g.traderTpTarget!)).toBeCloseTo(50, 4);
      expect(g.takeProfitPercent).toBe('10');
      await tick('105', trader, 700);
      // Capital may change after entry fees; target stays on initial $500
      expect(parseFloat(trader.toSummary().grid!.traderTpTarget!)).toBeCloseTo(50, 4);
      expect(trader.getStatus()).toBe('ACTIVE');
      trader.destroy();
    });

    it('destroys trader when combined net PnL reaches TRADER_TP', async () => {
      let completedEvents = 0;
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '1' });
      trader.on('traderEvent', (e: any) => {
        if (e?.type === 'COMPLETED') completedEvents += 1;
      });
      await tick('105', trader, 700);
      expect(trader.toSummary().grid!.traderTpReached).toBe(false);
      await tickThroughTp(trader);
      await wait(1200);
      expect(trader.getStatus()).toBe('COMPLETED');
      expect(trader.toSummary().grid!.exitReason).toBe('TRADER_TP');
      expect(completedEvents).toBe(1);
    });

    it('cancels pending entries and closes open legs on TRADER_TP', async () => {
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '10' });
      await tick('105', trader, 700);
      await tick('95', trader, 900);
      await wait(400);
      expect(trader.getOpenLegCount()).toBe(2);
      expect(trader.getStatus()).toBe('ACTIVE');
      // Combined path: exit closes BOTH open legs and cancels remaining PENDING
      await (trader as any).beginExit('TRADER_TP');
      await wait(500);
      expect(trader.getStatus()).toBe('COMPLETED');
      expect(trader.toSummary().grid!.exitReason).toBe('TRADER_TP');
      expect(trader.getOpenLegCount()).toBe(0);
      const pending = trader.toSummary().grid!.levels.filter((l) => l.status === 'PENDING');
      expect(pending.length).toBe(0);
    });

    it('stays ACTIVE when net PnL is below trader TP target', async () => {
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '10' });
      await tick('105', trader, 700);
      await tickThroughTp(trader);
      await wait(400);
      // L1 net ≈ few dollars; 10% of $500 = $50 — must remain ACTIVE
      expect(trader.getStatus()).toBe('ACTIVE');
      expect(trader.toSummary().grid!.traderTpReached).toBe(false);
      expect(parseFloat(trader.toSummary().grid!.traderTpCurrentPnl!)).toBeLessThan(50);
      trader.destroy();
    });

    it('only one exit workflow when TRADER_TP and GRID_EXHAUSTED race', async () => {
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '999' });
      await tick('105', trader, 500);
      let completed = 0;
      trader.on('traderEvent', (e: any) => {
        if (e?.type === 'COMPLETED') completed += 1;
      });
      const p1 = (trader as any).beginExit('TRADER_TP');
      const p2 = (trader as any).beginExit('GRID_EXHAUSTED');
      const p3 = (trader as any).beginExit('MAX_LIFETIME');
      await Promise.all([p1, p2, p3]);
      expect(trader.toSummary().grid!.exitReason).toBe('TRADER_TP');
      expect(completed).toBe(1);
      expect(trader.getStatus()).toBe('COMPLETED');
    });

    it('resume during EXITING does not duplicate COMPLETED', async () => {
      const trader = await boot({ ...baseConfig, traderTakeProfitPercent: '1' });
      let completed = 0;
      trader.on('traderEvent', (e: any) => {
        if (e?.type === 'COMPLETED') completed += 1;
      });
      await tick('105', trader, 700);
      await tickThroughTp(trader);
      await wait(200);
      await trader.resumeCompleting();
      await wait(1000);
      expect(completed).toBe(1);
      expect(trader.toSummary().grid!.exitReason).toBe('TRADER_TP');
    });
  });
});
