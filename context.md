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
- Create one LONG STOP-LIMIT hedge above the short entry.
- Main short has no SL and configurable TP.
- Hedge hitting SL recreates itself with identical parameters.
- Hedge hitting TP creates the next hedge level.
- Trader only ends when the original short reaches TP.
- After completion, free the slot and spawn a new trader using the latest eligible top gainer.
- Requires Hedge Mode (dual-side): SHORT + LONG held together via `positionSide`.

## Modes
Live:
- Real Binance prices, orders and account balances.
- Conditionals via Algo Order API (`POST /fapi/v1/algoOrder`, `workingType=MARK_PRICE`).
- Domain `STOP_LIMIT` → Binance `STOP`; hedge mode omits `reduceOnly`.
- Account reconciled from Binance wallet / maintMargin / income.

Testing:
- Real Binance mark prices (WebSocket + REST fallback).
- Simulated execution — Binance-aligned order state machine.
- STOP_LIMIT: PENDING → TRIGGERED (limit active) → FILLED when limit executable.
- Partial fills: PARTIALLY_FILLED then remainder → FILLED.
- Starting Balance = 200 USDT.
- Same calculation engine as Live.

## Account (single source of truth)
- Balance = wallet cash after realized trades + fees
- Realized PnL = cumulative closed-trade net PnL
- Unrealized PnL = mark-to-market on open positions
- Equity = Balance + Unrealized PnL
- Used margin = sum(notional / leverage); Available = Equity − Used
- Maintenance margin = Binance brackets (`notional × MMR − cum`) per leg
- Position sizing uses Balance (not equity-with-unrealized)
- Trader allocation = Balance / MaxTraders / 2 × Leverage per leg

## Dashboard
- Balance, Equity, Today's PnL, Realized, Unrealized
- Active traders, Open positions, Used/Available margin
- Top gainers, Bot status, Live/Testing mode
- Trader cards: strategy ladder (not candlesticks), hedge #, losses, orders

## Engineering
- Docker only
- Event-driven order book evaluation (no poll for triggers)
- Decimal.js everywhere for money math
- Persistent state + restart recovery
- No duplicated business logic
