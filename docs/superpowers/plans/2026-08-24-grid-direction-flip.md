# Grid Direction Flip Implementation Plan

> **For agentic workers:** Inline execution in this session (user approved Approach 1).

**Goal:** Flip grid so LONGs are below start and SHORTs above start, with TAKE_PROFIT_MARKET entries and normal TP/SL.

**Architecture:** Change pure math and crossing in `gridCalc.ts`, wire trader activation/orders/exhaustion bounds, light dashboard validation, update tests.

**Tech Stack:** TypeScript, Decimal.js, Jest, React dashboard.

## Global Constraints

- Do not change capital scaling or destroy rules
- Keep existing TP/SL formulas from entry
- Entry: TAKE_PROFIT_MARKET else MARKET
- No commit unless user asks

---

### Task 1: gridCalc orientation + crossing

**Files:** `backend/src/modules/trader/grid/gridCalc.ts`, `backend/tests/unit/gridCalc.test.ts`

- Flip `calcGridTriggerPrice`
- Flip `isEntryTriggered`, `didCrossEntry`, `findTriggeredPendingLevels`
- Add `assertDirectionalTpSl` / `isValidDirectionalTpSl`
- Fix exhaustion helper param docs; keep ±% math
- Update unit tests

### Task 2: GridDirectionalTrader

**Files:** `backend/src/modules/trader/grid/GridDirectionalTrader.ts`

- Flip side selection in `tryActivateNextLevel` and `logGridEvaluation`
- Flip `alreadyThrough`; use TAKE_PROFIT_MARKET
- Exhaustion: upper from last SHORT, lower from last LONG
- Call TP/SL assert on fill

### Task 3: Dashboard validation

**Files:** `frontend/src/pages/DashboardPage.tsx`

- Warn when LONG/SHORT TP/SL invariants break

### Task 4: Lifecycle tests + verify

**Files:** `backend/tests/lifecycle/gridDirectionalLifecycle.test.ts`

- Update price paths for new orientation
- Entry type expectation TAKE_PROFIT_MARKET
- Run unit + lifecycle tests
