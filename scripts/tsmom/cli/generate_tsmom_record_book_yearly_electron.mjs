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

const PARAMS = {
  targetVolAnn: 0.40,
  lookbackTradingDays: 252,
  skipRecentTradingDays: 21, // 12-1
  volCenterDays: 60,
  rebalance: 'monthly',
  maxLeverage: 5,
  minSigmaAnn: 0.01,
};

const PORTFOLIO = {
  initialCapital: 50_000,
  commission: 5,
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

function computeLongOnlyMonthlyPositionSeries(bars) {
  const p = PARAMS;
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

  const delta = clamp(p.volCenterDays / (p.volCenterDays + 1), 0.90, 0.9999);
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

  const position = new Array(n).fill(0);
  const rebalances = [];
  let currentPos = 0;

  for (let i = 1; i < n; i++) {
    const rebalanceDay = p.rebalance === 'monthly' && toMonthKeyUTC(bars[i].ts) !== toMonthKeyUTC(bars[i - 1].ts);
    if (rebalanceDay) {
      const t = i - 1;
      const t0 = t - p.skipRecentTradingDays;
      const lb = t0 - p.lookbackTradingDays;

      let longSignal = 0;
      if (lb >= 0 && t0 >= 0) {
        const mom = close[t0] / close[lb] - 1;
        longSignal = mom > 0 ? 1 : 0;
      }

      const sig = sigmaAnn[i];
      const denom = Math.max(p.minSigmaAnn, Number.isFinite(sig) ? sig : 0);
      const size = denom > 0 ? clamp(p.targetVolAnn / denom, 0, p.maxLeverage) : 0;
      currentPos = longSignal * size;

      rebalances.push({ ts: bars[i].ts, monthKey: toMonthKeyUTC(bars[i].ts) });
    }
    position[i] = currentPos;
  }

  return { position, rebalances };
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

function simulateWindow({ yearLabel, windowStartTs, windowEndTs, perSymbol, perSymbolPos }) {
  // Reference rebalance calendar: use LUMI if available
  const refSym = 'LUMI.TA';
  const refRebalances = (perSymbolPos[refSym]?.rebalances || [])
    .filter(r => r.ts <= windowEndTs)
    .slice();

  // only rebalance points inside window
  const windowRebalances = refRebalances.filter(r => r.ts >= windowStartTs && r.ts <= windowEndTs);

  let cash = PORTFOLIO.initialCapital;
  let commissionsTotal = 0;
  const holdings = new Map();
  const logRows = [];

  for (const rb of windowRebalances) {
    const rbTs = rb.ts;
    const rbDate = toDateISO(rbTs);
    const monthKey = rb.monthKey;

    // per-symbol execution (first bar >= rbTs within same month)
    const exec = {};
    let sumRaw = 0;

    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      const pos = perSymbolPos[sym].position;
      const execI = lowerBoundTs(bars, rbTs);
      if (execI >= bars.length) {
        exec[sym] = { price: NaN, raw: 0 };
        continue;
      }
      if (toMonthKeyUTC(bars[execI].ts) !== monthKey) {
        exec[sym] = { price: NaN, raw: 0 };
        continue;
      }
      const price = bars[execI].close;
      const raw = Math.max(0, pos[execI] || 0);
      exec[sym] = { price, raw };
      sumRaw += raw;
    }

    // current equity valued at last close <= rbTs
    let equity = cash;
    for (const sym of UNIVERSE) {
      const sh = holdings.get(sym) || 0;
      if (sh === 0) continue;
      const bars = perSymbol[sym].bars;
      const iVal = lastIndexAtOrBefore(bars, rbTs);
      if (iVal < 0) continue;
      equity += sh * bars[iVal].close;
    }

    // target weights: normalize positive exposures to sum 100% (cash-only)
    const weights = {};
    if (sumRaw > 0) {
      for (const sym of UNIVERSE) weights[sym] = exec[sym].raw / sumRaw;
    } else {
      for (const sym of UNIVERSE) weights[sym] = 0;
    }

    // desired whole shares
    const desired = {};
    for (const sym of UNIVERSE) {
      const px = exec[sym].price;
      if (!(px > 0)) {
        desired[sym] = 0;
        continue;
      }
      const targetValue = equity * (weights[sym] || 0);
      desired[sym] = Math.floor(targetValue / px);
    }

    const logged = new Set();

    // sells first
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired[sym] || 0;
      if (tgt >= cur) continue;
      const px = exec[sym].price;
      if (!(px > 0)) continue;

      const qty = cur - tgt;
      const proceeds = qty * px;
      cash += proceeds;
      cash -= PORTFOLIO.commission;
      commissionsTotal += PORTFOLIO.commission;
      holdings.set(sym, tgt);

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
      logged.add(sym);
    }

    // buys
    for (const sym of UNIVERSE.slice().sort()) {
      const cur = holdings.get(sym) || 0;
      const tgt = desired[sym] || 0;
      if (tgt <= cur) continue;
      const px = exec[sym].price;
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
      const px = exec[sym].price;
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

  // final valuation at end of window
  let finalEquity = cash;
  for (const sym of UNIVERSE) {
    const sh = holdings.get(sym) || 0;
    if (sh === 0) continue;
    const bars = perSymbol[sym].bars;
    const i = lastIndexAtOrBefore(bars, windowEndTs);
    if (i < 0) continue;
    finalEquity += sh * bars[i].close;
  }

  const perSymbolBars = Object.fromEntries(UNIVERSE.map(s => [s, perSymbol[s].bars]));
  const bh = buildBuyHoldForWindow({ windowStartTs, windowEndTs, perSymbolBars });

  // end valuation date (last available close among universe)
  const endValuationTs = Math.max(
    ...UNIVERSE.map(sym => {
      const bars = perSymbol[sym].bars;
      const i = lastIndexAtOrBefore(bars, windowEndTs);
      return i >= 0 ? bars[i].ts : 0;
    })
  );

  return {
    yearLabel,
    startDate: toDateISO(windowStartTs),
    endDate: toDateISO(windowEndTs),
    endValuationDate: toDateISO(endValuationTs),
    rows: logRows,
    finalEquity: round2(finalEquity),
    commissionsTotal: round2(commissionsTotal),
    bhFinalEquity: round2(bh.equity),
    bhCommissions: round2(bh.commissions),
  };
}

function buildMarkdownForYear(result) {
  const header = `# TSMOM Trade Record Book (Long-Only) — ${result.yearLabel}\n\n` +
    `Universe: 20 Israeli stocks (TASE via Yahoo \\".TA\\")\n\n` +
    `Window: **${result.startDate} → ${result.endDate}**\n\n` +
    `Start capital: **50,000 NIS** (reset each year)\n\n` +
    `Rules:\n` +
    `- 12-1 momentum (binary), long-only\n` +
    `- EWMA vol scaling (60D COM), target vol 40%\n` +
    `- Monthly rebalance (first trading day of month)\n` +
    `- 5 NIS commission per execution\n` +
    `- Whole shares only\n\n` +
    `Assumptions:\n` +
    `- Yahoo \\".TA\\" prices are typically in agorot; converted to NIS by dividing by 100.\n` +
    `- Trades execute at daily close on the rebalance day (or next available trading day for that symbol in the same month).\n` +
    `- Positive scaled exposures are normalized to sum to 100% (cash-only, no leverage).\n\n`;

  const tableHeader = `## Rebalance Log\n\n` +
    `| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Remaining Cash |\n` +
    `|---|---|---|---:|---:|---:|---:|---:|\n`;

  const tableRows = result.rows.map(r => {
    const priceStr = Number.isFinite(r.price) ? formatNIS(r.price) : 'n/a';
    const valStr = Number.isFinite(r.tradeValue) ? formatNIS(r.tradeValue) : '0.00';
    const commStr = Number.isFinite(r.commission) ? formatNIS(r.commission) : '0.00';
    const cashStr = formatNIS(r.cashAfter);
    return `| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${priceStr} | ${valStr} | ${commStr} | ${cashStr} |`;
  }).join('\n');

  const summary = `\n\n## Summary\n\n` +
    `- Final valuation uses last available closes on: **${result.endValuationDate}**\n` +
    `- Final equity (TSMOM long-only): **${formatNIS(result.finalEquity)} NIS**\n` +
    `- Total commissions paid: **${formatNIS(result.commissionsTotal)} NIS**\n` +
    `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(result.bhFinalEquity)} NIS**\n` +
    `- Buy & Hold commissions paid: **${formatNIS(result.bhCommissions)} NIS**\n`;

  return header + tableHeader + tableRows + summary + '\n';
}

async function main() {
  console.log('[yearly-record-book] Fetching candles (one-time)...');

  const outDir = path.resolve(process.cwd(), 'reports', 'tsmom', 'standard');
  fs.mkdirSync(outDir, { recursive: true });

  const perSymbol = {};
  for (const sym of UNIVERSE) {
    console.log('[yearly-record-book] Fetch', sym);
    const { ysym, bars } = await fetchFullDailyCandles(sym);
    perSymbol[sym] = { ysym, bars };
    console.log('[yearly-record-book] OK', sym, { bars: bars.length, start: toDateISO(bars[0].ts), end: toDateISO(bars.at(-1).ts) });
  }

  const perSymbolPos = {};
  for (const sym of UNIVERSE) {
    perSymbolPos[sym] = computeLongOnlyMonthlyPositionSeries(perSymbol[sym].bars);
  }

  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const summaryRows = [];

  for (const y of years) {
    const windowStartTs = Date.parse(`${y}-01-01T00:00:00Z`);
    const windowEndTs = Math.min(
      END_MS,
      Date.parse(`${y}-12-31T23:59:59Z`)
    );
    if (windowStartTs > END_MS) continue;

    const label = y === 2026 ? '2026 (YTD)' : String(y);
    console.log('[yearly-record-book] Simulate', label);

    const result = simulateWindow({
      yearLabel: label,
      windowStartTs,
      windowEndTs,
      perSymbol,
      perSymbolPos,
    });

    const md = buildMarkdownForYear(result);
    const outFile = y === 2026
      ? `Full_TSMOM_Record_Book_${y}_YTD.md`
      : `Full_TSMOM_Record_Book_${y}.md`;
    const outPath = path.resolve(outDir, outFile);
    fs.writeFileSync(outPath, md, 'utf8');

    summaryRows.push({
      year: label,
      finalEquity: result.finalEquity,
      comm: result.commissionsTotal,
      bh: result.bhFinalEquity,
    });

    console.log('[yearly-record-book] Wrote', outFile);
  }

  // one combined summary
  const summaryMd = `# TSMOM Yearly Summary (Long-Only, 50k reset each year)\n\n` +
    `| Year | Final Equity (NIS) | Commissions (NIS) | Buy & Hold (NIS) |\n` +
    `|---|---:|---:|---:|\n` +
    summaryRows.map(r => `| ${r.year} | ${formatNIS(r.finalEquity)} | ${formatNIS(r.comm)} | ${formatNIS(r.bh)} |`).join('\n') +
    `\n`;

  const summaryPath = path.resolve(outDir, 'TSMOM_Yearly_Summary_2020_2026.md');
  fs.writeFileSync(summaryPath, summaryMd, 'utf8');
  console.log('[yearly-record-book] Wrote TSMOM_Yearly_Summary_2020_2026.md');

  process.exit(0);
}

main().catch(err => {
  console.error('[yearly-record-book] Failed:', err);
  process.exit(1);
});
