# Balanced → Moderate Relaxation Selective Trend Engine

**Date:** 2026-08-23 (moderate)

## Philosophy
CORE decides eligibility. Supporting adjusts confidence. Prefer 75–80 with imperfect supporting over waiting for rare 90+.

## Thresholds
| Param | Prior balanced | Moderate now |
|-------|----------------|--------------|
| minConfidence | 78 | **72** |
| minAdx | 24 | **22** |
| strongAdx | 30 | **28** |
| minEfficiency | 0.48 (semi-gated) | **0.45 scoring**; chop hard &lt;0.30 |
| weakVolume | 0.5 | **0.7** (penalty only) |
| minCoreConfirmed | 3 | **4** (with softer confirms) |
| maxReversalRisk | 75 | **75** |
| hard room | 0.5 ATR | **0.5 ATR** |

## CORE
Structure · MTF (4H/1H) · Trend strength (developing+) · Momentum (1/3 votes)

## SUPPORTING (score only)
Volume · Efficiency · EMA stack · Persistence · Context · Breakout quality
