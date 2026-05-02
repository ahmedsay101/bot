import { CONFIG } from '../core/config.js';
import { Side, Regime } from '../core/constants.js';
import { rsi } from '../indicators/index.js';
import { detectRegime, type RegimeSnapshot } from './regime.service.js';
import type { Candle } from './marketData.service.js';

export type Signal =
  | { kind: 'OPEN'; side: Side; price: number; atr: number; rsi: number; reason: string }
  | { kind: 'CLOSE'; reason: 'rsi_neutral' | 'regime_change'; price: number }
  | { kind: 'HOLD'; reason: string };

export interface StrategyContext {
  candles: Candle[];
  hasOpenPosition: boolean;
  positionSide?: Side;
}

export interface StrategyEvaluation {
  signal: Signal;
  regime: RegimeSnapshot;
  rsi: number;
  support: number;
  resistance: number;
}

/**
 * Pure evaluation of latest closed candle.
 * - Entries only in RANGE regime.
 * - LONG  ⇔ RSI < oversold AND price near rolling support (low) within proximity buffer
 * - SHORT ⇔ RSI > overbought AND price near rolling resistance (high)
 * - Exit  ⇔ RSI returns to neutral band (price-based SL/TP handled by execution)
 */
export function evaluate(ctx: StrategyContext): StrategyEvaluation {
  const cfg = CONFIG();
  const regime = detectRegime(ctx.candles);

  const closes = ctx.candles.map((c) => c.close);
  const rsiSeries = rsi(closes, cfg.indicators.rsiPeriod);
  const i = ctx.candles.length - 1;
  const close = closes[i] as number;
  const rsiV = rsiSeries[i] as number;

  // rolling support/resistance over maPeriod / 2 candles
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

  // Entry path — RANGE only
  if (regime.regime !== Regime.RANGE) {
    return out({ kind: 'HOLD', reason: 'not_range' });
  }
  if (!Number.isFinite(rsiV) || !Number.isFinite(regime.atr)) {
    return out({ kind: 'HOLD', reason: 'indicators_not_ready' });
  }

  const proximity = cfg.thresholds.supportProximityAtr * regime.atr;

  if (rsiV < cfg.thresholds.rsiOversold && close - support <= proximity) {
    return out({
      kind: 'OPEN',
      side: Side.LONG,
      price: close,
      atr: regime.atr,
      rsi: rsiV,
      reason: 'rsi_oversold_at_support',
    });
  }
  if (rsiV > cfg.thresholds.rsiOverbought && resistance - close <= proximity) {
    return out({
      kind: 'OPEN',
      side: Side.SHORT,
      price: close,
      atr: regime.atr,
      rsi: rsiV,
      reason: 'rsi_overbought_at_resistance',
    });
  }

  return out({ kind: 'HOLD', reason: 'no_setup' });
}
