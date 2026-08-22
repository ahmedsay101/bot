/**
 * Selective two-stage trend engine.
 * Stage 1: regime filter. Stage 2: direction + category consensus.
 * Default: NO_TRADE. Confidence = signal quality (0–100), not probability.
 */
import type { Candle } from './trendCalc';
import {
  calcAdxDi,
  calcAtr,
  calcMacd,
  calcRoc,
  calcRsi,
  closedOnly,
  detectFalseBreakout,
  detectSwings,
  efficiencyRatio,
  ema,
  emaSlopeAtr,
  sma,
  structureBias,
  structureDistances,
  structureFromWindows,
  toOHLCV,
  type StructureBias,
} from './indicators';

export type TrendDecision = 'TRADE' | 'NO_TRADE';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NONE';
export type MarketRegime =
  | 'STRONG_TREND'
  | 'WEAK_TREND'
  | 'RANGE'
  | 'CHOP'
  | 'BREAKOUT'
  | 'REVERSAL_RISK'
  | 'UNCERTAIN'
  | 'INSUFFICIENT_DATA';

export type TfKey = '5m' | '15m' | '1h' | '4h';

export interface CategorySignal {
  confirmed: boolean;
  score: number; // 0–100 within category
  detail: string;
}

export interface TrendConfirmation {
  symbol: string;
  timestamp: number;
  decision: TrendDecision;
  direction: TrendDirection;
  regime: MarketRegime;
  confidenceScore: number;
  minimumRequiredScore: number;
  signals: {
    marketStructure: CategorySignal;
    multiTimeframe: CategorySignal;
    emaStructure: CategorySignal;
    trendStrength: CategorySignal;
    momentum: CategorySignal;
    volume: CategorySignal;
    volatility: CategorySignal;
    efficiency: CategorySignal;
    breakout: CategorySignal;
    trendPersistence: CategorySignal;
    marketContext: CategorySignal;
  };
  risk: {
    reversalRisk: number;
    exhaustionRisk: number;
    supportResistanceRisk: number;
    extensionRisk: number;
  };
  metrics: {
    adx: number;
    plusDi: number;
    minusDi: number;
    atrPercent: number;
    efficiencyRatio: number;
    relativeVolume: number;
    momentum: number;
    trendAge: string;
    distanceToResistanceATR: number;
    distanceToSupportATR: number;
    mtfAligned: number;
    mtfTotal: number;
    weightedBias: number;
  };
  rejectionReasons: string[];
  evaluatedAt: number;
  /** Compatibility with existing trader gate / UI. */
  confirmed: boolean;
  strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';
  score: number;
  maxScore: number;
  confidence: number;
  reasons: string[];
  signalsFlat: string[];
}

export interface TrendEngineConfig {
  minConfidence: number;
  minAdx: number;
  minEfficiency: number;
  minTrendRoomAtr: number;
  maxReversalRisk: number;
  minDiSeparation: number;
  minMtfAgree: number;
  minCategoryConfirmed: number;
  adxPeriod: number;
  erPeriod: number;
  volumeAvgPeriod: number;
  minRelativeVolume: number;
  rsiBullMin: number;
  rsiBearMax: number;
  rsiExhaustionHigh: number;
  rsiExhaustionLow: number;
  weights: Record<TfKey, number>;
  require4h1hAgree: boolean;
}

export const DEFAULT_TREND_ENGINE_CONFIG: TrendEngineConfig = {
  minConfidence: 85,
  minAdx: 25,
  minEfficiency: 0.35,
  minTrendRoomAtr: 1.2,
  maxReversalRisk: 55,
  minDiSeparation: 5,
  minMtfAgree: 3,
  minCategoryConfirmed: 5,
  adxPeriod: 14,
  erPeriod: 20,
  volumeAvgPeriod: 20,
  minRelativeVolume: 1.1,
  rsiBullMin: 55,
  rsiBearMax: 45,
  rsiExhaustionHigh: 78,
  rsiExhaustionLow: 22,
  weights: { '4h': 0.35, '1h': 0.3, '15m': 0.25, '5m': 0.1 },
  require4h1hAgree: true,
};

