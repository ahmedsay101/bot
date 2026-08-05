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

## Strategy
- Spawn one trader per configurable top 24h gainer.
- Each trader immediately opens one MARKET SHORT.
- Create one LONG STOP-LIMIT hedge above the short entry (configurable distance, default 10%).
- Main short has no SL and configurable TP (default 10% below entry).
- Hedge SL = entry × (1 − hedgeSl%), default 3%; TP = entry × (1 + hedgeTp%), default 10%.
- Hedge hitting SL recreates itself with identical Entry/SL/TP.
- Hedge hitting TP creates the next hedge from that TP fill.
- Hedge lifecycle stats (created/triggered/opened/closed/SL/TP/recreates) persist on Trader.
- Trader only ends when the original short reaches TP.
- After completion, free the slot and spawn a new trader using the latest eligible top gainer.
- Requires Hedge Mode (dual-side): SHORT + LONG held together via `positionSide`.

## Modes
Live:
- Real Binance prices, orders and account balances.
- Conditionals via Algo Order API (`POST /fapi/v1/algoOrder`, `workingType=MARK_PRICE`).
- Domain `STOP_LIMIT` → Binance `STOP`; hedge mode omits `reduceOnly`.
- Fills from `ORDER_TRADE_UPDATE` + `ALGO_UPDATE` (null avg price enriched from TP/stop/mark).
- User-data stream required (boot fails in LIVE if listen-key subscribe fails).
- Account reconciled from Binance wallet / maintMargin / income.

Testing:
- Real Binance mark prices (WebSocket + REST fallback).
- Simulated execution — Binance-aligned order state machine.
- STOP_LIMIT: PENDING → TRIGGERED (limit active) → FILLED when limit executable.
- Partial fills: PARTIALLY_FILLED then remainder → FILLED.
- Starting Balance = 200 USDT.
- Same calculation engine as Live.
- Open conditionals rehydrated into the sim book after restart.

## Account (single source of truth)
- Balance = wallet cash after realized trades + fees
- Realized PnL = cumulative closed-trade net PnL
- Unrealized PnL = mark-to-market on open positions
- Equity = Balance + Unrealized PnL
- Used margin = sum(notional / leverage); Available = Equity − Used
- Maintenance margin = Binance brackets (`notional × MMR − cum`) per leg
- Position sizing uses Balance (not equity-with-unrealized)
- Trader allocation = Balance / MaxTraders / 2 × Leverage per leg

## Lifecycle
Created → Short Opened → Hedge Ladder Active → Trading → Short TP Hit → Apply Realized → Cancel Hedges → Close Leftover Positions → Completed → Destroyed → Slot Released → Replacement from top gainers.
- Rewrites `COMPLETING` on restart; completion is idempotent; order updates serialized per trader.
- Positions + Trades persisted on open/close for API/history.

## Dashboard
- Balance, Equity, Today's PnL, Realized, Unrealized
- Active traders, Open positions, Used/Available margin
- Top gainers, Bot status, Live/Testing mode
- Trader cards: price-ordered strategy ladder, hedge stats, order strip (identical on mobile)
- WS pushes full snapshots + summary on connect; REST merges without clobbering WS

## Engineering
- Docker only
- Event-driven order book evaluation (no poll for triggers)
- Decimal.js everywhere for money math
- Persistent state + restart recovery
- Runtime config PATCH hot-applies to TraderManager
- Boot syncs all Configuration fields from env (default `MAX_TRADERS=1`)
- `RESET_DB_ON_START=true` (default) wipes traders/orders/positions/trades + resets sim ledger to 200 on every boot
- RiskManager validates every placed order
- No duplicated business logic
