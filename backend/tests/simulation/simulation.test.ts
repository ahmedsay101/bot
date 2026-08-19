/**
 * Simulation — Binance Futures-aligned order lifecycle using real mark ticks.
 */
import { SimulationExecutionProvider } from '../../src/modules/execution/SimulationExecutionProvider';
import { calcTakeProfit, calcStopLoss, nextSideAfterClose } from '../../src/modules/utils/precision';
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

async function wait(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('SimulationExecutionProvider — Binance-aligned', () => {
  let provider: SimulationExecutionProvider;

  beforeEach(() => {
    provider = new SimulationExecutionProvider(async () => [mockSymbolInfo]);
    // Deterministic fills for lifecycle tests
    provider.enablePartialFills = false;
  });

  it('fills MARKET immediately with slippage', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    const result = await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'm1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.001',
    });
    expect(result.status).toBe('FILLED');
    expect(result.avgFillPrice).toBeDefined();
    // SELL slippage → slightly below mark
    expect(parseFloat(result.avgFillPrice!)).toBeLessThan(50000);
  });

  it('STOP_LIMIT gap-fills at market when mark blows through the limit', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    // BUY stop-limit: stop=110, limit=110
    const placed = await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'sl1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      price: '110',
      stopPrice: '110',
    });
    expect(placed.status).toBe('PENDING');

    // Gap through stop to 120 — trigger + gap-fill (must not stay stranded TRIGGERED)
    provider.onPriceUpdate('BTCUSDT', '120');
    await wait();

    expect(updates.some((u) => u.status === 'FILLED')).toBe(true);
    const fill = updates.find((u) => u.status === 'FILLED');
    expect(parseFloat(fill!.avgFillPrice!)).toBeGreaterThan(110);
  });

  it('STOP_LIMIT SELL gap-fills when mark falls through limit (grid short case)', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'sl-short',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_LIMIT',
      role: 'SHORT',
      hedgeLevel: 1,
      quantity: '0.01',
      price: '90',
      stopPrice: '90',
      positionSide: 'SHORT',
    });

    // Crash through 90 to 80 — Short #1 must fill, not sit as LIMIT LIVE
    provider.onPriceUpdate('BTCUSDT', '80');
    await wait();
    expect(updates.some((u) => u.clientOrderId === 'sl-short' && u.status === 'FILLED')).toBe(true);
  });

  it('STOP_LIMIT fills when stop and limit are both satisfied on same tick', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'sl2',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      price: '110',
      stopPrice: '110',
    });

    // Exactly at stop=limit → trigger + limit executable
    provider.onPriceUpdate('BTCUSDT', '110');
    await wait();
    expect(updates.some((u) => u.status === 'FILLED')).toBe(true);
  });

  it('STOP_MARKET fills immediately on stop with market slippage', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'sm1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      stopPrice: '90',
      positionSide: 'LONG',
    });

    // Open long first so STOP_MARKET can close the LONG leg
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'long1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      positionSide: 'LONG',
    });

    provider.onPriceUpdate('BTCUSDT', '89');
    await wait();
    const fill = updates.find((u) => u.clientOrderId === 'sm1' && u.status === 'FILLED');
    expect(fill).toBeDefined();
  });

  it('TAKE_PROFIT for short closes when price drops to TP', async () => {
    provider.onPriceUpdate('BTCUSDT', '100');
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'short',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.01',
      positionSide: 'SHORT',
    });

    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'tp1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'TAKE_PROFIT',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.01',
      price: '80',
      stopPrice: '80',
      positionSide: 'SHORT',
    });

    provider.onPriceUpdate('BTCUSDT', '80');
    await wait();
    expect(updates.some((u) => u.clientOrderId === 'tp1' && u.status === 'FILLED')).toBe(true);
  });

  it('cancel is idempotent and removes from pending book', async () => {
    provider.onPriceUpdate('BTCUSDT', '50');
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'c1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LIMIT',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      price: '60',
      stopPrice: '60',
    });
    await provider.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'c1' });
    await provider.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'c1' });
    expect(provider.getPendingOrders('BTCUSDT').length).toBe(0);
  });

  it('emits orderUpdate for MARKET fills (shared Live path)', async () => {
    provider.onPriceUpdate('BTCUSDT', '50000');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'm2',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '0.001',
    });
    await wait();
    expect(updates[0]?.status).toBe('FILLED');
  });

  it('dual-side mode tracks LONG and SHORT positionSides independently', async () => {
    await provider.setHedgeMode(true);
    provider.onPriceUpdate('BTCUSDT', '100');

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'short',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 1,
      quantity: '0.01',
      positionSide: 'SHORT',
    });
    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'long',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      role: 'LONG',
      hedgeLevel: 2,
      quantity: '0.01',
      positionSide: 'LONG',
    });

    const positions = await provider.getPositions('BTCUSDT');
    expect(positions.map((p) => p.side).sort()).toEqual(['LONG', 'SHORT']);
  });

  it('partial fill emits PARTIALLY_FILLED then FILLED with remainder', async () => {
    provider.enablePartialFills = false;
    provider.forcePartialFraction = 0.5;
    provider.onPriceUpdate('BTCUSDT', '100');
    const updates: OrderUpdate[] = [];
    provider.on('orderUpdate', (u: OrderUpdate) => updates.push(u));

    await provider.placeOrder({
      traderId: 't',
      clientOrderId: 'pf1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      role: 'HEDGE',
      hedgeLevel: 1,
      quantity: '0.01',
      positionSide: 'LONG',
    });

    await wait(300);
    expect(updates.some((u) => u.status === 'PARTIALLY_FILLED')).toBe(true);
    expect(updates.some((u) => u.status === 'FILLED')).toBe(true);
    const filled = updates.find((u) => u.status === 'FILLED');
    expect(filled?.filledQuantity).toBe('0.010');
  });
});

describe('Reversal mathematics', () => {
  it('matches strategy V2 TP/SL and side rules', () => {
    expect(calcTakeProfit('100', 'SHORT', '0.10').toFixed(2)).toBe('90.00');
    expect(calcStopLoss('100', 'SHORT', '0.10').toFixed(2)).toBe('110.00');
    expect(calcTakeProfit('100', 'LONG', '0.10').toFixed(2)).toBe('110.00');
    expect(calcStopLoss('100', 'LONG', '0.10').toFixed(2)).toBe('90.00');
    expect(nextSideAfterClose('SHORT', 'TP')).toBe('SHORT');
    expect(nextSideAfterClose('SHORT', 'SL')).toBe('LONG');
  });
});
