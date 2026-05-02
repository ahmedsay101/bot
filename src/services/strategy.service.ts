import { CONFIG } from '../core/config.js';
import { Side, Regime } from '../core/constants.js';
import { rsi } from '../indicators/index.js';
import { detectRegime, type RegimeSnapshot } from './regime.service.js';
import type { Candle } from './marketData.service.js';
import type { Setup } from './setup.service.js';

export type Signal =
  | { kind: 'OPEN'; side: Side; price: number; atr: number; rsi: number; reason: string }
  | { kind: 'CLOSE'; reason: 'rsi_neutral' | 'regime_change'; price: number }
  | { kind: 'HOLD'; reason: string };

export interface StrategyContext {
  candles: Candle[];
  hasOpenPosition: boolean;
  positionSide?: Side;
  /** Active 15m setup for this symbol (from SetupService) or null. */
  setup?: Setup | null;
}

export interface StrategyEvaluation {
  signal: Signal;
  regime: RegimeSnapshot;
  rsi: number;
  support: number;
  resistance: number;
}

/**
 * Pure evaluation of latest closed 1m candle.
 *
 * Sequential setup→trigger model:
 *   - 15m scanner creates a Setup (LONG or SHORT) when 15m RSI breaches the
 *     oversold/overbought band in a RANGE regime.
 *   - Strategy fires OPEN only when an active Setup exists AND the 1m RSI
 *     also breaches its (typically tighter) trigger band in the matching
 *     direction. This decouples opportunity (slow) from entry timing (fast).
 *
 * No setup → HOLD with reason `no_setup`. Setup expired → HOLD `setup_expired`.
 * Position management (CLOSE on regime change / RSI neutral) is unchanged.
 */
export function evaluate(ctx: StrategyContext): StrategyEvaluation {
  const cfg = CONFIG();
  const regime = detectRegime(ctx.candles);

  const closes = ctx.candles.map((c) => c.close);
  const rsiSeries = rsi(closes, cfg.indicators.rsiPeriod);
  const i = ctx.candles.length - 1;
  const close = closes[i] as number;
  const rsiV = rsiSeries[i] as number;

  // rolling support/resistance over maPeriod / 2 candles (informational)
  const lookback = Math.max(5, Math.floor(cfg.indicators.maPeriod / 2));
  const window = ctx.candles.slice(Math.max(0, i - lookback + 1), i + 1);
  let support = Infinity;
  let resistance = -Infinity;
  for (const c of window) {
    if (c.low < support) support = c.low;
    if (c.high > resistance) resistance = c.high;
  }

  const out = (signal: Signal): StrategyEvaluation => ({ signal, regime, rsi: rsiV, support, resistance });

  if (regime.regime === Regime.UNKNOWN) {
    return out({ kind: 'HOLD', reason: 'insufficient_data' });
  }

  // Manage open position
  if (ctx.hasOpenPosition) {
    if (regime.regime === Regime.TREND) {
      return out({ kind: 'CLOSE', reason: 'regime_change', price: close });
    }
    const inNeutral = rsiV >= cfg.thresholds.rsiNeutralLow && rsiV <= cfg.thresholds.rsiNeutralHigh;
    if (Number.isFinite(rsiV) && inNeutral) {
      return out({ kind: 'CLOSE', reason: 'rsi_neutral', price: close });
    }
    return out({ kind: 'HOLD', reason: 'position_active' });
  }

  // Entry path — RANGE only and only against an active 15m setup.
  if (regime.regime !== Regime.RANGE) {
    return out({ kind: 'HOLD', reason: 'not_range' });
  }
  if (!Number.isFinite(rsiV) || !Number.isFinite(regime.atr)) {
    return out({ kind: 'HOLD', reason: 'indicators_not_ready' });
  }

  const setup = ctx.setup ?? null;
  if (!setup) {
    return out({ kind: 'HOLD', reason: 'no_setup' });
  }

  // Sequential trigger: setup direction + 1m RSI confirmation
  if (setup.type === 'LONG' && rsiV < cfg.thresholds.rsi1mTriggerLong) {
    return out({
      kind: 'OPEN',
      side: Side.LONG,
      price: close,
      atr: regime.atr,
      rsi: rsiV,
      reason: 'setup_long_triggered',
    });
  }
  if (setup.type === 'SHORT' && rsiV > cfg.thresholds.rsi1mTriggerShort) {
    return out({
      kind: 'OPEN',
      side: Side.SHORT,
      price: close,
      atr: regime.atr,
      rsi: rsiV,
      reason: 'setup_short_triggered',
    });
  }

  return out({ kind: 'HOLD', reason: 'awaiting_trigger' });
}
