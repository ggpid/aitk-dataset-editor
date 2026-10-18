#!/usr/bin/env bash
# Build the frontend (first run / when sources change) and start the server.
set -e
cd "$(dirname "$0")"
cd frontend
# (Re)install when node_modules is missing or older than the lockfile (e.g. after git pull).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  rm -rf node_modules
  npm install
  rm -rf dist
fi
if [ ! -d dist ] || [ -n "$(find src index.html package.json -newer dist -print -quit 2>/dev/null)" ]; then
  npm run build
  touch dist
fi
cd ../backend
exec uv run python -m app
