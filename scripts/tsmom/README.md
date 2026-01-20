# TSMOM scripts

Canonical entrypoints live in `scripts/tsmom/cli/`.

- `scripts/tsmom/` contains thin wrapper files so older commands still work.
- Shared helpers live in `scripts/tsmom/lib/`.

## Common commands

- Expanded-universe Turbo run:
  - `npx electron scripts/tsmom/cli/run_tsmom_turbo_expanded_universe_electron.mjs`

- Validate expanded-universe symbols (Yahoo fetch check):
  - `node scripts/tsmom/cli/check_expanded_universe_symbols.mjs`

- Probe a single Yahoo symbol quickly:
  - `node scripts/tsmom/cli/probe_yahoo_symbol.mjs ORA.TA`

- Full re-sync of daily candles (wipes + re-downloads universe, plus FX/benchmarks):
  - `npm run build:electron`
  - `cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/tsmom/cli/resync_all_electron.mjs --years=5`

> Most scripts import compiled modules from `dist-electron`. If you changed TypeScript in `backend/src/main`, run `npm run build:electron` first.
