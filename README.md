# Mean-Reversion Trading Bot

Production-grade Binance USDT-M Futures bot implementing **Market Regime Detection + Mean Reversion** with high-fidelity test-mode execution simulation.

## Quick start

```bash
cp .env.example .env       # set BINANCE_*, JWT_SECRET, ADMIN_PASSWORD
docker compose up --build
```

In production the entire app is reachable on **port 80** through an nginx reverse proxy:

- Dashboard:     http://localhost/        → Next.js (`web` service, internal :3000)
- REST API:      http://localhost/api/    → bot (internal :4000)
- WebSocket:     ws://localhost/ws        → bot (internal :4000)
- Healthcheck:   http://localhost/healthz

The `bot`, `web`, `mongo`, and `redis` services are not directly exposed to the internet (mongo/redis are bound to `127.0.0.1` for local ops only).

Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

## Local development

```bash
npm install
npm --prefix dashboard install
npm run dev   # bot on :4000, Next.js on :3000 with /api proxied to bot
```

Open http://localhost:3000.

## Architecture

```
                            :80 (public)
                             │
                       ┌─────▼──────┐
                       │  nginx     │  reverse proxy
                       └──┬──────┬──┘
                /, /_next │      │ /api/*, /ws, /healthz
                          ▼      ▼
                  ┌────────────┐ ┌──────────────────────────────────────┐
                  │ Next.js    │ │            bot (Node/TS)             │
                  │ dashboard  │ │  marketData → scanner → strategy →   │
                  │ (web :3000)│ │  → riskManager → execution (live|test)│
                  └────────────┘ │  ↕ Mongoose models       ↕ pino logs │
                                 └──┬─────────────────────────────┬─────┘
                                    │ Redis pub/sub + BullMQ      │ Express + ws gateway
                                    ▼                             ▼
                             ┌──────────┐                  Binance WS / REST
                             │  redis   │
                             └──────────┘
                             ┌──────────┐
                             │  mongo   │
                             └──────────┘
```

## Modes

- `MODE=test` — `TestExecutionService` simulates orders against **real** Binance market data (slippage, fees, latency, partial fills, liquidation). State persists in MongoDB; survives restarts.
- `MODE=live` — `LiveExecutionService` places real Binance orders via REST with `clientOrderId` idempotency, listens to user-data WS, reconciles on boot.

Both implement the same `IExecutionService` interface — strategy code is identical in either mode.

## Strategy

1. **Symbol scanner** ranks USDT-M perps by `ATR/price * 0.6 - |slope| * 0.4`, drops trending symbols (`|slope| > thresholds.trendSlope`), picks top `maxSymbols`.
2. **Regime detector** classifies each symbol as RANGE / TREND from slope + ATR expansion.
3. **Strategy** trades only in RANGE: enters LONG when `RSI < oversold` near rolling support, SHORT mirror; exits when RSI returns to neutral, SL, or TP.
4. **Risk manager** sizes positions for 1% loss-at-SL using ATR-based stop distance.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Bot (tsx watch) + dashboard concurrently |
| `npm run build` | TypeScript compile + dashboard build |
| `npm start` | Run compiled bot |
| `npm test` | Vitest unit + integration |
| `npm run backtest -- BTCUSDT 2024-01-01 2024-02-01` | CLI backtest |

## Safety

- Hard kill-switch (Settings page) closes all positions and halts new entries.
- Hot-reloadable settings via Mongo change stream.
- Mongo or Redis loss in live mode forces DEGRADED state — no new orders.
