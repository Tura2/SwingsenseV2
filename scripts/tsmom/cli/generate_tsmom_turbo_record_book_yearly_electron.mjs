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

// Turbo parameters
const TURBO = {
  topK: 5,
  lookbackTradingDays: 63, // ~3 months
  skipRecentTradingDays: 21, // skip ~1 month
  targetVolAnn: 0.80,
  volCenterDays: 60,
  maxLeverage: 5,
  minSigmaAnn: 0.01,
};

const START_MS = Date.parse('1990-01-01T00:00:00Z');
const END_MS = Date.parse('2026-01-11T23:59:59Z');

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

function precomputeCloseAndSigma(bars) {
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

  const delta = clamp(TURBO.volCenterDays / (TURBO.volCenterDays + 1), 0.90, 0.9999);
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

function momentumAtExec(close, execI) {
  const t = execI - 1;
  const t0 = t - TURBO.skipRecentTradingDays;
  const lb = t0 - TURBO.lookbackTradingDays;
  if (lb < 0 || t0 < 0) return null;
  const c0 = close[t0];
  const c1 = close[lb];
  if (!(c0 > 0) || !(c1 > 0)) return null;
  const mom = c0 / c1 - 1;
  return Number.isFinite(mom) ? mom : null;
}

function sizeFromSigma(sigmaAnn, execI) {
  const sig = sigmaAnn[execI];
  const denom = Math.max(TURBO.minSigmaAnn, Number.isFinite(sig) ? sig : 0);
  if (!(denom > 0)) return 0;
  return clamp(TURBO.targetVolAnn / denom, 0, TURBO.maxLeverage);
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

function buildBuyHoldForWindow({ windowStartTs, windowEndTs, perSymbolBars }) {
  const symbols = Object.keys(perSymbolBars).slice().sort();
  let cash = PORTFOLIO.initialCapital;
  let commissions = 0;
  const shares = new Map();

  const eligible = symbols.filter(sym => lastIndexAtOrBefore(perSymbolBars[sym], windowStartTs) >= 0);
  const perSymBudget = eligible.length ? cash / eligible.length : 0;

  for (const sym of eligible) {
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, windowStartTs);
    const px = bars[i].close;
    if (!(px > 0)) continue;
    if (cash <= PORTFOLIO.commission) continue;

    const maxShares = Math.floor((perSymBudget - PORTFOLIO.commission) / px);
    if (maxShares <= 0) continue;

    const cost = maxShares * px;
    cash -= cost;
    cash -= PORTFOLIO.commission;
    commissions += PORTFOLIO.commission;
    shares.set(sym, maxShares);
  }

  let equity = cash;
  for (const [sym, sh] of shares.entries()) {
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, windowEndTs);
    if (i < 0) continue;
    equity += sh * bars[i].close;
  }

  return { equity, commissions };
}

