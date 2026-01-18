# IPC Service Layer

## Purpose

`src/main/ipc.ts` defines the **backend API surface** exposed to the renderer via Electron IPC.

## Key logic

- Validates IPC inputs using `zod`.
- Delegates work to service modules (market, quotes, indicators, strategies, backtests, etc.).
- Keeps a small in-memory TTL cache for trending lists.

## Key handlers (examples)

- `candles:get`, `candles:getByInterval` → market data + caching
- `indicators:get`, `indicators:bundle` → indicator computation
- `quotes:get` → quote-lite fetching
- `logos:get` → logo resolution + caching
- `signals:*` → signal scanning and listing
- `backtests:*` → run + retrieve backtests

## Dependencies

**Imports**
- `electron/ipcMain`
- `zod` for validation
- `src/main/db.ts` (SQLite connection)
- `src/main/services/*` (business logic)

**Imported by**
- Electron bootstrap (via `registerIpcHandlers()`)

## Constraints

- IPC handlers must be **fast** and avoid unbounded parallelism.
- Any external network call must go through the throttled HTTP client (directly or indirectly).
