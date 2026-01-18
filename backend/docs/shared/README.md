# Shared Modules

`backend/src/shared/*` contains types, schemas, and cross-cutting utilities shared between the main process and renderer.

## What belongs here

- TypeScript types used on both sides (e.g. `Candle`, `QuoteLite`)
- IPC channel names
- Validation schemas used across boundaries

## Constraints

- Shared code should remain platform-neutral (no Electron/Node-only APIs).