export interface TfSnapshot {
  bias: StructureBias; // +1/-1 mapped later
  adx: number;
  plusDi: number;
  minusDi: number;
  adxSlope: number;
  er: number;
  emaStackBull: boolean;
  emaStackBear: boolean;
  ema20Slope: number;
  rsi: number;
  roc: number;
  macdHist: number;
  relativeVolume: number;
  atr: number;
  atrPercent: number;
  toResAtr: number;
  toSupAtr: number;
  falseBull: boolean;
  falseBear: boolean;
  structure: StructureBias;
  price: number;
  ema20: number;
  ema50: number;
  extensionAtr: number;
}

function emptyCategory(detail = 'n/a'): CategorySignal {
  return { confirmed: false, score: 0, detail };
}

function noTradeResult(
  symbol: string,
  regime: MarketRegime,
  reasons: string[],
  cfg: TrendEngineConfig,
  partial?: Partial<TrendConfirmation>,
): TrendConfirmation {
  const now = Date.now();
  const base: TrendConfirmation = {
    symbol,
    timestamp: now,
    decision: 'NO_TRADE',
    direction: 'NONE',
    regime,
    confidenceScore: 0,
    minimumRequiredScore: cfg.minConfidence,
    signals: {
      marketStructure: emptyCategory(),
      multiTimeframe: emptyCategory(),
      emaStructure: emptyCategory(),
      trendStrength: emptyCategory(),
      momentum: emptyCategory(),
      volume: emptyCategory(),
      volatility: emptyCategory(),
      efficiency: emptyCategory(),
      breakout: emptyCategory(),
      trendPersistence: emptyCategory(),
      marketContext: emptyCategory(),
    },
    risk: {
      reversalRisk: 100,
      exhaustionRisk: 0,
      supportResistanceRisk: 0,
      extensionRisk: 0,
    },
    metrics: {
      adx: 0,
      plusDi: 0,
      minusDi: 0,
      atrPercent: 0,
      efficiencyRatio: 0,
      relativeVolume: 0,
      momentum: 0,
      trendAge: 'UNKNOWN',
      distanceToResistanceATR: 0,
      distanceToSupportATR: 0,
      mtfAligned: 0,
      mtfTotal: 4,
      weightedBias: 0,
    },
    rejectionReasons: reasons,
    evaluatedAt: now,
    confirmed: false,
    strength: 'NONE',
    score: 0,
    maxScore: 100,
    confidence: 0,
    reasons,
    signalsFlat: [],
    ...partial,
  };
  return { ...base, ...partial, decision: 'NO_TRADE', confirmed: false, direction: partial?.direction ?? 'NONE' };
}

