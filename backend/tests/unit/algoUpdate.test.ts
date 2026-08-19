/**
 * ALGO_UPDATE / null avgFillPrice enrichment — live completion path.
 */
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import { Trader } from '../../src/modules/trader/Trader';
import Decimal from 'decimal.js';
import type { SymbolInfo, TraderConfig } from '../../src/types';

const mockSymbolInfo: SymbolInfo = {
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  pricePrecision: 2,
  quantityPrecision: 3,
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
  maxLeverage: 75,
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
  switchPositionOnTakeProfit: false,
  traderBehavior: 'grid_directional',
  gridLevelsPerSide: 10,
  gridDistancePercent: '5',
  traderTakeProfitPercent: '10',
  traderMaxLifetimeHours: 12,
  refreshInterval: 60000,
  retryLimit: 2,
  feeRate: '0.0005',
  makerFeeRate: '0.0002',
  takerFeeRate: '0.0005',
  slippage: '0.0001',
  mode: 'SIMULATION',
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ALGO-style fill with null avgFillPrice', () => {
  it('enriches null avgFillPrice from TP and continues same-side after TP', async () => {
    const provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    provider.enablePartialFills = false;
    provider.onPriceUpdate('ETHUSDT', '100');

    const orders = new Map<string, Record<string, unknown>>();
    const db = {
      trader: { update: jest.fn(async () => ({})) },
      order: {
        upsert: jest.fn(async ({ where, create, update }: {
          where: { clientOrderId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const next = { ...orders.get(where.clientOrderId), ...create, ...update, clientOrderId: where.clientOrderId, id: where.clientOrderId };
          orders.set(where.clientOrderId, next);
          return next;
        }),
        updateMany: jest.fn(async ({ where, data }: { where: { clientOrderId: string }; data: Record<string, unknown> }) => {
          const prev = orders.get(where.clientOrderId);
          if (prev) orders.set(where.clientOrderId, { ...prev, ...data });
          return { count: 1 };
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
      trade: { create: jest.fn(async () => ({})) },
      traderStatistics: { upsert: jest.fn(async () => ({})) },
    };

    const ledger = {
      getAllocation: jest.fn(async () => ({
        totalEquity: new Decimal(200),
        traderEquity: new Decimal(200),
        positionAllocation: new Decimal(200),
        positionNotional: new Decimal(2000),
        maxTraders: 1,
        leverage: 10,
      })),
      recordFee: jest.fn(async () => {}),
      recordRealized: jest.fn(async () => new Decimal(1)),
      getBalance: () => new Decimal(200),
      getRealizedPnl: () => new Decimal(0),
    };

    const trader = new Trader(
      'algo-test-1',
      'ETHUSDT',
      'SIMULATION',
      provider,
      traderConfig,
      db as never,
      ledger as never,
    );

    await trader.initialize();
    await wait(200);

    const summary = trader.toSummary();
    expect(summary.currentPosition).not.toBeNull();
    const tpId = [...orders.keys()].find((k) => k.startsWith('tp_'));
    expect(tpId).toBeDefined();
    const tp = summary.currentPosition!.tpPrice;
    const qty = summary.currentPosition!.quantity;

    await trader.onOrderUpdate({
      clientOrderId: tpId!,
      exchangeOrderId: 'algo-99',
      symbol: 'ETHUSDT',
      status: 'FILLED',
      filledQuantity: qty,
      avgFillPrice: null,
      fee: null,
      feeCurrency: null,
      timestamp: Date.now(),
    });

    await wait(300);

    expect(ledger.recordRealized).toHaveBeenCalled();
    const after = trader.toSummary();
    expect(after.stats.takeProfits).toBe(1);
    // Continuous trading: same side reopened
    expect(after.currentPosition).not.toBeNull();
    expect(after.currentPosition!.side).toBe('SHORT');
    expect(after.currentPosition!.number).toBe(2);
    expect(tp).toBeDefined();

    trader.destroy();
  });
});