function simulateTurboWindow({ yearLabel, windowStartTs, windowEndTs, perSymbol, perSymInputs }) {
  const refBars = perSymbol['LUMI.TA'].bars;
  const rebalances = buildMonthlyRebalanceCalendar(refBars, windowStartTs, windowEndTs);

  let cash = PORTFOLIO.initialCapital;
  let commissionsTotal = 0;
  const holdings = new Map();
  const logRows = [];

  for (const rb of rebalances) {
    const rbTs = rb.ts;
    const monthKey = rb.monthKey;
    const rbDate = toDateISO(rbTs);

    // snapshot all symbols with exec price, momentum, size
    const snap = [];
    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      const { close, sigmaAnn } = perSymInputs[sym];

      const execI = lowerBoundTs(bars, rbTs);
      if (execI >= bars.length) continue;
      if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;

      const mom = momentumAtExec(close, execI);
      if (!(mom > 0)) continue; // long-only; disqualify <=0

      const size = sizeFromSigma(sigmaAnn, execI);
      if (!(size > 0)) continue;

      snap.push({ sym, execTs: bars[execI].ts, execPrice: bars[execI].close, mom, size });
    }

    // Top-K by momentum
    snap.sort((a, b) => b.mom - a.mom);
    const selected = snap.slice(0, TURBO.topK);

    const raw = new Map();
    let sumRaw = 0;
    for (const x of selected) {
      raw.set(x.sym, x.size);
      sumRaw += x.size;
    }

    // equity at rebalance (mark-to-close at/before rbTs)
    let equity = cash;
    for (const sym of UNIVERSE) {
      const sh = holdings.get(sym) || 0;
      if (sh === 0) continue;
      const bars = perSymbol[sym].bars;
      const iVal = lastIndexAtOrBefore(bars, rbTs);
      if (iVal < 0) continue;
      equity += sh * bars[iVal].close;
    }

    // target weights: normalize to 100% (cash-only)
    const weights = new Map();
    if (sumRaw > 0) {
      for (const sym of UNIVERSE) weights.set(sym, (raw.get(sym) || 0) / sumRaw);
    } else {
      for (const sym of UNIVERSE) weights.set(sym, 0);
    }

    // desired shares (whole)
    const desired = new Map();
    for (const sym of UNIVERSE) {
      const x = selected.find(s => s.sym === sym) || null;
      const px = x?.execPrice;
      if (!(px > 0)) {
        desired.set(sym, 0);
        continue;
      }
      const targetValue = equity * (weights.get(sym) || 0);
      desired.set(sym, Math.floor(targetValue / px));
    }

    const logged = new Set();

    // sells first
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired.get(sym) || 0;
      if (tgt >= cur) continue;

      const x = selected.find(s => s.sym === sym) || null;
      const px = x?.execPrice;
      // If not selected, we still need a price to sell; fall back to any exec price for symbol in this month.
      let execPx = px;
      if (!(execPx > 0)) {
        const bars = perSymbol[sym].bars;
        const execI = lowerBoundTs(bars, rbTs);
        if (execI < bars.length && toMonthKeyUTC(bars[execI].ts) === monthKey) execPx = bars[execI].close;
      }
      if (!(execPx > 0)) continue;

      const qty = cur - tgt;
      const proceeds = qty * execPx;
      cash += proceeds;
      cash -= PORTFOLIO.commission;
      commissionsTotal += PORTFOLIO.commission;
      holdings.set(sym, tgt);

      logRows.push({
        date: rbDate,
        action: tgt === 0 ? 'Close' : 'Sell',
        symbol: sym,
        qty,
        price: round2(execPx),
        tradeValue: round2(proceeds),
        commission: PORTFOLIO.commission,
        cashAfter: round2(cash),
      });
      logged.add(sym);
    }

    // buys
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired.get(sym) || 0;
      if (tgt <= cur) continue;

      const x = selected.find(s => s.sym === sym) || null;
      const px = x?.execPrice;
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
      logged.add(sym);
    }

    // holds
    for (const sym of UNIVERSE.slice().sort()) {
      if (logged.has(sym)) continue;
      const x = selected.find(s => s.sym === sym) || null;
      const px = x?.execPrice;
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

  // final valuation at end
  let finalEquity = cash;
  for (const sym of UNIVERSE) {
    const sh = holdings.get(sym) || 0;
    if (sh === 0) continue;
    const bars = perSymbol[sym].bars;
    const i = lastIndexAtOrBefore(bars, windowEndTs);
    if (i < 0) continue;
    finalEquity += sh * bars[i].close;
  }

  const endValuationTs = Math.max(
    ...UNIVERSE.map(sym => {
      const bars = perSymbol[sym].bars;
      const i = lastIndexAtOrBefore(bars, windowEndTs);
      return i >= 0 ? bars[i].ts : 0;
    })
  );

  const perSymbolBars = Object.fromEntries(UNIVERSE.map(s => [s, perSymbol[s].bars]));
  const bh = buildBuyHoldForWindow({ windowStartTs, windowEndTs, perSymbolBars });

  return {
    yearLabel,
    startDate: toDateISO(windowStartTs),
    endDate: toDateISO(windowEndTs),
    endValuationDate: toDateISO(endValuationTs),
    finalEquity: round2(finalEquity),
    commissionsTotal: round2(commissionsTotal),
    bhFinalEquity: round2(bh.equity),
    bhCommissions: round2(bh.commissions),
    rows: logRows,
  };
}

