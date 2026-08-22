/**
 * Selective multi-TF trend detector (4h/1h/15m/5m) + concurrent batch scan.
 * Default: NO_TRADE. Uses trendEngine two-stage regime → direction.
 */
import {
  DEFAULT_TREND_CALC_CONFIG,
  type Candle,
  type TrendCalcConfig,
  type TrendSignals,
  type TrendStrength,
  type TrendStatus,
} from './trendCalc';
import {
  DEFAULT_TREND_ENGINE_CONFIG,
  evaluateTrendConfirmation,
  type MarketRegime,
  type TrendDecision,
  type TrendEngineConfig,
  type TfKey,
} from './trendEngine';

export interface TrendDetectorConfig {
  /** @deprecated Prefer timeframes[] — kept for env compat. */
  primaryTimeframe: string;
  /** @deprecated Prefer timeframes[] — kept for env compat. */
  confirmationTimeframe: string;
  timeframes: TfKey[];
  candleLimit: number;
  calc: TrendCalcConfig;
  engine: TrendEngineConfig;
  /** @deprecated score scale now 0–100 confidence. */
  maxScore: number;
  /** @deprecated use engine.minConfidence. */
  strongMinScore: number;
  concurrency: number;
  cacheTtlMs: number;
  maxAgeMs: number;
  btcSymbol: string;
}

export const DEFAULT_TREND_DETECTOR_CONFIG: TrendDetectorConfig = {
  primaryTimeframe: '15m',
  confirmationTimeframe: '1h',
  timeframes: ['5m', '15m', '1h', '4h'],
  candleLimit: 200,
  calc: { ...DEFAULT_TREND_CALC_CONFIG },
  engine: { ...DEFAULT_TREND_ENGINE_CONFIG },
  maxScore: 100,
  strongMinScore: 85,
  concurrency: 5,
  cacheTtlMs: 60_000,
  maxAgeMs: 300_000,
  btcSymbol: 'BTCUSDT',
};

/** Legacy multi-signal flags for UI backward compat. */
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
  /** Selective engine fields */
  decision: TrendDecision;
  regime: MarketRegime;
  confidenceScore: number;
  rejectionReasons: string[];
  efficiencyRatio: number;
  relativeVolume: number;
  reversalRisk: number;
  distanceToResistanceATR: number;
  distanceToSupportATR: number;
  mtfAligned: number;
  mtfTotal: number;
  plusDi: number;
  minusDi: number;
  atrPercent: number;
  trendAge: string;
  reasons: string[];
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

function statusFromDecision(
  decision: TrendDecision,
  regime: MarketRegime,
  strength: TrendStrength,
): TrendStatus {
  if (regime === 'INSUFFICIENT_DATA') return 'NO_TREND';
  if (decision === 'TRADE' && strength === 'STRONG') return 'STRONG_CONFIRMED';
  if (strength === 'MODERATE') return 'MODERATE';
  if (strength === 'WEAK') return 'WEAK';
  return 'NO_TREND';
}

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
    maxScore: 100,
    requiredScore: cfg.engine.minConfidence,
    confidence: 0,
    signals: { ...EMPTY_SIGNALS },
    multiSignals: { ...EMPTY_MULTI },
    timeframe: '15m',
    confirmationTimeframe: '1h',
    confirmationConfirmed: false,
    adx: 0,
    evaluatedAt: now,
    timestamp: now,
    decision: 'NO_TRADE',
    regime: status === 'ERROR' ? 'UNCERTAIN' : 'INSUFFICIENT_DATA',
    confidenceScore: 0,
    rejectionReasons: status === 'ERROR' ? ['API/data error'] : ['Insufficient evidence'],
    efficiencyRatio: 0,
    relativeVolume: 0,
    reversalRisk: 100,
    distanceToResistanceATR: 0,
    distanceToSupportATR: 0,
    mtfAligned: 0,
    mtfTotal: 4,
    plusDi: 0,
    minusDi: 0,
    atrPercent: 0,
    trendAge: 'UNKNOWN',
    reasons: status === 'ERROR' ? ['API/data error'] : ['Insufficient evidence'],
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

