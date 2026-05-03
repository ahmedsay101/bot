import { z } from 'zod';
import { env } from './env.js';

/**
 * Static defaults — verbatim from spec. Runtime overrides come from the
 * `settings` Mongo document and are merged in `loadRuntimeConfig()`.
 */
export const DefaultConfig = {
  mode: env.MODE,

  trading: {
    maxSymbols: 3,
    leverage: 2,
    totalBalance: 300,
    riskPerTrade: 0.01,
    maxOpenPositionsPerSymbol: 1,
  },

  filters: {
    // Audit: liquidity floor raised to 100M USDT 24h quote-volume to keep
    // the universe in BTC/ETH/SOL-tier names where fills + spreads are sane.
    minVolume: 100_000_000,
    maxSpreadPercent: 0.2,
    // How many top-volume symbols the scanner scores each cycle.
    // Trading parallelism is still capped by `trading.maxSymbols`.
    candidateUniverseSize: 100,
  },

  indicators: {
    rsiPeriod: 14,
    atrPeriod: 14,
    maPeriod: 50,
  },

  thresholds: {
    // Audit: widen RSI bands 30/70 → 35/65 so realistic mean-reversion
    // setups generate signals (was producing ~0 trades).
    rsiOverbought: 65,
    rsiOversold: 35,
    rsiNeutralLow: 45,
    rsiNeutralHigh: 55,
    // 1m trigger thresholds — stricter than the 15m setup thresholds so the
    // setup waits for an actual fast-RSI excursion before firing.
    rsi1mTriggerLong: 30,
    rsi1mTriggerShort: 70,
    // Audit: trendSlope tuned to 0.004 (per-bar relative MA slope).
    // |slope| < 0.004 → RANGE, otherwise TREND.
    trendSlope: 0.004,
    atrExpansion: 1.5,
    supportProximityAtr: 0.25,
  },

  // Strategy timeframes & SL/TP (decisions accepted)
  timeframes: {
    strategy: '1m' as const,
    scanner: '15m' as const,
  },
  exits: {
    slAtrMultiple: 1.5,
    tpAtrMultiple: 2.5,
  },

  // Test-execution simulator tuning
  simulator: {
    minLatencyMs: 50,
    maxLatencyMs: 200,
    takerFeeRate: 0.0004,
    makerFeeRate: 0.0002,
    maxSlippageAtrFraction: 0.05,
    partialFillVolumeThreshold: 0.05,
    partialFillMaxLegs: 5,
    partialFillSpreadMs: 30_000,
  },

  // Loop tuning (overridable via env)
  loop: {
    intervalMs: env.LOOP_INTERVAL_MS,
    scannerIntervalMs: env.SCANNER_INTERVAL_MS,
  },

  // Stateful setup engine (15m → 1m sequential confirmation).
  // 15m scanner creates a setup; 1m loop has `expiryMs` to find a trigger.
  // After a fill, symbol is locked out for `cooldownMs`.
  setup: {
    expiryMs: 30 * 60_000,
    cooldownMs: 10 * 60_000,
  },

  // ---------------------------------------------------------------------
  // GRID + HEDGE state machine (the active trading strategy).
  //
  // Pure price-structure based: NO indicators, NO predictions. Range is
  // built from recent candle highs/lows; breakouts are price + persistence.
  // ---------------------------------------------------------------------
  grid: {
    /** Range build timeframe — candle interval the engine reads. */
    timeframe: '5m' as const,
    /** Number of recent closed candles used to compute hi/lo. */
    lookback: 30,
    /** Buffer above max(highs) (1.002 = +0.2%). */
    upperBuffer: 1.002,
    /** Buffer below min(lows)  (0.998 = -0.2%). */
    lowerBuffer: 0.998,
    /** Minimum range as fraction of price; expanded to this if narrower. */
    minRangePercent: 0.01,
    /** Maximum range as fraction of price; shrunk to this if wider. */
    maxRangePercent: 0.04,
    /** Spacing between adjacent grid levels (0.0025 = 0.25%). */
    spacing: 0.0025,
    /** Per-side concurrent open positions cap. */
    maxOpenPositionsPerSide: 3,
    /** Total concurrent open positions cap (longs + shorts). */
    maxTotalPositions: 6,
    /** USDT notional per grid order. Floor of 5 to satisfy MIN_NOTIONAL. */
    orderNotionalUsdt: 25,
    /** Breakout trigger: |price/band - 1| ≥ this (0.005 = 0.5%). */
    breakoutPercent: 0.005,
    /** Number of consecutive timeframe-candles price must remain past band. */
    breakoutHoldCandles: 3,
    /** Trend-confirm: extra distance past band (0.005 = 0.5%) to flip RESET. */
    trendConfirmPercent: 0.005,
    /** Fake-breakout window: if price returns inside range within this many
     *  candles of breakout, it's a fake. */
    fakeBreakoutCandles: 5,
    /** Chop detection: ≥ this many band-crossings inside chopWindowCandles. */
    chopCrosses: 2,
    chopWindowCandles: 4,
    /** Reset cooldown before re-entering GRID. */
    cooldownMs: 15 * 60_000,
    /** Universe selection: top-N USDT perpetuals by 24h quote-volume. */
    universeSize: 3,
  },

  killSwitch: false,

  // Verbose per-tick decision logging. Toggle at runtime via Settings page.
  debug: false,
};

