import type { Candle, QuoteLite } from "../../../../shared/types.js";
import { httpClient } from "../../http/throttledHttpClient.js";

const DEFAULT_HOST = "https://query1.finance.yahoo.com";

type ChartFetchOptions = {
  host?: string;
};

type SearchFetchOptions = {
  host?: string;
  quotesCount?: number;
  enableFuzzyQuery?: boolean;
};

type ChartQuery = {
  interval: string;
  range?: string;
  period1?: number; // unix seconds
  period2?: number; // unix seconds
  includePrePost?: boolean;
  events?: string; // e.g. "div,splits"
};

type ChartResult = {
  meta?: any;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ open?: any[]; high?: any[]; low?: any[]; close?: any[]; volume?: any[] }>;
    // Yahoo provides adjusted close for many instruments (equities/ETFs) under indicators.adjclose[0].adjclose
    adjclose?: Array<{ adjclose?: any[] }>;
  };
};

function toUnixSecondsFromMs(ms: number): number {
  return Math.floor(ms / 1000);
}

function numOrNull(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function buildChartUrl(symbol: string, query: ChartQuery, opts?: ChartFetchOptions): string {
  const host = (opts?.host || DEFAULT_HOST).replace(/\/$/, "");
  const base = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const params = new URLSearchParams();

  params.set("interval", query.interval);

  if (query.range) {
    params.set("range", query.range);
  } else {
    if (typeof query.period1 === "number") params.set("period1", String(query.period1));
    if (typeof query.period2 === "number") params.set("period2", String(query.period2));
  }

  if (typeof query.includePrePost === "boolean") {
    params.set("includePrePost", query.includePrePost ? "true" : "false");
  }

  if (query.events) params.set("events", query.events);

  return `${base}?${params.toString()}`;
}

function buildSearchUrl(query: string, opts?: SearchFetchOptions): string {
  const host = (opts?.host || DEFAULT_HOST).replace(/\/$/, "");
  const base = `${host}/v1/finance/search`;
  const params = new URLSearchParams();

  params.set("q", query);
  params.set("quotesCount", String(opts?.quotesCount ?? 10));
  params.set("newsCount", "0");
  params.set("listsCount", "0");
  params.set("enableFuzzyQuery", String(opts?.enableFuzzyQuery ?? false));

  return `${base}?${params.toString()}`;
}

export async function fetchYahooSearchQuotes(query: string, opts?: SearchFetchOptions): Promise<Array<Record<string, any>>> {
  const url = buildSearchUrl(query, opts);
  const { status, text } = await httpClient.getText(url, {
    rateLimitKey: "yahoo",
    // Yahoo endpoints are touchy; a little spacing helps reduce 429s.
    rateLimit: { minTimeMs: 200, maxConcurrent: 2 },
    retry: { maxRetries: 3, baseDelayMs: 400 },
  });

  if (status < 200 || status >= 300) {
    throw new Error(`Yahoo search HTTP ${status}: ${text.slice(0, 120)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Yahoo search invalid JSON: ${text.slice(0, 120)}`);
  }

  return Array.isArray(json?.quotes) ? json.quotes : [];
}

export async function fetchYahooChartResult(symbol: string, query: ChartQuery, opts?: ChartFetchOptions): Promise<ChartResult> {
  const url = buildChartUrl(symbol, query, opts);
  const { status, text } = await httpClient.getText(url, {
    rateLimitKey: "yahoo",
    rateLimit: { minTimeMs: 200, maxConcurrent: 2 },
    retry: { maxRetries: 3, baseDelayMs: 400 },
  });

  if (status < 200 || status >= 300) {
    throw new Error(`Yahoo chart HTTP ${status}: ${text.slice(0, 120)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Yahoo chart invalid JSON: ${text.slice(0, 120)}`);
  }

  const result: ChartResult | undefined = json?.chart?.result?.[0];
  if (!result) {
    const errDesc = json?.chart?.error?.description || json?.chart?.error?.message;
    throw new Error(`Yahoo chart missing result: ${errDesc || "unknown"}`);
  }

  return result;
}

export function chartResultToCandles(
  result: ChartResult,
  opts?: {
    // Prefer adjusted closes when Yahoo provides them (helps avoid split artifacts).
    preferAdjClose?: boolean;
  }
): Candle[] {
  const ts = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];

  const adj = result?.indicators?.adjclose?.[0] as any;
  const adjcloses = Array.isArray(adj?.adjclose) ? adj.adjclose : [];
  const useAdj = (opts?.preferAdjClose ?? true) && adjcloses.length === ts.length;

  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (!Number.isFinite(t)) continue;

    const closeRaw = useAdj ? adjcloses[i] : closes[i];
    const closeN = numOrNull(closeRaw);
    if (closeN == null || closeN <= 0) continue;

    const openN = numOrNull(opens[i]) ?? closeN;
    const highN = numOrNull(highs[i]) ?? closeN;
    const lowN = numOrNull(lows[i]) ?? closeN;
    const volN = numOrNull(volumes[i]) ?? 0;

    if (![openN, highN, lowN, closeN, volN].every(Number.isFinite)) continue;
    if (openN <= 0 || highN <= 0 || lowN <= 0) continue;
    if (highN < lowN) continue;

    out.push({ ts: t * 1000, open: openN, high: highN, low: lowN, close: closeN, volume: volN });
  }

  out.sort((a, b) => a.ts - b.ts);
  const dedup: Candle[] = [];
  let lastTs = -1;
  for (const c of out) {
    if (c.ts === lastTs) {
      dedup[dedup.length - 1] = c;
      continue;
    }
    dedup.push(c);
    lastTs = c.ts;
  }

  return dedup;
}

