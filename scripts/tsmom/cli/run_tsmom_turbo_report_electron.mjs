import fs from 'node:fs';
import path from 'node:path';

import { fetchYahooCandlesByPeriod } from '../../../dist-electron/src/main/services/yahooChartApi.js';
import {
  normalizeInputSymbol,
  resolveCanonicalYahooSymbol,
  yahooCandidatesForSymbol,
} from '../../../dist-electron/src/main/services/symbols.js';

const UNIVERSE = [
  'LUMI.TA', 'POLI.TA', 'DSCT.TA', 'MZTF.TA', 'PHOE.TA',
  'HARL.TA', 'NICE.TA', 'TSEM.TA', 'NVMI.TA', 'CAMT.TA',
  'ESLT.TA', 'TEVA.TA', 'AZRG.TA', 'AMOT.TA', 'DLEKG.TA',
  'NWMD.TA', 'ICL.TA', 'STRS.TA', 'SAE.TA', 'RMLI.TA',
];

const PORTFOLIO = {
  initialCapital: 50_000,
  commission: 5,
};

// Compare on the same window as the existing batch report.
const COMPARE_START = Date.parse('2021-01-01T00:00:00Z');
const COMPARE_END = Date.parse('2026-01-11T23:59:59Z');

// Record book window: last 24 months from "now" (2026-01-11)
const RECORD24_START = Date.parse('2024-01-11T00:00:00Z');
const RECORD24_END = COMPARE_END;

