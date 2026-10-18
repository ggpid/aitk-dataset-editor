#!/usr/bin/env bash
# Development: backend with auto-reload on :8675 + Vite dev server on :5173.
cd "$(dirname "$0")"
(cd backend && uv run uvicorn app.main:app --reload --port 8675) &
trap 'kill $!' EXIT
cd frontend && { [ -d node_modules ] || npm install; } && npm run dev
