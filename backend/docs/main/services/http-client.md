# Throttled HTTP Client

## Purpose

Centralizes **all external HTTP requests** behind:
- rate limiting (min spacing + concurrency caps)
- timeouts
- retry with exponential backoff

Implementation: `src/main/services/http/throttledHttpClient.ts`.

## Key APIs

- `httpClient.getText(url, opts)`
- `httpClient.getBuffer(url, opts)`

### Rate limiting model

- Requests are scheduled by `rateLimitKey` (default: URL host).
- Each key has its own limiter:
  - `maxConcurrent`: maximum in-flight requests
  - `minTimeMs`: minimum time between request starts

### Retries

- Retries are applied for 429 and common 5xx statuses by default.
- Yahoo-specific quirk: plain-text bodies starting with "Too Many Requests" are treated as 429.

## Dependencies

**Imports**
- `src/shared/env.ts` (timeout + retry defaults; optional limiter overrides)

**Imported by**
- Yahoo provider (`src/main/services/providers/yahoo/*`)
- Logo service (`src/main/services/logos.ts`)

## Constraints

- Do not call global `fetch()` directly from services; route through this client.
- Keep per-key limits conservative to reduce upstream blocking.
