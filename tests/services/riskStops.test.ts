import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager } from '../../src/services/riskManager.service.js';
import { Side } from '../../src/core/constants.js';
import { resetConfig, applySettingsPatch } from '../../src/core/config.js';

beforeEach(() => resetConfig());

const sym = {
  symbol: 'BTCUSDT',
  filters: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
} as unknown as Parameters<RiskManager['computeStops']>[3];

describe('RiskManager.computeStops', () => {
  const r = new RiskManager();

  it('LONG: SL < entry < TP', () => {
    const out = r.computeStops(Side.LONG, 100, 1, sym);
    expect(out).not.toBeNull();
    expect(out!.stopPrice).toBeLessThan(100);
    expect(out!.takeProfitPrice).toBeGreaterThan(100);
  });

  it('SHORT: TP < entry < SL', () => {
    const out = r.computeStops(Side.SHORT, 100, 1, sym);
    expect(out).not.toBeNull();
    expect(out!.stopPrice).toBeGreaterThan(100);
    expect(out!.takeProfitPrice).toBeLessThan(100);
  });

  it('rejects zero/NaN ATR', () => {
    expect(r.computeStops(Side.LONG, 100, 0, sym)).toBeNull();
    expect(r.computeStops(Side.LONG, 100, NaN, sym)).toBeNull();
  });

  it('rejects when ATR rounds TP onto entry tick (no profit possible)', () => {
    // tickSize 1.0 + tiny atr → both stop and TP round to entry → invalid
    const tinyTickSym = {
      symbol: 'X',
      filters: { tickSize: 1.0, stepSize: 1, minQty: 1, minNotional: 1 },
    } as unknown as Parameters<RiskManager['computeStops']>[3];
    applySettingsPatch({ exits: { slAtrMultiple: 0.1, tpAtrMultiple: 0.1 } });
    const out = r.computeStops(Side.LONG, 100, 0.001, tinyTickSym);
    expect(out).toBeNull();
  });

  it('LONG with realistic ATR: TP distance = tpMul * ATR (modulo tick rounding)', () => {
    const out = r.computeStops(Side.LONG, 100, 2, sym)!; // tpMul=2.5, slMul=1.5
    expect(out.takeProfitPrice - 100).toBeCloseTo(5, 1);
    expect(100 - out.stopPrice).toBeCloseTo(3, 1);
  });
});
