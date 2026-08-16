# switchPositionOnTakeProfit Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox syntax.

**Goal:** Add `switchPositionOnTakeProfit` (default `false`) so TP/SL next-side can be inverted without changing capital steps or close lifecycle.

**Architecture:** Extend pure `nextSideAfterClose` with an optional flag; `Trader.closePosition` / `resumeIdlePosition` pass config; wire env → types → Prisma → API → UI.

**Tech Stack:** TypeScript, Prisma, Jest, React/MUI config page.

## Global Constraints

- Default `false` = today’s TP→same / SL→opposite
- Capital steps unchanged (TP↑ / SL→1)
- No parallel open path; keep `closeHandled` / sibling cancel
- Env: `SWITCH_POSITION_ON_TAKE_PROFIT`

---

### Task 1: Pure strategy + unit tests

**Files:**
- Modify: `backend/src/modules/calc/strategy.ts`
- Modify: `backend/tests/unit/strategy.test.ts`
- Modify: `backend/tests/unit/capitalSteps.test.ts` (if it calls `nextSideAfterClose` without opts — still valid)

- [ ] Extend `nextSideAfterClose(current, reason, opts?: { switchPositionOnTakeProfit?: boolean })`
- [ ] When flag true: TP→opposite, SL→same; else existing
- [ ] Tests for both modes × LONG/SHORT × TP/SL

### Task 2: Config wiring

**Files:** types, config Joi/env, server bootstrap, TraderManager hot-apply, config routes, prisma schema + migration `0009_switch_position_on_tp`, `.env.example`, frontend Configuration + api types

- [ ] `switchPositionOnTakeProfit: boolean` default false everywhere
- [ ] UI Switch with helper text describing both modes

### Task 3: Trader integration + lifecycle tests

**Files:**
- Modify: `backend/src/modules/trader/Trader.ts`
- Modify: `backend/tests/lifecycle/traderLifecycle.test.ts`
- Modify: test configs in `algoUpdate.test.ts` / lifecycle (add field)

- [ ] Pass flag into `nextSideAfterClose` in `closePosition` and `resumeIdlePosition`
- [ ] Log next-side rule on reopen
- [ ] Lifecycle: flag on LONG start → TP→SHORT, SL→LONG; SHORT start → TP→LONG, SL→SHORT; flag off regression; duplicate close still one position

### Task 4: Verify

- [ ] `npx tsc --noEmit` in backend
- [ ] `npx jest --testPathPattern="strategy|traderLifecycle|capitalSteps|algoUpdate"`
