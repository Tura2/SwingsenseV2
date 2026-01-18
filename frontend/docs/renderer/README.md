# Renderer (Frontend)

The renderer is a React app built with Vite.

## Responsibilities

- UI, routing, charts
- Calls into the backend via IPC (exposed by the preload bridge)

## Key files

- `frontend/main.tsx`: app bootstrap
- `frontend/routes.tsx`: route definitions
- `frontend/pages/*`: page-level views
- `frontend/components/*`: reusable UI components

## Dependency rules

- Renderer should not access the filesystem or network directly for market data.
- Renderer uses IPC APIs exposed by preload; add new backend APIs via IPC handlers.
