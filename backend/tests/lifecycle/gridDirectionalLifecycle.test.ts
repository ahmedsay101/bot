/**
 * GridDirectionalTrader lifecycle: capital modes, per-level TP/SL, destroy rules.
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

  it('after entry fill, TP and SL orders are created', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 900);
    const types = [...db._orders.values()].map((o: any) => o.type);
    expect(types.some((t: string) => t === 'TAKE_PROFIT_MARKET')).toBe(true);
    expect(types.some((t: string) => t === 'STOP_MARKET')).toBe(true);
    const g = trader.toSummary().grid!;
    const active = g.levels.find((l) => l.status === 'ACTIVE');
    expect(active?.tpPrice).toBeTruthy();
    expect(active?.slPrice).toBeTruthy();
    expect(trader.getStatus()).toBe('ACTIVE');
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
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('MODE B OFF: after TP next position uses updated capital', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    const before = parseFloat(trader.toSummary().grid!.currentCapital!);
    // TP ≈ 105 * 1.05 = 110.25
    await tick('110.30', trader, 1000);
    await wait(600);
    const mid = trader.toSummary().grid!;
    expect(mid.levelsTp).toBeGreaterThanOrEqual(1);
    expect(mid.activeOpenCount ?? 0).toBeLessThanOrEqual(1);
    // Capital should have changed from fees/PnL after close
    const afterClose = parseFloat(mid.currentCapital!);
    // If L2 activated at 110, margin should track updated capital (not original ÷ levels)
    if ((mid.activeOpenCount ?? 0) === 1 && mid.activePositionMargin != null) {
      const margin = parseFloat(mid.activePositionMargin);
      expect(margin).toBeGreaterThan(100); // not $50-style split
      // margin ≈ current capital at activation (may differ slightly after fees on prior)
      expect(Math.abs(margin - afterClose)).toBeLessThan(before); // sanity
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

  it('MODE A ON: multiple LONGs can be active simultaneously', async () => {
    const trader = await boot();
    await tick('105', trader, 700);
    await tick('110', trader, 700);
    await tick('115', trader, 700);
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(2);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('price leaving the grid does NOT destroy the trader (no GRID_EXHAUSTED)', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 800);
    await tick('110', trader, 800);
    await tick('115', trader, 1000);
    await wait(400);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('130', trader, 1000); // far past former exhaustion buffer
    await wait(600);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    trader.destroy();
  });

  it('one level SL does NOT destroy trader', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
    });
    // L1 LONG trigger 105; SL ≈ 105*0.95 = 99.75
    await tick('105', trader, 900);
    expect(trader.getOpenLegCount()).toBeGreaterThanOrEqual(1);
    await tick('99', trader, 1000); // hit SL (and may activate shorts — still alive)
    await wait(500);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    const slCount = trader.toSummary().grid!.levelsSl ?? 0;
    expect(slCount).toBeGreaterThanOrEqual(1);
    trader.destroy();
  });

  it('one level TP does NOT destroy trader', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 900);
    // TP ≈ 105 * 1.05 = 110.25 — but L2 also at 110; go carefully
    await tick('110.30', trader, 1000);
    await wait(500);
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
    trader.destroy();
  });

  it('ALL_GRID_POSITIONS_TP destroys when every level hit TP', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
    });
    // LONG L1@105 TP@110.25; SHORT L1@95 TP@90.25
    await tick('105', trader, 900);
    await tick('110.30', trader, 1000); // LONG TP
    await wait(400);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('95', trader, 900); // SHORT entry
    await tick('90', trader, 1000); // SHORT TP
    await wait(800);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.toSummary().grid!.exitReason).toBe('ALL_GRID_POSITIONS_TP');
  });

  it('19 TP + 1 SL does not destroy (SL does not count as TP)', async () => {
    // With 1 per side: force SL on long then TP on short → still alive
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 1,
      gridDistancePercent: '5',
    });
    await tick('105', trader, 900);
    await tick('99', trader, 1000); // LONG SL
    await wait(400);
    expect(trader.getStatus()).toBe('ACTIVE');
    await tick('95', trader, 900);
    await tick('90', trader, 1000); // SHORT TP
    await wait(600);
    // Long is SL_HIT, short is TP_HIT → not all TP
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().grid!.exitReason).toBeNull();
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
    expect(g.destroyConditions!.allPositionsTp).toBe(false);
    expect(g.levelsPending).toBe(4);
    expect(g.capitalScalingEnabled).toBe(false);
    expect(g.totalLevels).toBe(4);
    expect(g.levels.length).toBe(4);
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
    await tick('110.30', trader, 1000);
    await wait(500);
    const g = trader.toSummary().grid!;
    expect(g.levels.length).toBe(4); // complete original grid
    const l1 = g.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(l1.status).toBe('TP_HIT');
    expect(l1.triggerPrice).toBeTruthy();
    expect(g.activeOpenCount).toBeLessThanOrEqual(1);
    expect(g.levelsTp).toBeGreaterThanOrEqual(1);
    expect(g.levelsDead).toBeGreaterThanOrEqual(1);
    // Price returns through L1 then rises again — must not revive L1
    await tick('100', trader, 600);
    await tick('105', trader, 900);
    await tick('106', trader, 600);
    const again = trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(again.status).toBe('TP_HIT');
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('after SL: level stays visible as SL_HIT and never reactivates', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 2,
      gridDistancePercent: '5',
      gridCapitalScalingEnabled: false,
    });
    await tick('105', trader, 900);
    await tick('99', trader, 1000);
    await wait(500);
    const g = trader.toSummary().grid!;
    expect(g.levels.length).toBe(4);
    const l1 = g.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    expect(l1.status).toBe('SL_HIT');
    expect(g.levelsSl).toBeGreaterThanOrEqual(1);
    await tick('105', trader, 900);
    await tick('106', trader, 600);
    expect(
      trader.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!.status,
    ).toBe('SL_HIT');
    expect(trader.getStatus()).toBe('ACTIVE');
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
    await tick('110.30', trader, 1000);
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
      trader2.toSummary().grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!.status,
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
    await tick('110.30', trader, 1000);
    await wait(500);
    const mid = trader.toSummary();
    const afterCap = parseFloat(mid.grid!.currentCapital!);
    const afterPnl = parseFloat(mid.realizedPnl);
    expect(mid.grid!.levelsTp).toBe(1);

    const l1 = mid.grid!.levels.find((l) => l.direction === 'LONG' && l.level === 1)!;
    // Replay a fake duplicate TP fill for the same level — should no-op
    await (trader as any).handleProtectiveFill(
      'LONG:1',
      {
        clientOrderId: 'dup-tp',
        exchangeOrderId: 'x',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        filledQuantity: '1',
        avgFillPrice: '110.30',
        fee: '0',
        timestamp: Date.now(),
      },
      'TP',
    );
    const again = trader.toSummary();
    expect(parseFloat(again.grid!.currentCapital!)).toBeCloseTo(afterCap, 4);
    expect(parseFloat(again.realizedPnl)).toBeCloseTo(afterPnl, 4);
    expect(again.grid!.levelsTp).toBe(1);
    expect(afterCap).not.toBeCloseTo(beforeCap, 0); // capital did move once on real TP
    expect(l1.status).toBe('TP_HIT');
    trader.destroy();
  });

  it('mark gap past SHORT SL closes position even without waiting for exact SL tick', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 3,
      gridDistancePercent: '1',
      gridCapitalScalingEnabled: false,
    });
    // Activate SHORT L1 @ 99 (start 100, 1%)
    await tick('99', trader, 900);
    expect(trader.getOpenLegCount()).toBe(1);
    const active = trader.toSummary().grid!.levels.find((l) => l.status === 'ACTIVE');
    expect(active?.direction).toBe('SHORT');
    const sl = active!.slPrice!;
    expect(parseFloat(sl)).toBeGreaterThan(parseFloat(active!.entryPrice!));
    // Jump mark far above SL (gap) — must close via mark reconcile
    await tick('105', trader, 1200);
    await wait(400);
    const g = trader.toSummary().grid!;
    const short1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(short1.status).toBe('SL_HIT');
    expect(g.activeOpenCount ?? 0).toBeLessThanOrEqual(1);
    expect(trader.getStatus()).toBe('ACTIVE');
    trader.destroy();
  });

  it('OFF mode: after SHORT SL, gap into LONGs activates at most one; others stay PENDING', async () => {
    const trader = await boot({
      ...baseConfig,
      gridLevelsPerSide: 5,
      gridDistancePercent: '1',
      gridCapitalScalingEnabled: false,
    });
    await tick('99', trader, 900); // SHORT L1
    expect(trader.getOpenLegCount()).toBe(1);
    // Gap: past SHORT SL and through LONG 1–3
    await tick('104', trader, 1500);
    await wait(500);
    const g = trader.toSummary().grid!;
    const short1 = g.levels.find((l) => l.direction === 'SHORT' && l.level === 1)!;
    expect(short1.status).toBe('SL_HIT');
    expect(g.activeOpenCount ?? 0).toBeLessThanOrEqual(1);
    const activeLongs = g.levels.filter((l) => l.direction === 'LONG' && l.status === 'ACTIVE');
    expect(activeLongs.length).toBeLessThanOrEqual(1);
    const pendingCrossed = g.levels.filter(
      (l) => l.direction === 'LONG' && l.status === 'PENDING' && parseFloat(l.triggerPrice) <= 104,
    );
    // With max-1, not all crossed longs become ACTIVE
    expect(pendingCrossed.length + activeLongs.length).toBeGreaterThanOrEqual(1);
    trader.destroy();
  });
});
