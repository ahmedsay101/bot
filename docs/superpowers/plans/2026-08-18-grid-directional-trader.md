# Grid Directional Trader — Implementation Plan

> Inline execution on `feature/grid-directional-trader`.

**Goal:** Selectable `grid_directional` behavior without breaking `reversal`.

**Architecture:** Factory in `TraderManager`; new `GridDirectionalTrader` + `gridCalc.ts`; shared execution/ledger/pool.

## Tasks

1. `gridCalc.ts` + unit tests (prices, weights, margins, limit=stop tick-adjusted)
2. Config/types/prisma migration `0010_grid_directional`
3. `GridDirectionalTrader` (init, place 2N STOP_LIMITs, fills→open legs, exits, restore)
4. `TraderManager` factory + wire events/summary
5. Frontend strategy-conditional dashboard + config UI
6. Lifecycle/sim tests + `tsc` / jest / docker build smoke

**Limit policy:** `limitPrice = adjustPrice(triggerPrice)` (same price); BUY requires limit≥stop after adjust; SELL limit≤stop — bump one tick if needed.
