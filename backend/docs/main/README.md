# Main Process (Backend)

The Electron **main process** is responsible for:
- IPC request handling
- Market data acquisition + caching
- Strategy evaluation, signals scanning
- Backtest runs
- Local persistence (SQLite)

Entry points:
- `src/main/ipc.ts`: IPC handler registration (core backend API)
- `src/main/db.ts`: SQLite access + schema

See also:
- `docs/main/services/ipc.md`
- `docs/main/services/db.md`
