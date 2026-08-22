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
  | 'DEVELOPING_STRONG_TREND'
  | 'WEAK_TREND'
  | 'RANGE'
  | 'CHOP'
  | 'BREAKOUT'
  | 'REVERSAL_RISK'
  | 'UNCERTAIN'
  | 'INSUFFICIENT_DATA';

/** Regimes eligible for trader creation when confidence passes. */
export function isTradeableRegime(regime: MarketRegime): boolean {
  return regime === 'STRONG_TREND' || regime === 'DEVELOPING_STRONG_TREND';
}

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
  /** ADX at/above this → STRONG_TREND (vs developing). */
  strongAdx: number;
  minEfficiency: number;
  /** Soft room target — below this applies penalty, not always hard reject. */
  minTrendRoomAtr: number;
  /** Hard reject when opposing S/R closer than this (ATR). */
  hardBlockRoomAtr: number;
  maxReversalRisk: number;
  minDiSeparation: number;
  /**
   * Min agreeing TFs among 4h/1h/15m (5m excluded from this count).
   * Default 2 = 4h+1h aligned is enough; 15m preferred.
   */
  minMtfAgree: number;
  /** Min CORE categories confirmed (structure, MTF, strength, momentum). Allow 3/4. */
  minCoreConfirmed: number;
  adxPeriod: number;
  erPeriod: number;
  volumeAvgPeriod: number;
  /** Relative volume that boosts confidence (supporting, not hard gate). */
  minRelativeVolume: number;
  /** Below this relative volume → significant confidence penalty. */
  weakVolumeRatio: number;
  rsiBullMin: number;
  rsiBearMax: number;
  rsiExhaustionHigh: number;
  rsiExhaustionLow: number;
  weights: Record<TfKey, number>;
  require4h1hAgree: boolean;
  allowDevelopingStrong: boolean;
  allowStrongTrend: boolean;
}

