import { getDB } from '../../db.js';
import { fetchYahooCandlesByPeriod } from '../yahooChartApi.js';
import type { Candle } from '../../../shared/types.js';
import type { TsmomAssetRow } from './types.js';
import { resolveTicker } from './tickerMapper.js';

function normalizeCandles(arr: Candle[]): Candle[] {
  const cleaned = (arr || []).filter(c => [c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
  cleaned.sort((a, b) => a.ts - b.ts);
  const dedup: Candle[] = [];
  let lastTs = -1;
  for (const c of cleaned) {
    if (c.ts === lastTs) {
      dedup[dedup.length - 1] = c;
      continue;
    }
    dedup.push(c);
    lastTs = c.ts;
  }
  return dedup;
}

function toISODate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const CORP_ACTION_RATIOS = [2, 3, 4, 5, 10, 20, 25, 50, 100];

function detectCorporateAction(prevClose: number, close: number): null | {
  approxRatio: number;
  suggestedScaleBeforeFactor: number;
} {
  const pc = Number(prevClose);
  const cc = Number(close);
  if (!Number.isFinite(pc) || !Number.isFinite(cc) || pc <= 0 || cc <= 0) return null;

  const ratioAbs = Math.max(pc, cc) / Math.min(pc, cc);
  if (!Number.isFinite(ratioAbs) || ratioAbs < 1.8) return null;

  let best: null | { r: number; relErr: number } = null;
  for (const r of CORP_ACTION_RATIOS) {
    const relErr = Math.abs(ratioAbs - r) / r;
    if (!best || relErr < best.relErr) best = { r, relErr };
  }
  if (!best) return null;

  // Tolerance: within 3% of a common split ratio.
  if (best.relErr > 0.03) return null;

  const factor = cc / pc; // apply to history BEFORE the event to match post-event price scale
  if (!Number.isFinite(factor) || factor <= 0) return null;

  return { approxRatio: best.r, suggestedScaleBeforeFactor: factor };
}

export type SyncRunSummary = {
  startedAt: number;
  finishedAt: number;
  assets: number;
  updated: number;
  warnings: string[];
};

export class TsmomSyncManager {
  async syncDailyCandlesForUniverse(opts?: { backfillYears?: number; sanityMovePct?: number; corpActionMovePct?: number }): Promise<SyncRunSummary> {
    const db = getDB();
    const startedAt = Date.now();
    const warnings: string[] = [];

    const backfillYears = Number(opts?.backfillYears ?? 5);
    const sanityMovePct = Number(opts?.sanityMovePct ?? 20);
    const corpActionMovePct = Number(opts?.corpActionMovePct ?? Math.max(60, sanityMovePct * 2.5));

    const assets = db
      .prepare("SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets WHERE status='active' ORDER BY category, ticker")
      .all() as TsmomAssetRow[];

    const runInfo = db
      .prepare(`
        INSERT INTO tsmom_sync_runs(started_at, finished_at, assets, updated, status, warnings, meta)
        VALUES(?, NULL, ?, 0, 'running', '[]', NULL)
      `)
      .run(startedAt, assets.length);
    const runId = Number(runInfo.lastInsertRowid);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO candles(symbol, timeframe, ts, open, high, low, close, volume)
      VALUES(@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume)
    `);

    const latestStmt = db.prepare('SELECT MAX(ts) AS maxTs FROM candles WHERE symbol=? AND timeframe=?');

    const insertFlag = db.prepare(`
      INSERT OR IGNORE INTO tsmom_price_flags(
        ticker, ts, type, severity, message, move_pct, prev_close, close, acknowledged_at, meta
      ) VALUES(@ticker, @ts, @type, @severity, @message, @move_pct, @prev_close, @close, NULL, @meta)
    `);

    let updated = 0;

    try {

    for (const asset of assets) {
      const { ticker, yahooSymbol } = resolveTicker(asset);
      if (!yahooSymbol) continue;

      const now = Date.now();
      const timeframe = '1d';

      const last = latestStmt.get(ticker, timeframe) as { maxTs?: number } | undefined;
      const lastTs = Number(last?.maxTs ?? 0);

      const yearsMs = backfillYears * 366 * 24 * 60 * 60 * 1000;
      const startMs = lastTs && lastTs > 0 ? Math.max(lastTs - 5 * 24 * 60 * 60 * 1000, now - yearsMs) : (now - yearsMs);
      const endMs = now;

      let bars: Candle[] = [];
      try {
        bars = normalizeCandles(await fetchYahooCandlesByPeriod(yahooSymbol, timeframe, startMs, endMs, true));
      } catch (e: any) {
        warnings.push(`[sync] ${ticker}: Yahoo fetch failed (${yahooSymbol}): ${e?.message || e}`);
        continue;
      }

      if (!bars.length) {
        warnings.push(`[sync] ${ticker}: no candles returned (${yahooSymbol})`);
        continue;
      }

      // Sanity check large day-over-day moves
      for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1];
        const cur = bars[i];
        const pc = Number(prev.close);
        const cc = Number(cur.close);
        if (!Number.isFinite(pc) || !Number.isFinite(cc) || pc <= 0) continue;
        const movePct = Math.abs((cc - pc) / pc) * 100;

        // Corporate actions heuristic: close/prev_close near common split ratios
        if (movePct >= corpActionMovePct) {
          const corp = detectCorporateAction(pc, cc);
          if (corp) {
            const factor = corp.suggestedScaleBeforeFactor;
            const msg = `[corp] ${ticker} ${toISODate(cur.ts)} possible split/reverse-split (ratio~${corp.approxRatio}:1). Suggested scale-before factor=${factor.toFixed(6)} (prev=${pc}, close=${cc})`;
            warnings.push(msg);
            try {
              insertFlag.run({
                ticker,
                ts: cur.ts,
                type: 'CORP_ACTION_SUSPECT',
                severity: 'error',
                message: msg,
                move_pct: movePct,
                prev_close: pc,
                close: cc,
                meta: JSON.stringify({ runId, yahooSymbol, approxRatio: corp.approxRatio, suggestedScaleBeforeFactor: factor }),
              });
            } catch {
              // ignore
            }
          }
        }

        if (movePct > sanityMovePct) {
          const msg = `[sanity] ${ticker} ${toISODate(cur.ts)} move ${movePct.toFixed(1)}% (prev=${pc}, close=${cc})`;
          warnings.push(msg);
          try {
            insertFlag.run({
              ticker,
              ts: cur.ts,
              type: 'SANITY_MOVE',
              severity: 'warn',
              message: msg,
              move_pct: movePct,
              prev_close: pc,
              close: cc,
              meta: JSON.stringify({ runId, yahooSymbol }),
            });
          } catch {
            // ignore
          }
        }
      }

      const trx = db.transaction((rows: Candle[]) => {
        for (const r of rows) {
          insert.run({
            symbol: ticker,
            timeframe,
            ts: r.ts,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume ?? 0,
          });
        }
      });

      trx(bars);
      updated++;
    }
    const finishedAt = Date.now();
    try {
      db.prepare(`
        UPDATE tsmom_sync_runs
        SET finished_at=?, updated=?, status='completed', warnings=?
        WHERE id=?
      `).run(finishedAt, updated, JSON.stringify(warnings), runId);
    } catch {
      // ignore
    }

    return { startedAt, finishedAt, assets: assets.length, updated, warnings };
    } catch (e: any) {
      const finishedAt = Date.now();
      try {
        db.prepare(`
          UPDATE tsmom_sync_runs
          SET finished_at=?, updated=?, status='failed', warnings=?
          WHERE id=?
        `).run(finishedAt, updated, JSON.stringify([...warnings, `[sync] failed: ${e?.message || e}`]), runId);
      } catch {
        // ignore
      }
      throw e;
    }
  }
}
