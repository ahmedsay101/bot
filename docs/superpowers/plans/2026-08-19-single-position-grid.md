# Single-Position Directional Grid — Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Convert multi-leg open grid into one-position level-by-level directional grid.

**Architecture:** Extend `gridCalc.ts` math; rewrite `GridDirectionalTrader` lifecycle; light Prisma + dashboard updates. Shared fees/leverage/ledger unchanged.

**Tech Stack:** TypeScript, Decimal.js, Prisma, Jest, React/MUI

## Global Constraints

- Capital B: `margin = currentCapital × (N−L+1)/N`
- One open position max; levels never recreate
- TP = entry ± absolute grid distance; SL = startPrice
- Testing/Live same financial formulas

---

### Task 1: gridCalc math + unit tests

**Files:** `backend/src/modules/trader/grid/gridCalc.ts`, `backend/tests/unit/gridCalc.test.ts`

- [ ] Add `levelWeight(L,N)`, `calculatePositionAllocation`, `calcGridDistanceAbs`, `calcLevelTpPrice`, `calcLevelSlPrice`
- [ ] Change plan weights to reversed; plan stores prices/weights (display); sizing at activation
- [ ] Unit tests for B formula, TP/SL, reversed weights
- [ ] Run tests

### Task 2: Prisma fields

**Files:** `schema.prisma`, migration `0011_single_position_grid`

- [ ] Trader: `currentCapital String?`
- [ ] GridLevel: optional `tpPrice`, `slPrice`, `completionReason`, `completedAt`
- [ ] Reuse Trader `entryPrice/tpPrice/slPrice/quantity/currentSide` for active pos

### Task 3: Rewrite GridDirectionalTrader

**Files:** `GridDirectionalTrader.ts`, manager restore wiring, types for grid summary

- [ ] Single active position state machine
- [ ] Activate / TP / SL / capital update / one-shot levels
- [ ] Restore + idempotent fills

### Task 4: Lifecycle tests

**Files:** `gridDirectionalLifecycle.test.ts`

- [ ] Mandatory path 100→105→110→115→120→100→95→90
- [ ] One-position, capital carry, no recreate

### Task 5: Dashboard

**Files:** `DashboardPage.tsx`, api types

- [ ] Active position panel; level statuses TP_HIT/SL_HIT; current capital
