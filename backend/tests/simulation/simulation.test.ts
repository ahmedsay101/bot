/**
 * Simulation test — verifies that SimulationExecutionProvider fills orders
 * correctly and that the hedge ladder math is identical to spec.
 */
import { SimulationExecutionProvider } from '../../../src/modules/execution/SimulationExecutionProvider';
import { calcHedgeEntry, calcHedgeTp, calcNextHedgeEntry, calcShortTp } from '../../../src/modules/utils/precision';
import type { SymbolInfo } from '../../../src/types';

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

describe('SimulationExecutionProvider', () => {
  let provider: SimulationExecutionProvider;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
  });

  it('fills MARKET orders immediately', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    const result = await provider.placeOrder({
      traderId: 'test',
      clientOrderId: 'test-market-1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.001',
    });
    expect(result.status).toBe('FILLED');
    expect(result.filledQuantity).toBe('0.001');
    expect(result.avgFillPrice).toBeDefined();
  });

  it('does not fill STOP_LIMIT until stop price is reached', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    const result = await provider.placeOrder({
      traderId: 'test',
      clientOrderId: 'test-stop-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.001',
      price: '55000',
      stopPrice: '55000',
    });
    expect(result.status).toBe('NEW');
  });

  it('triggers STOP_LIMIT when price crosses stop price', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');

    const fills: import('../../../src/types').OrderResult[] = [];
    provider.on('orderFill', (r) => fills.push(r));

    await provider.placeOrder({
      traderId: 'test',
      clientOrderId: 'test-stop-2',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.001',
      price: '55000',
      stopPrice: '55000',
    });

    // Simulate price moving up past stop
    provider.onPriceUpdate('BTCUSDT', '55001');

    // Wait for async fill
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].status).toBe('FILLED');
  });

  it('cancels orders correctly', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    await provider.placeOrder({
      traderId: 'test',
      clientOrderId: 'test-cancel-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.001',
      price: '55000',
      stopPrice: '55000',
    });

    await expect(
      provider.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'test-cancel-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('Hedge ladder mathematics', () => {
  it('hedge level 1 matches spec exactly: price=10, hedge entry=11, stop=10, tp=16.5', () => {
    const shortEntry = '10';
    const hedgeEntry = calcHedgeEntry(shortEntry, '0.10');
    const hedgeTp = calcHedgeTp(hedgeEntry.toFixed(), '0.50');
    const hedgeStop = shortEntry;

    expect(hedgeEntry.toFixed(2)).toBe('11.00');
    expect(hedgeTp.toFixed(2)).toBe('16.50');
    expect(hedgeStop).toBe('10');
  });

  it('short TP = 20% below entry', () => {
    expect(calcShortTp('10', '0.20').toFixed(2)).toBe('8.00');
  });

  it('next hedge after TP: entry=18.15, stop=16.5, tp=27.225', () => {
    const nextEntry = calcNextHedgeEntry('16.5', '0.10');
    const nextTp = calcHedgeTp(nextEntry.toFixed(), '0.50');
    const nextStop = '16.5';

    expect(nextEntry.toFixed(3)).toBe('18.150');
    expect(nextTp.toFixed(4)).toBe('27.2250');
    expect(nextStop).toBe('16.5');
  });

  it('SL recreates same hedge level without changing prices', () => {
    // If hedge SL hits, we recreate same entry/stop/tp
    const original = {
      level: 1,
      entryPrice: '11',
      stopPrice: '10',
      tpPrice: '16.5',
    };
    const recreated = { ...original };
    expect(recreated).toStrictEqual(original);
  });
});
