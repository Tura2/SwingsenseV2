import { readEnv } from "../../../shared/env.js";

export type HttpResponseText = {
  status: number;
  text: string;
  contentType: string | null;
  headers: Headers;
};

export type HttpResponseBuffer = {
  status: number;
  buffer: Buffer;
  contentType: string | null;
  headers: Headers;
};

type RateLimiterOptions = {
  maxConcurrent: number;
  minTimeMs: number;
};

type QueueItem<T> = {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: any) => void;
};

class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minTimeMs: number;
  private running = 0;
  private nextAllowedStart = 0;
  private queue: Array<QueueItem<any>> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RateLimiterOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
    this.minTimeMs = Math.max(0, Math.floor(opts.minTimeMs));
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAllowedStart - now);
      if (waitMs > 0) {
        this.timer = setTimeout(() => this.drain(), waitMs);
        return;
      }

      const item = this.queue.shift()!;
      this.running += 1;
      this.nextAllowedStart = Date.now() + this.minTimeMs;

      void item
        .fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }
}

type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  retryOnStatuses: Set<number>;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  // +/- 20%
  const delta = ms * 0.2;
  const r = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.floor(ms + r));
}

function isRetryableStatus(status: number, policy: RetryPolicy): boolean {
  return policy.retryOnStatuses.has(status);
}

function defaultHeaders(): Record<string, string> {
  // These headers intentionally mimic a browser enough to keep Yahoo endpoints stable.
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://finance.yahoo.com/",
  };
}

export type RequestCommonOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  rateLimitKey?: string;
  rateLimit?: Partial<RateLimiterOptions>;
  retry?: Partial<RetryPolicy>;
};

export class ThrottledHttpClient {
  private readonly limiters = new Map<string, RateLimiter>();

  private getLimiter(key: string, override?: Partial<RateLimiterOptions>): RateLimiter {
    const env = readEnv();
    const maxConcurrent = override?.maxConcurrent ?? Number(process.env.HTTP_MAX_CONCURRENT ?? 4);
    const minTimeMs = override?.minTimeMs ?? Number(process.env.HTTP_MIN_TIME_MS ?? 150);

    const existing = this.limiters.get(key);
    if (existing) return existing;

    const limiter = new RateLimiter({
      maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : 4,
      minTimeMs: Number.isFinite(minTimeMs) ? minTimeMs : 150,
    });
    // Touch env so it's not dead code; defaults are used if unset.
    void env;

    this.limiters.set(key, limiter);
    return limiter;
  }

  async getText(url: string, opts?: RequestCommonOptions): Promise<HttpResponseText> {
    const key = opts?.rateLimitKey ?? new URL(url).host;
    const limiter = this.getLimiter(key, opts?.rateLimit);

    return limiter.schedule(async () => {
      const env = readEnv();
      const timeoutMs = opts?.timeoutMs ?? env.HTTP_TIMEOUT_MS;
      const policy: RetryPolicy = {
        maxRetries: opts?.retry?.maxRetries ?? env.RETRY_MAX,
        baseDelayMs: opts?.retry?.baseDelayMs ?? 300,
        retryOnStatuses: opts?.retry?.retryOnStatuses ?? new Set([429, 500, 502, 503, 504]),
      };

      const mergedHeaders = { ...defaultHeaders(), ...(opts?.headers || {}) };

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetch(url, { method: "GET", headers: mergedHeaders, signal: controller.signal });
          const text = await res.text();

          // Yahoo sometimes returns plain-text bodies with 200-ish behavior in some proxies.
          // Treat leading "Too Many Requests" as a 429-equivalent.
          const looksRateLimited = /^\s*too many requests\b/i.test(text);
          const effectiveStatus = looksRateLimited ? 429 : res.status;

          if (attempt < policy.maxRetries && isRetryableStatus(effectiveStatus, policy)) {
            attempt += 1;
            const delay = jitter(policy.baseDelayMs * Math.pow(2, attempt - 1));
            await sleep(delay);
            continue;
          }

          return {
            status: effectiveStatus,
            text,
            contentType: res.headers.get("content-type"),
            headers: res.headers,
          };
        } catch (e: any) {
          if (attempt < (opts?.retry?.maxRetries ?? readEnv().RETRY_MAX)) {
            attempt += 1;
            const delay = jitter(300 * Math.pow(2, attempt - 1));
            await sleep(delay);
            continue;
          }
          throw e;
        } finally {
          clearTimeout(t);
        }
      }
    });
  }

  async getBuffer(url: string, opts?: RequestCommonOptions): Promise<HttpResponseBuffer> {
    const key = opts?.rateLimitKey ?? new URL(url).host;
    const limiter = this.getLimiter(key, opts?.rateLimit);

    return limiter.schedule(async () => {
      const env = readEnv();
      const timeoutMs = opts?.timeoutMs ?? env.HTTP_TIMEOUT_MS;
      const mergedHeaders = { ...defaultHeaders(), ...(opts?.headers || {}) };

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, { method: "GET", headers: mergedHeaders, signal: controller.signal });
        const ab = await res.arrayBuffer();
        return {
          status: res.status,
          buffer: Buffer.from(ab),
          contentType: res.headers.get("content-type"),
          headers: res.headers,
        };
      } finally {
        clearTimeout(t);
      }
    });
  }
}

export const httpClient = new ThrottledHttpClient();
