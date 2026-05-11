#!/usr/bin/env bash
# -----------------------------------------------------------------
# dev.sh — one-command dev environment for TTRPG Tavern
#
# Starts Qdrant (if not already up), kills any stale dev node
# process, and launches the app with auto-reload on file changes.
#
# Uses prod LLM services (llama-server :8180, llama-director :8182,
# ollama :11434) — no extra GPU containers needed.
#
# To swap the Director to a reasoning model, set DIRECTOR_MODEL_FILE
# before starting the prod stack:
#   DIRECTOR_MODEL_FILE=Qwen3-32B-Thinking-Q5_K_M.gguf docker compose -f docker-compose.prod.yml up -d
# The app strips <think>/<thinking> tags automatically.
#
# Usage:
#   ./dev.sh          # start (or restart) dev
#   npm run dev       # same thing via package.json
# -----------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

DEV_PORT="${DEV_PORT:-8001}"
PIDFILE=".dev.pid"

# 1. Ensure dev Qdrant is running (idempotent)
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^ttrpgtavern-qdrant$'; then
    echo "[dev] Starting Qdrant..."
    docker compose up qdrant -d --wait
else
    echo "[dev] Qdrant already running"
fi

# 2. Kill any previous dev node process
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[dev] Stopping previous dev server (pid $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$PIDFILE"
fi

# 3. Fix data dir permissions if Docker left root-owned files
if [ -d data/default-user ] && [ "$(stat -c '%U' data/default-user 2>/dev/null)" = "root" ]; then
    echo "[dev] Fixing data directory permissions..."
    sudo chown -R "$(id -u):$(id -g)" data/ 2>/dev/null || echo "[dev] (could not fix permissions — run: sudo chown -R \$(id -u):\$(id -g) data/)"
fi

echo "[dev] Starting on http://localhost:${DEV_PORT}"
echo "[dev] LLM endpoints: llama-server :8180, llama-director :8182, ollama :11434"
echo "[dev] Press Ctrl+C to stop"
echo ""

# 4. Launch with nodemon for auto-reload, --port overrides config.yaml
npx nodemon \
    --watch src \
    --watch public \
    --ext js,mjs,json,css,html \
    --ignore 'data/**' \
    --ignore 'node_modules/**' \
    --ignore 'tests/**' \
    --ignore '.dev.pid' \
    --signal SIGTERM \
    -- server.js --port "$DEV_PORT" &

DEV_PID=$!
echo "$DEV_PID" > "$PIDFILE"

# Forward signals so Ctrl+C cleans up
trap 'kill $DEV_PID 2>/dev/null; rm -f "$PIDFILE"; exit 0' INT TERM
wait "$DEV_PID"
rm -f "$PIDFILE"
