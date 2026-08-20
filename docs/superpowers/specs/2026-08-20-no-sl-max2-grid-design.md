# No-SL Per-Side Directional Grid — Design

**Approved:** 2026-08-20  
**Update:** Removed `MAX_OPEN_POSITIONS_PER_TRADER`. Cap is structural: ≤1 LONG and ≤1 SHORT (TP sits at the next same-side level).

## Invariants

1. At most **one open LONG** and **one open SHORT** simultaneously
2. No SL orders / `SL_HIT` for new lifecycle
3. Level: `PENDING → ACTIVE → TP_HIT` or `PENDING → CANCELLED`
4. Capital: `margin = currentCapital × (N−L+1) / N / 2` (÷2 reserves both sides) → L1=50% …
5. Entry: STOP_MARKET / MARKET-if-through; exit: TAKE_PROFIT only

## Trader exits

`MAX_LIFETIME` | `TRADER_TP` | `GRID_EXHAUSTED` (either side N× TP_HIT)
