# Design: Directional Grid Trader (`grid_directional`)

**Date:** 2026-08-18  
**Branch:** `feature/grid-directional-trader`  
**Status:** Design approved in chat (selection mode **A**); awaiting written-spec review.

## Goal

Add a **new**, selectable trader behavior: a directional pyramiding grid with 20 Stop-Limit entries (10 LONG above / 10 SHORT below an immutable `startPrice`). Positions stay open after fill until trader-level exit. Existing **reversal** strategy must remain the default and stay behaviorally unchanged.

## Strategy selection (choice A)

| Config | Values | Default |
|--------|--------|---------|
| `TRADER_BEHAVIOR` / `traderBehavior` | `reversal` \| `grid_directional` | `reversal` |

- **Global** for the process: all traders use one behavior.
- Wired like other knobs: env → Joi → `Configuration` upsert → `TraderConfig` → `TraderManager` factory.
- Changing behavior mid-run applies to **new** traders after slot recycle (existing traders keep their created behavior until completed). Prefer documenting restart for a clean switch.

## Non-goals / safety

- Do **not** modify reversal TP/SL loop semantics when `traderBehavior === 'reversal'`.
- No per-level take-profits.
- No trailing/recentering grid.
- No new max-loss exit (only: combined TP, max lifetime, full-side activation).
- Do not invent a second balance/fee/PnL system — reuse `AccountLedger`, `fees.ts`, pool selection.

## Architecture (Approach 1)

```
TraderManager.createTrader(symbol)
  ├─ reversal           → existing Trader
  └─ grid_directional   → GridDirectionalTrader (new)
```

Shared infrastructure (unchanged contracts):

- `IExecutionProvider` / Live / Simulation (STOP_LIMIT already supported)
- `AccountLedger.getAllocation(maxTraders, leverage)`
- `selectReplacementSymbols` + `reconcileTraderPool`
- Dashboard WS `TRADER_SNAPSHOT` / `SUMMARY` (extend payload for grid)
- Hedge mode (already forced `setHedgeMode(true)`) — required so LONG and SHORT can coexist

New code (isolated):

- `backend/src/modules/trader/grid/gridCalc.ts` — pure Decimal math
- `backend/src/modules/trader/grid/GridDirectionalTrader.ts` — lifecycle / exit FSM
- Prisma `GridLevel` + Trader grid fields
- Frontend grid ladder when behavior is grid

## Configuration

| Env / field | Default | Notes |
|-------------|---------|--------|
| `TRADER_BEHAVIOR` | `reversal` | Selects factory path |
| `GRID_LEVELS_PER_SIDE` | `10` | N levels each side → 2N orders |
| `GRID_DISTANCE_PERCENT` | `5` | Percent points of **startPrice** (not compounded) |
| `TRADER_TAKE_PROFIT_PERCENT` | `10` | Combined net PnL / allocation × 100 |
| `TRADER_MAX_LIFETIME_HOURS` | `12` | Grid lifetime only; reversal keeps `TRADER_LIFETIME_HOURS` |

All values configurable; no hardcoding in strategy logic beyond defaults in Joi.

## Immutable start price

On trader create (after symbol mark/last price available):

1. Capture `startPrice` (mark price preferred, consistent with existing price feed).
2. Persist immediately; never recalculate; never trail.

## Grid price formula (non-compounded)

```
LONG  level L: startPrice * (1 + L * distancePercent / 100)
SHORT level L: startPrice * (1 - L * distancePercent / 100)
```

Example `start=100`, `distance=5`, `L=1..10`:

- LONG: 105 … 150  
- SHORT: 95 … 50  

Persist every level’s trigger (and limit) so restarts do not rebuild different prices.

## Stop-Limit policy

- Order type: `STOP_LIMIT` (Binance `STOP` via existing Algo path; sim uses PENDING → TRIGGERED → limit fill).
- LONG: BUY stop above start; SHORT: SELL stop below start.
- **Limit price:** deterministic offset from stop toward fill direction, tick-normalized via existing `adjustPrice` / symbol filters (do not use JS `Math.round`). Exact offset = one tick or a small configurable fraction of tick — document in implementation plan after reading current sim/live helpers; must pass risk validation and Binance filters.
- Do **not** mark filled on stop touch alone (sim already enforces this).

## Capital scaling

