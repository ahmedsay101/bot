import Decimal from 'decimal.js';
import {
  roundToTickSize,
  roundToStepSize,
  adjustPrice,
  countDecimals,
  calcShortTp,
  calcHedgeEntry,
  calcHedgeTp,
  calcNextHedgeEntry,
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
      // Deliberately low pricePrecision vs tick — previously truncated to 0.00
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

  describe('calcShortTp', () => {
    it('calculates 20% below entry', () => {
      const tp = calcShortTp('100', '0.20');
      expect(tp.toFixed(2)).toBe('80.00');
    });

    it('calculates 10% below entry', () => {
      const tp = calcShortTp('1000', '0.10');
      expect(tp.toFixed(2)).toBe('900.00');
    });
  });

  describe('calcHedgeEntry', () => {
    it('calculates 10% above short entry', () => {
      const entry = calcHedgeEntry('10', '0.10');
      expect(entry.toFixed(2)).toBe('11.00');
    });
  });

  describe('calcHedgeTp', () => {
    it('calculates 50% above hedge entry', () => {
      const tp = calcHedgeTp('11', '0.50');
      expect(tp.toFixed(2)).toBe('16.50');
    });
  });

  describe('calcNextHedgeEntry', () => {
    it('calculates 10% above previous TP', () => {
      const next = calcNextHedgeEntry('16.5', '0.10');
      expect(next.toFixed(3)).toBe('18.150');
    });
  });

  describe('calcShortUnrealizedPnl', () => {
    it('positive when price drops below entry', () => {
      const pnl = calcShortUnrealizedPnl('100', '80', '1');
      expect(pnl.toFixed(2)).toBe('20.00');
    });

    it('negative when price rises above entry', () => {
      const pnl = calcShortUnrealizedPnl('100', '120', '1');
      expect(pnl.toFixed(2)).toBe('-20.00');
    });
  });

  describe('calcLongUnrealizedPnl', () => {
    it('positive when price rises above entry', () => {
      const pnl = calcLongUnrealizedPnl('100', '150', '2');
      expect(pnl.toFixed(2)).toBe('100.00');
    });
  });

  describe('calcFee', () => {
    it('calculates Binance taker fee', () => {
      const fee = calcFee('100', '1', '0.0004');
      expect(fee.toFixed(4)).toBe('0.0400');
    });
  });

  describe('Hedge example from spec', () => {
    // Price = 10, Short = 10
    // Hedge: Entry = 11, Stop = 10, TP = 16.5
    it('matches spec example exactly', () => {
      const shortEntry = '10';
      const hedgeEntry = calcHedgeEntry(shortEntry, '0.10');
      const hedgeTp = calcHedgeTp(hedgeEntry.toFixed(), '0.50');
      const hedgeStop = new Decimal(shortEntry);

      expect(hedgeEntry.toFixed(2)).toBe('11.00');
      expect(hedgeStop.toFixed(2)).toBe('10.00');
      expect(hedgeTp.toFixed(2)).toBe('16.50');
    });

    it('computes next hedge correctly after TP', () => {
      // After TP at 16.5: next entry = 16.5 * 1.10 = 18.15
      // next TP = 18.15 * 1.50 = 27.225
      const nextEntry = calcNextHedgeEntry('16.5', '0.10');
      const nextTp = calcHedgeTp(nextEntry.toFixed(), '0.50');

      expect(nextEntry.toFixed(3)).toBe('18.150');
      expect(nextTp.toFixed(4)).toBe('27.2250');
    });
  });
});
