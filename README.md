# Binance Futures Trading Bot

A production-grade automated trading platform for Binance Futures perpetual contracts.

## Architecture

```
futures-bot/
├── backend/          # Node.js + TypeScript API server + BullMQ workers
│   ├── src/
│   │   ├── config/          # Environment configuration with validation
│   │   ├── modules/
│   │   │   ├── binance/     # Binance REST client (with circuit breaker + retry)
│   │   │   ├── websocket/   # WebSocket manager (reconnect, heartbeat, dedup)
│   │   │   ├── execution/   # IExecutionProvider, Live + Simulation providers
│   │   │   ├── trader/      # Individual Trader state machine
│   │   │   ├── trader-manager/ # Manages trader lifecycle + symbol selection
│   │   │   ├── orders/      # Order management
│   │   │   ├── positions/   # Position tracking
│   │   │   ├── risk/        # Pre-trade risk checks
│   │   │   ├── statistics/  # PnL + metrics calculation
│   │   │   ├── jobs/        # BullMQ queues + workers
│   │   │   ├── persistence/ # State persistence
│   │   │   ├── logger/      # Winston structured logging
│   │   │   └── utils/       # Precision math, retry, circuit breaker
│   │   ├── api/             # Express REST API + WS dashboard
│   │   ├── app.ts           # Express app factory
│   │   └── server.ts        # Bootstrap entry point
│   ├── prisma/
│   │   └── schema.prisma    # PostgreSQL schema
│   └── tests/
│       ├── unit/            # Unit tests (precision, retry, etc.)
│       ├── integration/     # Integration tests
│       └── simulation/      # End-to-end simulation tests
├── frontend/         # React + TypeScript dashboard
│   └── src/
│       ├── pages/           # Dashboard, Traders, Orders, Statistics, etc.
│       ├── components/      # Layout, charts, tables
│       ├── stores/          # Zustand state (systemStore)
│       ├── services/        # API client + WebSocket
│       └── hooks/           # React Query hooks
├── nginx/            # Production nginx config
├── docker-compose.yml       # Development
└── docker-compose.prod.yml  # Production
```

## Prerequisites

- Docker
- Docker Compose
- Binance Futures API key & secret

## Quick Start

```bash
# Clone and configure
cp futures-bot/.env.example futures-bot/.env
# Edit .env: set BINANCE_API_KEY, BINANCE_SECRET_KEY, JWT_SECRET

# Start everything (development mode — hot reload)
cd futures-bot
docker compose up --build
```

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5000
- **Database admin** (optional): http://localhost:8080 — run with `docker compose --profile tools up`

## Production Deployment

```bash
cp futures-bot/.env.example futures-bot/.env.prod
# Edit .env.prod with production values

docker compose -f docker-compose.prod.yml up --build -d
```

## Trading Strategy

### Symbol Selection
- Continuously monitors Binance Futures 24-hour statistics
- Selects the top `MAX_TRADERS` gainers (configurable)
- Excludes: leveraged tokens, non-USDT pairs, already-assigned symbols
- Never replaces active traders when rankings change
- Fills freed slots immediately when a trader completes

### Trader Lifecycle (Strategy V2 — Position Reversal)
1. **Initialization**: Open MARKET position (`STARTING_SIDE`, default SHORT) with TP + SL
2. **Active**: Always one position. TP → reopen same side; SL → reopen opposite side
3. **Completion**: After `TRADER_LIFETIME_HOURS` (default 24)
4. On completion: close position → cancel orders → persist stats → free slot → spawn replacement

### Example (Price = 100, TP/SL = 10%)
```
Position #1 SHORT @ 100
  TP 90 → Position #2 SHORT
  SL 110 → Position #2 LONG
```

## Trading Modes

### Simulation (default)
- Uses real Binance Futures mark prices via WebSocket
- Simulates order execution with latency (50–100ms), slippage, and fees
- Identical calculations to live mode
- Safe for testing without real money

