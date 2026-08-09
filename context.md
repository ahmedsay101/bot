# Trading Bot Project Context

## Overview
Production-grade Binance Futures trading platform with Live and Testing modes sharing the same trading/calculation engine.

## Stack
- Node.js + TypeScript
- React + Vite
- PostgreSQL + Prisma
- Redis + BullMQ
- Docker Compose
- Binance Futures REST/WebSockets
- Decimal.js

## Strategy V2 — Position Reversal
- One trader per symbol; one active position at a time (no hedges).
- Trader lifetime is elapsed time (`traderLifetimeHours`, default 24h), not PnL.
- On start: freeze trader allocation; open MARKET at **capital Step 1** (`startingSide`, default SHORT).
- Capital steps (`CAPITAL_STEPS`, default 5): Step N margin = allocation × N / steps; notional = margin × leverage.
- Place Take Profit and Stop Loss (defaults 10% each, configurable decimals e.g. `0.10`).
- **TP hit** → step +1 (cap at max) + same direction.
- **SL hit** → step −1 (floor at 1) + opposite direction.
- Step amounts are fixed from create-time allocation — not affected by PnL/balance.
- Continuous trading until lifetime ends.
- After lifetime: close position, cancel orders, persist stats, destroy trader, free slot, spawn next top-gainer trader.
- Binance dual-side (hedge) mode may still be used for positionSide LONG/SHORT, but strategy never holds two legs.

## Modes
Live:
- Real Binance prices, orders and account balances.
- Conditionals via Algo Order API (`POST /fapi/v1/algoOrder`, `workingType=MARK_PRICE`).
- Domain `STOP_LIMIT` → Binance `STOP`; dual-side mode omits `reduceOnly`.
- Fills from `ORDER_TRADE_UPDATE` + `ALGO_UPDATE` (null avg price enriched from TP/stop/mark).
- User-data stream required (boot fails in LIVE if listen-key subscribe fails).
- Account reconciled from Binance wallet / maintMargin / income.

Testing:
- Real Binance mark prices (WebSocket + REST fallback).
- Simulated execution — Binance-aligned order state machine.
- STOP_MARKET / TAKE_PROFIT evaluated on mark updates.
- Starting Balance = 200 USDT.
- Same calculation engine as Live.
- Open conditionals rehydrated into the sim book after restart.

## Account (single source of truth)
- Balance = wallet cash after realized trades + fees
- Realized PnL = cumulative closed-trade net PnL
- Unrealized PnL = mark-to-market on open positions
- Equity = Balance + Unrealized PnL
- Used margin = sum(notional / leverage); Available = Equity − Used
- Position sizing uses Balance (not equity-with-unrealized)
- Trader allocation = Balance / MaxTraders × Leverage (single position)

## Lifecycle
Created → Assigned Symbol → Open First Position → Trade Continuously → 24h Elapsed → Close Position → Cancel Orders → Persist Stats → Destroyed → Slot Released → Replacement from top gainers.
- Completion is idempotent; order updates serialized per trader.
- Positions + Trades + timeline persisted for API/history/restart.

## Dashboard
- Balance, Equity, Today's PnL, Realized, Unrealized, Active traders/positions, Mode, Bot status
- Trader cards: countdown, current position, TP/SL viz, stats, position timeline
- WS pushes full snapshots + summary on connect; REST merges without clobbering WS

## Config knobs
- `MAX_TRADERS` (default 1)
- `TRADER_LIFETIME_HOURS` (default 24)
- `TAKE_PROFIT_PERCENT` / `STOP_LOSS_PERCENT` (decimals, default `0.10`)
- `STARTING_SIDE` (`SHORT` | `LONG`, default `SHORT`)
- Also configurable via DB Configuration + Settings UI

## Engineering
- Docker only
- Event-driven order book evaluation (no poll for triggers)
- Decimal.js everywhere for money math
- Persistent state + restart recovery
- Runtime config PATCH hot-applies to TraderManager
- Boot syncs Configuration fields from env
- `RESET_DB_ON_START=true` (default) wipes traders/orders/positions/trades + resets sim ledger to 200 on every boot
- RiskManager validates every placed order
- No duplicated business logic
