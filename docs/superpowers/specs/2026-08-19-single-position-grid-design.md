# Single-Position Directional Grid — Design

**Approved:** 2026-08-19  
**Capital formula:** B — `margin = currentCapital × (N − L + 1) / N`

## Summary

Modify `GridDirectionalTrader` so each trader has at most one open position. Levels are one-shot. Per-position TP = one grid spacing from entry; SL = immutable `startPrice`. Dynamic `currentCapital` carries across LONG/SHORT.

## Invariants

1. `activeOpenPositions <= 1`
2. Level statuses: `PENDING | ACTIVE | TP_HIT | SL_HIT | CANCELLED` — TP/SL terminal
3. Leverage applied once: `notional = margin × leverage`
4. Capital never resets to initial after TP/SL

## Capital

```
weight(L) = N - L + 1
margin    = currentCapital × weight(L) / N
```

L1 = 100%, L2 = 90%, …, L10 = 10% of **current** capital.

## TP / SL

```
gridDistance = startPrice × GRID_DISTANCE_PERCENT / 100
LONG  TP = entry + gridDistance ; SL = startPrice
SHORT TP = entry - gridDistance ; SL = startPrice
```

## Flow

Init → build price grid (no bulk entries) → on mark, activate lowest eligible PENDING level → entry fill → place TP+SL → on exit cancel sibling → update currentCapital → repeat. Exit: trader TP, max lifetime, 10 levels completed on one side.

## Sim race

If one mark update crosses both TP and SL: for LONG prefer SL if `mark <= startPrice`, else TP if `mark >= tp`; SHORT mirrored.
