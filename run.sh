#!/usr/bin/env bash
# Build the frontend (first run / when sources change) and start the server.
set -e
cd "$(dirname "$0")"
if [ ! -d frontend/dist ] || [ -n "$(find frontend/src frontend/index.html -newer frontend/dist -print -quit 2>/dev/null)" ]; then
  (cd frontend && { [ -d node_modules ] || npm install; } && npm run build)
fi
cd backend
exec uv run python -m app
