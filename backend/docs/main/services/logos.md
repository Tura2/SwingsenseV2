# Logos Service

## Purpose

`src/main/services/logos.ts` resolves a ticker symbol to an icon URL.

Strategy:
1. Serve a cached file from Electron `userData/logos/`.
2. Try multiple public icon CDNs.
3. Fall back to an auto-generated SVG (colored circle + initials).

## Key API

- `getLogo(symbol): Promise<string>`

## Dependencies

**Imports**
- Electron `app` for the userData directory.
- `src/main/services/http/throttledHttpClient.ts` for downloads.

**Imported by**
- `src/main/ipc.ts` (`logos:get` handler)

## Constraints

- Network downloads are throttled via the shared HTTP client.
- Returned value can be a `file://` URL or a `data:` URL.
