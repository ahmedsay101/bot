# No-SL Max-2 Directional Grid — Design

**Approved:** 2026-08-20  
**Decisions:** GRID_EXHAUSTED = either side N/N TP_HIT (B); entry = STOP_MARKET / MARKET-if-through (A)

## Summary

Evolve `GridDirectionalTrader` to remove stop-loss entirely, allow up to **2** simultaneous open positions, and scale per-level margin so L1 ≤ 50% of current trader capital. Levels remain one-shot. Position TP = one absolute grid spacing from fill. Trader exits only for `MAX_LIFETIME`, `TRADER_TP`, or `GRID_EXHAUSTED`.

## Invariants

1. `activeOpenPositions <= MAX_OPEN_POSITIONS` (default 2)
2. No SL orders, SL prices, or `SL_HIT` for new lifecycle
3. Level: `PENDING → ACTIVE → TP_HIT` or `PENDING → CANCELLED`
4. Leverage once: `notional = margin × leverage`
5. Controlled activation only (no bulk pending entries that could all fill)

## Capital

```
weight(L) = N - L + 1
pct(L)    = weight(L) / N / MAX_OPEN
margin    = currentCapital × pct(L)
```

For N=10, MAX_OPEN=2: L1=50%, L2=45%, …, L10=5% of **current** capital.

After each TP: `currentCapital += netPnl` (gross − entry − exit fees). Never reset to initial.

## Orders

- Entry: `STOP_MARKET` at level; `MARKET` if mark already through
- Exit: `TAKE_PROFIT` only (reduceOnly), TP = entry ± `gridDistanceAbs`
- No Stop-Limit; no STOP_MARKET SL

## Activation

While `activeCount < MAX_OPEN` and trader ACTIVE: activate lowest eligible PENDING level on the side of mark vs start (LONG if mark > start, SHORT if mark < start). Opposite directions allowed if slot free. Crossing start does **not** close anything.

## Trader exits

| Reason | Condition |
|--------|-----------|
| `MAX_LIFETIME` | timer / endsAt |
| `TRADER_TP` | net (realized + open uPnL − est exit fees) ≥ % of **initial** allocation |
| `GRID_EXHAUSTED` | either side has all N levels `TP_HIT` (not merely activated) |

On exit: cancel pending, close all open positions, mark incomplete actives CANCELLED (not TP_HIT), COMPLETED, replace via manager.

## Dashboard

Active positions 0–2/2; Entry+TP only (no SL); grid progress L/S; three exit meters.

## Compatibility

Historical `SL_HIT` / `slPrice` columns remain readable. New traders never write SL state.
