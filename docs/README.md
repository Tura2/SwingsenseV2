# Project Docs (Knowledge Base)

This folder is the human + AI “knowledge base” for the SwingSense V2 codebase.

## How to use

- Start with `../AGENT_GUIDE.md` (root) for the big picture, rules, and indexes.
- Use the module docs under `../backend/docs/main/services/` when changing backend logic.
- Use `../frontend/docs/renderer/README.md` when changing the UI.

## Documentation conventions

Each doc file tries to answer:
- **Purpose**: what the module is responsible for
- **Key functions**: important exported APIs and how they work
- **Dependencies**: what it imports and what imports it
- **Constraints**: known gotchas (rate limits, caching, typing, etc.)
