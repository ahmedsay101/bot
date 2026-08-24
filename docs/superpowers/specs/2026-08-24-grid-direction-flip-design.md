# Grid Direction Flip — Design

**Date:** 2026-08-24  
**Status:** Approved (Approach 1, entry order A)  
**Scope:** Reverse LONG/SHORT grid orientation around start price; keep capital scaling, destroy rules, and PnL accounting unchanged.

## Goal

Directional grid must follow normal trading convention:

```
SHORT #N … SHORT #1   (entries ABOVE start)
========== START ==========
LONG #1 … LONG #N     (entries BELOW start)
```

- LONG: entry below start; TP above entry; SL below entry  
- SHORT: entry above start; TP below entry; SL above entry  
- TP/SL always from **actual position entry**, not start price  

## Decisions

| Decision | Choice |
|----------|--------|
| Approach | **1** — Flip math + crossing + entry order type; minimal blast radius |
| Entry orders (not already through) | **`TAKE_PROFIT_MARKET`** |
| Entry orders (already through) | **`MARKET`** |
| Capital / destroy / PnL | **Unchanged** |

## Current → Target

| Area | Current | Target |
|------|---------|--------|
| LONG triggers | `start × (1 + s×L)` above | `start × (1 − s×L)` below |
| SHORT triggers | `start × (1 − s×L)` below | `start × (1 + s×L)` above |
| LONG entry | `mark ≥ trigger` | `mark ≤ trigger` |
| SHORT entry | `mark ≤ trigger` | `mark ≥ trigger` |
| Side vs start | mark>start → LONG; mark<start → SHORT | mark>start → SHORT; mark<start → LONG |
| Entry order | `STOP_MARKET` | `TAKE_PROFIT_MARKET` (else `MARKET`) |
| TP/SL formulas | Already normal from entry | **Keep** |
| TP/SL mark detect | Already correct | **Keep** |
| Exhaustion display | Upper from last LONG; lower from last SHORT | Upper from last SHORT; lower from last LONG |

## Architecture

### Pure math (`gridCalc.ts`)

1. **`calcGridTriggerPrice`** — invert LONG/SHORT factors.  
2. **`isEntryTriggered` / `didCrossEntry`** — invert comparisons for the new sides.  
3. **`findTriggeredPendingLevels`** — invert side when mark ≠ start.  
4. **`calcLevelTpSlPrices` / `isTpTriggeredByMark` / `isSlTriggeredByMark`** — no formula change; add `assertDirectionalTpSl` (throws or returns false) for LONG `tp>entry>sl`, SHORT `sl>entry>tp`.  
5. **`getUpperGridExhaustionPrice` / `getLowerGridExhaustionPrice`** — keep ±% helpers; callers pass last SHORT for upper and last LONG for lower.  
6. **`calcGridLimitPrice`** — review for dip-buy / rally-sell if LIMIT still used anywhere; entry path uses TP_MARKET.

### Trader (`GridDirectionalTrader.ts`)

1. **`tryActivateNextLevel` / `logGridEvaluation`** — side selection: below start → LONG; above → SHORT.  
2. **`activateLevel`** — `alreadyThrough` flipped; order type `TAKE_PROFIT_MARKET` vs `MARKET`.  
3. **`getExhaustionBounds`** — upperDestroy from last SHORT; lowerDestroy from last LONG.  
4. Protective fills / close / capital — unchanged.

### Simulation & Live

- Sim already implements TAKE_PROFIT_* triggers (`BUY: mark≤stop`, `SELL: mark≥stop`).  
- Live provider must place the same type/side/stopPrice/positionSide; no parallel accounting.

### Dashboard

- Ladder remains high→low price sort (SHORT above start, LONG below — automatic).  
- Dev/test safeguard: if LONG TP≤entry or SHORT TP≥entry, surface an obvious warning (do not silently show wrong TP/SL as valid).

### Out of scope

- Capital scaling modes  
- Destroy rules (`MAX_LIFETIME`, `ALL_GRID_POSITIONS_TP`)  
- Realized/unrealized PnL close finalization  
- Migrating already-open traders mid-flight (new/restored plans use new math; existing DB levels keep stored prices until trader rebuild)

## Data flow

```
startPrice + spacing + levelsPerSide
        → buildGridLevelPrices (flipped triggers + existing TP/SL from trigger)
        → activate when mark crosses (flipped)
        → TAKE_PROFIT_MARKET / MARKET entry
        → on fill: recalc TP/SL from actual entry (existing)
        → protective exits (existing)
```

## Testing

Unit (`gridCalc.test.ts`): generation orientation; TP/SL invariants; entry/TP/SL crossing + gaps; side selection.

Lifecycle (`gridDirectionalLifecycle.test.ts`): update price paths that assumed LONG above / SHORT below; keep capital OFF/ON and destroy tests; add smoke for LONG dip→TP and SHORT rally→TP.

Do not change capital or destroy expectations.

## Acceptance

- Backend grid matches SHORT-above / LONG-below  
- LONG TP>entry>SL; SHORT SL>entry>TP  
- Downward cross activates LONG; upward activates SHORT  
- Entries use TAKE_PROFIT_MARKET / MARKET  
- Dashboard reflects backend; invalid TP/SL obvious in dev  
- Capital scaling and destroy rules unchanged  
- Tests green (unit + lifecycle)
