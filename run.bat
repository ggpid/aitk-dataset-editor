@echo off
cd /d "%~dp0"
if not exist frontend\dist (
  pushd frontend
  if not exist node_modules call npm install
  call npm run build
  popd
)
cd backend
uv run python -m app
