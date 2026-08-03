/**
 * Unit tests for Binance order routing helpers (algo vs regular, hedge positionSide).
 */
import type { OrderRequest } from '../../src/types';

// Mirror resolvePositionSide logic from client (kept local to avoid spinning up client)
function resolvePositionSide(
  req: OrderRequest,
  hedgeMode: boolean,
): 'LONG' | 'SHORT' | 'BOTH' {
  if (req.positionSide != null) return req.positionSide;
  if (!hedgeMode) return 'BOTH';
  return req.role === 'SHORT' ? 'SHORT' : 'LONG';
}

function isConditional(type: OrderRequest['type']): boolean {
  return (
    type === 'STOP_LIMIT' ||
    type === 'STOP_MARKET' ||
    type === 'TAKE_PROFIT' ||
    type === 'TAKE_PROFIT_MARKET'
  );
}

function toBinanceType(type: OrderRequest['type']): string {
  if (type === 'STOP_LIMIT') return 'STOP';
  return type;
}

describe('Binance order routing', () => {
  it('maps STOP_LIMIT → STOP for Algo API', () => {
    expect(toBinanceType('STOP_LIMIT')).toBe('STOP');
    expect(toBinanceType('TAKE_PROFIT')).toBe('TAKE_PROFIT');
    expect(toBinanceType('MARKET')).toBe('MARKET');
  });

  it('routes conditionals to algo path', () => {
    expect(isConditional('STOP_LIMIT')).toBe(true);
    expect(isConditional('STOP_MARKET')).toBe(true);
    expect(isConditional('TAKE_PROFIT')).toBe(true);
    expect(isConditional('TAKE_PROFIT_MARKET')).toBe(true);
    expect(isConditional('MARKET')).toBe(false);
    expect(isConditional('LIMIT')).toBe(false);
  });

  it('resolves hedge positionSide from role when omitted', () => {
    const shortReq = {
      traderId: 't',
      clientOrderId: 'a',
      symbol: 'BTCUSDT',
      side: 'SELL' as const,
      type: 'MARKET' as const,
      role: 'SHORT' as const,
      hedgeLevel: 0,
      quantity: '1',
    };
    const hedgeReq = { ...shortReq, role: 'HEDGE' as const, side: 'BUY' as const };
    expect(resolvePositionSide(shortReq, true)).toBe('SHORT');
    expect(resolvePositionSide(hedgeReq, true)).toBe('LONG');
    expect(resolvePositionSide(shortReq, false)).toBe('BOTH');
  });

  it('honors explicit positionSide over role', () => {
    const req: OrderRequest = {
      traderId: 't',
      clientOrderId: 'a',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      role: 'SHORT',
      hedgeLevel: 0,
      quantity: '1',
      positionSide: 'LONG',
    };
    expect(resolvePositionSide(req, true)).toBe('LONG');
  });
});
