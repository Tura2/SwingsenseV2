import { getDB } from "../db.js";
import { getCandlesByInterval } from "./market.js";
import { computeOverlaysAndSnapshot } from "./indicators.js";
import type { Interval } from "../../shared/types.js";

/**
 * Generate Golden Cross signals (EMA50 crossing above EMA200).
 * Uses existing daily candles from DB. If not enough candles, skips.
 */
export function scanGoldenCrossForSymbol(symbol: string) {
  const db = getDB();
  const rows = db.prepare(
    "SELECT ts, close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts ASC"
  ).all(symbol) as { ts: number; close: number }[];

  if (rows.length < 220) return; // need history

  const ema = (period: number) => {
    const k = 2 / (period + 1);
    let prev = rows[0].close;
    const out: number[] = [];
    for (const r of rows) {
      prev = r.close * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };

  const ema50 = ema(50);
  const ema200 = ema(200);

  const insert = db.prepare(
    "INSERT INTO signals(symbol, type, ts, meta) VALUES (?, 'golden_cross', ?, ?)"
  );
  const exists = db.prepare(
    "SELECT 1 FROM signals WHERE symbol=? AND type='golden_cross' AND ts=?"
  );

  for (let i = 1; i < rows.length; i++) {
    const prevDiff = ema50[i - 1] - ema200[i - 1];
    const currDiff = ema50[i] - ema200[i];
    if (prevDiff <= 0 && currDiff > 0) {
      const ts = rows[i].ts;
      if (!exists.get(symbol, ts)) {
        insert.run(symbol, ts, JSON.stringify({ ema50: ema50[i], ema200: ema200[i] }));
      }
    }
  }
}

/** Scan all symbols found in watchlists and portfolio */
export function scanAllSymbols() {
  const db = getDB();
  const symbols = new Set<string>();

  const wsyms = db.prepare(`
    SELECT DISTINCT ws.symbol FROM watchlist_symbols ws
  `).all() as { symbol: string }[];
  wsyms.forEach(r => symbols.add(r.symbol));

  const psyms = db.prepare(`
    SELECT DISTINCT symbol FROM portfolio_trades
  `).all() as { symbol: string }[];
  psyms.forEach(r => symbols.add(r.symbol));

  for (const s of symbols) {
    scanGoldenCrossForSymbol(s);
  }
}

// --- New scanning service for UI ---

type ScanFilters = {
  watchlistId?: number; // if omitted, scan all watchlists
  timeframe: Interval; // '4h' | '1d' | '1wk' | '1mo'
  direction?: 'LONG' | 'SHORT';
  strategy?: string; // strategy name filter
  minConfidence?: number; // 0-100
  minRR?: number; // minimum R:R for first target
};

type UICard = {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  timeframe: Interval;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  triggeredAt: number;
  rr?: number;
};

type WatchlistSignals = { watchlistId: number; name: string; cards: UICard[] };

// 60s bars cache
const barsCache = new Map<string, { ts: number; candles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[] }>();

function createSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = async () => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active++;
  };

  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  return { acquire, release };
}

async function getBarsCached(symbol: string, timeframe: Interval) {
  const key = `${symbol}::${timeframe}`;
  const now = Date.now();
  const hit = barsCache.get(key);
  if (hit && now - hit.ts < 60_000) return hit.candles;
  const { candles } = await getCandlesByInterval(symbol, timeframe);
  barsCache.set(key, { ts: now, candles });
  return candles;
}

function computeConfidence(side: 'LONG'|'SHORT', snapshot: any): number {
  let c = 60;
  const ema200Slope = snapshot?.ema200Slope ?? 0;
  const macdHist = snapshot?.macd?.hist ?? 0;
  if (side === 'LONG') {
    if (ema200Slope > 0) c += 10;
    if (macdHist > 0) c += 10;
  } else {
    if (ema200Slope < 0) c += 10;
    if (macdHist < 0) c += 10;
  }
  if (snapshot?.rsi14) {
    if (side === 'LONG' && snapshot.rsi14 >= 35 && snapshot.rsi14 <= 65) c += 5;
    if (side === 'SHORT' && snapshot.rsi14 >= 35 && snapshot.rsi14 <= 65) c += 5;
  }
  return Math.max(40, Math.min(95, Math.round(c)));
}

export async function scanWatchlistsSignals(filters: ScanFilters): Promise<{ stats: { scanned: number; signaled: number; durationMs: number }, results: WatchlistSignals[] }> {
  const started = Date.now();
  const db = getDB();
  const lists = filters.watchlistId
    ? db.prepare("SELECT id, name FROM watchlists WHERE id=?").all(filters.watchlistId) as { id: number; name: string }[]
    : db.prepare("SELECT id, name FROM watchlists ORDER BY created_at ASC").all() as { id: number; name: string }[];

  // Load symbols per list
  const perList: { id: number; name: string; symbols: string[] }[] = lists.map(l => {
    const rows = db.prepare("SELECT symbol FROM watchlist_symbols WHERE watchlist_id=? ORDER BY symbol ASC").all(l.id) as { symbol: string }[];
    return { id: l.id, name: l.name, symbols: rows.map(r => r.symbol) };
  });

  const timeframe = '1d' as Interval; // Engine uses Daily execution
  const direction = filters.direction;
  const strategyFilter = filters.strategy?.toLowerCase();
  const minConf = (filters.minConfidence ?? 0);
  const minRR = (filters.minRR ?? 0.5);

  // Concurrency-limited processing (important: prevents Yahoo 429 rate limits)
  const concurrency = 3;
  const sem = createSemaphore(concurrency);
  const tasks: Promise<void>[] = [];
  let scanned = 0; let signaled = 0;
  const results: WatchlistSignals[] = perList.map(l => ({ watchlistId: l.id, name: l.name, cards: [] }));

  async function processSymbol(listIdx: number, symbol: string) {
    await sem.acquire();
    scanned++;
    try {
      const candles = await getBarsCached(symbol, timeframe);
      if (!candles?.length) return;
      const stratMod: typeof import('./strategies.js') = await import('./strategies.js');
      const signals = stratMod.evaluateStrategies(candles);
      for (const s of signals) {
        const card: UICard = {
          symbol,
          strategy: s.name,
          direction: s.side,
          timeframe,
          entry: s.entryPrice,
          stop: s.stopPrice,
          target: Array.isArray(s.targets) && s.targets.length ? s.targets[0] : s.entryPrice,
          confidence: Math.round(s.confidence ?? computeConfidence(s.side as any, computeOverlaysAndSnapshot(candles).snapshot)),
          triggeredAt: s.timestamp,
        };
        card.rr = s.rMultipleFirst ?? undefined;

        // Apply filters
        if (direction && card.direction !== direction) continue;
        if (strategyFilter && !card.strategy.toLowerCase().includes(strategyFilter)) continue;
  if (card.confidence < minConf) continue;
  if ((card.rr ?? 0) < minRR) continue;

        results[listIdx].cards.push(card);
        signaled++;
      }
    } catch (e) {
      console.warn('[signals] scan symbol failed', { symbol, timeframe }, (e as any)?.message || e);
    } finally {
      sem.release();
    }
  }

  for (let i = 0; i < perList.length; i++) {
    for (const sym of perList[i].symbols) {
      tasks.push(processSymbol(i, sym));
    }
  }
  await Promise.allSettled(tasks);

  const durationMs = Date.now() - started;
  console.log('[signals] scan stats', { scanned, signaled, durationMs });
  return { stats: { scanned, signaled, durationMs }, results };
}
