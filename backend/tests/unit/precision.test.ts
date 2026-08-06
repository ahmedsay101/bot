import {
  roundToTickSize,
  roundToStepSize,
  adjustPrice,
  countDecimals,
  calcTakeProfit,
  calcStopLoss,
  calcShortUnrealizedPnl,
  calcLongUnrealizedPnl,
  calcFee,
} from '../../src/modules/utils/precision';
import type { SymbolInfo } from '../../src/types';

describe('Precision utilities', () => {
  describe('roundToTickSize', () => {
    it('rounds to the nearest tick', () => {
      expect(roundToTickSize('10.123', '0.01').toFixed(2)).toBe('10.12');
      expect(roundToTickSize('10.125', '0.01').toFixed(2)).toBe('10.13');
      expect(roundToTickSize('10.005', '0.01').toFixed(2)).toBe('10.01');
    });

    it('handles tick size of 1', () => {
      expect(roundToTickSize('10.9', '1').toFixed(0)).toBe('11');
      expect(roundToTickSize('10.4', '1').toFixed(0)).toBe('10');
    });
  });

  describe('roundToStepSize', () => {
    it('rounds down to step', () => {
      expect(roundToStepSize('1.999', '0.001').toFixed(3)).toBe('1.999');
      expect(roundToStepSize('1.9994', '0.001').toFixed(3)).toBe('1.999');
    });
  });

  describe('adjustPrice micro-priced alts', () => {
    const bicoLike: SymbolInfo = {
      symbol: 'BICOUSDT',
      baseAsset: 'BICO',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 0,
      tickSize: '0.0000001',
      stepSize: '1',
      minQty: '1',
      minNotional: '5',
      maxLeverage: 25,
      contractType: 'PERPETUAL',
      status: 'TRADING',
    };

    it('countDecimals reads tick size', () => {
      expect(countDecimals('0.0000001')).toBe(7);
      expect(countDecimals('0.01')).toBe(2);
    });

    it('does not truncate micro prices to zero when pricePrecision < tick decimals', () => {
      const adjusted = adjustPrice('0.0142700', bicoLike);
      expect(parseFloat(adjusted)).toBeGreaterThan(0);
      expect(adjusted).toBe('0.0142700');
    });

    it('throws on non-positive input', () => {
      expect(() => adjustPrice('0', bicoLike)).toThrow(/Invalid price/);
    });
  });

  describe('V2 TP/SL via precision re-exports', () => {
    it('SHORT TP 10% below entry', () => {
      expect(calcTakeProfit('1000', 'SHORT', '0.10').toFixed(2)).toBe('900.00');
    });

    it('SHORT SL 10% above entry', () => {
      expect(calcStopLoss('100', 'SHORT', '0.10').toFixed(2)).toBe('110.00');
    });
  });

  describe('calcShortUnrealizedPnl', () => {
    it('positive when price drops below entry', () => {
      expect(calcShortUnrealizedPnl('100', '80', '1').toFixed(2)).toBe('20.00');
    });

    it('negative when price rises above entry', () => {
      expect(calcShortUnrealizedPnl('100', '120', '1').toFixed(2)).toBe('-20.00');
    });
  });

  describe('calcLongUnrealizedPnl', () => {
    it('positive when price rises above entry', () => {
      expect(calcLongUnrealizedPnl('100', '150', '2').toFixed(2)).toBe('100.00');
    });
  });

  describe('calcFee', () => {
    it('calculates Binance taker fee', () => {
      expect(calcFee('100', '1', '0.0004').toFixed(4)).toBe('0.0400');
    });
  });
});
