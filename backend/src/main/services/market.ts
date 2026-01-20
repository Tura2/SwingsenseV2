import { getDB } from "../db.js";
import type { Interval, CandlesByIntervalRes, Candle } from "../../shared/types.js";
import { yahooCandidatesForSymbol, normalizeInputSymbol, resolveCanonicalYahooSymbol } from "./symbols.js";
import { fetchYahooCandlesByPeriod } from "./yahooChartApi.js";

function normalizeCandles(arr: Candle[]): Candle[] {
  const cleaned = arr.filter(c => {
    if (![c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) return false;
    if (c.ts <= 0) return false;
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return false;
    if (c.high < c.low) return false;
    return true;
  });
  cleaned.sort((a,b)=>a.ts-b.ts);
  const dedup: Candle[] = [];
  let lastTs = -1;
  for (const c of cleaned) {
    if (c.ts === lastTs) { dedup[dedup.length - 1] = c; continue; }
    dedup.push(c); lastTs = c.ts;
  }
  return dedup;
}

function hasSuspiciousDiscontinuity(candles: Candle[]): boolean {
  // Heuristic for split-like discontinuities in cached daily candles.
  // If we see a single-day jump beyond a wide threshold, force a refetch.
  // Adjusted close should eliminate most of these.
  if (!candles || candles.length < 3) return false;
  const start = Math.max(1, candles.length - 400);
  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const a = Number(prev?.close);
    const b = Number(cur?.close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const ratio = b / a;
    if (ratio < 0.25 || ratio > 4) return true;
  }
  return false;
}

async function fetchChartCandles(ysym: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const base = await fetchYahooCandlesByPeriod(ysym, interval, startMs, endMs, true);
  return normalizeCandles(base);
}

/**
 * Fetch candles from Yahoo and cache to SQLite. Simple daily candles.
 * range: "1M" | "6M" | "1Y" | "5Y"  -> maps to period
 */
export async function getCandles(symbol: string, range: "1M"|"6M"|"1Y"|"5Y" = "1Y") {
  const timeframe = "1d";
  const db = getDB();
  const original = normalizeInputSymbol(symbol);
  const candidates = yahooCandidatesForSymbol(original);

  // Determine start date by range
  const msDay = 86400000;
  const now = Date.now();
  const periods: Record<typeof range, number> = {
    "1M": 31, "6M": 186, "1Y": 366, "5Y": 366*5
  };
  const startMs = now - periods[range] * msDay;

  // See if we have enough recent candles cached
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM candles WHERE symbol=? AND timeframe=? AND ts>=?"
  ).get(original, timeframe, startMs) as { c: number };

  // If we already have enough candles, still sanity-check for split-like discontinuities.
  // This is a lightweight guard against stale unadjusted closes that can cause -100% artifacts.
  let cachedLooksBad = false;
  if (row.c >= Math.floor(periods[range] * 0.8)) {
    try {
      const recent = db
        .prepare(
          "SELECT ts, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? AND ts>=? ORDER BY ts ASC"
        )
        .all(original, timeframe, now - 400 * msDay) as any[];
      const norm = normalizeCandles(
        recent.map(r => ({
          ts: Number(r.ts),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
        }))
      );
      cachedLooksBad = hasSuspiciousDiscontinuity(norm);
    } catch {
      cachedLooksBad = false;
    }
  }

  if (row.c < Math.floor(periods[range] * 0.8) || cachedLooksBad) {
    // Fetch fresh and upsert using first working candidate
    let res: Candle[] | null = null;
    let lastErr: any = null;
    for (const ysym of candidates) {
      try {
        const r = await fetchChartCandles(ysym, timeframe, startMs, now);
        if (Array.isArray(r) && r.length) { res = r; break; }
      } catch (e) {
        lastErr = e;
      }
    }
    if (!res) {
      // If none worked, propagate the last error if any
      if (lastErr) throw new Error(`Yahoo fetch failed for ${original}: ${lastErr?.message || lastErr}`);
      // else keep empty result to avoid crashing
      res = [] as Candle[];
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO candles(symbol, timeframe, ts, open, high, low, close, volume)
      VALUES(@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume)
    `);

    const trx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run({
          symbol: original,
          timeframe,
          ts: r.ts,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume ?? 0
        });
      }
    });
    trx(res ?? []);
  }

  const out = db.prepare(
    "SELECT ts, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? AND ts>=? ORDER BY ts ASC"
  ).all(original, timeframe, startMs) as any[];

  return out.map(r => ({
    ts: Number(r.ts),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume)
  }));
}
/** Fetch ~5y candles by interval; for 4h, resample from 1h; may set partialRange. */
export async function getCandlesByInterval(symbol: string, interval: Interval): Promise<CandlesByIntervalRes> {
  const original = normalizeInputSymbol(symbol);
  const resolved = await resolveCanonicalYahooSymbol(original).catch(() => ({ candidates: yahooCandidatesForSymbol(original) } as { candidates: string[]; exchange?: string }));
  const candidates = resolved.candidates;
  const exchange = resolved.exchange;
  console.log(`[market] getCandlesByInterval`, { symbol: original, candidates, exchange, interval });

  if (interval === '4h') {
    // Intraday path: descending windows with drift buffer; try 1h then 60m; UTC 4h bucketing
    const minToMs = 60 * 1000;
    const hourMs = 60 * minToMs;
    const dayMs = 24 * hourMs;
    const driftBuffer = 15 * minToMs; // avoid future/edge minute
    const windows = [729, 365, 180, 90];
    let intraday: Candle[] = [];

    for (const ysym of candidates) {
      // First pass: 1h across windows
      for (const days of windows) {
        const end = Math.floor(Date.now() / minToMs) * minToMs - driftBuffer;
        const start = end - days * dayMs;
        try {
          const base = await fetchChartCandles(ysym, '1h', start, end);
          console.log('[market] intraday try', { ysym, iv: '1h', windowDays: days, count: base.length });
          if (base.length) { intraday = base; break; }
        } catch (e) {
          console.warn('[market] intraday 1h failed', { ysym, days }, (e as any)?.message || e);
        }
      }
      if (intraday.length) break;
      // Second pass: 60m across windows (optional fallback)
      for (const days of windows) {
        const end = Math.floor(Date.now() / minToMs) * minToMs - driftBuffer;
        const start = end - days * dayMs;
        try {
          const base = await fetchChartCandles(ysym, '60m', start, end);
          console.log('[market] intraday try', { ysym, iv: '60m', windowDays: days, count: base.length });
          if (base.length) { intraday = base; break; }
        } catch (e) {
          console.warn('[market] intraday 60m failed', { ysym, days }, (e as any)?.message || e);
        }
      }
      if (intraday.length) break;
    }

    if (intraday.length) {
      // UTC 4h bucketing: align to 00:00,04:00,...
      const bucketMs = 4 * hourMs;
      const buckets = new Map<number, Candle[]>();
      for (const c of intraday) {
        const ms = c.ts;
        const aligned = Math.floor(ms / bucketMs) * bucketMs;
        const arr = buckets.get(aligned) || [];
        arr.push(c);
        buckets.set(aligned, arr);
      }
      const out: Candle[] = [];
      const keys = Array.from(buckets.keys()).sort((a,b)=>a-b);
      for (const k of keys) {
        const group = buckets.get(k)!;
        const open = group[0].open;
        const close = group[group.length - 1].close;
        let high = -Infinity, low = Infinity, volume = 0;
        for (const g of group) { if (g.high>high) high=g.high; if (g.low<low) low=g.low; volume += g.volume||0; }
        out.push({ ts: k, open, high, low, close, volume });
      }
      const candles = normalizeCandles(out);
      const historyStart = candles[0]?.ts; const historyEnd = candles.at(-1)?.ts;
  const approxFiveYearsMs = 5 * 365 * dayMs;
  const partialRange = (historyEnd && historyStart) ? (historyEnd - historyStart) < approxFiveYearsMs : true;
  return { candles, partialRange, intradayAvailable: true, interval: '4h', historyStart, historyEnd };
    }

    // No intraday available → graceful fallback to 1d
    const nowH = Date.now();
    const fiveYearsMsH = 1000 * 60 * 60 * 24 * 365 * 5;
    for (const ysym of candidates) {
      try {
        const candles = await fetchChartCandles(ysym, '1d', nowH - fiveYearsMsH, nowH);
        if (candles.length) {
          const historyStart = candles[0]?.ts; const historyEnd = candles.at(-1)?.ts;
          return { candles, intradayAvailable: false, fallbackInterval: '1d', interval: '1d', historyStart, historyEnd };
        }
      } catch {}
    }
    return { candles: [], intradayAvailable: false, fallbackInterval: '1d', interval: '1d' };
  }

  // 1d/1wk/1mo: fetch via Yahoo chart endpoint
  const intervalMap: Record<'1d'|'1wk'|'1mo', string> = { '1d': '1d', '1wk': '1wk', '1mo': '1mo' };
  const nowH = Date.now();
  const fiveYearsMsH = 1000 * 60 * 60 * 24 * 365 * 5;
  for (const ysym of candidates) {
    try {
      const candles = await fetchChartCandles(ysym, intervalMap[interval as '1d'|'1wk'|'1mo'], nowH - fiveYearsMsH, nowH);
      if (candles.length) {
        const historyStart = candles[0]?.ts; const historyEnd = candles.at(-1)?.ts;
        return { candles, interval, historyStart, historyEnd };
      }
    } catch (e:any) {
      console.warn('[market] chart failed', { ysym, interval }, e?.message || e);
    }
  }
  // nothing worked
  console.warn('[market] no candles for any candidate', { symbol: original, candidates, interval });
  return { candles: [] };
}
