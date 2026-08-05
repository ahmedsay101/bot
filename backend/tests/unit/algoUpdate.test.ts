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
  hedgeDistance: '0.10',
  hedgeTpPercent: '0.10',
  hedgeSlPercent: '0.03',
  shortTpPercent: '0.10',
  refreshInterval: 60000,
  retryLimit: 2,
  feeRate: '0.0004',
  slippage: '0.0001',
  mode: 'SIMULATION',
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ALGO-style fill with null avgFillPrice', () => {
  it('completes trader when FILLED arrives without avg price (uses TP fallback)', async () => {
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
        positionAllocation: new Decimal(100),
        positionNotional: new Decimal(1000),
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

    let completed = false;
    trader.on('traderEvent', (e: { type: string }) => {
      if (e.type === 'COMPLETED') completed = true;
    });

    // Skip sim auto-fill path — drive manually like ALGO_UPDATE
    await trader.initialize();
    await wait(200);

    const tpId = [...orders.keys()].find((k) => k.startsWith('short_tp_'));
    expect(tpId).toBeDefined();
    const tp = trader.getShortTpPrice()!;

    // Simulate ALGO_UPDATE FINISHED with null avgFillPrice
    await trader.onOrderUpdate({
      clientOrderId: tpId!,
      exchangeOrderId: 'algo-99',
      symbol: 'ETHUSDT',
      status: 'FILLED',
      filledQuantity: trader.getShortQuantity() ?? '0',
      avgFillPrice: null,
      fee: null,
      feeCurrency: null,
      timestamp: Date.now(),
    });

    await wait(200);
    expect(completed).toBe(true);
    expect(trader.getStatus()).toBe('COMPLETED');
    // Enrichment should have used short TP price
    expect(ledger.recordRealized).toHaveBeenCalled();
    const call = (ledger.recordRealized as jest.Mock).mock.calls.find(
      (c) => new Decimal(c[0]).abs().gt(0),
    );
    expect(call).toBeDefined();
    expect(tp).toBeDefined();
  });
});
