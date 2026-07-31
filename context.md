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

## Modes
Live:
- Real Binance prices, orders and account equity.

Testing:
- Real Binance prices.
- Fake execution for Market, Stop-Limit, TP, SL and order lifecycle.
- Fixed equity = 200 USDT.
- Same calculation engine as Live.

## Equity
Live equity comes from Binance Futures USDT wallet balance.
Testing equity = 200 USDT + realized PnL.
Trader allocation = Total Equity / MaxTraders.
Each trader splits its allocation equally between Main Short and Hedge.
Position notional = Allocation × Leverage.
`positionSize` config is ignored for order sizing (equity formula is the only source of truth).

## Dashboard
Keep it simple:
- Equity
- Total PnL
- Active traders
- Top gainers
- Trader cards

Each trader should include a ladder/grid visualizing:
- Current price
- Main short
- Main TP
- Active hedge
- Hedge SL
- Hedge TP
- Pending hedge levels

## Engineering
- Docker only
- Event-driven
- Decimal.js
- Persistent state
- Restart recovery
- No race conditions
- No duplicated business logic
- No unhandled errors