function renderYearMarkdown(result) {
  const header = `# TSMOM Turbo Record Book — ${result.yearLabel}\n\n` +
    `Start capital: **50,000 NIS** (reset each year)\n\n` +
    `Window: **${result.startDate} → ${result.endDate}**\n\n` +
    `Turbo strategy:\n` +
    `- Top ${TURBO.topK} by momentum (3-1)\n` +
    `- Disqualify negative momentum\n` +
    `- Target vol 80% (EWMA vol, 60D COM), cash-only normalization\n` +
    `- Monthly rebalance, 5 NIS commission per execution, whole shares\n\n` +
    `Assumptions:\n` +
    `- Yahoo \\".TA\\" prices converted agorot→NIS (/100).\n` +
    `- Trades execute at daily close on rebalance day (or next available trading day in same month).\n\n`;

  const tableHeader = `## Rebalance Log\n\n` +
    `| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Remaining Cash |\n` +
    `|---|---|---|---:|---:|---:|---:|---:|\n`;

  const lines = result.rows.map(r => {
    const priceStr = Number.isFinite(r.price) ? formatNIS(r.price) : 'n/a';
    const valStr = Number.isFinite(r.tradeValue) ? formatNIS(r.tradeValue) : '0.00';
    const commStr = Number.isFinite(r.commission) ? formatNIS(r.commission) : '0.00';
    const cashStr = formatNIS(r.cashAfter);
    return `| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${priceStr} | ${valStr} | ${commStr} | ${cashStr} |`;
  }).join('\n');

  const summary = `\n\n## Summary\n\n` +
    `- Final valuation uses last available closes on: **${result.endValuationDate}**\n` +
    `- Final equity (Turbo): **${formatNIS(result.finalEquity)} NIS**\n` +
    `- Total commissions paid: **${formatNIS(result.commissionsTotal)} NIS**\n` +
    `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(result.bhFinalEquity)} NIS**\n` +
    `- Buy & Hold commissions paid: **${formatNIS(result.bhCommissions)} NIS**\n`;

  return header + tableHeader + lines + summary + '\n';
}

function renderContinuousMarkdown(result) {
  const header = `# TSMOM Turbo Record Book — ${result.yearLabel}\n\n` +
    `Start capital: **50,000 NIS**\n\n` +
    `Window: **${result.startDate} → ${result.endDate}**\n\n` +
    `Turbo strategy:\n` +
    `- Top ${TURBO.topK} by momentum (3-1)\n` +
    `- Disqualify negative momentum\n` +
    `- Target vol 80% (EWMA vol, 60D COM), cash-only normalization\n` +
    `- Monthly rebalance, 5 NIS commission per execution, whole shares\n\n` +
    `Assumptions:\n` +
    `- Yahoo \\".TA\\" prices converted agorot→NIS (/100).\n` +
    `- Trades execute at daily close on rebalance day (or next available trading day in same month).\n\n`;

  const tableHeader = `## Rebalance Log\n\n` +
    `| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Remaining Cash |\n` +
    `|---|---|---|---:|---:|---:|---:|---:|\n`;

  const lines = result.rows.map(r => {
    const priceStr = Number.isFinite(r.price) ? formatNIS(r.price) : 'n/a';
    const valStr = Number.isFinite(r.tradeValue) ? formatNIS(r.tradeValue) : '0.00';
    const commStr = Number.isFinite(r.commission) ? formatNIS(r.commission) : '0.00';
    const cashStr = formatNIS(r.cashAfter);
    return `| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${priceStr} | ${valStr} | ${commStr} | ${cashStr} |`;
  }).join('\n');

  const summary = `\n\n## Summary\n\n` +
    `- Final valuation uses last available closes on: **${result.endValuationDate}**\n` +
    `- Final equity (Turbo): **${formatNIS(result.finalEquity)} NIS**\n` +
    `- Total commissions paid: **${formatNIS(result.commissionsTotal)} NIS**\n` +
    `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(result.bhFinalEquity)} NIS**\n` +
    `- Buy & Hold commissions paid: **${formatNIS(result.bhCommissions)} NIS**\n`;

  return header + tableHeader + lines + summary + '\n';
}

