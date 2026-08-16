# Design: `switchPositionOnTakeProfit`

**Date:** 2026-08-16  
**Status:** Approved in chat (capital-step choice A); awaiting spec file review before implementation.

## Goal

Add a configurable boolean that inverts **next-side** selection after TP vs SL, while keeping today’s behavior as the default.

## Current behavior (must remain default)

In `backend/src/modules/calc/strategy.ts` → `nextSideAfterClose`:

- **TP** → same side (LONG→LONG, SHORT→SHORT)
- **SL** → opposite side (LONG→SHORT, SHORT→LONG)

Capital steps (`nextStepAfterClose`) are independent:

- **TP** → step + 1 (capped at `capitalSteps`)
- **SL** → reset to Step 1

Close path lives in `Trader.closePosition`: cancel sibling protective order, book fees/PnL, apply step progression, then `openPosition(nextSide)`. Duplicate closes are guarded by `closeHandled` / `handledCloseIds`.

## Configuration

| Field | Value |
|-------|--------|
| Config / API / UI name | `switchPositionOnTakeProfit` |
| Env | `SWITCH_POSITION_ON_TAKE_PROFIT` |
| Type | `boolean` |
| **Default** | **`false`** (preserve production) |

Wire through the same path as other trading knobs:

1. Joi + `config.trading` (`backend/src/config/index.ts`)
2. `TraderConfig` (`backend/src/types/index.ts`)
3. Server bootstrap upsert + `traderConfig` object (`backend/src/server.ts`)
4. Prisma `Configuration` column (migration if missing)
5. Config API allow-list + runtime hot-apply (`api/routes/config.ts`, `TraderManager.applyRuntimeConfig`)
6. Configuration UI toggle (`frontend` Configuration page)
7. `.env.example` documentation

Existing APIs remain compatible: new optional/DB-defaulted field; omitting it keeps current behavior.

## Behavior matrix

| `switchPositionOnTakeProfit` | After TP | After SL | Capital steps |
|------------------------------|----------|----------|---------------|
| `false` (default) | same side | opposite side | unchanged (TP↑ / SL→1) |
| `true` | opposite side | same side | unchanged (TP↑ / SL→1) |

Examples when flag is `true`:

- LONG TP → SHORT  
- SHORT TP → LONG  
- LONG SL → LONG  
- SHORT SL → SHORT  

## Implementation approach (chosen)

**Extend the pure SSOT** `nextSideAfterClose(current, reason, options?)` rather than branching only inside `Trader` or introducing parallel strategy classes.

Suggested signature:

```ts
nextSideAfterClose(
  current: TradeSide,
  reason: 'TP' | 'SL',
  opts?: { switchPositionOnTakeProfit?: boolean },
): TradeSide
```

When `opts?.switchPositionOnTakeProfit !== true`, behavior is bit-identical to today.

`Trader.closePosition` passes `this.traderConfig.switchPositionOnTakeProfit` and logs the chosen rule:

- flag on: `TP → opposite position` / `SL → same position`
- flag off: existing lifecycle wording (same after TP / reverse after SL)

No second open path: continue to use existing `openPosition`, order cancel, risk validation, and execution providers (Live / Simulation), including One-Way vs Hedge conventions already abstracted by the trader.

## Non-goals

- Changing TP%/SL% distances, leverage, sizing, fees, or lifetime
- Reintroducing consecutive-SL destroy/block
- Changing position mode on Binance
- Parallel close/open orchestration outside `closePosition`

## Edge cases

1. **Duplicate TP/SL events** — existing `closeHandled` / `handledFeeTradeIds` / `handledCloseIds` remain the sole reopen gate; flag does not add a second open.
2. **FORCE / EXPIRED** — no continuous reopen via this rule (existing complete/force paths unchanged).
3. **Hot-apply mid-trade** — next close after apply uses the new flag; open position is not flipped in place.
4. **Restore after restart** — side comes from restored state; next close uses current runtime config.
5. **Sibling cancel before reopen** — unchanged; must complete before `openPosition`.

## Tests

**Unit (`strategy.test.ts` / related):**

- Flag off: LONG/SHORT × TP/SL → current expectations  
- Flag on: LONG→TP→SHORT, SHORT→TP→LONG, LONG→SL→LONG, SHORT→SL→SHORT  

**Lifecycle / integration:**

- Flag on: TP and SL paths open correct next side (Simulation provider)  
- Flag off: regression = existing behavior  
- Duplicate close event does not open a second position  
- Failed place / retry continues to use existing provider retry (no new dual-open)

Capital-step tests remain unchanged (steps independent of side flag).

## Assumptions

- “Opposite position” means opposite **position side** (`LONG`/`SHORT`) via existing `openPosition` / `marketSideForPosition`, not raw order-side flipping outside that abstraction.
- Capital-step rules stay coupled to TP/SL **reason**, not to whether the side flipped (user choice A).
