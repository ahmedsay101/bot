import Decimal from 'decimal.js';
import {
  calcAllocation,
  calcTestingEquity,
  calcTotalPnl,
  calcQuantityFromNotional,
  TESTING_BASE_EQUITY,
} from '../../src/modules/calc/allocation';
import type { SymbolInfo } from '../../src/types';

const symbol: SymbolInfo = {
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

describe('allocation', () => {
  it('splits equity across traders and halves for main/hedge', () => {
    const a = calcAllocation('200', 5, 10);
    expect(a.traderEquity.toFixed(2)).toBe('40.00');
    expect(a.positionAllocation.toFixed(2)).toBe('20.00');
    expect(a.positionNotional.toFixed(2)).toBe('200.00');
  });

  it('testing equity = 200 + realized pnl', () => {
    expect(TESTING_BASE_EQUITY).toBe('200');
    expect(calcTestingEquity('15.5').toFixed(2)).toBe('215.50');
    expect(calcTestingEquity('-10').toFixed(2)).toBe('190.00');
  });

  it('total pnl = realized + unrealized', () => {
    expect(calcTotalPnl('10', '-3').toFixed(2)).toBe('7.00');
  });

  it('sizes quantity from notional / price with step size', () => {
    // notional 200 / 50000 = 0.004
    const qty = calcQuantityFromNotional(new Decimal(200), '50000', symbol);
    expect(qty).toBe('0.004');
  });

  it('rejects invalid price', () => {
    expect(() => calcQuantityFromNotional('200', '0', symbol)).toThrow(/invalid price/i);
  });
});
