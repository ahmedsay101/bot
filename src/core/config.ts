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
    totalBalance: 600,
    riskPerTrade: 0.01,
    maxOpenPositionsPerSymbol: 1,
  },

  filters: {
    minVolume: 50_000_000,
    maxSpreadPercent: 0.2,
  },

  indicators: {
    rsiPeriod: 14,
    atrPeriod: 14,
    maPeriod: 50,
  },

  thresholds: {
    rsiOverbought: 70,
    rsiOversold: 30,
    rsiNeutralLow: 45,
    rsiNeutralHigh: 55,
    trendSlope: 0.002,
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

  killSwitch: false,
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
  killSwitch: z.boolean().optional(),
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