export const DEFAULT_TREND_ENGINE_CONFIG: TrendEngineConfig = {
  minConfidence: 78,
  minAdx: 24,
  strongAdx: 30,
  minEfficiency: 0.48,
  minTrendRoomAtr: 1.0,
  hardBlockRoomAtr: 0.5,
  maxReversalRisk: 75,
  minDiSeparation: 3,
  minMtfAgree: 2,
  minCoreConfirmed: 3,
  adxPeriod: 14,
  erPeriod: 20,
  volumeAvgPeriod: 20,
  minRelativeVolume: 1.1,
  weakVolumeRatio: 0.5,
  rsiBullMin: 52,
  rsiBearMax: 48,
  rsiExhaustionHigh: 75,
  rsiExhaustionLow: 25,
  weights: { '4h': 0.35, '1h': 0.3, '15m': 0.25, '5m': 0.1 },
  require4h1hAgree: true,
  allowDevelopingStrong: true,
  allowStrongTrend: true,
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
  // Sustained participation: mean of last 3 relative volumes (avoids single pullback bar veto)
  const recentRelVol =
    avgVol > 0
      ? volumes.slice(-3).reduce((a, v) => a + v / avgVol, 0) / Math.min(3, volumes.length)
      : 0;
  const participationVolume = Math.max(relativeVolume, recentRelVol);

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
    relativeVolume: participationVolume,
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

  // Weighted MTF bias — 5m is supporting only (cannot set/veto primary direction alone)
  let weighted = 0;
  let htfAgreeBull = 0;
  let htfAgreeBear = 0;
  const htfKeys: TfKey[] = ['4h', '1h', '15m'];
  for (const tf of htfKeys) {
    const s = snaps[tf]!;
    const w = cfg.weights[tf];
    if (s.bias === 'BULLISH') {
      weighted += w;
      htfAgreeBull += 1;
    } else if (s.bias === 'BEARISH') {
      weighted -= w;
      htfAgreeBear += 1;
    }
  }
  // 5m contributes lightly to score only
  if (m5.bias === 'BULLISH') weighted += cfg.weights['5m'] * 0.5;
  else if (m5.bias === 'BEARISH') weighted -= cfg.weights['5m'] * 0.5;

  const mtfAligned = Math.max(htfAgreeBull, htfAgreeBear);

  // 4H+1H: same direction, or one NONE with the other directional (developing OK)
  const h4h1AlignedDirection: TrendDirection =
    h4.bias !== 'NONE' && primary.bias !== 'NONE' && h4.bias === primary.bias
      ? (h4.bias as TrendDirection)
      : h4.bias === 'NONE' && (primary.bias === 'BULLISH' || primary.bias === 'BEARISH')
        ? primary.bias
        : primary.bias === 'NONE' && (h4.bias === 'BULLISH' || h4.bias === 'BEARISH')
          ? h4.bias
          : 'NONE';
  const h4h1Agree = h4h1AlignedDirection !== 'NONE';

  let proposed: TrendDirection = 'NONE';
  if (h4h1Agree) {
    proposed = h4h1AlignedDirection;
  } else if (weighted >= 0.55) {
    proposed = 'BULLISH';
  } else if (weighted <= -0.55) {
    proposed = 'BEARISH';
  }

  // Prefer 15m agreement; count HTF trio. Do not require 5m.
  const needHtf = cfg.minMtfAgree;
  if (proposed === 'NONE' || mtfAligned < needHtf || !h4h1Agree) {
    const reasonsEarly: string[] = [];
    if (!h4h1Agree) reasonsEarly.push('4H/1H not aligned (required for TRADE)');
    if (proposed === 'NONE') reasonsEarly.push(`Weighted bias ${weighted.toFixed(2)} insufficient`);
    if (mtfAligned < needHtf) {
      reasonsEarly.push(`HTF agreement ${mtfAligned}/3 (4h/1h/15m) below minimum ${needHtf}`);
    }
    return noTradeResult(
      symbol,
      mtfAligned === 0 ? 'RANGE' : 'UNCERTAIN',
      reasonsEarly,
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

  // Stage 1 — regime (allow DEVELOPING_STRONG when ADX rising in mid band)
  const regimeAdx = Math.min(primary.adx, h4.adx > 0 ? h4.adx : primary.adx);
  const regimeEr = Math.min(primary.er, m15.er);
  const adxRising = primary.adxSlope > 0;
  let regime: MarketRegime = 'UNCERTAIN';

  if (
    (proposed === 'BULLISH' && (primary.falseBull || m15.falseBull)) ||
    (proposed === 'BEARISH' && (primary.falseBear || m15.falseBear))
  ) {
    regime = 'BREAKOUT';
  } else if (regimeAdx < 16 || regimeEr < 0.25) {
    regime = regimeEr < 0.25 ? 'CHOP' : 'RANGE';
  } else if (regimeAdx < cfg.minAdx || regimeEr < cfg.minEfficiency * 0.75) {
    regime = 'WEAK_TREND';
  } else if (primary.adx >= cfg.strongAdx && regimeEr >= cfg.minEfficiency) {
    regime = 'STRONG_TREND';
  } else if (
    primary.adx >= cfg.minAdx
    && (adxRising || primary.adx >= cfg.strongAdx - 2)
    && regimeEr >= cfg.minEfficiency * 0.9
  ) {
    regime = 'DEVELOPING_STRONG_TREND';
  } else if (primary.adx >= cfg.minAdx && regimeEr >= cfg.minEfficiency) {
    regime = 'DEVELOPING_STRONG_TREND';
  } else {
    regime = 'WEAK_TREND';
  }

  const regimeAllowed =
    (regime === 'STRONG_TREND' && cfg.allowStrongTrend)
    || (regime === 'DEVELOPING_STRONG_TREND' && cfg.allowDevelopingStrong);

  if (!regimeAllowed) {
    return noTradeResult(symbol, regime, [
      `Regime=${regime} (ADX≈${regimeAdx.toFixed(1)}, ER≈${regimeEr.toFixed(2)}) — not tradeable`,
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

  // Hard rejects only (supporting signals use penalties later)
  const reasons: string[] = [];
  const diSep = Math.abs(primary.plusDi - primary.minusDi);
  if (proposed === 'BULLISH' && primary.plusDi <= primary.minusDi) {
    reasons.push('+DI not dominant');
  }
  if (proposed === 'BEARISH' && primary.minusDi <= primary.plusDi) {
    reasons.push('-DI not dominant');
  }
  if (proposed === 'BULLISH' && (primary.falseBull || m15.falseBull)) {
    reasons.push('Recent false bullish breakout');
  }
  if (proposed === 'BEARISH' && (primary.falseBear || m15.falseBear)) {
    reasons.push('Recent false bearish breakout');
  }
  // Immediate S/R block only (hard); soft room handled via penalty
  if (proposed === 'BULLISH' && primary.toResAtr < cfg.hardBlockRoomAtr) {
    reasons.push(`Major resistance only ${primary.toResAtr.toFixed(2)} ATR away (< ${cfg.hardBlockRoomAtr})`);
  }
  if (proposed === 'BEARISH' && primary.toSupAtr < cfg.hardBlockRoomAtr) {
    reasons.push(`Major support only ${primary.toSupAtr.toFixed(2)} ATR away (< ${cfg.hardBlockRoomAtr})`);
  }

  // Categories
  const marketStructure: CategorySignal = (() => {
    const ok =
      (proposed === 'BULLISH' && primary.structure === 'BULLISH' && h4.structure !== 'BEARISH') ||
      (proposed === 'BEARISH' && primary.structure === 'BEARISH' && h4.structure !== 'BULLISH');
    const softOk =
      !ok &&
      ((proposed === 'BULLISH' && primary.emaStackBull && primary.plusDi > primary.minusDi) ||
        (proposed === 'BEARISH' && primary.emaStackBear && primary.minusDi > primary.plusDi));
    return {
      confirmed: ok || softOk,
      score: ok ? 92 : softOk ? 72 : primary.structure === proposed ? 50 : 18,
      detail: `1H structure=${primary.structure}, 4H=${h4.structure}${softOk ? ' (EMA+DI soft)' : ''}`,
    };
  })();

  const emaStructure: CategorySignal = (() => {
    const ok =
      (proposed === 'BULLISH' && primary.emaStackBull && primary.ema20Slope > 0.05) ||
      (proposed === 'BEARISH' && primary.emaStackBear && primary.ema20Slope < -0.05);
    const partial =
      (proposed === 'BULLISH' && primary.ema20 > primary.ema50 && primary.ema20Slope > 0) ||
      (proposed === 'BEARISH' && primary.ema20 < primary.ema50 && primary.ema20Slope < 0);
    return {
      confirmed: ok || partial,
      score: ok ? 88 : partial ? 65 : 28,
      detail: `stack=${primary.emaStackBull ? 'bull' : primary.emaStackBear ? 'bear' : 'mixed'} slope=${primary.ema20Slope.toFixed(2)}`,
    };
  })();

  const trendStrength: CategorySignal = (() => {
    const rising = primary.adxSlope > 0;
    const strongEnough = primary.adx >= cfg.strongAdx;
    const developingOk = primary.adx >= cfg.minAdx && (rising || primary.adx >= cfg.strongAdx - 3);
    const diOk = diSep >= cfg.minDiSeparation || (diSep >= 1 && primary.adx >= cfg.strongAdx);
    const ok = developingOk && diOk && (
      (proposed === 'BULLISH' && primary.plusDi > primary.minusDi) ||
      (proposed === 'BEARISH' && primary.minusDi > primary.plusDi)
    );
    let score = Math.min(100, (primary.adx / 40) * 65 + (rising ? 22 : strongEnough ? 12 : 0) + Math.min(12, diSep));
    if (!rising && !strongEnough) score *= 0.85;
    return {
      confirmed: ok,
      score,
      detail: `ADX=${primary.adx.toFixed(1)} slope=${primary.adxSlope.toFixed(1)} DIΔ=${diSep.toFixed(1)}`,
    };
  })();

  const momentum: CategorySignal = (() => {
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
    // Moderate momentum OK: 1–2 votes can confirm if structure/strength strong later
    const ok = votes >= 1;
    return {
      confirmed: ok,
      score: exhausted ? Math.max(35, votes * 22) : Math.min(100, votes * 32 + 10),
      detail: `votes=${votes}/3 RSI=${primary.rsi.toFixed(0)} ROC=${primary.roc.toFixed(2)} MACDh=${primary.macdHist.toFixed(4)}${exhausted ? ' EXHAUSTION_PENALTY' : ''}`,
    };
  })();

  const volume: CategorySignal = (() => {
    const rv = primary.relativeVolume;
    const boost = rv >= cfg.minRelativeVolume;
    const weak = rv < cfg.weakVolumeRatio;
    return {
      confirmed: !weak,
      score: weak ? 15 : boost ? Math.min(100, rv * 50) : Math.min(70, 40 + rv * 25),
      detail: `relVol 1H=${rv.toFixed(2)}x 15m=${m15.relativeVolume.toFixed(2)}x${weak ? ' WEAK' : boost ? ' BOOST' : ' NEUTRAL'}`,
    };
  })();

  const efficiencyCat: CategorySignal = (() => {
    const ok = primary.er >= cfg.minEfficiency;
    const moderate = primary.er >= cfg.minEfficiency * 0.75;
    return {
      confirmed: ok || moderate,
      score: Math.min(100, primary.er * 130),
      detail: `ER 1H=${primary.er.toFixed(2)} 15m=${m15.er.toFixed(2)}`,
    };
  })();

  const volatility: CategorySignal = (() => {
    const ok = primary.atrPercent >= 0.12 && primary.atrPercent < 10;
    return {
      confirmed: ok,
      score: ok ? 75 : 35,
      detail: `ATR%=${primary.atrPercent.toFixed(2)}`,
    };
  })();

  const multiTimeframe: CategorySignal = {
    confirmed: h4h1Agree && mtfAligned >= cfg.minMtfAgree,
    score: Math.min(
      100,
      (h4h1Agree ? 40 : 0)
        + mtfAligned * 18
        + (m15.bias === proposed ? 15 : 0)
        + (m5.bias === proposed ? 8 : m5.bias === 'NONE' ? 5 : 0)
        + Math.abs(weighted) * 25,
    ),
    detail: `4H/1H aligned · HTF ${mtfAligned}/3 · 5m=${m5.bias} · w=${weighted.toFixed(2)}`,
  };

  const breakout: CategorySignal = (() => {
    const falseOk =
      (proposed === 'BULLISH' && !primary.falseBull && !m15.falseBull) ||
      (proposed === 'BEARISH' && !primary.falseBear && !m15.falseBear);
    return {
      confirmed: falseOk,
      score: falseOk ? 80 : 12,
      detail: falseOk ? 'No recent false breakout' : 'False breakout detected',
    };
  })();

  const trendPersistence: CategorySignal = (() => {
    // 5m opposing does NOT fail the category — only soft score hit
    const slopeOk =
      (proposed === 'BULLISH' && primary.ema20Slope > 0) ||
      (proposed === 'BEARISH' && primary.ema20Slope < 0);
    let score = slopeOk ? 70 : 45;
    if (m5.bias === proposed) score += 20;
    else if (m5.bias === 'NONE') score += 10;
    else score -= 12; // temporary countertrend on 5m
    return {
      confirmed: slopeOk,
      score: Math.max(20, Math.min(100, score)),
      detail: `5m=${m5.bias} (non-veto) slopeOk=${slopeOk}`,
    };
  })();

  const marketContext: CategorySignal = (() => {
    if (!market) {
      return { confirmed: true, score: 60, detail: 'No BTC context supplied' };
    }
    let score = 60;
    if (market.btcBias === proposed) score += 25;
    else if (market.btcBias !== 'NONE' && market.btcBias !== proposed) score -= 15;
    if (market.relativeStrength != null) {
      if (proposed === 'BULLISH' && market.relativeStrength > 0) score += 15;
      if (proposed === 'BEARISH' && market.relativeStrength < 0) score += 15;
      if (proposed === 'BULLISH' && market.relativeStrength < -0.02) score -= 12;
      if (proposed === 'BEARISH' && market.relativeStrength > 0.02) score -= 12;
    }
    score = Math.max(0, Math.min(100, score));
    return {
      confirmed: true, // supporting — never hard-fail alone
      score,
      detail: `BTC=${market.btcBias} RS=${market.relativeStrength?.toFixed(3) ?? 'n/a'}`,
    };
  })();

  // Reversal / exhaustion risk (proportional)
  let reversalRisk = 0;
  if (primary.adxSlope < -2) reversalRisk += 18;
  else if (primary.adxSlope < 0) reversalRisk += 6;
  if (
    (proposed === 'BULLISH' && primary.rsi >= cfg.rsiExhaustionHigh) ||
    (proposed === 'BEARISH' && primary.rsi <= cfg.rsiExhaustionLow)
  ) {
    reversalRisk += 18; // penalty, not auto-reject
  }
  if (primary.extensionAtr > 4) reversalRisk += 22;
  else if (primary.extensionAtr > 3) reversalRisk += 14;
  else if (primary.extensionAtr > 2) reversalRisk += 6;
  if (
    (proposed === 'BULLISH' && primary.macdHist < 0 && primary.adxSlope < 0) ||
    (proposed === 'BEARISH' && primary.macdHist > 0 && primary.adxSlope < 0)
  ) {
    reversalRisk += 18;
  }
  if (
    (proposed === 'BULLISH' && primary.falseBull) ||
    (proposed === 'BEARISH' && primary.falseBear)
  ) {
    reversalRisk += 30;
  }
  if (proposed === 'BULLISH' && primary.roc < m15.roc * 0.3 && primary.roc > 0) {
    reversalRisk += 8;
  }
  if (proposed === 'BEARISH' && primary.roc > m15.roc * 0.3 && primary.roc < 0) {
    reversalRisk += 8;
  }
  reversalRisk = Math.min(100, reversalRisk);

  const exhaustionRisk = Math.min(
    100,
    (primary.extensionAtr / 4) * 50 +
      (proposed === 'BULLISH' && primary.rsi > 75 ? primary.rsi - 75 : 0) +
      (proposed === 'BEARISH' && primary.rsi < 25 ? 25 - primary.rsi : 0),
  );
  const roomAtr = proposed === 'BULLISH' ? primary.toResAtr : primary.toSupAtr;
  const supportResistanceRisk =
    roomAtr < cfg.minTrendRoomAtr
      ? Math.min(100, ((cfg.minTrendRoomAtr - roomAtr) / cfg.minTrendRoomAtr) * 70 + 20)
      : Math.min(40, (cfg.minTrendRoomAtr / Math.max(roomAtr, 0.01)) * 25);
  const extensionRisk = Math.min(100, (primary.extensionAtr / 4) * 100);

  if (reversalRisk >= cfg.maxReversalRisk) {
    reasons.push(`Reversal risk ${reversalRisk}/100 ≥ ${cfg.maxReversalRisk}`);
    regime = 'REVERSAL_RISK';
  }

  // CORE vs SUPPORTING
  const core = [marketStructure, multiTimeframe, trendStrength, momentum];
  const coreConfirmed = core.filter((c) => c.confirmed).length;
  if (coreConfirmed < cfg.minCoreConfirmed) {
    reasons.push(`Only ${coreConfirmed}/4 CORE signals confirmed (need ${cfg.minCoreConfirmed})`);
  }
  // Structure remains important: reject clear structure failure
  if (!marketStructure.confirmed) {
    reasons.push('Market structure failed (CORE)');
  }
  // False breakout stays hard via breakout.confirmed
  if (!breakout.confirmed) {
    reasons.push('False breakout (hard reject)');
  }

  // Confidence model (user weights)
  // Structure 25, MTF 20, Strength 15, Momentum 15, Volume 8, Efficiency 7, Breakout/Persistence 5, Context 5
  const persistenceBreakoutScore = (breakout.score * 0.5 + trendPersistence.score * 0.5);
  let confidence =
    marketStructure.score * 0.25
    + multiTimeframe.score * 0.2
    + trendStrength.score * 0.15
    + momentum.score * 0.15
    + volume.score * 0.08
    + efficiencyCat.score * 0.07
    + persistenceBreakoutScore * 0.05
    + marketContext.score * 0.05;

  // Penalties (proportional)
  confidence -= reversalRisk * 0.15;
  // Extension hurts less when the move is efficient (clean trend, not chop extension)
  const extPenaltyScale = primary.er >= cfg.minEfficiency ? 0.03 : 0.08;
  confidence -= extensionRisk * extPenaltyScale;
  if (roomAtr < cfg.minTrendRoomAtr) confidence -= supportResistanceRisk * 0.2;
  if (primary.relativeVolume < cfg.weakVolumeRatio) confidence -= 8;
  if (market?.relativeStrength != null) {
    const rsBoost =
      proposed === 'BULLISH'
        ? Math.max(-4, Math.min(6, market.relativeStrength * 80))
        : Math.max(-4, Math.min(6, -market.relativeStrength * 80));
    confidence += rsBoost;
  }
  // Mild EMA contribution already in structure soft path; slight boost if full stack
  if (emaStructure.confirmed && emaStructure.score >= 80) confidence += 2;

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  if (confidence < cfg.minConfidence) {
    reasons.push(`Confidence ${confidence} < minimum ${cfg.minConfidence}`);
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

  if (regime === 'REVERSAL_RISK' || reasons.length > 0) {
    return noTradeResult(
      symbol,
      isTradeableRegime(regime) ? 'UNCERTAIN' : regime,
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
        strength: confidence >= 60 ? 'MODERATE' : confidence >= 40 ? 'WEAK' : 'NONE',
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
  const finalRegime: MarketRegime =
    regime === 'DEVELOPING_STRONG_TREND' ? 'DEVELOPING_STRONG_TREND' : 'STRONG_TREND';
  return {
    symbol,
    timestamp: now,
    decision: 'TRADE',
    direction: proposed,
    regime: finalRegime,
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
      `${finalRegime} ${proposed} confidence ${confidence}/100`,
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
