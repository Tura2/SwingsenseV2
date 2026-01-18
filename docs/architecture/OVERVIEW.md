# Architecture Overview

SwingSense V2 is a desktop trading analytics app built with:
- **Electron main process** (Node runtime) for data access, caching, and strategy/backtest execution
- **React renderer** (Vite) for UI
- **SQLite** (local) as the persistence layer

## High-level data flow

1. Renderer calls `window.api.*` (preload bridge) → Electron IPC.
2. Main process handles IPC in `backend/src/main/ipc.ts`.
3. IPC handlers call service modules in `backend/src/main/services/*`.
4. Services read/write SQLite via `backend/src/main/db.ts`.
5. External market data is fetched via **Yahoo endpoints** (v8 chart + v1 search), wrapped by a throttled HTTP client.

## Key design goals

- **Deterministic, replayable computations**: indicators/strategies/backtests operate on candle arrays.
- **Local-first**: cache candles and derived signals locally.
- **Robust external calls**: all network calls should go through the throttled HTTP client.

## External dependencies & constraints

- Yahoo endpoints can return throttling responses (e.g. plain-text "Too Many Requests").
- Rate limiting is handled centrally (see `backend/docs/main/services/http-client.md`).
