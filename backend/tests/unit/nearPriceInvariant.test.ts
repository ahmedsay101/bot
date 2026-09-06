/**
 * Pure, deterministic tests for the near-price grid CORE INVARIANT validator and
 * exact grid/TP alignment across symbols and tick sizes.
 *
 * These cover spec sections:
 *   #3  TP == adjacent grid level (arithmetic grid, no geometric formula)
 *   #10 Exact grid alignment after tick-size rounding
 *   #11 Floating point / exchange precision
 *   #14 Core invariant assertions (missing/wrong-side/stale/misaligned)
 */
import {
  buildNearPriceLevelPlans,
  adjacentGridLevelPrice,
  auditNearPriceInvariant,
  type NearPriceLevelSnapshot,
} from '../../src/modules/trader/near-price/nearPriceGridCalc';
import type { SymbolInfo } from '../../src/types';

const btc: SymbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
  pricePrecision: 2, quantityPrecision: 3, tickSize: '0.01', stepSize: '0.001',
  minQty: '0.001', minNotional: '5', maxLeverage: 125,
  contractType: 'PERPETUAL', status: 'TRADING',
};

const micro: SymbolInfo = {
  symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT',
  pricePrecision: 6, quantityPrecision: 0, tickSize: '0.000001', stepSize: '1',
  minQty: '1', minNotional: '5', maxLeverage: 75,
  contractType: 'PERPETUAL', status: 'TRADING',
};

const big: SymbolInfo = {
  symbol: 'XYZUSDT', baseAsset: 'XYZ', quoteAsset: 'USDT',
  pricePrecision: 1, quantityPrecision: 2, tickSize: '0.1', stepSize: '0.01',
  minQty: '0.01', minNotional: '5', maxLeverage: 50,
  contractType: 'PERPETUAL', status: 'TRADING',
};

function plans(startPrice: string, spacingPercent: string, boundaryPercent: string, info: SymbolInfo) {
  return buildNearPriceLevelPlans({ startPrice, boundaryPercent, spacingPercent, symbolInfo: info })
    .map((p) => ({ level: p.level, levelPrice: p.levelPrice }));
}

describe('exact grid/TP alignment (#3, #10, #11)', () => {
  const cases: Array<[string, string, string, string, SymbolInfo]> = [
    ['BTC 2%', '30000', '2', '20', btc],
    ['BTC 5%', '100', '5', '60', btc],
    ['micro price 2%', '0.033546', '2', '20', micro],
    ['micro price 1%', '0.033546', '1', '15', micro],
    ['big price 3%', '12345.6', '3', '30', big],
  ];

  it.each(cases)('%s: LONG tp(N)=level[N+1], SHORT tp(N)=level[N-1] after tick rounding',
    (_name, start, spacing, boundary, info) => {
      const levels = plans(start, spacing, boundary, info);
      const sorted = [...levels].sort((a, b) => a.level - b.level);
      const fallback = { startPrice: start, spacingPercent: spacing, symbolInfo: info };
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i];
        const up = sorted[i + 1];
        const down = sorted[i - 1];
        if (up) {
          expect(adjacentGridLevelPrice(levels, cur.level, 'LONG', fallback)).toBe(up.levelPrice);
        }
        if (down) {
          expect(adjacentGridLevelPrice(levels, cur.level, 'SHORT', fallback)).toBe(down.levelPrice);
        }
      }
    });

  it('never uses a geometric entryPrice-based TP: TP equals the neighbour LEVEL, not entry×(1+s)', () => {
    const levels = plans('100', '5', '60', btc); // arithmetic: 95,100,105,110...
    const l105 = levels.find((l) => l.levelPrice === '105.00')!;
    const l110 = levels.find((l) => l.levelPrice === '110.00')!;
    const fb = { startPrice: '100', spacingPercent: '5', symbolInfo: btc };
    // adjacent = exactly 110.00 (level), NOT 105 * 1.05 = 110.25
    expect(adjacentGridLevelPrice(levels, l105.level, 'LONG', fb)).toBe('110.00');
    expect(adjacentGridLevelPrice(levels, l110.level, 'SHORT', fb)).toBe('105.00');
  });

  it('grid extremity falls back to one arithmetic step (no crash, exchange-normalized)', () => {
    const levels = plans('100', '5', '60', btc);
    const top = [...levels].sort((a, b) => Number(b.levelPrice) - Number(a.levelPrice))[0];
    const fb = { startPrice: '100', spacingPercent: '5', symbolInfo: btc };
    const tp = adjacentGridLevelPrice(levels, top.level, 'LONG', fb);
    // one step of 100*5% = 5 above the topmost level
    expect(Number(tp)).toBeCloseTo(Number(top.levelPrice) + 5, 2);
  });
});

