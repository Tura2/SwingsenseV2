#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDB, initDB } from '../../../dist-electron/src/main/db.js';
import { fetchYahooCandlesByPeriod } from '../../../dist-electron/src/main/services/yahooChartApi.js';
import { TsmomSyncManager } from '../../../dist-electron/src/main/services/tsmom/syncManager.js';
import { ensurePortfolioUniverseSeededFromExpandedUniverseJson } from '../../../dist-electron/src/main/services/tsmom/universeSeeder.js';

function parseArgv(argv) {
  const out = { years: 5, wipe: true, allAssets: false, portfolioId: 1 };
  for (const a of argv) {
    if (!a || typeof a !== 'string') continue;
    if (a === '--noWipe' || a === '--no-wipe') out.wipe = false;
    else if (a === '--allAssets' || a === '--all-assets') out.allAssets = true;
    else if (a.startsWith('--portfolioId=')) out.portfolioId = Number(a.slice('--portfolioId='.length));
    else if (a.startsWith('--years=')) out.years = Number(a.slice('--years='.length));
    else if (a.startsWith('--backfillYears=')) out.years = Number(a.slice('--backfillYears='.length));
    else if (a.startsWith('--sanityMovePct=')) out.sanityMovePct = Number(a.slice('--sanityMovePct='.length));
    else if (a.startsWith('--corpActionMovePct=')) out.corpActionMovePct = Number(a.slice('--corpActionMovePct='.length));
  }
  if (!Number.isFinite(out.years) || out.years <= 0) out.years = 5;
  out.years = Math.min(20, Math.max(1, Math.floor(out.years)));
  if (!Number.isFinite(out.portfolioId) || out.portfolioId <= 0) out.portfolioId = 1;
  return out;
}

function nowMs() {
  return Date.now();
}

