// Runs under Electron's Node runtime to match better-sqlite3 ABI.
// Usage:
//   cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/audit_assets_multipliers_electron.mjs
// Optional:
//   --min=0.000001 --max=100000 --onlyActive

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { getDB, initDB } from '../dist-electron/src/main/db.js';

function parseArgs(argv) {
  const out = { min: 0, max: Number.POSITIVE_INFINITY, onlyActive: false, showNon1: true };
  for (const a of argv.slice(2)) {
    if (a === '--onlyActive') out.onlyActive = true;
    else if (a === '--noShowNon1') out.showNon1 = false;
    else if (a.startsWith('--min=')) out.min = Number(a.slice('--min='.length));
    else if (a.startsWith('--max=')) out.max = Number(a.slice('--max='.length));
  }
  return out;
}

function guessDbPath() {
  // Keep in sync with resync script heuristics.
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, 'Electron', 'swingsense.db');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'swingsense.db');
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = guessDbPath();

  // Ensure schema is initialized and DB is opened.
  // initDB is idempotent.
  return initDB(dbPath).then(() => {
    const db = getDB();

    const rows = db
      .prepare(
        `SELECT ticker, name, category, status, yahoo_symbol, price_multiplier
         FROM assets
         ${args.onlyActive ? "WHERE status='active'" : ''}
         ORDER BY ticker ASC`
      )
      .all();

    const suspicious = [];
    const non1 = [];
    for (const r of rows) {
      const m = Number(r.price_multiplier);
      const ok = Number.isFinite(m) && m >= args.min && m <= args.max;
      if (!ok) suspicious.push({ ...r, price_multiplier: m });
      else if (args.showNon1 && m !== 1) non1.push({ ...r, price_multiplier: m });
    }

    console.log(`[audit] dbPath=${dbPath}`);
    console.log(`[audit] assets=${rows.length} suspicious=${suspicious.length} non1=${non1.length}`);

    if (args.showNon1 && non1.length) {
      console.log('--- non-1 multipliers ---');
      console.log('ticker\tstatus\tmultiplier\tcategory\tyahoo_symbol\tname');
      for (const r of non1) {
        console.log(
          `${r.ticker}\t${r.status}\t${r.price_multiplier}\t${r.category ?? ''}\t${r.yahoo_symbol ?? ''}\t${r.name ?? ''}`
        );
      }
    }

    if (suspicious.length) {
      console.log('ticker\tstatus\tmultiplier\tcategory\tyahoo_symbol\tname');
      for (const r of suspicious) {
        console.log(
          `${r.ticker}\t${r.status}\t${r.price_multiplier}\t${r.category ?? ''}\t${r.yahoo_symbol ?? ''}\t${r.name ?? ''}`
        );
      }
      process.exitCode = 2;
    }
  });
}

await main();
