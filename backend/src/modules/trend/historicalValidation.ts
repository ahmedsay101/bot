/**
 * Historical forward-return hooks for confidence calibration.
 * Does not claim predictive certainty — measures whether higher confidence
 * historically showed better directional follow-through on fixtures.
 */
export interface ForwardHorizon {
  label: string;
  ms: number;
}

export const DEFAULT_FORWARD_HORIZONS: ForwardHorizon[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '4h', ms: 4 * 60 * 60_000 },
  { label: '12h', ms: 12 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
];

export interface HistoricalSignalRecord {
  symbol: string;
  detectedAt: number;
  direction: 'BULLISH' | 'BEARISH';
  confidenceScore: number;
  regime: string;
  entryPrice: number;
  forward: Record<string, { price: number; returnPct: number } | null>;
}

export interface CalibrationBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  directionalAccuracy: number;
  avgForwardReturnPct: number;
}

/** Pick close at or after target time from sorted closes {t, price}. */
export function priceAtOrAfter(
  series: Array<{ t: number; price: number }>,
  targetT: number,
): number | null {
  for (const p of series) {
    if (p.t >= targetT) return p.price;
  }
  return null;
}

export function buildHistoricalRecord(
  input: {
    symbol: string;
    detectedAt: number;
    direction: 'BULLISH' | 'BEARISH';
    confidenceScore: number;
    regime: string;
    entryPrice: number;
    futureCloses: Array<{ t: number; price: number }>;
  },
  horizons: ForwardHorizon[] = DEFAULT_FORWARD_HORIZONS,
): HistoricalSignalRecord {
  const forward: HistoricalSignalRecord['forward'] = {};
  for (const h of horizons) {
    const px = priceAtOrAfter(input.futureCloses, input.detectedAt + h.ms);
    if (px == null || input.entryPrice === 0) {
      forward[h.label] = null;
    } else {
      const raw = ((px - input.entryPrice) / input.entryPrice) * 100;
      const signed = input.direction === 'BULLISH' ? raw : -raw;
      forward[h.label] = { price: px, returnPct: signed };
    }
  }
  return {
    symbol: input.symbol,
    detectedAt: input.detectedAt,
    direction: input.direction,
    confidenceScore: input.confidenceScore,
    regime: input.regime,
    entryPrice: input.entryPrice,
    forward,
  };
}

export function calibrateConfidence(
  records: HistoricalSignalRecord[],
  horizonLabel = '1h',
  buckets = [
    { label: '60-69', min: 60, max: 69 },
    { label: '70-79', min: 70, max: 79 },
    { label: '80-89', min: 80, max: 89 },
    { label: '90-94', min: 90, max: 94 },
    { label: '95-100', min: 95, max: 100 },
  ],
): CalibrationBucket[] {
  return buckets.map((b) => {
    const subset = records.filter(
      (r) => r.confidenceScore >= b.min && r.confidenceScore <= b.max,
    );
    let hits = 0;
    let sumRet = 0;
    let n = 0;
    for (const r of subset) {
      const f = r.forward[horizonLabel];
      if (!f) continue;
      n++;
      sumRet += f.returnPct;
      if (f.returnPct > 0) hits++;
    }
    return {
      label: b.label,
      min: b.min,
      max: b.max,
      count: n,
      directionalAccuracy: n === 0 ? 0 : hits / n,
      avgForwardReturnPct: n === 0 ? 0 : sumRet / n,
    };
  });
}
