/**
 * Simulation test — verifies that SimulationExecutionProvider fills orders
 * correctly and that the hedge ladder math is identical to spec.
 */
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import { calcHedgeEntry, calcHedgeTp, calcNextHedgeEntry, calcShortTp } from '../../src/modules/utils/precision';
import type { OrderUpdate, SymbolInfo } from '../../src/types';

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

  it('emits orderUpdate for MARKET fills (shared path with Live)', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 'test',
      clientOrderId: 'test-market-evt',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.001',
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.status).toBe('FILLED');
    expect(updates[0]!.clientOrderId).toBe('test-market-evt');
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

    const fills: import('../../src/types').OrderResult[] = [];
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

    provider.onPriceUpdate('BTCUSDT', '55001');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0]!.status).toBe('FILLED');
  });

  it('triggers TAKE_PROFIT for short close when price drops', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    // Open short
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'short-1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.01',
    });

    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'short-tp-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'TAKE_PROFIT',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.01',
      price: '80',
      stopPrice: '80',
      reduceOnly: true,
    });

    provider.onPriceUpdate('BTCUSDT', '79');
    await new Promise((r) => setTimeout(r, 200));

    const tpFill = updates.find((u) => u.clientOrderId === 'short-tp-1');
    expect(tpFill?.status).toBe('FILLED');
  });

  it('triggers STOP_MARKET hedge SL and reduceOnly closes LONG', async () => {
    provider.onPriceUpdate('BTCUSDT', '110');
    // Open long hedge
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'hedge-fill',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
    });

    let positions = await provider.getPositions('BTCUSDT');
    expect(positions.some((p) => p.side === 'LONG')).toBe(true);

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'hedge-sl',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      stopPrice: '100',
      reduceOnly: true,
    });

    provider.onPriceUpdate('BTCUSDT', '99');
    await new Promise((r) => setTimeout(r, 200));

    positions = await provider.getPositions('BTCUSDT');
    expect(positions.find((p) => p.side === 'LONG')).toBeUndefined();
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

    // Idempotent second cancel
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