function analyzeTf(candlesIn: Candle[], cfg: TrendEngineConfig): TfSnapshot | null {
  const candles = closedOnly(candlesIn);
  // Need enough bars for EMA200-ish stack + ADX
  if (candles.length < 80) return null;
  const { highs, lows, closes, volumes } = toOHLCV(candles);
  const atr = calcAtr(highs, lows, closes, cfg.adxPeriod);
  const price = closes[closes.length - 1]!;
  if (atr <= 0 || price <= 0) return null;

  const adxDi = calcAdxDi(highs, lows, closes, cfg.adxPeriod);
  const er = efficiencyRatio(closes, cfg.erPeriod);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const last = closes.length - 1;
  const ema20 = e20[last]!;
  const ema50 = e50[last]!;
  const ema100 = e100[last]!;
  const ema200 = e200[last]!;
  const emaStackBull = ema20 > ema50 && ema50 > ema100 && ema100 > ema200;
  const emaStackBear = ema20 < ema50 && ema50 < ema100 && ema100 < ema200;
  const ema20Slope = emaSlopeAtr(e20, atr, 5);
  const rsi = calcRsi(closes, 14);
  const roc = calcRoc(closes, 10);
  const macd = calcMacd(closes);
  const avgVol = sma(volumes, cfg.volumeAvgPeriod);
  const lastVol = volumes[last]!;
  const relativeVolume = avgVol > 0 ? lastVol / avgVol : 0;
  // persistence: avg of last 3 relative volumes
  const recentRel =
    avgVol > 0
      ? averageSafe(volumes.slice(-3).map((v) => v / avgVol))
      : 0;
  void recentRel;

  const swings = detectSwings(highs, lows, 2, 2);
  const fractalStructure = structureBias(swings, 6);
  const windowStructure = structureFromWindows(highs, lows, 24);
  const structure =
    fractalStructure !== 'NONE'
      ? fractalStructure
      : windowStructure !== 'NONE'
        ? windowStructure
        : 'NONE';
  const dist = structureDistances(closes, swings, atr);
  const fb = detectFalseBreakout(closes, highs, lows, swings, 5);
  const extensionAtr = Math.abs(price - ema20) / atr;

  let bias: StructureBias = 'NONE';
  const diBull = adxDi.plusDi - adxDi.minusDi >= cfg.minDiSeparation;
  const diBear = adxDi.minusDi - adxDi.plusDi >= cfg.minDiSeparation;
  if (structure === 'BULLISH' && (emaStackBull || diBull)) bias = 'BULLISH';
  else if (structure === 'BEARISH' && (emaStackBear || diBear)) bias = 'BEARISH';
  else if (emaStackBull && diBull && ema20Slope > 0.05) bias = 'BULLISH';
  else if (emaStackBear && diBear && ema20Slope < -0.05) bias = 'BEARISH';

  return {
    bias,
    adx: adxDi.adx,
    plusDi: adxDi.plusDi,
    minusDi: adxDi.minusDi,
    adxSlope: adxDi.adxSlope,
    er,
    emaStackBull,
    emaStackBear,
    ema20Slope,
    rsi,
    roc,
    macdHist: macd.histogram,
    relativeVolume,
    atr,
    atrPercent: (atr / price) * 100,
    toResAtr: dist.toResistanceAtr,
    toSupAtr: dist.toSupportAtr,
    falseBull: fb.falseBull,
    falseBear: fb.falseBear,
    structure,
    price,
    ema20,
    ema50,
    extensionAtr,
  };
}