function cleanCandles(bars) {
  const cleaned = (bars || [])
    .filter(c => [c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
    .filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .sort((a, b) => a.ts - b.ts);

  const dedup = [];
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

function findDbPathFromUserData() {
  const envPath = process.env.SWINGSENSE_DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const direct = [
    path.join(appData, 'swingsenseV2', 'swingsense.db'),
    path.join(appData, 'swingsense-v2', 'swingsense.db'),
    path.join(appData, 'SwingsenseV2', 'swingsense.db'),
    path.join(appData, 'Swingsense-v2', 'swingsense.db'),
    // In dev, Electron sometimes uses the default app name "Electron" for userData.
    path.join(appData, 'Electron', 'swingsense.db'),
    path.join(localAppData, 'swingsenseV2', 'swingsense.db'),
    path.join(localAppData, 'swingsense-v2', 'swingsense.db'),
    path.join(localAppData, 'Electron', 'swingsense.db'),
  ];
  for (const p of direct) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const entries = fs.readdirSync(appData, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(n => /swingsense/i.test(n));
    for (const dir of entries) {
      const p = path.join(appData, dir, 'swingsense.db');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // ignore
  }

  return null;
}

async function syncExtraSymbol(db, { symbol, startMs, endMs }) {
  const bars = await fetchYahooCandlesByPeriod(symbol, '1d', startMs, endMs, true);
  const cleaned = cleanCandles(bars);
  if (!cleaned.length) return { symbol, inserted: 0 };

  const insert = db.prepare(`
    INSERT OR REPLACE INTO candles(symbol, timeframe, ts, open, high, low, close, volume)
    VALUES(@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume)
  `);

  const trx = db.transaction(() => {
    for (const c of cleaned) {
      insert.run({
        symbol,
        timeframe: '1d',
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
  });
  trx();

  return { symbol, inserted: cleaned.length };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const dbPath = findDbPathFromUserData();
  if (!dbPath) {
    throw new Error(
      'Could not locate swingsense.db. Run the Electron app once, or set SWINGSENSE_DB_PATH to the full path of swingsense.db.'
    );
  }

  await initDB(dbPath);
  const db = getDB();

  const years = args.years;
  const startMs = nowMs() - years * 366 * 24 * 60 * 60 * 1000;
  const endMs = nowMs();

  const extras = ['USDILS=X', '^GSPC', 'SPY', '^TA125.TA', 'TA35.TA', 'TA90.TA'];

  console.log(`[resync] starting (years=${years}, wipe=${args.wipe ? 'yes' : 'no'}, allPortfolios=${args.allAssets ? 'yes' : 'no'}, portfolioId=${args.portfolioId})`);
  console.log(`[resync] dbPath=${dbPath}`);

  // Ensure we have a portfolio universe to sync.
  try {
    const seeded = ensurePortfolioUniverseSeededFromExpandedUniverseJson({
      db,
      portfolioId: args.portfolioId,
      jsonPathCandidates: [
        path.resolve(process.cwd(), 'data', 'tsmom_turbo_expanded_universe.json'),
        path.resolve(process.cwd(), 'data', 'tsmom_turbo_expanded_us_universe.json'),
      ],
    });
    if (seeded?.seeded) console.log(`[resync] seeded portfolio universe from JSON: portfolioId=${args.portfolioId} count=${seeded.count}`);
  } catch (e) {
    console.log(`[resync] universe seeding skipped/failed: ${e?.message || e}`);
  }

  // Always remove clearly-invalid candles (pre-existing). Keeps DB sane even if wipe=false.
  const badDel = db.prepare("DELETE FROM candles WHERE timeframe='1d' AND (open<=0 OR high<=0 OR low<=0 OR close<=0)").run();
  if (Number(badDel?.changes || 0) > 0) console.log(`[resync] removed invalid candles: ${badDel.changes}`);

  if (args.wipe) {
    const assetSyms = (args.allAssets
      ? db.prepare("SELECT DISTINCT UPPER(ticker) AS sym FROM portfolio_universe").all()
      : db.prepare("SELECT DISTINCT UPPER(ticker) AS sym FROM portfolio_universe WHERE portfolio_id=?").all(args.portfolioId)
    ).map(r => String(r.sym));

    const wipeSyms = Array.from(new Set([...assetSyms, ...extras.map(s => s.toUpperCase())]));
    console.log(`[resync] wiping 1d candles for ${wipeSyms.length} symbols…`);

    const del = db.prepare("DELETE FROM candles WHERE symbol=? AND timeframe='1d'");
    const trx = db.transaction(() => {
      for (const s of wipeSyms) del.run(s);
    });
    trx();
  }

  console.log('[resync] syncing universe (portfolio universes)…');
  const mgr = new TsmomSyncManager();
  const sum = await mgr.syncDailyCandlesForUniverse({
    backfillYears: years,
    sanityMovePct: Number.isFinite(args.sanityMovePct) ? args.sanityMovePct : undefined,
    corpActionMovePct: Number.isFinite(args.corpActionMovePct) ? args.corpActionMovePct : undefined,
  });
  console.log(`[resync] universe sync done: updated=${sum.updated}, warnings=${sum.warnings.length}`);

  console.log('[resync] syncing extra symbols (benchmarks/FX)…');
  for (const s of extras) {
    try {
      const r = await syncExtraSymbol(db, { symbol: s, startMs, endMs });
      console.log(`[resync] ${r.symbol}: inserted ${r.inserted}`);
    } catch (e) {
      console.log(`[resync] ${s}: FAILED (${e?.message || e})`);
    }
  }

  // Post-clean (just in case)
  const badDel2 = db.prepare("DELETE FROM candles WHERE timeframe='1d' AND (open<=0 OR high<=0 OR low<=0 OR close<=0)").run();
  if (Number(badDel2?.changes || 0) > 0) console.log(`[resync] removed invalid candles (post): ${badDel2.changes}`);

  console.log('[resync] done');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