const START_MS = Date.parse('1990-01-01T00:00:00Z');
const END_MS = COMPARE_END;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function toDateISO(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toMonthKeyUTC(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function lowerBoundTs(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastIndexAtOrBefore(arr, ts) {
  const i = lowerBoundTs(arr, ts);
  return i === 0 ? -1 : i - 1;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  return Math.sqrt(v / (arr.length - 1));
}

function round2(x) {
  if (!Number.isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}

function formatNIS(x) {
  if (!Number.isFinite(x)) return 'n/a';
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchFullDailyCandles(inputSymbol) {
  const original = normalizeInputSymbol(inputSymbol);
  const resolved = await resolveCanonicalYahooSymbol(original).catch(() => ({ candidates: yahooCandidatesForSymbol(original) }));
  const candidates = resolved.candidates?.length ? resolved.candidates : yahooCandidatesForSymbol(original);

  let lastErr = null;
  for (const ysym of candidates) {
    try {
      const candles = await fetchYahooCandlesByPeriod(ysym, '1d', START_MS, END_MS, true);
      const isTase = String(ysym || '').toUpperCase().endsWith('.TA');
      const pxMult = isTase ? 0.01 : 1; // agorot -> NIS

      const cleaned = (candles || [])
        .filter(c => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0)
        .filter(c => c.ts >= START_MS && c.ts <= END_MS)
        .map(c => ({
          ...c,
          open: c.open * pxMult,
          high: c.high * pxMult,
          low: c.low * pxMult,
          close: c.close * pxMult,
        }))
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

      if (dedup.length) return { ysym, bars: dedup };
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`No candles for ${original}. Last error: ${lastErr?.message || lastErr}`);
}

function precomputeSignalInputs(bars, volCenterDays) {
  const n = bars.length;
  const close = bars.map(b => b.close);

  const r = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev = close[i - 1];
    const cur = close[i];
    if (!(prev > 0) || !(cur > 0)) {
      r[i] = NaN;
      continue;
    }
    const raw = cur / prev - 1;
    r[i] = Number.isFinite(raw) ? clamp(raw, -0.95, 5) : NaN;
  }

  const delta = clamp(volCenterDays / (volCenterDays + 1), 0.90, 0.9999);
  const mu = new Array(n).fill(0);
  const varD = new Array(n).fill(0);
  const sigmaAnn = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const lag = r[i - 1];
    if (!Number.isFinite(lag)) {
      mu[i] = mu[i - 1];
      varD[i] = varD[i - 1];
      sigmaAnn[i] = sigmaAnn[i - 1];
      continue;
    }
    const muPrev = mu[i - 1];
    const varPrev = varD[i - 1];
    const muNow = delta * muPrev + (1 - delta) * lag;
    const diff = lag - muNow;
    const varNow = delta * varPrev + (1 - delta) * (diff * diff);
    mu[i] = muNow;
    varD[i] = varNow;
    sigmaAnn[i] = Math.sqrt(261 * Math.max(0, varNow));
  }

  return { close, sigmaAnn };
}

function buildMonthlyRebalanceCalendar(refBars, startTs, endTs) {
  const out = [];
  for (let i = 1; i < refBars.length; i++) {
    const ts = refBars[i].ts;
    if (ts < startTs || ts > endTs) continue;
    const isNewMonth = toMonthKeyUTC(refBars[i].ts) !== toMonthKeyUTC(refBars[i - 1].ts);
    if (isNewMonth) out.push({ ts, monthKey: toMonthKeyUTC(ts) });
  }
  return out;
}

function computeMomentumAtExec({ close, execI, lookbackTradingDays, skipRecentTradingDays }) {
  const t = execI - 1;
  const t0 = t - skipRecentTradingDays;
  const lb = t0 - lookbackTradingDays;
  if (lb < 0 || t0 < 0) return null;
  const c0 = close[t0];
  const c1 = close[lb];
  if (!(c0 > 0) || !(c1 > 0)) return null;
  const mom = c0 / c1 - 1;
  return Number.isFinite(mom) ? mom : null;
}

function sizeFromSigma({ sigmaAnn, execI, targetVolAnn, maxLeverage, minSigmaAnn }) {
  const sig = sigmaAnn[execI];
  const denom = Math.max(minSigmaAnn, Number.isFinite(sig) ? sig : 0);
  if (!(denom > 0)) return 0;
  return clamp(targetVolAnn / denom, 0, maxLeverage);
}

function simulatePortfolio({
  name,
  perSymbol,
  perSymInputs,
  rebalanceCalendar,
  startTs,
  endTs,
  params,
  turbo,
  recordLogStartTs,
}) {
  let cash = PORTFOLIO.initialCapital;
  let commissionsTotal = 0;
  const holdings = new Map(); // sym -> shares

  const logRows = [];

  for (const rb of rebalanceCalendar) {
    const rbTs = rb.ts;
    const monthKey = rb.monthKey;

    // determine execution index, momentum, size per symbol
    const snapshot = [];

    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      const { close, sigmaAnn } = perSymInputs[sym];

      const execI = lowerBoundTs(bars, rbTs);
      if (execI >= bars.length) continue;
      if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;

      const mom = computeMomentumAtExec({
        close,
        execI,
        lookbackTradingDays: params.lookbackTradingDays,
        skipRecentTradingDays: params.skipRecentTradingDays,
      });

      const size = sizeFromSigma({
        sigmaAnn,
        execI,
        targetVolAnn: params.targetVolAnn,
        maxLeverage: params.maxLeverage,
        minSigmaAnn: params.minSigmaAnn,
      });

      snapshot.push({
        sym,
        execTs: bars[execI].ts,
        execPrice: bars[execI].close,
        mom: mom ?? null,
        size,
      });
    }

    // choose eligible symbols
    let selected = snapshot
      .filter(x => x.mom != null && x.mom > 0)
      .sort((a, b) => (b.mom - a.mom));

    if (turbo) selected = selected.slice(0, 5);

    const raw = new Map();
    let sumRaw = 0;
    for (const x of selected) {
      const w = x.size;
      if (!(w > 0)) continue;
      raw.set(x.sym, w);
      sumRaw += w;
    }

    // equity at rebalance, valued at last close <= rbTs
    let equity = cash;
    for (const sym of UNIVERSE) {
      const sh = holdings.get(sym) || 0;
      if (sh === 0) continue;
      const bars = perSymbol[sym].bars;
      const iVal = lastIndexAtOrBefore(bars, rbTs);
      if (iVal < 0) continue;
      equity += sh * bars[iVal].close;
    }

    // target weights (cash-only normalization)
    const weights = new Map();
    if (sumRaw > 0) {
      for (const sym of UNIVERSE) {
        const w = raw.get(sym) || 0;
        weights.set(sym, w / sumRaw);
      }
    } else {
      for (const sym of UNIVERSE) weights.set(sym, 0);
    }

    // desired shares
    const desired = new Map();
    for (const sym of UNIVERSE) {
      const snap = snapshot.find(s => s.sym === sym) || null;
      const px = snap?.execPrice;
      if (!(px > 0)) {
        desired.set(sym, 0);
        continue;
      }
      const targetValue = equity * (weights.get(sym) || 0);
      desired.set(sym, Math.floor(targetValue / px));
    }

    const rbDate = toDateISO(rbTs);
    const logThisRebalance = rbTs >= recordLogStartTs;
    const logged = new Set();

    // sells first
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired.get(sym) || 0;
      if (tgt >= cur) continue;

      const snap = snapshot.find(s => s.sym === sym) || null;
      const px = snap?.execPrice;
      if (!(px > 0)) continue;

      const qty = cur - tgt;
      const proceeds = qty * px;
      cash += proceeds;
      cash -= PORTFOLIO.commission;
      commissionsTotal += PORTFOLIO.commission;
      holdings.set(sym, tgt);

      if (logThisRebalance) {
        logRows.push({
          date: rbDate,
          action: tgt === 0 ? 'Close' : 'Sell',
          symbol: sym,
          qty,
          price: round2(px),
          tradeValue: round2(proceeds),
          commission: PORTFOLIO.commission,
          cashAfter: round2(cash),
        });
      }
      logged.add(sym);
    }

    // buys
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired.get(sym) || 0;
      if (tgt <= cur) continue;

      const snap = snapshot.find(s => s.sym === sym) || null;
      const px = snap?.execPrice;
      if (!(px > 0)) continue;

      const want = tgt - cur;
      if (cash <= PORTFOLIO.commission) continue;
      const maxAffordable = Math.floor((cash - PORTFOLIO.commission) / px);
      const qty = Math.min(want, Math.max(0, maxAffordable));
      if (qty <= 0) continue;

      const cost = qty * px;
      cash -= cost;
      cash -= PORTFOLIO.commission;
      commissionsTotal += PORTFOLIO.commission;
      holdings.set(sym, cur + qty);

      if (logThisRebalance) {
        logRows.push({
          date: rbDate,
          action: 'Buy',
          symbol: sym,
          qty,
          price: round2(px),
          tradeValue: round2(cost),
          commission: PORTFOLIO.commission,
          cashAfter: round2(cash),
        });
      }
      logged.add(sym);
    }

    // holds
    if (logThisRebalance) {
      for (const sym of UNIVERSE.slice().sort()) {
        if (logged.has(sym)) continue;
        const snap = snapshot.find(s => s.sym === sym) || null;
        const px = snap?.execPrice;
        logRows.push({
          date: rbDate,
          action: 'Hold',
          symbol: sym,
          qty: 0,
          price: Number.isFinite(px) ? round2(px) : NaN,
          tradeValue: 0,
          commission: 0,
          cashAfter: round2(cash),
        });
      }
    }
  }

  // compute daily equity series on ref calendar
  const refBars = perSymbol['LUMI.TA'].bars;
  const dayTsList = refBars
    .filter(b => b.ts >= startTs && b.ts <= endTs)
    .map(b => b.ts);

  // pointers for each symbol
  const ptr = new Map();
  const lastClose = new Map();
  for (const sym of UNIVERSE) {
    ptr.set(sym, 0);
    lastClose.set(sym, NaN);
  }

  const equitySeries = [];
  for (const ts of dayTsList) {
    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      let i = ptr.get(sym) || 0;
      while (i < bars.length && bars[i].ts <= ts) {
        lastClose.set(sym, bars[i].close);
        i++;
      }
      ptr.set(sym, i);
    }

    let eq = cash;
    for (const sym of UNIVERSE) {
      const sh = holdings.get(sym) || 0;
      if (sh === 0) continue;
      const px = lastClose.get(sym);
      if (!Number.isFinite(px)) continue;
      eq += sh * px;
    }
    equitySeries.push({ ts, equity: eq });
  }

  const rets = [];
  for (let i = 1; i < equitySeries.length; i++) {
    const prev = equitySeries[i - 1].equity;
    const cur = equitySeries[i].equity;
    if (!(prev > 0) || !(cur > 0)) continue;
    const r = cur / prev - 1;
    if (Number.isFinite(r)) rets.push(r);
  }

  const muD = mean(rets);
  const volD = stdev(rets);
  const sharpe = volD > 0 ? (muD / volD) * Math.sqrt(261) : 0;

  const endValuationTs = Math.max(
    ...UNIVERSE.map(sym => {
      const bars = perSymbol[sym].bars;
      const i = lastIndexAtOrBefore(bars, endTs);
      return i >= 0 ? bars[i].ts : 0;
    })
  );

  // final equity at end
  let finalEquity = cash;
  for (const sym of UNIVERSE) {
    const sh = holdings.get(sym) || 0;
    if (sh === 0) continue;
    const bars = perSymbol[sym].bars;
    const i = lastIndexAtOrBefore(bars, endTs);
    if (i < 0) continue;
    finalEquity += sh * bars[i].close;
  }

  return {
    name,
    startDate: toDateISO(startTs),
    endDate: toDateISO(endTs),
    endValuationDate: toDateISO(endValuationTs),
    finalEquity: round2(finalEquity),
    totalCommissions: round2(commissionsTotal),
    sharpe: round2(sharpe),
    logRows,
  };
}