### Live
- Places real orders on Binance Futures
- Set `TRADING_MODE=LIVE` in `.env`
- **Use with extreme caution — real funds at risk**

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/traders` | All traders |
| GET | `/api/traders/active` | Active trader summaries |
| GET | `/api/traders/:id` | Trader detail with orders/trades |
| POST | `/api/traders/pause` | Pause all traders |
| POST | `/api/traders/resume` | Resume all traders |
| POST | `/api/traders/emergency-stop` | Emergency stop + close all |
| GET | `/api/orders` | Orders (filterable by traderId, status, symbol) |
| GET | `/api/positions` | Open positions |
| GET | `/api/statistics` | Global statistics |
| GET | `/api/statistics/summary` | Live summary |
| GET | `/api/system/health` | System health |
| GET | `/api/system/logs` | Application logs |
| GET | `/api/config` | Current configuration |
| PATCH | `/api/config` | Update configuration |

WebSocket dashboard: `ws://localhost:3001/ws` — receives real-time trader events.

## Configuration

All trading parameters are configurable via environment variables or the `/api/config` API:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `RESET_DB_ON_START` | true | Wipe trading history + reset sim balance on every boot |
| `MAX_TRADERS` | 1 | Maximum concurrent traders |
| `INITIAL_CAPITAL` | 1000 | Initial capital per trader (USDT) |
| `POSITION_SIZE` | 100 | Position size in USDT |
| `LEVERAGE` | 10 | Futures leverage multiplier |
| `MARGIN_MODE` | ISOLATED | ISOLATED or CROSSED |
| `TRADER_LIFETIME_HOURS` | 24 | Destroy + replace trader after this many hours |
| `TAKE_PROFIT_PERCENT` | 0.10 | TP distance from entry (reopens same side) |
| `STOP_LOSS_PERCENT` | 0.10 | SL distance from entry (reopens opposite side) |
| `STARTING_SIDE` | SHORT | First position side (`SHORT` or `LONG`) |
| `REFRESH_INTERVAL` | 60000 | Symbol refresh interval (ms) |
| `FEE_RATE` | 0.0004 | Binance taker fee rate |
| `SLIPPAGE` | 0.0001 | Simulated market slippage |

## Running Tests

```bash
cd futures-bot/backend

# All tests
npm test

# Unit tests only
npm run test:unit

# Simulation tests
npm run test:simulation

# Coverage report
npm run test:coverage
```

## Reliability Features

- **Automatic reconnect**: WebSocket streams reconnect with exponential backoff
- **Circuit breaker**: Binance REST API calls protected by circuit breaker
- **Deduplication**: WebSocket events deduplicated by ID + timestamp
- **Retry policies**: All critical operations retry with configurable limits
- **State recovery**: Full trading state restored from PostgreSQL on restart
- **Graceful shutdown**: SIGTERM/SIGINT triggers orderly shutdown
- **No unhandled rejections**: All promise rejections are caught and logged
- **Gap detection**: Heartbeat monitoring for WebSocket connections

## Risk Controls

- Duplicate order guard (clientOrderId deduplication)
- Position size validation against exchange minimums
- Minimum notional validation
- Leverage validation against symbol maximum
- Clock drift detection
- Exchange precision enforcement via Decimal.js
- Leveraged token filtering (UP, DOWN, BEAR, BULL, 2L, 2S, 3L, 3S)
- Duplicate symbol/trader guard

## Tech Stack

**Backend**: Node.js 20 LTS, TypeScript 5, Express, Prisma ORM, PostgreSQL 16, Redis 7, BullMQ, Winston, Decimal.js, Jest

**Frontend**: React 18, TypeScript, Vite, Material UI 5, React Query (TanStack), Zustand, Recharts

**Infrastructure**: Docker, Docker Compose, nginx

## Development

```bash
# Backend only (requires postgres + redis running)
cd futures-bot/backend
npm install
npm run prisma:generate
npm run dev

# Frontend only
cd futures-bot/frontend
npm install
npm run dev

# Lint
npm run lint

# Format
npm run format
```

## Security Notes

- Store API keys in `.env` files only — never commit them
- Use `ISOLATED` margin mode to limit risk per position
- Test extensively in `SIMULATION` mode before enabling `LIVE`
- Set `BINANCE_TESTNET=true` to use the Binance Futures testnet in live mode
- The JWT secret must be at least 32 characters
