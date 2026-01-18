# Engine Config

## Purpose

`src/main/services/config/engineConfig.ts` loads the engine configuration used by strategies/backtests.

## Key logic

- Loads a JSON config, optionally from `process.env.ENGINE_CONFIG_PATH`.
- Falls back to `default-engine-config.json`.

## Dependencies

**Imports**
- JSON config file

**Imported by**
- `src/main/ipc.ts` (`engine:getConfig`)

## Constraints

- Config must be JSON-serializable.
- Keep defaults in version control.