function renderLogTable(rows) {
  const header = `| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Remaining Cash |\n` +
    `|---|---|---|---:|---:|---:|---:|---:|\n`;
  const lines = rows.map(r => {
    const priceStr = Number.isFinite(r.price) ? formatNIS(r.price) : 'n/a';
    const valStr = Number.isFinite(r.tradeValue) ? formatNIS(r.tradeValue) : '0.00';
    const commStr = Number.isFinite(r.commission) ? formatNIS(r.commission) : '0.00';
    const cashStr = formatNIS(r.cashAfter);
    return `| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${priceStr} | ${valStr} | ${commStr} | ${cashStr} |`;
  });
  return header + lines.join('\n');
}

async function main() {
  console.log('[turbo] Fetching candles...');

  const perSymbol = {};
  for (const sym of UNIVERSE) {
    console.log('[turbo] Fetch', sym);
    const { bars } = await fetchFullDailyCandles(sym);
    perSymbol[sym] = { bars };
  }

  const perSymInputs = {};
  for (const sym of UNIVERSE) {
    perSymInputs[sym] = precomputeSignalInputs(perSymbol[sym].bars, 60);
  }

  const refBars = perSymbol['LUMI.TA'].bars;
  const rebalanceCalendar = buildMonthlyRebalanceCalendar(refBars, COMPARE_START, COMPARE_END);

  // Standard (baseline): 12-1, 40% target vol, long-only, no top-k
  const standardParams = {
    lookbackTradingDays: 252,
    skipRecentTradingDays: 21,
    targetVolAnn: 0.40,
    maxLeverage: 5,
    minSigmaAnn: 0.01,
  };

  // Turbo: top 5 by momentum, 3-1, 80% target vol
  const turboParams = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 21,
    targetVolAnn: 0.80,
    maxLeverage: 5,
    minSigmaAnn: 0.01,
  };

  console.log('[turbo] Simulating standard...');
  const standard = simulatePortfolio({
    name: 'Standard (12-1, 40% vol, all positive)',
    perSymbol,
    perSymInputs,
    rebalanceCalendar,
    startTs: COMPARE_START,
    endTs: COMPARE_END,
    params: standardParams,
    turbo: false,
    recordLogStartTs: Number.POSITIVE_INFINITY, // don’t include log
  });

  console.log('[turbo] Simulating turbo...');
  const turbo = simulatePortfolio({
    name: 'Turbo (Top-5, 3-1, 80% vol)',
    perSymbol,
    perSymInputs,
    rebalanceCalendar,
    startTs: COMPARE_START,
    endTs: COMPARE_END,
    params: turboParams,
    turbo: true,
    recordLogStartTs: RECORD24_START,
  });

  const prevBatchSharpe = 0.81;
  const prevBatchCagr = '10.4%';
  const prevBatchFinalEqMultiple = 1.6403;

  const md = `# TSMOM Turbo Results\n\n` +
    `Date range (comparison): **${standard.startDate} → ${standard.endDate}** (final valuation: **${standard.endValuationDate}**)\n\n` +
    `Portfolio: **50,000 NIS**, commission **5 NIS** per execution, whole shares only.\n\n` +
    `Turbo strategy changes:\n` +
    `- Concentration: **Top 5** stocks by relative momentum at each rebalance\n` +
    `- Disqualify negative momentum\n` +
    `- Lookback: **3-1** (approx 63 trading days, skipping last 21 trading days)\n` +
    `- Target vol: **80%** (cash-only normalization after vol scaling)\n\n` +
    `## Headline Comparison\n\n` +
    `Previous Standard (from batch report, no commissions / no share rounding): Sharpe **${prevBatchSharpe}**, CAGR **${prevBatchCagr}**, Final Equity **${prevBatchFinalEqMultiple}x**.\n\n` +
    `This run (includes commissions + whole shares):\n\n` +
    `| Variant | Sharpe | Final Equity (NIS) | Total Commissions (NIS) |\n` +
    `|---|---:|---:|---:|\n` +
    `| Standard (12-1, 40% vol) | ${standard.sharpe.toFixed(2)} | ${formatNIS(standard.finalEquity)} | ${formatNIS(standard.totalCommissions)} |\n` +
    `| Turbo (Top-5, 3-1, 80% vol) | ${turbo.sharpe.toFixed(2)} | ${formatNIS(turbo.finalEquity)} | ${formatNIS(turbo.totalCommissions)} |\n\n` +
    `## Turbo Record Book (Last 24 Months)\n\n` +
    `Window: **${toDateISO(RECORD24_START)} → ${toDateISO(RECORD24_END)}**\n\n` +
    renderLogTable(turbo.logRows) +
    `\n\n## Notes\n\n` +
    `- The Turbo version is intentionally more aggressive (shorter lookback, higher target vol, concentrated Top-5). Expect higher turnover and commissions.\n` +
    `- Results differ from the earlier portfolio batch report because this simulation enforces **whole shares** and **5 NIS commissions** per execution.\n`;

  const outDir = path.resolve(process.cwd(), 'reports', 'tsmom', 'turbo');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(outDir, 'TSMOM_Turbo_Results.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log('[turbo] Wrote', outPath);

  process.exit(0);
}

main().catch(err => {
  console.error('[turbo] Failed:', err);
  process.exit(1);
});