describe('auditNearPriceInvariant (#14)', () => {
  // A tidy 5-level grid centred on 100: 90,95,100,105,110 (levels 1..5).
  const grid = (over: Partial<Record<number, Partial<NearPriceLevelSnapshot>>> = {}): NearPriceLevelSnapshot[] => {
    const base: NearPriceLevelSnapshot[] = [
      { level: 1, levelPrice: '90', status: 'EMPTY', direction: null },
      { level: 2, levelPrice: '95', status: 'EMPTY', direction: null },
      { level: 3, levelPrice: '100', status: 'EMPTY', direction: null },
      { level: 4, levelPrice: '105', status: 'EMPTY', direction: null },
      { level: 5, levelPrice: '110', status: 'EMPTY', direction: null },
    ];
    return base.map((l) => ({ ...l, ...(over[l.level] ?? {}) }));
  };

  it('reports the correct expected LONG/SHORT windows around mark', () => {
    const r = auditNearPriceInvariant(grid(), '101', { requireCovered: false });
    expect(r.expectedLong).toEqual([4, 5]);   // 105, 110
    expect(r.expectedShort).toEqual([3, 2]);  // 100, 95 (nearest first)
  });

  it('ok when required slots carry the correct side', () => {
    const r = auditNearPriceInvariant(grid({
      4: { status: 'PENDING', direction: 'LONG' },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101');
    expect(r.ok).toBe(true);
  });

  it('MISSING_REQUIRED_* when required slot is EMPTY and requireCovered', () => {
    const r = auditNearPriceInvariant(grid({
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101', { requireCovered: true });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === 'MISSING_REQUIRED_LONG' && v.level === 4)).toBe(true);
  });

  it('WRONG_SIDE_PENDING when a required LONG slot holds a PENDING SHORT', () => {
    const r = auditNearPriceInvariant(grid({
      4: { status: 'PENDING', direction: 'SHORT' },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101');
    expect(r.violations.some((v) => v.kind === 'WRONG_SIDE_PENDING' && v.level === 4)).toBe(true);
  });

  it('allowed exception: a required slot occupied by a FILLED opposite position is NOT a violation', () => {
    // Level 4 (105) is required LONG but holds a still-open filled SHORT waiting for its TP.
    const r = auditNearPriceInvariant(grid({
      4: { status: 'ACTIVE', direction: 'SHORT', filled: true },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101', { requireCovered: true });
    expect(r.violations.some((v) => v.level === 4)).toBe(false);
  });

  it('STALE_PENDING_OUTSIDE_WINDOW for a pending far from mark', () => {
    const r = auditNearPriceInvariant(grid({
      1: { status: 'PENDING', direction: 'SHORT' }, // 90 is far below when mark=101
      4: { status: 'PENDING', direction: 'LONG' },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101');
    expect(r.violations.some((v) => v.kind === 'STALE_PENDING_OUTSIDE_WINDOW' && v.level === 1)).toBe(true);
  });

  it('a far pending whose stop was reached (activating) is NOT stale', () => {
    const r = auditNearPriceInvariant(grid({
      1: { status: 'PENDING', direction: 'SHORT', activating: true },
      4: { status: 'PENDING', direction: 'LONG' },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101');
    expect(r.violations.some((v) => v.level === 1)).toBe(false);
  });

  it('TP_MISALIGNED when an active position TP != adjacent grid level; ok when aligned', () => {
    const opts = { startPrice: '100', spacingPercent: '5', symbolInfo: btc, requireCovered: false };
    const bad = auditNearPriceInvariant(grid({
      4: { status: 'ACTIVE', direction: 'LONG', filled: true, tpPrice: '109' }, // should be 110
    }), '101', opts);
    expect(bad.violations.some((v) => v.kind === 'TP_MISALIGNED' && v.level === 4)).toBe(true);

    const good = auditNearPriceInvariant(grid({
      4: { status: 'ACTIVE', direction: 'LONG', filled: true, tpPrice: '110' },
      5: { status: 'PENDING', direction: 'LONG' },
      3: { status: 'PENDING', direction: 'SHORT' },
      2: { status: 'PENDING', direction: 'SHORT' },
    }), '101', opts);
    expect(good.violations.some((v) => v.kind === 'TP_MISALIGNED')).toBe(false);
  });
});
