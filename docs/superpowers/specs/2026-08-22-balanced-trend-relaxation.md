# Balanced Selective Trend Engine

**Date:** 2026-08-22 (relaxed)

## Why zero traders before
Required nearly all categories + confidence ≥85 + ADX/ER/volume hard gates + 3/4 MTF including 5m pressure. Supporting failures vetoed CORE-strong setups.

## Balanced defaults
| Param | Old | New |
|-------|-----|-----|
| minConfidence | 85 | **78** |
| minAdx | 25 | **24** (developing); strongAdx **30** |
| minEfficiency | 0.35 critical | **0.48** supporting |
| maxReversalRisk | 55 | **75** |
| minTrendRoomAtr | 1.2 hard | **1.0** soft; hard block **0.5** |
| minMtfAgree | 3/4 | **2/3** (4h/1h/15m); 5m non-veto |
| categories | 5/11 critical | **3/4 CORE** |

## Still hard-reject
Insufficient data, API error, 4H↔1H conflict, chop/range, false breakout, reversal ≥75, S/R &lt;0.5 ATR, structure CORE fail, stale.

## Tradeable regimes
`STRONG_TREND` and `DEVELOPING_STRONG_TREND`
