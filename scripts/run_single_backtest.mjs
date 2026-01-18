#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

function logStep(msg, obj) {
  console.log(`[RUN][STEP] ${msg}`, obj !== undefined ? obj : '');
}

async function main() {
  const symbol = process.argv[2] || 'GNRS';
  const side = process.argv[3] || 'BOTH';
  const minRR = Number.isFinite(Number(process.argv[4])) ? Number(process.argv[4]) : 0;

  const candidatePaths = [
    'dist-electron/src/main/services/backtest/backtestRunner.js',
    'dist-electron/electron/main/services/backtest/backtestRunner.js',
    'dist-electron/main/services/backtest/backtestRunner.js'
  ];
  let loaded = null;
  for (const p of candidatePaths) {
    const abs = path.resolve(p);
    try {
      logStep('trying_import', { path: abs });
      const url = pathToFileURL(abs).href;
      loaded = await import(url);
      logStep('import_success', { path: abs });
      break;
    } catch (e) {
      logStep('import_fail', { path: abs, error: e.message });
    }
  }
  if (!loaded) {
    console.error('[RUN] Failed to import backtestRunner from all candidate paths');
    process.exit(1);
  }
  const { runTickerBacktest, getLatestForTicker } = loaded;

  // Initialize DB if needed
  const dbModPath = path.resolve('dist-electron/src/main/db.js');
  try {
    const { initDB } = await import(pathToFileURL(dbModPath).href);
    const dbFile = path.resolve('data', 'app.db');
    try {
      await initDB(dbFile);
      logStep('db_init_ok', { dbFile });
    } catch (e) {
      logStep('db_init_error', { error: e.message });
      process.exit(1);
    }
  } catch (e) {
    logStep('db_module_import_fail', { path: dbModPath, error: e.message });
    process.exit(1);
  }

  console.log(`[RUN] Backtest ${symbol} side=${side} minRR=${minRR}`);
  let runId;
  try {
    const res = await runTickerBacktest({ ticker: symbol, minRRGlobal: minRR, side });
    runId = res.runId;
    logStep('runTickerBacktest_ok', { runId });
  } catch (e) {
    logStep('runTickerBacktest_error', { error: e.message });
    process.exit(1);
  }
  console.log('[RUN] runId', runId);
  const latest = getLatestForTicker(symbol);
  if (!latest) {
    logStep('no_latest_for_symbol', { symbol });
    process.exit(1);
  }
  logStep('trades_count', { count: latest.trades?.length });
  console.log('[RUN] latest summary', JSON.stringify(latest?.summary || {}, null, 2));
  const t1 = latest?.trades?.[0];
  if (t1) {
    const breakevenDiff = Math.abs(t1.exit_price - t1.entry_price);
    console.log('[RUN] Trade 1:', {
      seq: t1.seq,
      strategy: t1.strategy_id,
      entry: t1.entry_price,
      stop_at_entry: t1.stop_at_entry,
      target_at_entry: t1.target_at_entry,
      exit_reason: t1.exit_reason,
      exit_price: t1.exit_price,
      r_multiple: t1.r_multiple,
      mae_r: t1.mae_r,
      mfe_r: t1.mfe_r,
      trail_used: t1.trail_used,
      exit_trail_level: t1.exit_trail_level,
      nearBreakeven: breakevenDiff < 1e-6,
      breakevenDiff
    });
  } else {
    logStep('no_trade_1', {});
  }
}

main().catch(err => { console.error('[RUN] error', err); process.exit(1); });
