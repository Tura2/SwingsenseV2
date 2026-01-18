# AGENT_GUIDE.md — First Stop for AI Agents

This file is the primary orientation guide for working on SwingSense V2.

## Quick commands

- Dev (Vite + Electron): `npm run dev`
- Build (Vite + Electron tsc): `npm run build`
- Start packaged main (uses `dist-electron`): `npm run start`

## Project tree (high-level, complete)

```text
swingsenseV2/
  package.json
  vite.config.ts
  tsconfig.json
  README.md

  backend/
    electron/
      main.ts
      preload.ts
      preload.cts
      tsconfig.json
    src/
      main/
        db.ts
        ipc.ts
        services/
          ...
      shared/
        env.ts
        market.ts
        schemas.ts
        types.ts
        ipc/
          channels.ts
    docs/
      main/
      electron/
      shared/
      tsmom/

  frontend/
    index.html
    main.tsx
    App.tsx
    routes.tsx
    styles.css
    components/
    pages/
    types/
    docs/
      renderer/

  data/
  diagnostics/
  scripts/
    smoke.mjs
    tsmom/
      cli/
        (TSMOM report/utility entrypoints)
      lib/
        (TSMOM script helpers)
    run_single_backtest.mjs

  tests/
    engine.test.mjs        (wrapper)
    backtest.test.mjs      (wrapper)
    smoke/
      engine.test.mjs
      backtest.test.mjs

  reports/
    tsmom/
      standard/
      turbo/

  docs/
    README.md
    architecture/
    scripts/

  dist/            (Vite build output)
  dist-electron/   (build output)
  node_modules/
```

## Docs index (“Tree of Docs”)

Start here:
- docs/README.md
- docs/architecture/OVERVIEW.md

Mapping code → docs:
- IPC surface: backend/docs/main/services/ipc.md → backend/src/main/ipc.ts
- SQLite: backend/docs/main/services/db.md → backend/src/main/db.ts
- HTTP throttling: backend/docs/main/services/http-client.md → backend/src/main/services/http/throttledHttpClient.ts
- Yahoo provider: backend/docs/main/services/yahoo-provider.md → backend/src/main/services/providers/yahoo/* + backend/src/main/services/yahooChartApi.ts
- Symbols: backend/docs/main/services/symbols.md → backend/src/main/services/symbols.ts
- Market candles/cache: backend/docs/main/services/market.md → backend/src/main/services/market.ts
- Quotes: backend/docs/main/services/quotes.md → backend/src/main/services/quotes.ts
- Logos: backend/docs/main/services/logos.md → backend/src/main/services/logos.ts
- Indicators: backend/docs/main/services/indicators.md → backend/src/main/services/indicators.ts
- Indicator bundle: backend/docs/main/services/indicator-service.md → backend/src/main/services/indicatorService.ts
- Strategies: backend/docs/main/services/strategies.md → backend/src/main/services/strategies* and strategies/impl
- Signals: backend/docs/main/services/signals.md → backend/src/main/services/signals.ts
- Backtests: backend/docs/main/services/backtest.md → backend/src/main/services/backtest/*
- Engine config: backend/docs/main/services/engine-config.md → backend/src/main/services/config/engineConfig.ts

Frontend:
- Renderer overview: frontend/docs/renderer/README.md → frontend/*

Electron:
- Electron bootstrap + preload: backend/docs/electron/README.md → backend/electron/*

## Architectural overview

- **Renderer (React/Vite)** displays UI and requests data.
- **Preload bridge** exposes a safe, typed IPC API to the renderer.
- **Main process** serves as the backend:
  - validates IPC inputs (zod)
  - fetches/caches candles
  - computes indicators
  - runs strategies/backtests
- **SQLite** stores candles, watchlists, portfolio trades, signals.

There is no Firebase integration in the current codebase.

## Rules of engagement (project standards)

### 1) Network calls

- Do **not** call `fetch()` directly from services.
- All external requests must go through the throttler: `backend/src/main/services/http/throttledHttpClient.ts`.
- For Yahoo market data:
  - prefer the chart endpoint (`v8/finance/chart`) + meta
  - avoid quote endpoints (they are more frequently blocked)

### 2) Boundaries

- Renderer must not implement market-data fetching logic.
- Business logic lives in `backend/src/main/services/*`.
- IPC is the only bridge between renderer and main.

### 3) Data model

- Candles are the primary time-series primitive (`Candle[]`).
- Indicators/strategies/backtests should be deterministic functions of candles.

### 4) Validation

- IPC handlers validate inputs with `zod`.
- Services should still guard against malformed upstream data.

### 5) Style & naming

- Use TypeScript, keep exports explicit.
- Prefer pure functions for computations (especially strategies).
- Prefer functional components in the renderer.

## Common tasks

### Add a new IPC endpoint

1. Add handler in `backend/src/main/ipc.ts` with `zod` validation.
2. Implement logic in a service module under `backend/src/main/services/`.
3. Expose a preload API if needed.
4. Update docs: add/extend a file under `backend/docs/main/services/`.

### Add a new external data source

1. Create a provider under `backend/src/main/services/providers/<provider>/`.
2. Route requests through the throttled HTTP client.
3. Update symbol resolution + market service to use the provider.
4. Document constraints and rate limits.