- Trader allocation = existing ledger slice (e.g. equity / `maxTraders`).
- Weights per side: `1..N` (default N=10 → sum 55 per side, **110** total).
- `baseUnit = allocation / totalWeight`
- `levelMargin = baseUnit * level`
- `notional = levelMargin * leverage`
- `qty = adjustQuantity(notional / price)` then recompute actual notional/margin; **sum of actual margins ≤ allocation** (deterministic remainder policy: floor toward lower levels / last-level absorb remainder without exceeding).

## Positions remain open

After a grid level fills:

- Create/update open position for that level.
- **No** individual TP/SL orders for that leg.
- Level status → FILLED; counts toward side activation.
- Multiple LONG and/or SHORT positions may be open concurrently (hedge mode).

## Combined PnL & trader TP

```
traderNetProfit = sum(unrealized net of open legs) + realized − applicable fees
                 (follow existing ledger conventions; prefer net after fees)
traderProfitPercent = traderNetProfit / traderAllocatedAmount * 100
```

Exit when `traderProfitPercent >= TRADER_TAKE_PROFIT_PERCENT`.  
Final accounting uses **actual** close fills, not the trigger mark alone.

## Exit conditions (only these)

1. Combined trader TP  
2. Max lifetime (`createdAt + TRADER_MAX_LIFETIME_HOURS`)  
3. All N levels on LONG filled → `FULL_LONG_GRID`  
4. All N levels on SHORT filled → `FULL_SHORT_GRID`  

Activation count = **FILLED** levels only (triggered-but-unfilled does not count).

### Exit priority / idempotency

1. If already `EXITING`+ → ignore duplicate exit requests.  
2. Prefer recording all conditions true at exit moment; primary `exitReason` priority: `TRADER_TP` > `FULL_LONG_GRID` / `FULL_SHORT_GRID` > `MAX_LIFETIME`.  
3. Single exit workflow; use order/execution IDs as fill idempotency keys.

### Exit FSM

`CREATING` → `ACTIVE` → `EXITING` → cancel pending grid orders → close all open positions → persist final PnL/fees → `COMPLETED` → manager releases slot → `reconcileTraderPool()`.

Also: `FAILED` on unrecoverable init/place failures.

## Database

**Extend `Trader`:** `behavior`, `startPrice`, `gridLevelsPerSide`, `gridDistancePercent`, `traderTakeProfitPercent`, `expiresAt` / lifetime, `exitReason`, grid counters (longFilled / shortFilled).

**New `GridLevel`:** `traderId`, `level`, `direction` (LONG|SHORT), `triggerPrice`, `limitPrice`, `weight`, `allocatedMargin`, `notional`, `quantity`, `status` (PENDING|TRIGGERED|LIMIT_ACTIVE|FILLED|CANCELED|…), exchange/sim order ids, timestamps, fill price/qty, fees.

Reuse `Order` / `Position` / `Trade` where practical (`hedgeLevel` = grid level number; role = LONG/SHORT).

Transactions for create (trader + all levels) and exit (cancels/closes/final stats).

## Frontend

When `traderBehavior === 'grid_directional'`:

- Top summary: Balance, Equity, PnL, 24h high/low, active/max traders, mode, strategy label  
- Top gainers strip  
- Trader cards: start/current price, allocation, used margin, PnL/%, lifetime, exit TP, long/short activated counts  
- **Vertical price ladder** with start price band, current-price marker, per-level status/allocation/PnL  
- Responsive mobile layout  

When `reversal`: keep existing dashboard cards/panels.

## Testing (minimum)

Unit: non-compounded prices; weight sum 110; margin caps.  
Sim lifecycle: stop→trigger→limit→fill; multi LONG keep-open; no close at next level; both sides; TP/lifetime/full-side exits; single exit under race; restart restore.  
Scenarios A–E from product spec.  
Regression: existing reversal lifecycle tests still pass with `traderBehavior=reversal`.

## Docker

- Migration `0010_…` for schema  
- Env vars in `.env.example` (+ compose env if needed)  
- Dev: `prisma db push` / prod: `migrate deploy` (existing compose commands)

## Funding

If existing bot does not account for funding fees, document as known limitation; do not build a parallel funding subsystem in this work.

## Assumptions

1. Mark price is the authoritative start/trigger working type (matches current Binance client `workingType: MARK_PRICE`).  
2. One trader per symbol remains (existing pool rule).  
3. Reversal `TRADER_LIFETIME_HOURS` and grid `TRADER_MAX_LIFETIME_HOURS` are separate knobs.  
4. Limit offset policy finalized in implementation plan with a concrete tick-based rule.
