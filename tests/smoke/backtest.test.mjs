#!/usr/bin/env node
import { runTickerBacktest } from '../../dist-electron/src/main/services/backtest/backtestRunner.js';

// Lightweight smoke test: verify the backtest module loads and exposes expected API.
// (We intentionally avoid a network/DB backtest run here to keep this test deterministic.)

function assert(name, cond) {
  if (!cond) throw new Error('FAIL: ' + name);
  console.log('PASS:', name);
}

console.log('[backtest.test] start');
assert('exports runTickerBacktest', typeof runTickerBacktest === 'function');
console.log('[backtest.test] done');
