/**
 * NearPriceDirectionalTrader lifecycle.
 *
 * Focus: the grid invariant + TP behaviour that produced the reported bug where
 * LONG positions stayed ACTIVE far above the current mark after price moved up
 * through their levels (and their TP) and then back down.
 *
 * Invariant under test:
 *  - 2 nearest levels strictly ABOVE mark → LONG
 *  - 2 nearest levels strictly BELOW mark → SHORT
 *  - Any LONG whose TP (entry × (1+spacing)) was reached MUST close and free the
 *    level — it must never linger ACTIVE below its own TP.
 */
import { NearPriceDirectionalTrader } from '../../src/modules/trader/near-price/NearPriceDirectionalTrader';
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
  traderBehavior: 'near_price_directional',
  gridLevelsPerSide: 10,
  gridDistancePercent: '5',
  gridSpacingPercent: '5',
  gridBoundaryPercent: '60',
  gridActivationMultiplier: '2',
  gridCapitalScalingEnabled: false,
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
      findFirst: jest.fn(async ({ where }: any) =>
        [...levels.values()].find(
          (r) => r.traderId === where.traderId && r.level === where.level,
        ) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const id = `gl-${data.level}`;
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
    _positions: positions,
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

describe('NearPriceDirectionalTrader lifecycle', () => {
  let provider: SimulationExecutionProvider;
  let db: ReturnType<typeof mockDb>;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [symbolInfo]);
    provider.enablePartialFills = false;
    provider.onPriceUpdate('BTCUSDT', '100');
    db = mockDb();
  });

  async function boot(cfg: TraderConfig = baseConfig): Promise<NearPriceDirectionalTrader> {
    const trader = new NearPriceDirectionalTrader(
      't-np',
      'BTCUSDT',
      'SIMULATION',
      provider,
      cfg,
      db as any,
      mockLedger(),
    );
    provider.on('orderUpdate', (u) => { void trader.onOrderUpdate(u); });
    provider.onPriceUpdate('BTCUSDT', '100');
    await trader.initialize();
    return trader;
  }

  async function tick(price: string, trader: NearPriceDirectionalTrader, ms = 600): Promise<void> {
    provider.onPriceUpdate('BTCUSDT', price);
    trader.onPriceUpdate(price);
    await wait(ms);
  }

  function levelsOf(trader: NearPriceDirectionalTrader) {
    return trader.toSummary().grid!.levels;
  }

  it('boot establishes the 2↑ LONG / 2↓ SHORT window around start', async () => {
    const trader = await boot();
    const levels = levelsOf(trader);
    const pending = levels.filter((l) => l.status === 'PENDING');
    const longs = pending.filter((l) => l.direction === 'LONG');
    const shorts = pending.filter((l) => l.direction === 'SHORT');
    expect(longs.length).toBe(2);
    expect(shorts.length).toBe(2);
    for (const l of longs) expect(parseFloat(l.triggerPrice)).toBeGreaterThan(100);
    for (const l of shorts) expect(parseFloat(l.triggerPrice)).toBeLessThan(100);
    trader.destroy();
  });

  it('LONG that has price move up one spacing hits TP and frees the level', async () => {
    const trader = await boot();
    // Rise to first LONG level (~105) → fills LONG, TP ≈ 110.25
    await tick('105', trader, 900);
    const filled = levelsOf(trader).find((l) => l.status === 'ACTIVE' && l.direction === 'LONG');
    expect(filled).toBeTruthy();
    const tp = parseFloat(filled!.tpPrice!);
    expect(tp).toBeGreaterThan(105);
    // Move up through that TP
    await tick(String(tp + 0.5), trader, 1000);
    await wait(400);
    // That level must no longer hold an ACTIVE LONG below its TP
    const same = levelsOf(trader).find((l) => l.level === filled!.level)!;
    expect(same.status).not.toBe('ACTIVE');
    expect((same as any).positionsCompleted).toBeGreaterThanOrEqual(1);
    expect(parseFloat(trader.getRealizedPnl())).toBeGreaterThan(0);
    trader.destroy();
  });

  it('SCREENSHOT REPRO: after up-through-LONGs then back down, no LONG lingers ACTIVE below its TP', async () => {
    const trader = await boot();

    // Walk the price UP through several LONG levels, capturing the peak.
    let peak = 100;
    for (const p of ['105', '110.5', '116', '122']) {
      await tick(p, trader, 700);
      peak = Math.max(peak, parseFloat(p));
    }
    // Now the price collapses back down well below all those LONG entries.
    for (const p of ['110', '100', '92']) {
      await tick(p, trader, 700);
    }
    await wait(500);

    const levels = levelsOf(trader);
    const mark = parseFloat(trader.toSummary().markPrice);

    // CORE INVARIANT: no ACTIVE LONG may remain whose TP was already reached by the peak.
    const stale = levels.filter(
      (l) => l.status === 'ACTIVE'
        && l.direction === 'LONG'
        && l.tpPrice != null
        && parseFloat(l.tpPrice) <= peak,
    );
    expect(stale).toHaveLength(0);

    // Any position still ACTIVE must genuinely straddle a live TP (never crossed).
    for (const l of levels) {
      if (l.status !== 'ACTIVE') continue;
      if (l.direction === 'LONG') {
        expect(parseFloat(l.tpPrice!)).toBeGreaterThan(peak);
      }
    }

    // Trader keeps running; TP closes should have booked realized PnL.
    expect(trader.getStatus()).toBe('ACTIVE');
    expect(trader.toSummary().stats.takeProfits).toBeGreaterThanOrEqual(1);
    void mark;
    trader.destroy();
  });

  it('LONG TP = adjacent grid level (N+1) and the sim/Binance TP order uses the exact same price', async () => {
    const trader = await boot();
    await tick('105', trader, 900); // fills LONG @105 (grid level up = 110)
    const active = levelsOf(trader).find((l) => l.status === 'ACTIVE' && l.direction === 'LONG')!;
    // TP must equal the adjacent level price (110), not 105 × 1.05.
    expect(active.tpPrice).toBe('110.00');
    // The exchange/sim TP order must carry the identical price — one source of truth.
    const tpOrders = [...db._orders.values()].filter(
      (o: any) => o.type === 'TAKE_PROFIT_MARKET' && o.hedgeLevel === active.level,
    );
    expect(tpOrders.length).toBeGreaterThanOrEqual(1);
    for (const o of tpOrders) expect(String(o.stopPrice)).toBe('110.00');
    trader.destroy();
  });

  it('after LONG TP the freed level is reused as SHORT once price is above it', async () => {
    const trader = await boot();
    await tick('105', trader, 900); // LONG @105, TP = 110
    const lvl = levelsOf(trader).find((l) => l.status === 'ACTIVE' && l.direction === 'LONG')!;
    const idx = lvl.level;
    await tick('110.5', trader, 1100); // crosses TP 110 → LONG closes; 105 now below mark
    await wait(500);
    const reused = levelsOf(trader).find((l) => l.level === idx)!;
    // The old LONG must be gone and booked.
    expect((reused as any).positionsCompleted).toBeGreaterThanOrEqual(1);
    expect(!(reused.status === 'ACTIVE' && reused.direction === 'LONG')).toBe(true);
    // Since the level is now below the mark, any live order on it must be SHORT.
    if (reused.status === 'PENDING' || reused.status === 'ACTIVE') {
      expect(reused.direction).toBe('SHORT');
    }
    trader.destroy();
  });

  it('restored open position receives the adjacent-grid TP (re-derived from the grid)', async () => {
    const trader = await boot();
    await tick('105', trader, 900); // LONG @105, TP = 110
    const before = levelsOf(trader).find((l) => l.status === 'ACTIVE' && l.direction === 'LONG')!;
    expect(before.tpPrice).toBe('110.00');

    const rows = [...db._levels.values()].map((r: any) => ({ ...r }));
    const openPositions = db._positions
      .filter((p: any) => p.isOpen)
      .map((p: any) => ({
        hedgeLevel: p.hedgeLevel,
        side: p.side,
        entryPrice: p.entryPrice,
        quantity: p.quantity,
        clientOrderId: p.clientOrderId,
      }));
    // Simulate a DB row that lost its TP so restore must re-derive it from the grid.
    for (const r of rows) if (r.status === 'ACTIVE') r.tpPrice = null;

    trader.destroy();
    provider.onPriceUpdate('BTCUSDT', '101'); // mark below 105 → LONG still held
    const t2 = new NearPriceDirectionalTrader(
      't-np', 'BTCUSDT', 'SIMULATION', provider, baseConfig, db as any, mockLedger(),
    );
    provider.on('orderUpdate', (u) => { void t2.onOrderUpdate(u); });
    await t2.restore({
      status: 'ACTIVE',
      realizedPnl: '0',
      unrealizedPnl: '0',
      totalFees: '0',
      traderAllocatedAmount: '1000',
      currentCapital: '1000',
      startPrice: '100',
      gridLevelsPerSide: baseConfig.gridLevelsPerSide,
      gridDistancePercent: '5',
      gridSpacingPercent: '5',
      gridLevels: rows,
      openPositions,
      endsAt: new Date(Date.now() + 3600_000),
    });
    const restored = t2.toSummary().grid!.levels.find(
      (l) => l.status === 'ACTIVE' && l.direction === 'LONG',
    );
    expect(restored).toBeTruthy();
    expect(restored!.tpPrice).toBe('110.00');
    t2.destroy();
  });

  it('LONG TP latch: a TP touched during a spike is booked, not lost after retrace', async () => {
    const trader = await boot();
    // Fill a LONG near 105 and let its resting TP (~110.25) establish.
    await tick('105', trader, 900);
    const active = levelsOf(trader).find((l) => l.status === 'ACTIVE' && l.direction === 'LONG')!;
    const tp = parseFloat(active.tpPrice!);
    const tpCountBefore = trader.toSummary().stats.takeProfits;

    // Spike just past TP then retrace well below it.
    const peak = tp + 0.3;
    await tick(String(peak), trader, 800);
    await tick('101', trader, 900);
    await wait(400);

    // The TP that the peak crossed MUST have been booked (latch), and no LONG may
    // remain ACTIVE below a TP the peak already reached.
    expect(trader.toSummary().stats.takeProfits).toBeGreaterThan(tpCountBefore);
    const stale = levelsOf(trader).filter(
      (l) => l.status === 'ACTIVE'
        && l.direction === 'LONG'
        && l.tpPrice != null
        && parseFloat(l.tpPrice) <= peak,
    );
    expect(stale).toHaveLength(0);
    expect(parseFloat(trader.getRealizedPnl())).toBeGreaterThan(0);
    trader.destroy();
  });

  // ---------------------------------------------------------------------------
  // CORE INVARIANT SCENARIO MATRIX (uses the canonical trader.auditInvariant())
  // requireCovered=false so capital limits don't create false negatives; we only
  // assert the *correctness* invariant: no stale pendings, no wrong-side pendings
  // on required slots, and every active TP aligned to the adjacent grid level.
  // ---------------------------------------------------------------------------

  function expectInvariant(trader: NearPriceDirectionalTrader): void {
    const audit = trader.auditInvariant(false);
    if (!audit.ok) {
      // Surface a readable failure with the offending levels.
      throw new Error(
        `invariant violated @${audit.markPrice}: ` + JSON.stringify(audit.violations),
      );
    }
    expect(audit.ok).toBe(true);
  }

  it('boot state satisfies the canonical invariant validator', async () => {
    const trader = await boot();
    expectInvariant(trader);
    const a = trader.auditInvariant(true); // fully covered at boot (enough capital)
    expect(a.expectedLong.length).toBe(2);
    expect(a.expectedShort.length).toBe(2);
    trader.destroy();
  });

  it('Scenario A — upward one level at a time keeps the invariant', async () => {
    const trader = await boot();
    for (const p of ['104', '105', '109', '110', '114']) {
      await tick(p, trader, 700);
      await wait(200);
      expectInvariant(trader);
    }
    // At least one LONG should have activated and its TP aligns to the next level.
    for (const l of levelsOf(trader)) {
      if (l.status === 'ACTIVE' && l.direction === 'LONG' && l.tpPrice) {
        expect(parseFloat(l.tpPrice)).toBeGreaterThan(parseFloat(l.triggerPrice));
      }
    }
    trader.destroy();
  });

  it('Scenario B — downward one level at a time keeps the invariant', async () => {
    const trader = await boot();
    for (const p of ['96', '95', '91', '90', '86']) {
      await tick(p, trader, 700);
      await wait(200);
      expectInvariant(trader);
    }
    trader.destroy();
  });

  it('Scenario — large upward jump across multiple levels reconciles cleanly', async () => {
    const trader = await boot();
    await tick('100', trader, 400);
    // Jump straight from 100 to 124 (across ~5 levels) in one observation.
    await tick('124', trader, 1200);
    await wait(600);
    expectInvariant(trader);
    // Desired window must have moved up with the price.
    const a = trader.auditInvariant(false);
    for (const idx of a.expectedLong) {
      const lvl = levelsOf(trader).find((l) => l.level === idx)!;
      expect(parseFloat(lvl.triggerPrice)).toBeGreaterThan(124);
    }
    trader.destroy();
  });

  it('Scenario — large downward jump across multiple levels reconciles cleanly', async () => {
    const trader = await boot();
    await tick('100', trader, 400);
    await tick('76', trader, 1200);
    await wait(600);
    expectInvariant(trader);
    trader.destroy();
  });

  it('Scenario C — reversal after LONG TP: freed level flips to SHORT, invariant holds', async () => {
    const trader = await boot();
    await tick('105', trader, 900);   // LONG @105, TP=110
    await tick('110.5', trader, 1100); // TP hit; 105 now below mark
    await wait(400);
    expectInvariant(trader);
    // Reverse down toward 105 — it should now be (or become) SHORT, never a stale LONG.
    await tick('106', trader, 800);
    await wait(300);
    expectInvariant(trader);
    const l105 = levelsOf(trader).find((l) => parseFloat(l.triggerPrice) === 105);
    if (l105 && (l105.status === 'PENDING' || l105.status === 'ACTIVE')) {
      expect(l105.direction).toBe('SHORT');
    }
    trader.destroy();
  });

  it('Edge — price landing exactly on a grid level keeps the invariant', async () => {
    const trader = await boot();
    for (const p of ['105', '110', '95', '100']) {
      await tick(p, trader, 800);
      await wait(200);
      expectInvariant(trader);
    }
    trader.destroy();
  });

  // ---------------------------------------------------------------------------
  // STARTUP / RESTART RECOVERY (#12)
  // ---------------------------------------------------------------------------

  async function restoreTrader(
    rows: any[],
    openPositions: any[],
    mark: string,
  ): Promise<NearPriceDirectionalTrader> {
    provider.onPriceUpdate('BTCUSDT', mark);
    const t = new NearPriceDirectionalTrader(
      't-np', 'BTCUSDT', 'SIMULATION', provider, baseConfig, db as any, mockLedger(),
    );
    provider.on('orderUpdate', (u) => { void t.onOrderUpdate(u); });
    await t.restore({
      status: 'ACTIVE',
      realizedPnl: '0',
      unrealizedPnl: '0',
      totalFees: '0',
      traderAllocatedAmount: '1000',
      currentCapital: '1000',
      startPrice: '100',
      gridLevelsPerSide: baseConfig.gridLevelsPerSide,
      gridDistancePercent: '5',
      gridSpacingPercent: '5',
      gridLevels: rows,
      openPositions,
      endsAt: new Date(Date.now() + 3600_000),
    });
    return t;
  }

  it('restart with only pending orders restores the correct 2↑/2↓ window', async () => {
    const t1 = await boot();
    const rows = [...db._levels.values()].map((r: any) => ({ ...r }));
    t1.destroy();

    const t2 = await restoreTrader(rows, [], '100');
    t2.onPriceUpdate('100');
    await wait(600);
    const audit = t2.auditInvariant(false);
    expect(audit.ok).toBe(true);
    expect(audit.expectedLong.length).toBe(2);
    expect(audit.expectedShort.length).toBe(2);
    t2.destroy();
  });

  it('restart with an open position whose TP was crossed while offline closes it (latch)', async () => {
    const t1 = await boot();
    await tick('105', t1, 900); // LONG @105, TP = 110
    const rows = [...db._levels.values()].map((r: any) => ({ ...r }));
    const openPositions = db._positions
      .filter((p: any) => p.isOpen)
      .map((p: any) => ({
        hedgeLevel: p.hedgeLevel,
        side: p.side,
        entryPrice: p.entryPrice,
        quantity: p.quantity,
        clientOrderId: p.clientOrderId,
      }));
    expect(openPositions.length).toBeGreaterThanOrEqual(1);
    t1.destroy();

    // Price ran to 113 (past TP 110) while the app was down.
    const t2 = await restoreTrader(rows, openPositions, '113');
    t2.onPriceUpdate('113');
    await wait(900);
    // The stale-open LONG must not linger ACTIVE below its already-crossed TP.
    const stale = t2.toSummary().grid!.levels.filter(
      (l) => l.status === 'ACTIVE'
        && l.direction === 'LONG'
        && l.tpPrice != null
        && parseFloat(l.tpPrice) <= 113,
    );
    expect(stale).toHaveLength(0);
    // And the recovered grid must still be self-consistent.
    expect(t2.auditInvariant(false).ok).toBe(true);
    t2.destroy();
  });

  it('restart re-derives the adjacent-grid TP even if the DB row lost its tpPrice', async () => {
    const t1 = await boot();
    await tick('105', t1, 900);
    const rows = [...db._levels.values()].map((r: any) => ({ ...r }));
    for (const r of rows) if (r.status === 'ACTIVE') r.tpPrice = null; // stale DB
    const openPositions = db._positions
      .filter((p: any) => p.isOpen)
      .map((p: any) => ({
        hedgeLevel: p.hedgeLevel, side: p.side, entryPrice: p.entryPrice,
        quantity: p.quantity, clientOrderId: p.clientOrderId,
      }));
    t1.destroy();

    const t2 = await restoreTrader(rows, openPositions, '101'); // still below TP → held
    const restored = t2.toSummary().grid!.levels.find(
      (l) => l.status === 'ACTIVE' && l.direction === 'LONG',
    );
    expect(restored!.tpPrice).toBe('110.00');
    expect(t2.auditInvariant(false).ok).toBe(true);
    t2.destroy();
  });
});
