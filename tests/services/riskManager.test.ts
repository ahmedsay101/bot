import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager, computeLiquidationPrice } from '../../src/services/riskManager.service.js';
import { resetConfig, applySettingsPatch } from '../../src/core/config.js';
import { Side } from '../../src/core/constants.js';
import type { ExchangeSymbolInfo } from '../../src/api/binance.rest.js';

beforeEach(() => resetConfig());

const info: ExchangeSymbolInfo = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  contractType: 'PERPETUAL',
  pricePrecision: 2,
  quantityPrecision: 3,
  filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
};

describe('RiskManager.size', () => {
  it('sizes LONG so loss-at-stop ≈ riskPerTrade × marginAllocated', () => {
    const r = new RiskManager();
    const out = r.size({
      symbol: 'BTCUSDT',
      side: Side.LONG,
      entryPrice: 50_000,
      atrValue: 200, // SL = 50000 - 1.5*200 = 49700
      marginAllocated: 200,
      symbolInfo: info,
    });
    expect(out).not.toBeNull();
    expect(out!.qty).toBeGreaterThan(0);
    expect(out!.stopPrice).toBeCloseTo(49_700, 0);
    expect(out!.takeProfitPrice).toBeCloseTo(50_500, 0);
    // riskUsdt should be ≤ 1% of 200 = 2 USDT (floored by stepSize quantization)
    expect(out!.riskUsdt).toBeLessThanOrEqual(2 + 1e-9);
    expect(out!.riskUsdt).toBeGreaterThan(1.5);
  });

  it('mirrors for SHORT', () => {
    const r = new RiskManager();
    const out = r.size({
      symbol: 'BTCUSDT',
      side: Side.SHORT,
      entryPrice: 50_000,
      atrValue: 200,
      marginAllocated: 200,
      symbolInfo: info,
    });
    expect(out).not.toBeNull();
    expect(out!.stopPrice).toBeCloseTo(50_300, 0);
    expect(out!.takeProfitPrice).toBeCloseTo(49_500, 0);
  });

  it('returns null on bad inputs', () => {
    const r = new RiskManager();
    expect(r.size({ symbol: 'X', side: Side.LONG, entryPrice: 0, atrValue: 1, marginAllocated: 100, symbolInfo: info })).toBeNull();
    expect(r.size({ symbol: 'X', side: Side.LONG, entryPrice: 100, atrValue: 0, marginAllocated: 100, symbolInfo: info })).toBeNull();
  });

  it('caps notional by margin × leverage', () => {
    applySettingsPatch({ trading: { leverage: 2, riskPerTrade: 0.5 } as never }); // huge risk
    const r = new RiskManager();
    const out = r.size({
      symbol: 'BTCUSDT',
      side: Side.LONG,
      entryPrice: 50_000,
      atrValue: 5, // tiny SL → riskPerTrade would otherwise need huge qty
      marginAllocated: 100,
      symbolInfo: info,
    });
    if (out) {
      expect(out.notional).toBeLessThanOrEqual(100 * 2 + 1);
    }
  });
});

describe('liquidationPrice', () => {
  it('LONG below entry, SHORT above', () => {
    const e = 1000;
    expect(computeLiquidationPrice(Side.LONG, e, 2)).toBeLessThan(e);
    expect(computeLiquidationPrice(Side.SHORT, e, 2)).toBeGreaterThan(e);
  });
});
