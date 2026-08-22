/**
 * Multi-timeframe trend detector + controlled concurrent batch scan.
 */
import {
  DEFAULT_TREND_CALC_CONFIG,
  evaluateTrendFromCandles,
  statusFromStrength,
  strengthFromScore,
  type Candle,
  type TrendCalcConfig,
  type TrendSignals,
  type TrendStrength,
  type TrendStatus,
} from './trendCalc';

export interface TrendDetectorConfig {
  primaryTimeframe: string;
  confirmationTimeframe: string;
  candleLimit: number;
  calc: TrendCalcConfig;
  /** Combined multi-TF max score (default 7). */
  maxScore: number;
  /** Score required for STRONG / confirmed (default 6). */
  strongMinScore: number;
  /** Concurrent symbol analyses (default 5). */
  concurrency: number;
  /** Cache TTL ms (default 60s). */
  cacheTtlMs: number;
  /** Max age of a result usable for createTrader (default 300s). */
  maxAgeMs: number;
}

export const DEFAULT_TREND_DETECTOR_CONFIG: TrendDetectorConfig = {
  primaryTimeframe: '15m',
  confirmationTimeframe: '1h',
  candleLimit: 120,
  calc: { ...DEFAULT_TREND_CALC_CONFIG },
  maxScore: 7,
  strongMinScore: 6,
  concurrency: 5,
  cacheTtlMs: 60_000,
  maxAgeMs: 300_000,
};

/** Full multi-TF signal breakdown for dashboard / createTrader. */
export interface MultiTrendSignals {
  emaPrimary: boolean;
  emaConfirmation: boolean;
  adx: boolean;
  di: boolean;
  momentum: boolean;
  volume: boolean;
  priceStructure: boolean;
}

export interface TrendDetectionView {
  symbol: string;
  direction: 'NONE' | 'BULLISH' | 'BEARISH';
  confirmed: boolean;
  strength: TrendStrength;
  status: TrendStatus;
  score: number;
  maxScore: number;
  requiredScore: number;
  confidence: number;
  signals: TrendSignals;
  multiSignals: MultiTrendSignals;
  timeframe: string;
  confirmationTimeframe: string;
  confirmationConfirmed: boolean;
  adx: number;
  priceChangePercent?: string;
  gainRank?: number;
  evaluatedAt: number;
  /** @deprecated use evaluatedAt */
  timestamp: number;
}

const EMPTY_MULTI: MultiTrendSignals = {
  emaPrimary: false,
  emaConfirmation: false,
  adx: false,
  di: false,
  momentum: false,
  volume: false,
  priceStructure: false,
};

const EMPTY_SIGNALS: TrendSignals = {
  emaAlignment: false,
  priceVsEma: false,
  adxStrong: false,
  diConfirms: false,
  momentumOk: false,
  volumeConfirmed: false,
};

export function emptyTrendView(
  symbol: string,
  cfg: TrendDetectorConfig,
  status: TrendStatus = 'NO_TREND',
): TrendDetectionView {
  const now = Date.now();
  return {
    symbol,
    direction: 'NONE',
    confirmed: false,
    strength: 'NONE',
    status,
    score: 0,
    maxScore: cfg.maxScore,
    requiredScore: cfg.strongMinScore,
    confidence: 0,
    signals: { ...EMPTY_SIGNALS },
    multiSignals: { ...EMPTY_MULTI },
    timeframe: cfg.primaryTimeframe,
    confirmationTimeframe: cfg.confirmationTimeframe,
    confirmationConfirmed: false,
    adx: 0,
    evaluatedAt: now,
    timestamp: now,
  };
}

/** Run async work over items with a concurrency limit. */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Combine primary + confirmation TF into a 7-point multi-signal score.
 * Confirmed only when direction agrees AND strength === STRONG.
 */