function averageSafe(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface MarketContextInput {
  /** BTC primary TF bias: BULLISH | BEARISH | NONE */
  btcBias: StructureBias;
  /** Symbol vs BTC relative return over lookback (fraction, e.g. 0.05 = +5%). */
  relativeStrength?: number;
}

/**
 * Evaluate multi-TF candle map for one symbol.
 * Keys: 5m, 15m, 1h, 4h (closed candles only used inside).
 */
export function evaluateTrendConfirmation(
  symbol: string,
  candlesByTf: Partial<Record<TfKey, Candle[]>>,
  cfg: TrendEngineConfig = DEFAULT_TREND_ENGINE_CONFIG,
  market?: MarketContextInput,
): TrendConfirmation {
  const tfs: TfKey[] = ['4h', '1h', '15m', '5m'];
  const snaps: Partial<Record<TfKey, TfSnapshot>> = {};
  for (const tf of tfs) {
    const raw = candlesByTf[tf];
    if (!raw || raw.length === 0) {
      return noTradeResult(symbol, 'INSUFFICIENT_DATA', [`Missing ${tf} candles`], cfg);
    }
    const snap = analyzeTf(raw, cfg);
    if (!snap) {
      return noTradeResult(symbol, 'INSUFFICIENT_DATA', [`Insufficient closed ${tf} data`], cfg);
    }
    snaps[tf] = snap;
  }

  const primary = snaps['1h']!;
  const h4 = snaps['4h']!;
  const m15 = snaps['15m']!;
  const m5 = snaps['5m']!;

  // --- Hard: 4H vs 1H conflict ---
  if (cfg.require4h1hAgree && h4.bias !== 'NONE' && primary.bias !== 'NONE' && h4.bias !== primary.bias) {
    return noTradeResult(symbol, 'UNCERTAIN', ['1H and 4H trends disagree'], cfg, {
      metrics: {
        ...noTradeResult(symbol, 'UNCERTAIN', [], cfg).metrics,
        adx: primary.adx,
        efficiencyRatio: primary.er,
        distanceToResistanceATR: primary.toResAtr,
        distanceToSupportATR: primary.toSupAtr,
      },
    });
  }

  // Weighted MTF bias
  let weighted = 0;
  let agreeBull = 0;
  let agreeBear = 0;
  for (const tf of tfs) {
    const s = snaps[tf]!;
    const w = cfg.weights[tf];
    if (s.bias === 'BULLISH') {
      weighted += w;
      agreeBull += 1;
    } else if (s.bias === 'BEARISH') {
      weighted -= w;
      agreeBear += 1;
    }
  }
  const mtfAligned = Math.max(agreeBull, agreeBear);
  const proposed: TrendDirection =
    weighted >= 0.55 ? 'BULLISH' : weighted <= -0.55 ? 'BEARISH' : 'NONE';

  if (proposed === 'NONE' || mtfAligned < cfg.minMtfAgree) {
    return noTradeResult(
      symbol,
      mtfAligned === 0 ? 'RANGE' : 'UNCERTAIN',
      [
        `MTF agreement ${mtfAligned}/4 below minimum ${cfg.minMtfAgree}`,
        `Weighted bias ${weighted.toFixed(2)} insufficient for strong direction`,
      ],
      cfg,
      {
        metrics: {
          ...noTradeResult(symbol, 'UNCERTAIN', [], cfg).metrics,
          adx: primary.adx,
          efficiencyRatio: primary.er,
          mtfAligned,
          weightedBias: weighted,
          distanceToResistanceATR: primary.toResAtr,
          distanceToSupportATR: primary.toSupAtr,
        },
      },
    );
  }

  // Stage 1 — regime on primary (1h) + confirmation from 4h
  const regimeAdx = Math.min(primary.adx, h4.adx);
  const regimeEr = Math.min(primary.er, m15.er);
  let regime: MarketRegime = 'UNCERTAIN';
  if (regimeAdx < 18 || regimeEr < 0.2) {
    regime = regimeEr < 0.2 ? 'CHOP' : 'RANGE';
  } else if (regimeAdx < cfg.minAdx || regimeEr < cfg.minEfficiency) {
    regime = 'WEAK_TREND';
  } else if (
    (proposed === 'BULLISH' && (primary.falseBull || m15.falseBull)) ||
    (proposed === 'BEARISH' && (primary.falseBear || m15.falseBear))
  ) {
    regime = 'BREAKOUT'; // failed / questionable
  } else {
    regime = 'STRONG_TREND';
  }

  if (regime !== 'STRONG_TREND') {
    return noTradeResult(symbol, regime, [
      `Regime=${regime} (ADX≈${regimeAdx.toFixed(1)}, ER≈${regimeEr.toFixed(2)}) — only STRONG_TREND can trade`,
    ], cfg, {
      metrics: {
        ...noTradeResult(symbol, regime, [], cfg).metrics,
        adx: primary.adx,
        plusDi: primary.plusDi,
        minusDi: primary.minusDi,
        efficiencyRatio: primary.er,
        atrPercent: primary.atrPercent,
        relativeVolume: primary.relativeVolume,
        mtfAligned,
        weightedBias: weighted,
        distanceToResistanceATR: primary.toResAtr,
        distanceToSupportATR: primary.toSupAtr,
      },
    });
  }

  // Direction-specific hard rejects
  const reasons: string[] = [];
  if (primary.adx < cfg.minAdx) reasons.push(`ADX ${primary.adx.toFixed(1)} below ${cfg.minAdx}`);
  if (primary.er < cfg.minEfficiency) reasons.push(`Efficiency ${primary.er.toFixed(2)} below ${cfg.minEfficiency}`);
  const diSep = Math.abs(primary.plusDi - primary.minusDi);
  if (diSep < cfg.minDiSeparation) reasons.push(`DI separation ${diSep.toFixed(1)} too small`);
  if (proposed === 'BULLISH' && primary.plusDi <= primary.minusDi) reasons.push('+DI not dominant');
  if (proposed === 'BEARISH' && primary.minusDi <= primary.plusDi) reasons.push('-DI not dominant');
  if (proposed === 'BULLISH' && primary.toResAtr < cfg.minTrendRoomAtr) {
    reasons.push(`Trend room to resistance ${primary.toResAtr.toFixed(2)} ATR < ${cfg.minTrendRoomAtr}`);
  }
  if (proposed === 'BEARISH' && primary.toSupAtr < cfg.minTrendRoomAtr) {
    reasons.push(`Trend room to support ${primary.toSupAtr.toFixed(2)} ATR < ${cfg.minTrendRoomAtr}`);
  }
  if (proposed === 'BULLISH' && (primary.falseBull || m15.falseBull)) {
    reasons.push('Recent false bullish breakout');
  }
  if (proposed === 'BEARISH' && (primary.falseBear || m15.falseBear)) {
    reasons.push('Recent false bearish breakout');
  }

  // Categories
  const marketStructure: CategorySignal = (() => {
    const ok =
      (proposed === 'BULLISH' && primary.structure === 'BULLISH' && h4.structure !== 'BEARISH') ||
      (proposed === 'BEARISH' && primary.structure === 'BEARISH' && h4.structure !== 'BULLISH');
    // EMA stack + DI already imply directional structure when fractal/window soft-miss
    const softOk =
      !ok &&
      ((proposed === 'BULLISH' && primary.emaStackBull && primary.plusDi > primary.minusDi) ||
        (proposed === 'BEARISH' && primary.emaStackBear && primary.minusDi > primary.plusDi));
    return {
      confirmed: ok || softOk,
      score: ok ? 90 : softOk ? 70 : primary.structure === proposed ? 55 : 20,
      detail: `1H structure=${primary.structure}, 4H=${h4.structure}${softOk ? ' (EMA+DI soft)' : ''}`,
    };
  })();

  const emaStructure: CategorySignal = (() => {
    const ok =
      (proposed === 'BULLISH' && primary.emaStackBull && primary.ema20Slope > 0.08) ||
      (proposed === 'BEARISH' && primary.emaStackBear && primary.ema20Slope < -0.08);
    return {
      confirmed: ok,
      score: ok ? 88 : 30,
      detail: `stack=${primary.emaStackBull ? 'bull' : primary.emaStackBear ? 'bear' : 'mixed'} slope=${primary.ema20Slope.toFixed(2)}`,
    };
  })();

  const trendStrength: CategorySignal = (() => {
    const rising = primary.adxSlope > 0;
    // Rising ADX preferred; already-strong ADX (≥30) still confirms even if slope flat.
    const strongEnough = primary.adx >= Math.max(cfg.minAdx, 30);
    const ok =
      primary.adx >= cfg.minAdx
      && diSep >= cfg.minDiSeparation
      && (rising || strongEnough);
    let score = Math.min(100, (primary.adx / 40) * 70 + (rising ? 20 : strongEnough ? 10 : 0) + Math.min(10, diSep));
    if (!rising && !strongEnough) score *= 0.7;
    return {
      confirmed: ok,
      score,
      detail: `ADX=${primary.adx.toFixed(1)} slope=${primary.adxSlope.toFixed(1)} DIΔ=${diSep.toFixed(1)}`,
    };
  })();

  const momentum: CategorySignal = (() => {
    // Single momentum category: RSI + ROC + MACD (not 3 independent votes)
    let votes = 0;
    if (proposed === 'BULLISH') {
      if (primary.rsi >= cfg.rsiBullMin) votes++;
      if (primary.roc > 0) votes++;
      if (primary.macdHist > 0) votes++;
    } else {
      if (primary.rsi <= cfg.rsiBearMax) votes++;
      if (primary.roc < 0) votes++;
      if (primary.macdHist < 0) votes++;
    }
    const exhausted =
      (proposed === 'BULLISH' && primary.rsi >= cfg.rsiExhaustionHigh) ||
      (proposed === 'BEARISH' && primary.rsi <= cfg.rsiExhaustionLow);
    // Exhaustion reduces score but does not alone nullify if 3/3 momentum votes + structure OK
    const ok = votes >= 2 && !(exhausted && votes < 3);
    return {
      confirmed: ok && !exhausted,
      score: exhausted ? Math.max(20, votes * 15) : votes * 30,
      detail: `votes=${votes}/3 RSI=${primary.rsi.toFixed(0)} ROC=${primary.roc.toFixed(2)} MACDh=${primary.macdHist.toFixed(4)}${exhausted ? ' EXHAUSTION' : ''}`,
    };
  })();

  const volume: CategorySignal = (() => {
    const ok = primary.relativeVolume >= cfg.minRelativeVolume && m15.relativeVolume >= 0.9;
    return {
      confirmed: ok,
      score: Math.min(100, primary.relativeVolume * 45),
      detail: `relVol 1H=${primary.relativeVolume.toFixed(2)}x 15m=${m15.relativeVolume.toFixed(2)}x`,
    };
  })();

  const efficiencyCat: CategorySignal = (() => {
    const ok = primary.er >= cfg.minEfficiency && m15.er >= cfg.minEfficiency * 0.85;
    return {
      confirmed: ok,
      score: Math.min(100, primary.er * 120),
      detail: `ER 1H=${primary.er.toFixed(2)} 15m=${m15.er.toFixed(2)}`,
    };
  })();

  const volatility: CategorySignal = (() => {
    // Need enough ATR% to move, not extreme chaos without direction
    const ok = primary.atrPercent >= 0.15 && primary.atrPercent < 8 && primary.er >= cfg.minEfficiency;
    return {
      confirmed: ok,
      score: ok ? 75 : 35,
      detail: `ATR%=${primary.atrPercent.toFixed(2)}`,
    };
  })();

  const multiTimeframe: CategorySignal = {
    confirmed: mtfAligned >= cfg.minMtfAgree && Math.abs(weighted) >= 0.55,
    score: Math.min(100, mtfAligned * 22 + Math.abs(weighted) * 40),
    detail: `aligned=${mtfAligned}/4 weighted=${weighted.toFixed(2)}`,
  };

  const breakout: CategorySignal = (() => {
    const falseOk =
      (proposed === 'BULLISH' && !primary.falseBull && !m15.falseBull) ||
      (proposed === 'BEARISH' && !primary.falseBear && !m15.falseBear);
    return {
      confirmed: falseOk,
      score: falseOk ? 80 : 15,
      detail: falseOk ? 'No recent false breakout' : 'False breakout detected',
    };
  })();

  const trendPersistence: CategorySignal = (() => {
    // 5m should not fight; prefer same or NONE
    const ok = m5.bias === proposed || m5.bias === 'NONE';
    const slopeOk =
      (proposed === 'BULLISH' && primary.ema20Slope > 0) ||
      (proposed === 'BEARISH' && primary.ema20Slope < 0);
    return {
      confirmed: ok && slopeOk,
      score: ok && slopeOk ? 82 : 40,
      detail: `5m=${m5.bias} slopeOk=${slopeOk}`,
    };
  })();

  const marketContext: CategorySignal = (() => {
    if (!market) {
      return { confirmed: true, score: 60, detail: 'No BTC context supplied' };
    }
    let score = 60;
    if (market.btcBias === proposed) score += 25;
    else if (market.btcBias !== 'NONE' && market.btcBias !== proposed) score -= 20;
    if (market.relativeStrength != null) {
      if (proposed === 'BULLISH' && market.relativeStrength > 0) score += 15;
      if (proposed === 'BEARISH' && market.relativeStrength < 0) score += 15;
      if (proposed === 'BULLISH' && market.relativeStrength < -0.02) score -= 15;
      if (proposed === 'BEARISH' && market.relativeStrength > 0.02) score -= 15;
    }
    score = Math.max(0, Math.min(100, score));
    // Context is soft — confirmed unless strongly opposed
    const confirmed = !(market.btcBias !== 'NONE' && market.btcBias !== proposed && score < 45);
    return {
      confirmed,
      score,
      detail: `BTC=${market.btcBias} RS=${market.relativeStrength?.toFixed(3) ?? 'n/a'}`,
    };
  })();

  // Reversal / exhaustion risk
  let reversalRisk = 0;
  if (primary.adxSlope < -2) reversalRisk += 20;
  else if (primary.adxSlope < 0) reversalRisk += 8;
  if (
    (proposed === 'BULLISH' && primary.rsi >= cfg.rsiExhaustionHigh) ||
    (proposed === 'BEARISH' && primary.rsi <= cfg.rsiExhaustionLow)
  ) {
    reversalRisk += 25;
  }
  // Extension only hurts when efficiency is also decaying (late/choppy extension)
  if (primary.extensionAtr > 3.5 && primary.er < 0.5) reversalRisk += 20;
  else if (primary.extensionAtr > 4) reversalRisk += 10;
  if (
    (proposed === 'BULLISH' && primary.macdHist < 0) ||
    (proposed === 'BEARISH' && primary.macdHist > 0)
  ) {
    reversalRisk += 15;
  }
  if (
    (proposed === 'BULLISH' && primary.falseBull) ||
    (proposed === 'BEARISH' && primary.falseBear)
  ) {
    reversalRisk += 30;
  }
  if (proposed === 'BULLISH' && primary.roc < m15.roc * 0.3 && primary.roc > 0) {
    reversalRisk += 10;
  }
  if (proposed === 'BEARISH' && primary.roc > m15.roc * 0.3 && primary.roc < 0) {
    reversalRisk += 10;
  }
  reversalRisk = Math.min(100, reversalRisk);

  const exhaustionRisk = Math.min(
    100,
    (primary.extensionAtr / 4) * 50 +
      (proposed === 'BULLISH' && primary.rsi > 70 ? primary.rsi - 70 : 0) +
      (proposed === 'BEARISH' && primary.rsi < 30 ? 30 - primary.rsi : 0),
  );
  const supportResistanceRisk =
    proposed === 'BULLISH'
      ? Math.min(100, (cfg.minTrendRoomAtr / Math.max(primary.toResAtr, 0.01)) * 40)
      : Math.min(100, (cfg.minTrendRoomAtr / Math.max(primary.toSupAtr, 0.01)) * 40);
  const extensionRisk = Math.min(100, (primary.extensionAtr / 4) * 100);

  if (reversalRisk >= cfg.maxReversalRisk) {
    reasons.push(`Reversal risk ${reversalRisk}/100 ≥ ${cfg.maxReversalRisk}`);
    regime = 'REVERSAL_RISK';
  }

  const categories = [
    marketStructure,
    multiTimeframe,
    emaStructure,
    trendStrength,
    momentum,
    volume,
    volatility,
    efficiencyCat,
    breakout,
    trendPersistence,
    marketContext,
  ];
  const confirmedCount = categories.filter((c) => c.confirmed).length;
  if (confirmedCount < cfg.minCategoryConfirmed) {
    reasons.push(`Only ${confirmedCount}/${categories.length} categories confirmed (need ${cfg.minCategoryConfirmed})`);
  }

  // Critical categories must confirm
  const criticalFail: string[] = [];
  if (!marketStructure.confirmed) criticalFail.push('marketStructure');
  if (!multiTimeframe.confirmed) criticalFail.push('multiTimeframe');
  if (!trendStrength.confirmed) criticalFail.push('trendStrength');
  if (!efficiencyCat.confirmed) criticalFail.push('efficiency');
  if (!breakout.confirmed) criticalFail.push('breakout');
  if (criticalFail.length) {
    reasons.push(`Critical categories failed: ${criticalFail.join(', ')}`);
  }

  // Confidence: weighted category scores (reversal reduces)
  const weights = [1.2, 1.3, 1.0, 1.2, 1.0, 0.8, 0.7, 1.1, 0.9, 0.8, 0.6];
  let sumW = 0;
  let sumS = 0;
  categories.forEach((c, i) => {
    const w = weights[i]!;
    sumW += w;
    sumS += c.score * w;
  });
  let confidence = sumS / sumW;
  confidence *= 1 - reversalRisk / 200;
  if (market?.relativeStrength != null) {
    const rsBoost =
      proposed === 'BULLISH'
        ? Math.max(-5, Math.min(8, market.relativeStrength * 100))
        : Math.max(-5, Math.min(8, -market.relativeStrength * 100));
    confidence += rsBoost;
  }
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  if (confidence < cfg.minConfidence) {
    reasons.push(`Confidence ${confidence} < minimum ${cfg.minConfidence}`);
  }

  if (regime === 'REVERSAL_RISK' || reasons.length > 0) {
    return noTradeResult(
      symbol,
      regime === 'STRONG_TREND' ? 'UNCERTAIN' : regime,
      reasons,
      cfg,
      {
        direction: proposed,
        confidenceScore: confidence,
        signals: {
          marketStructure,
          multiTimeframe,
          emaStructure,
          trendStrength,
          momentum,
          volume,
          volatility,
          efficiency: efficiencyCat,
          breakout,
          trendPersistence,
          marketContext,
        },
        risk: {
          reversalRisk,
          exhaustionRisk,
          supportResistanceRisk,
          extensionRisk,
        },
        metrics: {
          adx: primary.adx,
          plusDi: primary.plusDi,
          minusDi: primary.minusDi,
          atrPercent: primary.atrPercent,
          efficiencyRatio: primary.er,
          relativeVolume: primary.relativeVolume,
          momentum: primary.roc,
          trendAge: primary.extensionAtr > 3 ? 'EXHAUSTED' : primary.extensionAtr > 1.5 ? 'MATURE' : 'DEVELOPING',
          distanceToResistanceATR: primary.toResAtr,
          distanceToSupportATR: primary.toSupAtr,
          mtfAligned,
          mtfTotal: 4,
          weightedBias: weighted,
        },
        strength: 'NONE',
        score: confidence,
        maxScore: 100,
        confidence: confidence / 100,
        reasons,
        signalsFlat: categories.map((c) => c.detail),
      },
    );
  }

  // TRADE
  const now = Date.now();
  return {
    symbol,
    timestamp: now,
    decision: 'TRADE',
    direction: proposed,
    regime: 'STRONG_TREND',
    confidenceScore: confidence,
    minimumRequiredScore: cfg.minConfidence,
    signals: {
      marketStructure,
      multiTimeframe,
      emaStructure,
      trendStrength,
      momentum,
      volume,
      volatility,
      efficiency: efficiencyCat,
      breakout,
      trendPersistence,
      marketContext,
    },
    risk: {
      reversalRisk,
      exhaustionRisk,
      supportResistanceRisk,
      extensionRisk,
    },
    metrics: {
      adx: primary.adx,
      plusDi: primary.plusDi,
      minusDi: primary.minusDi,
      atrPercent: primary.atrPercent,
      efficiencyRatio: primary.er,
      relativeVolume: primary.relativeVolume,
      momentum: primary.roc,
      trendAge: primary.extensionAtr > 3 ? 'EXHAUSTED' : primary.extensionAtr > 1.5 ? 'MATURE' : 'DEVELOPING',
      distanceToResistanceATR: primary.toResAtr,
      distanceToSupportATR: primary.toSupAtr,
      mtfAligned,
      mtfTotal: 4,
      weightedBias: weighted,
    },
    rejectionReasons: [],
    evaluatedAt: now,
    confirmed: true,
    strength: 'STRONG',
    score: confidence,
    maxScore: 100,
    confidence: confidence / 100,
    reasons: [
      `STRONG_${proposed} confidence ${confidence}/100`,
      multiTimeframe.detail,
      marketStructure.detail,
      trendStrength.detail,
    ],
    signalsFlat: categories.filter((c) => c.confirmed).map((c) => c.detail),
  };
}

/** Map engine result to legacy TrendResult shape fields used by Manager. */
export function toLegacyCompatible(c: TrendConfirmation): {
  direction: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  confirmed: boolean;
  strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';
  score: number;
  maxScore: number;
  confidence: number;
  reasons: string[];
  signals: string[];
  adx: number;
  plusDi: number;
  minusDi: number;
  atrPercent: number;
  volumeRatio: number;
  decision: TrendDecision;
  regime: MarketRegime;
  confidenceScore: number;
  rejectionReasons: string[];
} {
  return {
    direction: c.direction === 'NONE' ? 'SIDEWAYS' : c.direction,
    confirmed: c.decision === 'TRADE' && c.confirmed,
    strength: c.strength,
    score: c.score,
    maxScore: c.maxScore,
    confidence: c.confidence,
    reasons: c.rejectionReasons.length ? c.rejectionReasons : c.reasons,
    signals: c.signalsFlat,
    adx: c.metrics.adx,
    plusDi: c.metrics.plusDi,
    minusDi: c.metrics.minusDi,
    atrPercent: c.metrics.atrPercent,
    volumeRatio: c.metrics.relativeVolume,
    decision: c.decision,
    regime: c.regime,
    confidenceScore: c.confidenceScore,
    rejectionReasons: c.rejectionReasons,
  };
}
