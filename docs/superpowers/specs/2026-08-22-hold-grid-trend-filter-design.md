# Hold-to-Exhaustion Two-Sided Grid + Trend Filter

**Date:** 2026-08-22  
**Status:** Approved (user confirmed always two-sided grid; trend = creation filter only)

## Summary

Evolve `GridDirectionalTrader` in place:

1. **Capital:** Split trader allocation 50/50 into independent LONG/SHORT pools. Level margins use normalized weights `L / triangular(N)` of **side** capital so all N levels fit in the side pool.
2. **Positions:** No TP, no SL. `PENDING → ACTIVE` only. Many simultaneous opens allowed (capital reserved at plan time).
3. **Exits:** Only `GRID_EXHAUSTED` (either side has N levels ACTIVE) or `MAX_LIFETIME`. No `TRADER_TP`.
4. **Creation:** Top gainer **and** confirmed multi-signal trend. Unconfirmed → skip. May run under `maxTraders`.
5. **Trend:** Does not modify grid geometry or destroy existing traders when score drops.
6. **Leverage:** 10x (config), applied once: `notional = margin × leverage`.

## Capital formula

```
sideCapital = traderAllocation / 2
weight(L) = L
totalWeight = N(N+1)/2
levelMargin = sideCapital × weight(L) / totalWeight
notional = levelMargin × leverage
```

Example $1000 trader, N=10: LONG pool $500, L1≈$9.09 … L10≈$90.91; same for SHORT.

## Trend confirmation

Signals (1 pt each, default min score 4/5): EMA20/50 alignment, price vs EMAs, ADX≥min, momentum (ROC), volume vs avg×multiplier. Primary + confirmation timeframes. Incomplete/error data → not confirmed.

## Files (primary)

- `gridCalc.ts`, `GridDirectionalTrader.ts`
- New: `trend/trendCalc.ts`, `trend/TrendDetector.ts`
- `BinanceClient` (+klines), `TraderManager`, `poolSelection` (optional trend filter hook)
- `config`, types, dashboard, tests