export type Config = typeof DefaultConfig;

export const SettingsSchema = z.object({
  trading: z
    .object({
      maxSymbols: z.number().int().min(1).max(20),
      leverage: z.number().int().min(1).max(20),
      totalBalance: z.number().positive(),
      riskPerTrade: z.number().positive().max(0.1),
      maxOpenPositionsPerSymbol: z.number().int().min(1).max(5),
    })
    .partial(),
  filters: z
    .object({
      minVolume: z.number().nonnegative(),
      maxSpreadPercent: z.number().positive().max(5),
      candidateUniverseSize: z.number().int().min(5).max(500),
    })
    .partial(),
  indicators: z
    .object({
      rsiPeriod: z.number().int().min(2).max(200),
      atrPeriod: z.number().int().min(2).max(200),
      maPeriod: z.number().int().min(2).max(500),
    })
    .partial(),
  thresholds: z
    .object({
      rsiOverbought: z.number().min(50).max(100),
      rsiOversold: z.number().min(0).max(50),
      rsiNeutralLow: z.number().min(0).max(100),
      rsiNeutralHigh: z.number().min(0).max(100),
      rsi1mTriggerLong: z.number().min(0).max(50),
      rsi1mTriggerShort: z.number().min(50).max(100),
      trendSlope: z.number().nonnegative(),
      atrExpansion: z.number().positive(),
      supportProximityAtr: z.number().positive(),
    })
    .partial(),
  exits: z
    .object({
      slAtrMultiple: z.number().positive(),
      tpAtrMultiple: z.number().positive(),
    })
    .partial(),
  setup: z
    .object({
      expiryMs: z.number().int().positive().max(24 * 60 * 60_000),
      cooldownMs: z.number().int().nonnegative().max(24 * 60 * 60_000),
    })
    .partial(),
  grid: z
    .object({
      timeframe: z.string().min(1),
      lookback: z.number().int().min(5).max(500),
      upperBuffer: z.number().min(1).max(1.05),
      lowerBuffer: z.number().min(0.95).max(1),
      minRangePercent: z.number().positive().max(0.5),
      maxRangePercent: z.number().positive().max(0.5),
      spacing: z.number().positive().max(0.05),
      maxOpenPositionsPerSide: z.number().int().min(1).max(50),
      maxTotalPositions: z.number().int().min(1).max(100),
      orderNotionalUsdt: z.number().positive().max(100000),
      breakoutPercent: z.number().nonnegative().max(0.1),
      breakoutHoldCandles: z.number().int().min(1).max(50),
      trendConfirmPercent: z.number().nonnegative().max(0.1),
      fakeBreakoutCandles: z.number().int().min(1).max(50),
      chopCrosses: z.number().int().min(1).max(20),
      chopWindowCandles: z.number().int().min(1).max(50),
      cooldownMs: z.number().int().nonnegative().max(24 * 60 * 60_000),
      universeSize: z.number().int().min(1).max(20),
    })
    .partial(),
  killSwitch: z.boolean().optional(),
  debug: z.boolean().optional(),
}).partial();

export type SettingsPatch = z.infer<typeof SettingsSchema>;

let active: Config = structuredClone(DefaultConfig);

export function CONFIG(): Config {
  return active;
}

export function applySettingsPatch(patch: SettingsPatch): Config {
  const next = structuredClone(active);
  for (const k of Object.keys(patch) as Array<keyof SettingsPatch>) {
    const v = patch[k];
    if (v === undefined) continue;
    if (k === 'killSwitch') {
      next.killSwitch = Boolean(v);
    } else if (k === 'debug') {
      next.debug = Boolean(v);
    } else {
      // shallow merge per top-level key
      // @ts-expect-error dynamic merge; structurally identical sub-shapes
      next[k] = { ...next[k], ...v };
    }
  }
  active = next;
  return active;
}

export function resetConfig(): void {
  active = structuredClone(DefaultConfig);
}