export function combineMultiTimeframeTrends(
  symbol: string,
  primary: ReturnType<typeof evaluateTrendFromCandles>,
  confirmation: ReturnType<typeof evaluateTrendFromCandles>,
  cfg: TrendDetectorConfig,
): TrendDetectionView {
  const sameDirection =
    primary.direction !== 'NONE'
    && confirmation.direction !== 'NONE'
    && primary.direction === confirmation.direction;

  if (!sameDirection) {
    const view = emptyTrendView(symbol, cfg, 'NO_TREND');
    view.signals = primary.signals;
    view.adx = primary.adx;
    return view;
  }

  const direction = primary.direction;
  const multi: MultiTrendSignals = {
    emaPrimary: primary.signals.emaAlignment,
    emaConfirmation: confirmation.signals.emaAlignment,
    adx: primary.signals.adxStrong && primary.adx >= cfg.calc.minAdx,
    di: primary.signals.diConfirms,
    momentum: primary.signals.momentumOk,
    volume: primary.signals.volumeConfirmed,
    priceStructure: primary.signals.priceVsEma && confirmation.signals.priceVsEma,
  };

  let score = 0;
  if (multi.emaPrimary) score++;
  if (multi.emaConfirmation) score++;
  if (multi.adx) score++;
  if (multi.di) score++;
  if (multi.momentum) score++;
  if (multi.volume) score++;
  if (multi.priceStructure) score++;

  let strength = strengthFromScore(score, cfg.maxScore, cfg.strongMinScore);
  // Prefer strong ADX for STRONG classification
  if (strength === 'STRONG' && primary.adx < cfg.calc.strongAdx) {
    strength = 'MODERATE';
  }
  // Confirmation TF must also have EMA aligned (already in score) and not be NONE
  if (strength === 'STRONG' && !confirmation.signals.emaAlignment) {
    strength = 'MODERATE';
  }

  const confirmed = strength === 'STRONG';
  const now = Date.now();

  return {
    symbol,
    direction,
    confirmed,
    strength,
    status: statusFromStrength(strength),
    score,
    maxScore: cfg.maxScore,
    requiredScore: cfg.strongMinScore,
    confidence: cfg.maxScore > 0 ? score / cfg.maxScore : 0,
    signals: primary.signals,
    multiSignals: multi,
    timeframe: cfg.primaryTimeframe,
    confirmationTimeframe: cfg.confirmationTimeframe,
    confirmationConfirmed: confirmation.signals.emaAlignment && confirmation.direction === direction,
    adx: primary.adx,
    evaluatedAt: now,
    timestamp: now,
  };
}

export class TrendDetector {
  private cache = new Map<string, { at: number; view: TrendDetectionView }>();

  constructor(
    private deps: {
      getKlines: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
      config: TrendDetectorConfig;
    },
  ) {}

  get config(): TrendDetectorConfig {
    return this.deps.config;
  }

  isFresh(view: TrendDetectionView, now = Date.now()): boolean {
    return now - view.evaluatedAt <= this.deps.config.maxAgeMs;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async detectTrend(symbol: string, opts?: { bypassCache?: boolean }): Promise<TrendDetectionView> {
    const { config: cfg, getKlines } = this.deps;
    const now = Date.now();

    if (!opts?.bypassCache) {
      const hit = this.cache.get(symbol);
      if (hit != null && now - hit.at <= cfg.cacheTtlMs) {
        return hit.view;
      }
    }

    try {
      const [primaryCandles, confirmCandles] = await Promise.all([
        getKlines(symbol, cfg.primaryTimeframe, cfg.candleLimit),
        getKlines(symbol, cfg.confirmationTimeframe, cfg.candleLimit),
      ]);

      if (!primaryCandles?.length || !confirmCandles?.length) {
        const empty = emptyTrendView(symbol, cfg, 'NO_TREND');
        this.cache.set(symbol, { at: now, view: empty });
        return empty;
      }

      const primary = evaluateTrendFromCandles(primaryCandles, cfg.calc);
      const confirmation = evaluateTrendFromCandles(confirmCandles, cfg.calc);
      const view = combineMultiTimeframeTrends(symbol, primary, confirmation, cfg);
      this.cache.set(symbol, { at: now, view });
      return view;
    } catch {
      const errView = emptyTrendView(symbol, cfg, 'ERROR');
      this.cache.set(symbol, { at: now, view: errView });
      return errView;
    }
  }

  /**
   * Analyze EVERY symbol (no early stop). Controlled concurrency.
   * Failures are isolated per symbol.
   */
  async detectTrendForAll(symbols: string[]): Promise<TrendDetectionView[]> {
    const { concurrency } = this.deps.config;
    return mapLimit(symbols, concurrency, async (symbol) => {
      try {
        return await this.detectTrend(symbol);
      } catch {
        return emptyTrendView(symbol, this.deps.config, 'ERROR');
      }
    });
  }
}