export async function fetchYahooCandlesByPeriod(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
  includePrePost: boolean,
): Promise<Candle[]> {
  const result = await fetchYahooChartResult(symbol, {
    interval,
    period1: toUnixSecondsFromMs(startMs),
    period2: toUnixSecondsFromMs(endMs),
    includePrePost,
    events: interval === '1d' || interval === '1wk' || interval === '1mo' ? 'div,splits' : undefined,
  });
  return chartResultToCandles(result, { preferAdjClose: interval === '1d' || interval === '1wk' || interval === '1mo' });
}

export async function fetchYahooCandlesByRange(
  symbol: string,
  interval: string,
  range: string,
  includePrePost: boolean,
): Promise<Candle[]> {
  const result = await fetchYahooChartResult(symbol, {
    interval,
    range,
    includePrePost,
    events: interval === '1d' || interval === '1wk' || interval === '1mo' ? 'div,splits' : undefined,
  });
  return chartResultToCandles(result, { preferAdjClose: interval === '1d' || interval === '1wk' || interval === '1mo' });
}

export async function fetchQuoteLiteFromChart(symbol: string): Promise<QuoteLite> {
  const result = await fetchYahooChartResult(symbol, {
    interval: "1d",
    range: "5d",
    includePrePost: true,
  });

  const meta = result?.meta || {};
  const candles = chartResultToCandles(result);
  const lastCandle = candles.length ? candles[candles.length - 1] : null;

  const last = numOrNull(meta.regularMarketPrice) ?? (lastCandle ? numOrNull(lastCandle.close) : null);
  const prevClose = numOrNull(meta.chartPreviousClose) ?? numOrNull(meta.previousClose) ?? null;

  let ts: number | null = null;
  const t = meta.regularMarketTime;
  if (typeof t === "number" && Number.isFinite(t)) {
    ts = String(t).length < 13 ? t * 1000 : t;
  }

  let change: number | null = null;
  let changePct: number | null = null;
  if (last != null && prevClose != null) {
    change = last - prevClose;
    if (prevClose !== 0) changePct = (change / prevClose) * 100;
  }

  return {
    symbol: String(meta.symbol || symbol).toUpperCase(),
    last,
    change,
    changePct,
    ts,
  };
}
