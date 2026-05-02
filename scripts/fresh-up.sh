#!/usr/bin/env bash
# Rebuild & restart the stack with a clean Mongo + Redis state.
# Use this whenever you want to discard old test trades, positions, balances.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Stopping stack..."
docker compose down

echo "==> Building & starting with reset profile..."
docker compose --profile reset up -d --build

echo "==> Waiting for db-reset to finish..."
docker compose wait db-reset || true

echo "==> Tail bot logs:"
docker compose logs -f --tail=50 bot
