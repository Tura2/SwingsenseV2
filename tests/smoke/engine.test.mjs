#!/usr/bin/env node
// Lightweight ad-hoc test harness (no Jest) for strategy engine sanity.
import { buildIndicatorBundle } from '../../backend/src/main/services/indicatorService.js';
import { getEnabledStrategies } from '../../backend/src/main/services/strategies/index.js';
import { loadEngineConfig } from '../../backend/src/main/services/config/engineConfig.js';
import { detectFlagPennant, detectCupHandle } from '../../backend/src/main/services/utils/patternUtils.js';
import { activeUpLegPivot, inFibZone } from '../../backend/src/main/services/utils/fibUtils.js';


function assert(name, cond) { if (!cond) { throw new Error('FAIL: '+name); } console.log('PASS:', name); }

function makeCandles(prices) {
  return prices.map((p,i)=>({ ts: Date.now() + i*86400000, open:p*0.99, high:p*1.01, low:p*0.98, close:p, volume: Math.round(1000000*(1+ (i%5)/10)) }));
}

// Utility tests
(() => {
  const closes = [10,11,12,11.5,11.8,12.2,12.4,12.3,12.5,12.7,12.6,12.8,12.9,13];
  const highs = closes.map(c=>c*1.01); const lows = closes.map(c=>c*0.99);
  const ema20 = closes.map(c=>c); // dummy trending
  const flag = detectFlagPennant(closes, highs, lows, ema20);
  assert('detectFlagPennant returns object', typeof flag === 'object');
  const cup = detectCupHandle([...Array(50).keys()].map(i=> 50 + Math.sin(i/10)*5 + (i>35? i-35:0)));
  assert('detectCupHandle returns object', typeof cup === 'object');
  const leg = activeUpLegPivot(closes);
  assert('activeUpLegPivot indexes valid', leg.swingHighIdx >= leg.swingLowIdx);
  assert('inFibZone negative false', !inFibZone(5,10,20));
})();

// Strategy smoke tests (emaPullback + macdZeroLineUp)
(() => {
  const prices = [];
  for (let i=0;i<160;i++) prices.push(100 + i*0.2 + Math.sin(i/5));
  const candles = makeCandles(prices);
  const cfg = loadEngineConfig();
  // Force enable a couple strategies for smoke
  cfg.enabledStrategies = Array.from(new Set([...cfg.enabledStrategies, 'emaPullback', 'macdZeroLineUp']));
  const bundle = buildIndicatorBundle(candles, cfg.indicatorParams);
  const strategies = getEnabledStrategies(cfg);
  const out = [];
  for (const s of strategies) out.push(...(s.evaluate({ symbol:'TEST', candles, bundle, config: cfg, now: Date.now() })||[]));
  assert('Strategies produce array', Array.isArray(out));
})();

console.log('\nAll ad-hoc tests completed.');