async function main() {
  console.log('[turbo-yearly] Fetching candles (one-time)...');

  const outDir = path.resolve(process.cwd(), 'reports', 'tsmom', 'turbo');
  fs.mkdirSync(outDir, { recursive: true });

  const perSymbol = {};
  for (const sym of UNIVERSE) {
    console.log('[turbo-yearly] Fetch', sym);
    const { bars } = await fetchFullDailyCandles(sym);
    perSymbol[sym] = { bars };
    console.log('[turbo-yearly] OK', sym, { bars: bars.length, start: toDateISO(bars[0].ts), end: toDateISO(bars.at(-1).ts) });
  }

  const perSymInputs = {};
  for (const sym of UNIVERSE) {
    perSymInputs[sym] = precomputeCloseAndSigma(perSymbol[sym].bars);
  }

  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const summaryRows = [];
  const perYearResults = [];

  for (const y of years) {
    const windowStartTs = Date.parse(`${y}-01-01T00:00:00Z`);
    const windowEndTs = Math.min(END_MS, Date.parse(`${y}-12-31T23:59:59Z`));
    if (windowStartTs > END_MS) continue;

    const label = y === 2026 ? '2026 (YTD)' : String(y);
    console.log('[turbo-yearly] Simulate', label);

    const result = simulateTurboWindow({
      yearLabel: label,
      windowStartTs,
      windowEndTs,
      perSymbol,
      perSymInputs,
    });

    const md = renderYearMarkdown(result);
    const outFile = y === 2026
      ? `TSMOM_Turbo_Record_Book_${y}_YTD.md`
      : `TSMOM_Turbo_Record_Book_${y}.md`;
    fs.writeFileSync(path.resolve(outDir, outFile), md, 'utf8');

    perYearResults.push({ outFile, ...result });

    summaryRows.push({
      year: label,
      finalEquity: result.finalEquity,
      comm: result.commissionsTotal,
      bh: result.bhFinalEquity,
    });

    console.log('[turbo-yearly] Wrote', outFile);
  }

  const summaryMd = `# TSMOM Turbo Yearly Summary (Top-5, 3-1, 80% vol; 50k reset)\n\n` +
    `| Year | Final Equity (NIS) | Commissions (NIS) | Buy & Hold (NIS) |\n` +
    `|---|---:|---:|---:|\n` +
    summaryRows.map(r => `| ${r.year} | ${formatNIS(r.finalEquity)} | ${formatNIS(r.comm)} | ${formatNIS(r.bh)} |`).join('\n') +
    `\n`;

  fs.writeFileSync(path.resolve(outDir, 'TSMOM_Turbo_Yearly_Summary_2020_2026.md'), summaryMd, 'utf8');
  console.log('[turbo-yearly] Wrote TSMOM_Turbo_Yearly_Summary_2020_2026.md');

  const report = `# TSMOM Turbo Report (50,000 NIS reset each year)\n\n` +
    `Turbo strategy: Top ${TURBO.topK}, 3-1 momentum, 80% target vol, long-only, monthly rebalance, 5 NIS commission, whole shares.\n\n` +
    perYearResults.map(r => {
      return `## ${r.yearLabel}\n\n` +
        `Record book: [${r.outFile}](${r.outFile})\n\n` +
        `## Summary\n\n` +
        `- Final valuation uses last available closes on: **${r.endValuationDate}**\n` +
        `- Final equity (Turbo): **${formatNIS(r.finalEquity)} NIS**\n` +
        `- Total commissions paid: **${formatNIS(r.commissionsTotal)} NIS**\n` +
        `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(r.bhFinalEquity)} NIS**\n` +
        `- Buy & Hold commissions paid: **${formatNIS(r.bhCommissions)} NIS**\n`;
    }).join('\n\n');

  fs.writeFileSync(path.resolve(outDir, 'TSMOM_Turbo_Report_2020_2026.md'), report + '\n', 'utf8');
  console.log('[turbo-yearly] Wrote TSMOM_Turbo_Report_2020_2026.md');

  // Continuous (no-reset) run: start once at 50k in 2020 and carry through to END_MS.
  const contStartTs = Date.parse('2020-01-01T00:00:00Z');
  const contEndTs = END_MS;
  const contLabel = `2020-01-01 to ${toDateISO(contEndTs)} (No Reset)`;
  console.log('[turbo-yearly] Simulate continuous', contLabel);

  const cont = simulateTurboWindow({
    yearLabel: contLabel,
    windowStartTs: contStartTs,
    windowEndTs: contEndTs,
    perSymbol,
    perSymInputs,
  });

  const contOutFile = 'TSMOM_Turbo_Record_Book_2020_2026_NoReset.md';
  fs.writeFileSync(path.resolve(outDir, contOutFile), renderContinuousMarkdown(cont), 'utf8');
  console.log('[turbo-yearly] Wrote', contOutFile);

  const contReport = `# TSMOM Turbo Report (No Reset)\n\n` +
    `Start capital: **50,000 NIS**\n\n` +
    `Window: **${cont.startDate} → ${cont.endDate}**\n\n` +
    `Record book: [${contOutFile}](${contOutFile})\n\n` +
    `## Summary\n\n` +
    `- Final valuation uses last available closes on: **${cont.endValuationDate}**\n` +
    `- Final equity (Turbo): **${formatNIS(cont.finalEquity)} NIS**\n` +
    `- Total commissions paid: **${formatNIS(cont.commissionsTotal)} NIS**\n` +
    `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(cont.bhFinalEquity)} NIS**\n` +
    `- Buy & Hold commissions paid: **${formatNIS(cont.bhCommissions)} NIS**\n`;

  fs.writeFileSync(path.resolve(outDir, 'TSMOM_Turbo_Report_2020_2026_NoReset.md'), contReport + '\n', 'utf8');
  console.log('[turbo-yearly] Wrote TSMOM_Turbo_Report_2020_2026_NoReset.md');

  process.exit(0);
}

main().catch(err => {
  console.error('[turbo-yearly] Failed:', err);
  process.exit(1);
});
