# Full Top-Gainer Trend Scan Pipeline

**Date:** 2026-08-22  
**Status:** Implemented

## Root cause (prior behavior)

`reconcileTraderPool` stopped trend analysis early:

```ts
if (toCreate.length >= slotsNeeded) break;
```

So only enough symbols to fill empty slots were analyzed, and higher 24h gain could win without a full-list STRONG comparison.

## New flow

1. Fetch top gainers (`TOP_GAINERS_LIMIT`, default 50)
2. `detectTrendForAll(symbols)` — concurrency-limited, **no early stop**
3. Rank `confirmed && strength===STRONG` (score → confidence → ADX → gain rank)
4. Create at most `maxTraders - occupied`
5. `createTrader` rejects missing/stale/non-STRONG candidates

## Strong trend (7-point multi-TF)

15m EMA, 1h EMA, ADX≥25, +DI/−DI, momentum, volume, price structure on both TFs.  
`TREND_STRONG_MIN_SCORE=6`, prefer ADX≥`TREND_STRONG_ADX=30`. Conflicting TFs → not STRONG.
