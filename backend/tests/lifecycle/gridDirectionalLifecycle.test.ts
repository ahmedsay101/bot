/**
 * GridDirectionalTrader lifecycle: capital modes, per-level TP only, destroy rules.
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
  gridCapitalScalingEnabled: true,
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

describe('GridDirectionalTrader lifecycle', () => {
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

  it('after entry fill, TP order created and no protective STOP_MARKET SL', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 900);
    const types = [...db._orders.values()].map((o: any) => o.type);
    expect(types.some((t: string) => t === 'TAKE_PROFIT_MARKET')).toBe(true);
    expect(types.some((t: string) => t === 'STOP_MARKET')).toBe(false);
    const g = trader.toSummary().grid!;
    const active = g.levels.find((l) => l.status === 'ACTIVE');
    expect(active?.tpPrice).toBeTruthy();
    expect(active?.slPrice == null || active?.slPrice === '').toBe(true);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('no SL order created after entry', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    expect(trader.getOpenLegCount()).toBe(1);
    const stopMarket = [...db._orders.values()].filter((o: any) => o.type === 'STOP_MARKET');
    expect(stopMarket).toHaveLength(0);
    const active = trader.toSummary().grid!.levels.find((l) => l.status === 'ACTIVE')!;
    expect(active.slPrice == null || active.slPrice === '').toBe(true);
    trader.destroy();
  });

  it('MODE B OFF: capitalPerLevel echoes full current capital (NOT ÷ levels)', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 10,
      gridCapitalScalingEnabled: false,
    });
    const g = trader.toSummary().grid!;
    expect(g.capitalScalingEnabled).toBe(false);
    expect(parseFloat(g.capitalPerLevel!)).toBeCloseTo(1000, 4);
    expect(g.maxActivePositions).toBe(1);
    expect(g.totalLevels).toBe(20);
    trader.destroy();
  });

  it('MODE B OFF: first active position margin ≈ 100% of trader capital', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 10,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    const g = trader.toSummary().grid!;
    expect(g.activeOpenCount).toBe(1);
    expect(parseFloat(g.activePositionMargin!)).toBeGreaterThan(900);
    expect(parseFloat(g.activePositionMargin!)).toBeLessThanOrEqual(1000.01);
    // Must NOT be equal-split $50
    expect(parseFloat(g.activePositionMargin!)).toBeGreaterThan(100);
    expect(parseFloat(g.activePositionNotional!)).toBeGreaterThan(9000);
    trader.destroy();
  });

  it('MODE B OFF: max one active even when price crosses multiple levels', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 5,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 700);
    await tick('110', trader, 700);
    await tick('115', trader, 700);
    await tick('120', trader, 700);
    expect(trader.getOpenLegCount()).toBeLessThanOrEqual(1);
    expect(trader.toSummary().grid!.activeOpenCount).toBeLessThanOrEqual(1);
    // past last short @125 → may complete via GRID_BOUNDARY_PASSED
    trader.destroy();
  });

  it('MODE B OFF: after TP next position uses updated capital', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    // SHORT L1 @105; TP ≈ 105*0.95 = 99.75
    await tick('105', trader, 900);
    const before = parseFloat(trader.toSummary().grid!.currentCapital!);
    await tick('99.70', trader, 1000);
    await wait(600);
    const mid = trader.toSummary().grid!;
    expect(mid.levelsTp).toBeGreaterThanOrEqual(1);
    expect(mid.activeOpenCount ?? 0).toBeLessThanOrEqual(1);
    const afterClose = parseFloat(mid.currentCapital!);
    if ((mid.activeOpenCount ?? 0) === 1 && mid.activePositionMargin != null) {
      const margin = parseFloat(mid.activePositionMargin);
      expect(margin).toBeGreaterThan(100);
      expect(Math.abs(margin - afterClose)).toBeLessThan(before);
    }
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('MODE A ON preserves side pools', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    const g = trader.toSummary().grid!;
    expect(g.capitalScalingEnabled).toBe(true);
    expect(parseFloat(g.longSideCapital!)).toBeCloseTo(500, 4);
    expect(parseFloat(g.shortSideCapital!)).toBeCloseTo(500, 4);
    trader.destroy();
  });

  it('MODE A ON: multiple SHORTs can be active simultaneously', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    await tick('110', trader, 700);
    await tick('115', trader, 700);
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(2);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('adverse move does NOT close SHORT (no SL)', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    // SHORT L1 @105; old SL zone was ~110.25 — must stay open
    await tick('105', trader, 900);
    expect(trader.getOpenLegCount()).toBe(1);
    await tick('110.30', trader, 1000);
    await wait(500);
    const g = trader.toSummary().grid!;
    const s1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(s1.status).toBe('ACTIVE');
    expect(g.levelsSl ?? 0).toBe(0);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(g.exitReason).toBeNull();
    trader.destroy();
  });

  it('one level TP does NOT destroy trader', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 900);
    // SHORT TP ≈ 99.75
    await tick('99.70', trader, 1000);
    await wait(500);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    trader.destroy();
  });

  it('ALL_GRID_POSITIONS_TP does NOT destroy trader — stays ACTIVE', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
    });
    // SHORT L1@105 TP@99.75; LONG L1@95 TP@99.75
    await tick('105', trader, 900);
    await tick('99.70', trader, 1000); // SHORT TP
    await wait(400);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('95', trader, 900); // LONG entry
    await tick('99.80', trader, 1000); // LONG TP
    await wait(800);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    expect(trader.toSummary().grid!.levelsTp).toBe(2);
    trader.destroy();
  });

  it('multiple TPs do not destroy trader', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: true,
    });
    await tick('105', trader, 900);
    await tick('110', trader, 900);
    await tick('99.70', trader, 1200); // SHORT L1 TP (~99.75); L2 TP = 110*0.95=104.5 — may still be open
    await wait(600);
    await tick('104.40', trader, 1200); // SHORT L2 TP
    await wait(600);
    expect(trader.toSummary().grid!.levelsTp).toBeGreaterThanOrEqual(2);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    trader.destroy();
  });

  it('LONG gap TP: entry 95, jump past TP closes', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('95', trader, 900);
    const active = trader.toSummary().grid!.levels.find((l) => l.status === 'ACTIVE')!;
    expect(active.direction).toBe('LONG');
    expect(parseFloat(active.tpPrice!)).toBeCloseTo(99.75, 1);
    await tick('99', trader, 600); // below TP — still open
    expect(
      trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!.status,
    ).toBe('ACTIVE');
    await tick('100', trader, 1200); // gap past TP
    await wait(500);
    const l1 = trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(l1.status).toBe('TP_HIT');
    trader.destroy();
  });

  it('SHORT gap TP: entry 105, jump past TP closes', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    const active = trader.toSummary().grid!.levels.find((l) => l.status === 'ACTIVE')!;
    expect(active.direction).toBe('SHORT');
    expect(parseFloat(active.tpPrice!)).toBeCloseTo(99.75, 1);
    await tick('100', trader, 600); // above TP — still open
    expect(
      trader.toSummary().grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!.status,
    ).toBe('ACTIVE');
    await tick('99.70', trader, 1200);
    await wait(500);
    const s1 = trader.toSummary().grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(s1.status).toBe('TP_HIT');
    trader.destroy();
  });

  it('already past TP closes position', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('95', trader, 900);
    expect(trader.getOpenLegCount()).toBe(1);
    // Single jump well past LONG TP ~99.75
    await tick('101', trader, 1200);
    await wait(500);
    const l1 = trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(l1.status).toBe('TP_HIT');
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('price beyond final LONG destroys with GRID_BOUNDARY_PASSED', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    // last long @90; mark 89 is strictly past
    await tick('90', trader, 900);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('89', trader, 1200);
    await wait(600);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('GRID_BOUNDARY_PASSED');
  });

  it('price beyond final SHORT destroys with GRID_BOUNDARY_PASSED', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    // last short @110; mark 111 is strictly past
    await tick('110', trader, 900);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('111', trader, 1200);
    await wait(600);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('GRID_BOUNDARY_PASSED');
  });

  it('touch final LONG level does NOT destroy', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('90', trader, 1200);
    await wait(500);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    expect(trader.toSummary().grid!.destroyConditions!.pastFinalLong).toBe(false);
    trader.destroy();
  });

  it('touch final SHORT level does NOT destroy', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('110', trader, 1200);
    await wait(500);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    expect(trader.toSummary().grid!.destroyConditions!.pastFinalShort).toBe(false);
    trader.destroy();
  });

  it('MAX_LIFETIME destroys trader', async () => {
    const trader = await boot({
      ...baseConfig,
      traderMaxLifetimeHours: 0.0001,
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
      (trader as any).beginExit('FORCE'),
      (trader as any).beginExit('MAX_LIFETIME'),
    ]);
    expect(completed).toBe(1);
    expect(['FORCE', 'MAX_LIFETIME']).toContain(trader.toSummary().grid!.exitReason);
  });

  it('dashboard summary exposes destroy conditions and progress', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridCapitalScalingEnabled: false,
    });
    const g = trader.toSummary().grid!;
    expect(g.destroyConditions).toBeDefined();
    expect(g.destroyConditions!.pastFinalLong).toBe(false);
    expect(g.destroyConditions!.pastFinalShort).toBe(false);
    expect(g.levelsPending).toBe(4);
    expect(g.capitalScalingEnabled).toBe(false);
    expect(g.totalLevels).toBe(4);
    expect(g.levels.length).toBe(4);
    // Orientation: SHORT above start, LONG below
    const s1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    const l1 = g.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(parseFloat(s1.triggerPrice)).toBeGreaterThan(100);
    expect(parseFloat(l1.triggerPrice)).toBeLessThan(100);
    trader.destroy();
  });

  it('after TP: level stays visible as TP_HIT, position gone, never reactivates', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    expect(trader.toSummary().grid!.levels.some((l) => l.status === 'ACTIVE')).toBe(true);
    await tick('99.70', trader, 1000);
    await wait(500);
    const g = trader.toSummary().grid!;
    expect(g.levels.length).toBe(4);
    const s1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(s1.status).toBe('TP_HIT');
    expect(s1.triggerPrice).toBeTruthy();
    expect(g.activeOpenCount).toBeLessThanOrEqual(1);
    expect(g.levelsTp).toBeGreaterThanOrEqual(1);
    expect(g.levelsDead).toBeGreaterThanOrEqual(1);
    await tick('100', trader, 600);
    await tick('105', trader, 900);
    await tick('106', trader, 600);
    const again = trader.toSummary().grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(again.status).toBe('TP_HIT');
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('adverse move toward old SL zone does NOT close SHORT without TP', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    // Last short @115; 110.30 is adverse but still inside grid (old SL ~110.25)
    await tick('110.30', trader, 1000);
    await wait(500);
    const g = trader.toSummary().grid!;
    const s1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(s1.status).toBe('ACTIVE');
    expect(g.levelsSl ?? 0).toBe(0);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(g.exitReason).toBeNull();
    trader.destroy();
  });

  it('restore preserves TP_HIT and does not reopen that level', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    await tick('99.70', trader, 1000);
    await wait(500);
    const snap = trader.toSummary().grid!;
    expect(snap.levelsTp).toBeGreaterThanOrEqual(1);
    const rows = [...db._levels.values()];
    expect(rows.some((r: any) => r.status === 'TP_HIT')).toBe(true);

    trader.destroy();
    const trader2 = new GridDirectionalTrader(
      't1',
      'BTCUSDT',
      'SIMULATION',
      provider,
      { ...baseConfig, gridLevelsPerSide: 2, gridDistancePercent: '5', gridCapitalScalingEnabled: false },
      db as any,
      mockLedger(),
    );
    provider.on('orderUpdate', (u) => { void trader2.onOrderUpdate(u); });
    await trader2.restore({
      status: 'ACTIVE',
      realizedPnl: '0',
      unrealizedPnl: '0',
      totalFees: '0',
      traderAllocatedAmount: '1000',
      currentCapital: '1000',
      startPrice: '100',
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridLevels: rows,
      endsAt: new Date(Date.now() + 3600_000),
    });
    const restored = trader2.toSummary().grid!;
    expect(restored.levels.length).toBe(4);
    expect(restored.levels.some((l) => l.status === 'TP_HIT')).toBe(true);
    await tick('105', trader2, 800);
    expect(
      trader2.toSummary().grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!.status,
    ).toBe('TP_HIT');
    trader2.destroy();
  });

  it('duplicate protective fill is idempotent (no double capital/PnL)', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    const beforeCap = parseFloat(trader.toSummary().grid!.currentCapital!);
    await tick('99.70', trader, 1000);
    await wait(500);
    const mid = trader.toSummary();
    const afterCap = parseFloat(mid.grid!.currentCapital!);
    const afterPnl = parseFloat(mid.realizedPnl);
    expect(mid.grid!.levelsTp).toBe(1);

    const s1 = mid.grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    await (trader as any).handleProtectiveFill(
      'SHORT:1',
      {
        clientOrderId: 'dup-tp',
        exchangeOrderId: 'x',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        filledQuantity: '1',
        avgFillPrice: '99.70',
        fee: '0',
        timestamp: Date.now(),
      },
      'TP',
    );
    const again = trader.toSummary();
    expect(parseFloat(again.grid!.currentCapital!)).toBeCloseTo(afterCap, 4);
    expect(parseFloat(again.realizedPnl)).toBeCloseTo(afterPnl, 4);
    expect(again.grid!.levelsTp).toBe(1);
    expect(afterCap).not.toBeCloseTo(beforeCap, 0);
    expect(s1.status).toBe('TP_HIT');
    trader.destroy();
  });

  it('OFF mode: after SHORT TP, gap into LONGs activates at most one; others stay PENDING', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 5,
      gridDistancePercent: '1',
      gridCapitalScalingEnabled: false,
    });
    await tick('101', trader, 900); // SHORT L1
    expect(trader.getOpenLegCount()).toBe(1);
    // SHORT L1 TP ≈ 101*0.99 = 99.99
    await tick('99.90', trader, 1200);
    await wait(400);
    await tick('96', trader, 1500); // gap into LONG side
    await wait(500);
    const g = trader.toSummary().grid!;
    const short1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(short1.status).toBe('TP_HIT');
    expect(g.activeOpenCount ?? 0).toBeLessThanOrEqual(1);
    const activeLongs = g.levels.filter((l) => l.direction === 'LONG' && l.status === 'ACTIVE');
    expect(activeLongs.length).toBeLessThanOrEqual(1);
    const pendingCrossed = g.levels.filter(
      (l) => l.direction === 'LONG' && l.status === 'PENDING' && parseFloat(l.triggerPrice) >= 96,
    );
    expect(pendingCrossed.length + activeLongs.length).toBeGreaterThanOrEqual(1);
    trader.destroy();
  });

  it('REGRESSION: after TP, closed PnL never changes when mark moves', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    await tick('99.70', trader, 1200);
    await wait(600);
    const afterClose = trader.toSummary();
    const closed = afterClose.grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(closed.status).toBe('TP_HIT');
    // Stay above LONG L1@95 so no new open; SHORT L1 is dead
    expect(afterClose.grid!.activeOpenCount ?? 0).toBe(0);
    const frozenRealized = parseFloat(afterClose.realizedPnl);
    expect(parseFloat(afterClose.unrealizedPnl)).toBe(0);
    // Stay inside final levels (LONG@95 / SHORT@105) so boundary does not fire
    for (const p of ['100', '102', '98', '104']) {
      await tick(p, trader, 400);
      const s = trader.toSummary();
      expect(s.status).toBe('ACTIVE');
      expect(parseFloat(s.realizedPnl)).toBeCloseTo(frozenRealized, 4);
      expect(s.grid!.activeOpenCount ?? 0).toBe(0);
      expect(parseFloat(s.unrealizedPnl)).toBe(0);
      const lvl = s.grid!.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
      expect(lvl.status).toBe('TP_HIT');
      expect(lvl.unrealizedPnl).toBe('0');
    }
    trader.destroy();
  });

  it('LONG dip entry then upward TP', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('95', trader, 900);
    const active = trader.toSummary().grid!.levels.find((l) => l.status === 'ACTIVE');
    expect(active?.direction).toBe('LONG');
    expect(parseFloat(active!.tpPrice!)).toBeGreaterThan(parseFloat(active!.entryPrice!));
    expect(active!.slPrice == null || active!.slPrice === '').toBe(true);
    await tick('99.80', trader, 1200);
    await wait(500);
    const l1 = trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(l1.status).toBe('TP_HIT');
    trader.destroy();
  });
});
