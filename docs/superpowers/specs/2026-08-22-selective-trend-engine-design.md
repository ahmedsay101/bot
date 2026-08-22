# High-Precision Selective Trend Engine

**Date:** 2026-08-22  
**Philosophy:** Uncertainty → NO_TRADE. Precision over frequency. Confidence = signal quality, not probability.

## Failures of prior model
- Flat multi-point scoring double-counted EMA/price/momentum.
- Only 15m+1h; no 4H regime gate.
- No market structure, efficiency ratio, S/R room, false-breakout, or reversal risk.
- `confirmed=true` could fire without a true directional regime.

## Architecture (implemented)
1. **Stage 1 — Regime:** ER, ADX, swing/window structure → STRONG_TREND | RANGE | CHOP | UNCERTAIN | …
2. **Stage 2 — Direction:** Only if STRONG_TREND; MTF-weighted bias + category consensus.
3. **Hard rejects:** insufficient data, 4H/1H conflict, low ADX/ER, high reversal risk, insufficient trend room, API error, stale, critical category failure, confidence < min.
4. **Categories (bounded influence):** structure, trendStrength, momentum, participation, volatility/efficiency, multiTF, context, reversalRisk — no double-counting EMA comparisons or RSI+MACD+ROC as separate votes.
5. **TRADE** iff: decision=TRADE, regime=STRONG_TREND, confidence≥min, no hard reject, fresh.

## Timeframes (weighted)
4H 35% · 1H 30% · 15M 25% · 5M 10% — 5m cannot override 4H/1H conflict.

## Key modules
- `backend/src/modules/trend/indicators.ts` — ATR, ADX/DI, RSI, MACD, ER, swings, structure
- `backend/src/modules/trend/trendEngine.ts` — two-stage selective engine
- `backend/src/modules/trend/TrendDetector.ts` — 4-TF fetch, BTC context, concurrency, cache
- `backend/src/modules/trend/historicalValidation.ts` — forward-return calibration hooks
- Gate: `candidateScan` + `TraderManager.assertStrongTrendCandidate`

## Defaults
`TREND_MIN_STRONG_CONFIDENCE=85`, `TREND_MIN_EFFICIENCY=0.35`, `TREND_MIN_ROOM_ATR=1.2`, `TREND_MAX_REVERSAL_RISK=55`, `TREND_MIN_MTF_AGREE=3`, `TREND_MIN_CATEGORY_CONFIRMED=5`
