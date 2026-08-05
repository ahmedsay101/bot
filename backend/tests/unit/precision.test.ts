import Decimal from 'decimal.js';
import {
  roundToTickSize,
  roundToStepSize,
  adjustPrice,
  countDecimals,
  calcShortTp,
  calcHedgeEntry,
  calcHedgeTp,
  calcHedgeStopLoss,
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
    it('calculates 10% above hedge entry', () => {
      const tp = calcHedgeTp('110', '0.10');
      expect(tp.toFixed(2)).toBe('121.00');
    });
  });

  describe('calcHedgeStopLoss', () => {
    it('calculates 3% below hedge entry', () => {
      const sl = calcHedgeStopLoss('110', '0.03');
      expect(sl.toFixed(2)).toBe('106.70');
    });
  });

  describe('calcNextHedgeEntry', () => {
    it('calculates 10% above previous TP', () => {
      const next = calcNextHedgeEntry('121', '0.10');
      expect(next.toFixed(2)).toBe('133.10');
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
    // Short = 100 → Hedge Entry 110, SL 106.70, TP 121
    it('matches new risk/reward defaults', () => {
      const shortEntry = '100';
      const hedgeEntry = calcHedgeEntry(shortEntry, '0.10');
      const hedgeSl = calcHedgeStopLoss(hedgeEntry, '0.03');
      const hedgeTp = calcHedgeTp(hedgeEntry.toFixed(), '0.10');

      expect(hedgeEntry.toFixed(2)).toBe('110.00');
      expect(hedgeSl.toFixed(2)).toBe('106.70');
      expect(hedgeTp.toFixed(2)).toBe('121.00');
    });

    it('computes next hedge correctly after TP', () => {
      const nextEntry = calcNextHedgeEntry('121', '0.10');
      const nextSl = calcHedgeStopLoss(nextEntry, '0.03');
      const nextTp = calcHedgeTp(nextEntry.toFixed(), '0.10');

      expect(nextEntry.toFixed(2)).toBe('133.10');
      expect(nextSl.toFixed(3)).toBe('129.107');
      expect(nextTp.toFixed(2)).toBe('146.41');
    });
  });
});
