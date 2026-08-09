/**
 * Strategy V2 lifecycle: open → TP (same side) / SL (reverse) → lifetime expiry.
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
  traderLifetimeHours: 24,
  takeProfitPercent: '0.10',
  stopLossPercent: '0.10',
  startingSide: 'SHORT',
  capitalSteps: 5,
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
      positionAllocation: new Decimal(200),
      positionNotional: new Decimal(2000),
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

async function bootTrader(
  id: string,
  provider: SimulationExecutionProvider,
  db: ReturnType<typeof createMockDb>,
  ledger: ReturnType<typeof createMockLedger>,
  cfg: TraderConfig = traderConfig,
): Promise<Trader> {
  provider.onPriceUpdate('BTCUSDT', '100');
  const trader = new Trader(id, 'BTCUSDT', 'SIMULATION', provider, cfg, db as never, ledger as never);
  provider.on('orderUpdate', (u) => {
    void trader.onOrderUpdate(u);
  });
  await trader.initialize();
  await wait(250);
  return trader;
}

describe('Trader V2 reversal lifecycle', () => {
  let provider: SimulationExecutionProvider;
  let db: ReturnType<typeof createMockDb>;
  let ledger: ReturnType<typeof createMockLedger>;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    provider.enablePartialFills = false;
    db = createMockDb();
    ledger = createMockLedger();
  });

  it('opens a single SHORT with TP 10% below and SL 10% above', async () => {
    const trader = await bootTrader('t-open', provider, db, ledger);
    const s = trader.toSummary();

    expect(trader.getStatus()).toBe('ACTIVE');
    expect(s.currentPosition).not.toBeNull();
    expect(s.currentPosition!.side).toBe('SHORT');
    expect(s.currentPosition!.number).toBe(1);
    expect(parseFloat(s.currentPosition!.entryPrice)).toBeCloseTo(100, 0);
    expect(parseFloat(s.currentPosition!.tpPrice)).toBeCloseTo(90, 0);
    expect(parseFloat(s.currentPosition!.slPrice)).toBeCloseTo(110, 0);
    expect(s.stats.positionsOpened).toBe(1);
    expect(s.stats.shortPositions).toBe(1);
    expect(trader.hasOpenPosition()).toBe(true);

    // Capital steps: start at Step 1 = allocation / 5
    expect(s.capital.currentStep).toBe(1);
    expect(s.capital.capitalSteps).toBe(5);
    expect(parseFloat(s.capital.traderAllocatedAmount)).toBeCloseTo(200, 0);
    expect(parseFloat(s.capital.currentStepAmount)).toBeCloseTo(40, 0); // 200/5
    expect(s.currentPosition!.capitalStep).toBe(1);
    expect(s.timeline.length).toBe(1);
    expect(s.timeline[0]!.closeReason).toBeNull();
    expect(s.timeline[0]!.capitalStep).toBe(1);

    trader.destroy();
  });

  it('TP opens another position in the SAME direction and steps up', async () => {
    const trader = await bootTrader('t-tp', provider, db, ledger);
    const tp = trader.toSummary().currentPosition!.tpPrice;

    provider.onPriceUpdate('BTCUSDT', tp);
    trader.onPriceUpdate(tp);
    await wait(500);

    const s = trader.toSummary();
    expect(s.stats.takeProfits).toBe(1);
    expect(s.stats.positionsClosed).toBe(1);
    expect(s.currentPosition).not.toBeNull();
    expect(s.currentPosition!.side).toBe('SHORT');
    expect(s.currentPosition!.number).toBe(2);
    expect(s.stats.shortPositions).toBe(2);
    expect(s.timeline[0]!.closeReason).toBe('TP');
    expect(s.capital.currentStep).toBe(2);
    expect(parseFloat(s.capital.currentStepAmount)).toBeCloseTo(80, 0); // 200 * 2/5
    expect(s.stats.stepIncreases).toBe(1);

    trader.destroy();
  });

  it('SL opens OPPOSITE direction and steps down (floor at 1)', async () => {
    const trader = await bootTrader('t-sl', provider, db, ledger);
    const sl = trader.toSummary().currentPosition!.slPrice;

    provider.onPriceUpdate('BTCUSDT', sl);
    trader.onPriceUpdate(sl);
    await wait(500);

    const s = trader.toSummary();
    expect(s.stats.stopLosses).toBe(1);
    expect(s.stats.positionsClosed).toBe(1);
    expect(s.currentPosition).not.toBeNull();
    expect(s.currentPosition!.side).toBe('LONG');
    expect(s.currentPosition!.number).toBe(2);
    expect(s.stats.longPositions).toBe(1);
    expect(s.timeline[0]!.closeReason).toBe('SL');
    // Was step 1, SL keeps step 1
    expect(s.capital.currentStep).toBe(1);
    expect(s.stats.stepDecreases).toBe(0);

    trader.destroy();
  });

  it('never holds two simultaneous open positions', async () => {
    const trader = await bootTrader('t-one', provider, db, ledger);
    expect(trader.hasOpenPosition()).toBe(true);

    const positions = await provider.getPositions('BTCUSDT');
    const openSides = positions.filter((p) => new Decimal(p.quantity).abs().gt(0));
    expect(openSides.length).toBe(1);
    expect(openSides[0]!.side).toBe('SHORT');

    trader.destroy();
  });

  it('completes after lifetime elapses', async () => {
    const shortLife: TraderConfig = { ...traderConfig, traderLifetimeHours: 0.001 };
    const trader = await bootTrader('t-life', provider, db, ledger, shortLife);

    let completed = false;
    trader.on('traderEvent', (e: { type: string }) => {
      if (e.type === 'COMPLETED') completed = true;
    });

    await wait(4200);
    expect(completed).toBe(true);
    expect(trader.getStatus()).toBe('COMPLETED');
    expect(trader.hasOpenPosition()).toBe(false);
  }, 10000);

  it('persists timeline of TP then SL progression with steps', async () => {
    const trader = await bootTrader('t-timeline', provider, db, ledger);

    // Hit TP → SHORT #2 at step 2
    const tp = trader.toSummary().currentPosition!.tpPrice;
    provider.onPriceUpdate('BTCUSDT', tp);
    trader.onPriceUpdate(tp);
    await wait(500);

    // Hit SL on SHORT #2 → LONG #3 at step 1
    const sl = trader.toSummary().currentPosition!.slPrice;
    provider.onPriceUpdate('BTCUSDT', sl);
    trader.onPriceUpdate(sl);
    await wait(500);

    const s = trader.toSummary();
    expect(s.stats.takeProfits).toBe(1);
    expect(s.stats.stopLosses).toBe(1);
    expect(s.currentPosition!.side).toBe('LONG');
    expect(s.currentPosition!.number).toBe(3);
    expect(s.capital.currentStep).toBe(1);
    expect(s.timeline[0]!.capitalStep).toBe(1);
    expect(s.timeline[1]!.capitalStep).toBe(2);
    expect(s.timeline[2]!.capitalStep).toBe(1);
    expect(s.timeline.filter((t) => t.closeReason === 'TP').length).toBe(1);
    expect(s.timeline.filter((t) => t.closeReason === 'SL').length).toBe(1);

    trader.destroy();
  });

  it('restores capital step from persisted state (no reset to 1)', async () => {
    const trader = await bootTrader('t-restore-step', provider, db, ledger);
    const tp = trader.toSummary().currentPosition!.tpPrice;
    provider.onPriceUpdate('BTCUSDT', tp);
    trader.onPriceUpdate(tp);
    await wait(500);
    expect(trader.toSummary().capital.currentStep).toBe(2);

    const snap = trader.toSummary();
    trader.destroy();

    const trader2 = new Trader(
      't-restore-step-2',
      'BTCUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );
    await trader2.restore({
      status: 'ACTIVE',
      realizedPnl: snap.realizedPnl,
      unrealizedPnl: '0',
      startedAt: new Date(snap.stats.startedAt!),
      endsAt: new Date(snap.stats.endsAt!),
      currentSide: snap.currentPosition!.side,
      currentPositionNumber: snap.currentPosition!.number,
      entryPrice: snap.currentPosition!.entryPrice,
      tpPrice: snap.currentPosition!.tpPrice,
      slPrice: snap.currentPosition!.slPrice,
      quantity: snap.currentPosition!.quantity,
      traderAllocatedAmount: snap.capital.traderAllocatedAmount,
      capitalSteps: snap.capital.capitalSteps,
      currentStep: snap.capital.currentStep,
      currentStepAmount: snap.capital.currentStepAmount,
      highestStepReached: snap.capital.highestStepReached,
      lowestStepReached: snap.capital.lowestStepReached,
      stepIncreases: snap.capital.stepIncreases,
      stepDecreases: snap.capital.stepDecreases,
      step1Trades: snap.capital.step1Trades,
      maxStepTrades: snap.capital.maxStepTrades,
      positionsOpened: snap.stats.positionsOpened,
      positionsClosed: snap.stats.positionsClosed,
      winningPositions: snap.stats.winningPositions,
      losingPositions: snap.stats.losingPositions,
      takeProfits: snap.stats.takeProfits,
      stopLosses: snap.stats.stopLosses,
      longPositions: snap.stats.longPositions,
      shortPositions: snap.stats.shortPositions,
      totalFees: snap.stats.totalFees,
      timelineJson: JSON.stringify(snap.timeline),
      pendingClientOrderIds: [],
      entryClientOrderId: null,
      tpClientOrderId: null,
      slClientOrderId: null,
      positionOpen: true,
    });

    expect(trader2.toSummary().capital.currentStep).toBe(2);
    expect(parseFloat(trader2.toSummary().capital.currentStepAmount)).toBeCloseTo(80, 0);
    trader2.destroy();
  });
});
