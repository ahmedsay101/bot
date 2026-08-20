# No-SL Max-2 Grid Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans (or implement directly when user said go ahead).

**Goal:** Remove SL, max 2 positions, 50%-scaled capital, GRID_EXHAUSTED on either-side full TP.

**Files:** `gridCalc.ts`, `GridDirectionalTrader.ts`, config/types, dashboard/api, unit+lifecycle tests.

## Tasks

1. **gridCalc** — `MAX_OPEN` in allocation (`/ maxOpenPositions`); drop SL from plan math (optional null `slPrice`); update unit tests (50/45/5%).
2. **Trader** — `activePositions` Map ≤2; TP-only exits; remove SL paths; side TP_HIT exhaustion → `GRID_EXHAUSTED`; close all on exit; restore multi-open.
3. **Config/types/API** — `MAX_OPEN_POSITIONS_PER_TRADER=2`; summary `currentPositions[]`, no SL UI fields required.
4. **Dashboard** — multi-position panel, no SL, exit conditions, grid progress.
5. **Tests** — no-SL stay-open, max-2, capital scaling, exhaustion after final TP, §47 path.
6. **Verify** — tsc + jest grid patterns.
