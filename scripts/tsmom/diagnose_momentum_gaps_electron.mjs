// Diagnose why some assets don't compute momentum.
// Runs under Electron's Node runtime to match better-sqlite3 ABI.
//
// Usage:
//   npm run build:electron
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/tsmom/diagnose_momentum_gaps_electron.mjs
// Options:
//   --onlyActive
//   --lookback=63 --skip=10
//   --out=reports/momentum_gaps_YYYY-MM-DD.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { getDB, initDB } from '../../dist-electron/src/main/db.js';
import { resolveTicker } from '../../dist-electron/src/main/services/tsmom/tickerMapper.js';

function parseArgs(argv) {
  const out = {
    portfolioId: 1,
    onlyActive: false,
    lookback: 63,
    skip: 10,
    outPath: null,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--portfolioId=')) out.portfolioId = Number(a.slice('--portfolioId='.length));
    if (a === '--onlyActive') out.onlyActive = true;
    else if (a.startsWith('--lookback=')) out.lookback = Number(a.slice('--lookback='.length));
    else if (a.startsWith('--skip=')) out.skip = Number(a.slice('--skip='.length));
    else if (a.startsWith('--out=')) out.outPath = a.slice('--out='.length);
  }
  if (!Number.isFinite(out.portfolioId) || out.portfolioId <= 0) out.portfolioId = 1;
  if (!Number.isFinite(out.lookback) || out.lookback <= 0) out.lookback = 63;
  if (!Number.isFinite(out.skip) || out.skip < 0) out.skip = 10;
  out.lookback = Math.floor(out.lookback);
  out.skip = Math.floor(out.skip);
  return out;
}

function guessDbPath() {
  const envPath = process.env.SWINGSENSE_DB_PATH;
  if (envPath) return envPath;
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, 'Electron', 'swingsense.db');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'swingsense.db');
}

function isoDate(ts) {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function mdEscape(s) {
  return String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const args = parseArgs(process.argv);
const dbPath = guessDbPath();
await initDB(dbPath);
const db = getDB();

const assets = db
  .prepare(
    `SELECT u.ticker as ticker,
            pa.name as name,
            pa.category as category,
            'active' as status,
            pa.yahoo_symbol as yahoo_symbol,
            pa.price_multiplier as price_multiplier,
            COALESCE(pa.created_at, u.created_at) as created_at,
            COALESCE(pa.updated_at, u.created_at) as updated_at,
            pa.meta as meta
     FROM portfolio_universe u
     LEFT JOIN portfolio_assets pa ON pa.portfolio_id=u.portfolio_id AND pa.ticker=u.ticker
     WHERE u.portfolio_id=?
     ORDER BY category, ticker`
  )
  .all(args.portfolioId);

const candleCountStmt = db.prepare("SELECT COUNT(*) AS c FROM candles WHERE symbol=? AND timeframe='1d'");
const validCloseCountStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM candles WHERE symbol=? AND timeframe='1d' AND close IS NOT NULL AND close>0"
);
const lastTsStmt = db.prepare("SELECT MAX(ts) AS maxTs FROM candles WHERE symbol=? AND timeframe='1d'");
const closeAtStmt = db.prepare(
  "SELECT close FROM candles WHERE symbol=? AND timeframe='1d' AND close IS NOT NULL AND close>0 ORDER BY ts ASC LIMIT 1 OFFSET ?"
);

const required = args.lookback + args.skip + 2;

const rows = [];
for (const a of assets) {
  const { ticker, yahooSymbol } = resolveTicker(a);
  const sym = String(ticker || '').toUpperCase();
  const yahoo = String(yahooSymbol || '').trim();

  const cRow = candleCountStmt.get(sym);
  const count = Number(cRow?.c || 0);
  const vcRow = validCloseCountStmt.get(sym);
  const validCount = Number(vcRow?.c || 0);
  const ltRow = lastTsStmt.get(sym);
  const lastTs = Number(ltRow?.maxTs || 0);

  let reason = 'OK';
  let mom = null;

  if (!yahoo) {
    reason = 'NO_YAHOO_SYMBOL';
  } else if (validCount < required) {
    reason = `INSUFFICIENT_VALID_CLOSES(valid=${validCount}, total=${count}, need>=${required})`;
  } else {
    // Use ascending offset indexing: a at (n-1-skip-lookback), b at (n-1-skip)
    const idxB = validCount - 1 - args.skip;
    const idxA = idxB - args.lookback;

    const aRow = idxA >= 0 ? closeAtStmt.get(sym, idxA) : null;
    const bRow = idxB >= 0 ? closeAtStmt.get(sym, idxB) : null;
    const aClose = Number(aRow?.close);
    const bClose = Number(bRow?.close);

    if (!Number.isFinite(aClose) || !Number.isFinite(bClose) || aClose <= 0 || bClose <= 0) {
      reason = 'INVALID_CLOSES_IN_WINDOW';
    } else {
      mom = (bClose / aClose - 1) * 100;
    }
  }

  rows.push({
    ticker: sym,
    status: a.status,
    category: a.category,
    yahoo_symbol: a.yahoo_symbol,
    resolved_yahoo: yahoo || null,
    price_multiplier: a.price_multiplier,
    candles_1d: count,
    valid_closes_1d: validCount,
    last_candle: lastTs ? isoDate(lastTs) : null,
    momentum_pct: mom,
    reason,
    name: a.name,
  });
}

const missing = rows.filter(r => r.reason !== 'OK');
const ok = rows.filter(r => r.reason === 'OK');

const now = new Date();
const ymd = now.toISOString().slice(0, 10);
const outPath = args.outPath
  ? path.resolve(process.cwd(), args.outPath)
  : path.resolve(process.cwd(), 'reports', `momentum_gaps_${ymd}.md`);

const lines = [];
lines.push(`# Momentum Diagnostics (${ymd})`);
lines.push('');
lines.push(`- dbPath: ${dbPath}`);
lines.push(`- assets: ${rows.length} (ok=${ok.length}, missing=${missing.length})`);
lines.push(`- lookback=${args.lookback}, skip=${args.skip}, requiredCandles>=${required}`);
lines.push('');

const byReason = new Map();
for (const r of missing) byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
lines.push('## Missing By Reason');
lines.push('');
for (const [k, v] of Array.from(byReason.entries()).sort((a, b) => b[1] - a[1])) {
  lines.push(`- ${k}: ${v}`);
}
lines.push('');

lines.push('## Missing Details');
lines.push('');
lines.push('| ticker | status | candles_1d | valid_1d | last_candle | reason | resolved_yahoo | multiplier | category | name |');
lines.push('|---|---:|---:|---|---|---|---:|---|---|');
for (const r of missing) {
  lines.push(
    `| ${mdEscape(r.ticker)} | ${mdEscape(r.status)} | ${mdEscape(r.candles_1d)} | ${mdEscape(r.valid_closes_1d)} | ${mdEscape(r.last_candle)} | ${mdEscape(r.reason)} | ${mdEscape(r.resolved_yahoo)} | ${mdEscape(r.price_multiplier)} | ${mdEscape(r.category)} | ${mdEscape(r.name)} |`
  );
}
lines.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

console.log(`[momentum] dbPath=${dbPath}`);
console.log(`[momentum] assets=${rows.length} ok=${ok.length} missing=${missing.length}`);
console.log(`[momentum] wrote report: ${outPath}`);
