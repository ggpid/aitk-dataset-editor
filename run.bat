@echo off
cd /d "%~dp0"
pushd frontend
if not exist dist (
  call npm install || exit /b 1
  call npm run build || exit /b 1
)
popd
cd backend
uv run python -m app