function confirmationToView(
  symbol: string,
  c: ReturnType<typeof evaluateTrendConfirmation>,
  cfg: TrendDetectorConfig,
): TrendDetectionView {
  const signals: TrendSignals = {
    emaAlignment: c.signals.emaStructure.confirmed,
    priceVsEma: c.signals.marketStructure.confirmed,
    adxStrong: c.signals.trendStrength.confirmed,
    diConfirms: c.signals.trendStrength.confirmed,
    momentumOk: c.signals.momentum.confirmed,
    volumeConfirmed: c.signals.volume.confirmed,
  };
  const multi: MultiTrendSignals = {
    emaPrimary: c.signals.emaStructure.confirmed,
    emaConfirmation: c.signals.multiTimeframe.confirmed,
    adx: c.signals.trendStrength.confirmed,
    di: c.signals.trendStrength.confirmed,
    momentum: c.signals.momentum.confirmed,
    volume: c.signals.volume.confirmed,
    priceStructure: c.signals.marketStructure.confirmed,
  };

  return {
    symbol,
    direction: c.direction === 'NONE' ? 'NONE' : c.direction,
    confirmed: c.decision === 'TRADE' && c.confirmed,
    strength: c.strength,
    status: statusFromDecision(c.decision, c.regime, c.strength),
    score: c.confidenceScore,
    maxScore: 100,
    requiredScore: cfg.engine.minConfidence,
    confidence: c.confidenceScore / 100,
    signals,
    multiSignals: multi,
    timeframe: '15m',
    confirmationTimeframe: '1h',
    confirmationConfirmed: c.signals.multiTimeframe.confirmed,
    adx: c.metrics.adx,
    evaluatedAt: c.evaluatedAt,
    timestamp: c.evaluatedAt,
    decision: c.decision,
    regime: c.regime,
    confidenceScore: c.confidenceScore,
    rejectionReasons: c.rejectionReasons,
    efficiencyRatio: c.metrics.efficiencyRatio,
    relativeVolume: c.metrics.relativeVolume,
    reversalRisk: c.risk.reversalRisk,
    distanceToResistanceATR: c.metrics.distanceToResistanceATR,
    distanceToSupportATR: c.metrics.distanceToSupportATR,
    mtfAligned: c.metrics.mtfAligned,
    mtfTotal: c.metrics.mtfTotal,
    plusDi: c.metrics.plusDi,
    minusDi: c.metrics.minusDi,
    atrPercent: c.metrics.atrPercent,
    trendAge: c.metrics.trendAge,
    reasons: c.rejectionReasons.length ? c.rejectionReasons : c.reasons,
  };
}

export class TrendDetector {
  private cache = new Map<string, { at: number; view: TrendDetectionView }>();
  private btcCache: { at: number; bias: 'BULLISH' | 'BEARISH' | 'NONE' } | null = null;

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
    this.btcCache = null;
  }

  private async fetchBtcBias(): Promise<'BULLISH' | 'BEARISH' | 'NONE'> {
    const { config: cfg, getKlines } = this.deps;
    const now = Date.now();
    if (this.btcCache && now - this.btcCache.at <= cfg.cacheTtlMs) {
      return this.btcCache.bias;
    }
    try {
      const [h1, h4] = await Promise.all([
        getKlines(cfg.btcSymbol, '1h', cfg.candleLimit),
        getKlines(cfg.btcSymbol, '4h', cfg.candleLimit),
      ]);
      // Soft context-only evaluation — never used to create traders.
      const result = evaluateTrendConfirmation(
        cfg.btcSymbol,
        { '5m': h1, '15m': h1, '1h': h1, '4h': h4 },
        {
          ...cfg.engine,
          minConfidence: 40,
          minCoreConfirmed: 2,
          minMtfAgree: 2,
          require4h1hAgree: false,
          maxReversalRisk: 90,
        },
      );
      const bias =
        result.direction === 'BULLISH' || result.direction === 'BEARISH' ? result.direction : 'NONE';
      this.btcCache = { at: now, bias };
      return bias;
    } catch {
      this.btcCache = { at: now, bias: 'NONE' };
      return 'NONE';
    }
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
      const tfs = cfg.timeframes;
      const candleSets = await Promise.all(
        tfs.map((tf) => getKlines(symbol, tf, cfg.candleLimit)),
      );

      const byTf: Partial<Record<TfKey, Candle[]>> = {};
      for (let i = 0; i < tfs.length; i++) {
        const tf = tfs[i]!;
        const candles = candleSets[i];
        if (!candles?.length) {
          const empty = emptyTrendView(symbol, cfg, 'NO_TREND');
          empty.rejectionReasons = [`Missing ${tf} candles`];
          empty.reasons = empty.rejectionReasons;
          this.cache.set(symbol, { at: now, view: empty });
          return empty;
        }
        byTf[tf] = candles;
      }

      const btcBias = symbol === cfg.btcSymbol ? 'NONE' : await this.fetchBtcBias();
      // Relative strength: last 24 closes of 1h vs BTC skipped if same candles; optional later
      const confirmation = evaluateTrendConfirmation(symbol, byTf, cfg.engine, {
        btcBias,
      });
      const view = confirmationToView(symbol, confirmation, cfg);
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
    // Warm BTC context once before batch
    await this.fetchBtcBias().catch(() => 'NONE' as const);
    return mapLimit(symbols, concurrency, async (symbol) => {
      try {
        return await this.detectTrend(symbol);
      } catch {
        return emptyTrendView(symbol, this.deps.config, 'ERROR');
      }
    });
  }
}

/**
 * @deprecated Legacy 2-TF combiner retained for older unit tests only.
 * Prefer evaluateTrendConfirmation via TrendDetector.
 */
export function combineMultiTimeframeTrends(
  symbol: string,
  primary: { direction: string; signals: TrendSignals; adx: number },
  confirmation: { direction: string; signals: TrendSignals; adx: number },
  cfg: TrendDetectorConfig,
): TrendDetectionView {
  const sameDirection =
    primary.direction !== 'NONE'
    && confirmation.direction !== 'NONE'
    && primary.direction === confirmation.direction;

  if (!sameDirection) {
    return emptyTrendView(symbol, cfg, 'NO_TREND');
  }

  // Legacy path never grants TRADE — selective engine is authoritative.
  const view = emptyTrendView(symbol, cfg, 'NO_TREND');
  view.direction = primary.direction as 'BULLISH' | 'BEARISH';
  view.adx = primary.adx;
  view.signals = primary.signals;
  view.rejectionReasons = ['Legacy 2-TF combiner disabled — use selective engine'];
  view.reasons = view.rejectionReasons;
  return view;
}
