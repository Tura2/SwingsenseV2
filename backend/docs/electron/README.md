# Electron Layer

This folder contains Electron entry points and the preload bridge.

## Files

- `electron/main.ts`: Electron main bootstrap
- `electron/preload.ts` / `electron/preload.cts`: exposes a safe IPC API to the renderer

## Design rule

- Keep preload minimal: validate inputs, define IPC surface, avoid business logic.
