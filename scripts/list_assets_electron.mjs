// Runs under Electron's Node runtime to match better-sqlite3 ABI.
// Usage:
//   npm run build:electron
//   cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/list_assets_electron.mjs
// Options:
//   --portfolioId=1
//   --out=reports/assets_list.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { getDB, initDB } from '../dist-electron/src/main/db.js';

function parseArgs(argv) {
  const out = { portfolioId: 1, outPath: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--portfolioId=')) out.portfolioId = Number(a.slice('--portfolioId='.length));
    else if (a.startsWith('--out=')) out.outPath = a.slice('--out='.length);
  }
  if (!Number.isFinite(out.portfolioId) || out.portfolioId <= 0) out.portfolioId = 1;
  return out;
}

function guessDbPath() {
  const envPath = process.env.SWINGSENSE_DB_PATH;
  if (envPath) return envPath;
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, 'Electron', 'swingsense.db');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'swingsense.db');
}

function mdEscape(s) {
  return String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const args = parseArgs(process.argv);
const dbPath = guessDbPath();
await initDB(dbPath);
const db = getDB();

const rows = db
  .prepare(
    `SELECT u.ticker as ticker,
            pa.name as name,
            pa.category as category,
            'active' as status,
            pa.yahoo_symbol as yahoo_symbol,
            pa.price_multiplier as price_multiplier
     FROM portfolio_universe u
     LEFT JOIN portfolio_assets pa ON pa.portfolio_id=u.portfolio_id AND pa.ticker=u.ticker
     WHERE u.portfolio_id=?
     ORDER BY category, ticker`
  )
  .all(args.portfolioId);

const now = new Date();
const ymd = now.toISOString().slice(0, 10);
const outPath = args.outPath
  ? path.resolve(process.cwd(), args.outPath)
  : path.resolve(process.cwd(), 'reports', `assets_list_${ymd}.md`);

const lines = [];
lines.push(`# Portfolio Universe List (${ymd})`);
lines.push('');
lines.push(`- dbPath: ${dbPath}`);
lines.push(`- portfolioId: ${args.portfolioId}`);
lines.push(`- count: ${rows.length}`);
lines.push('');
lines.push('| ticker | status | multiplier | category | yahoo_symbol | name |');
lines.push('|---|---:|---:|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${mdEscape(r.ticker)} | ${mdEscape(r.status)} | ${mdEscape(r.price_multiplier)} | ${mdEscape(r.category)} | ${mdEscape(r.yahoo_symbol)} | ${mdEscape(r.name)} |`
  );
}
lines.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

console.log(`[universe] dbPath=${dbPath}`);
console.log(`[universe] portfolioId=${args.portfolioId}`);
console.log(`[universe] wrote ${rows.length} rows to ${outPath}`);
