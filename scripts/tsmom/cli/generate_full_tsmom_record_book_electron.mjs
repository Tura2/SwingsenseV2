import fs from 'node:fs';
import path from 'node:path';

import {
  fetchYahooCandlesByPeriod,
} from '../../../dist-electron/src/main/services/yahooChartApi.js';
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
  skipRecentTradingDays: 21, // 12-1 momentum
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
  // first index with arr[i].ts >= ts
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

async function fetchFullDailyCandles(inputSymbol) {
  const original = normalizeInputSymbol(inputSymbol);
  const resolved = await resolveCanonicalYahooSymbol(original).catch(() => ({ candidates: yahooCandidatesForSymbol(original) }));
  const candidates = resolved.candidates?.length ? resolved.candidates : yahooCandidatesForSymbol(original);

  let lastErr = null;
  for (const ysym of candidates) {
    try {
      const candles = await fetchYahooCandlesByPeriod(ysym, '1d', START_MS, END_MS, true);
      const isTase = String(ysym || '').toUpperCase().endsWith('.TA');
      const pxMult = isTase ? 0.01 : 1;

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

      // dedup by ts
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

      if (dedup.length) {
        return { ysym, candles: dedup };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`No candles for ${original}. Last error: ${lastErr?.message || lastErr}`);
}

function computeLongOnlyMonthlyPositionSeries(bars, params) {
  const p = params;
  const n = bars.length;
  const close = bars.map(b => b.close);

  // returns
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

  // EWMA mu/var → sigmaAnn
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
  let currentPos = 0;
  const rebalances = [];

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

function formatNIS(x) {
  if (!Number.isFinite(x)) return 'n/a';
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round2(x) {
  if (!Number.isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function buildMarkdown({
  startDate,
  endDate,
  endValuationDate,
  rows,
  finalEquity,
  totalCommissions,
  bhFinalEquity,
  bhTotalCommissions,
}) {
  const header = `# Full TSMOM Trade Record Book (Long-Only)\n\n` +
    `Universe: 20 Israeli stocks (TASE via Yahoo \\".TA\\")\n\n` +
    `Timeframe: **${startDate} → ${endDate}** (monthly rebalance on first trading day of month)\n\n` +
    `Strategy:\n` +
    `- Signal: 12-1 momentum (binary)\n` +
    `- Long-only: negative signal => 0 (cash), no shorts\n` +
    `- Volatility scaling: target vol **40%** (EWMA vol, 60D center-of-mass)\n` +
    `- Rebalance: monthly\n\n` +
    `Portfolio settings:\n` +
    `- Initial capital: **50,000 NIS**\n` +
    `- Commission: **5 NIS** per execution (Buy/Sell)\n` +
    `- Shares: whole numbers only\n\n` +
    `Execution assumptions:\n` +
    `- Yahoo \\".TA\\" prices are typically quoted in **agorot**; this report converts all TASE prices to **NIS** by dividing by 100.\n` +
    `- Trades execute at **daily close** on the rebalance day (or the next available trading day for that symbol within the same month).\n` +
    `- Exposure scaling is computed per-asset; to remain cash-only (no leverage), positive scaled exposures are **normalized to sum to 100%** each rebalance.\n\n`;

  const tableHeader = `## Rebalance Log\n\n` +
    `| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Remaining Cash |\n` +
    `|---|---|---|---:|---:|---:|---:|---:|\n`;

  const tableRows = rows.map(r => {
    const priceStr = Number.isFinite(r.price) ? formatNIS(r.price) : 'n/a';
    const valStr = Number.isFinite(r.tradeValue) ? formatNIS(r.tradeValue) : '0.00';
    const commStr = Number.isFinite(r.commission) ? formatNIS(r.commission) : '0.00';
    const cashStr = formatNIS(r.cashAfter);
    return `| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${priceStr} | ${valStr} | ${commStr} | ${cashStr} |`;
  }).join('\n');

  const summary = `\n\n## Summary\n\n` +
    `- Final valuation uses last available closes on: **${endValuationDate}**\n` +
    `- Final equity (TSMOM long-only): **${formatNIS(finalEquity)} NIS**\n` +
    `- Total commissions paid: **${formatNIS(totalCommissions)} NIS**\n` +
    `- Buy & Hold (equal-weight, one-time buy at start): **${formatNIS(bhFinalEquity)} NIS**\n` +
    `- Buy & Hold commissions paid: **${formatNIS(bhTotalCommissions)} NIS**\n`;

  return header + tableHeader + tableRows + summary + '\n';
}

function buildBuyHold({ startTs, endTs, perSymbolBars }) {
  const symbols = Object.keys(perSymbolBars).slice().sort();
  let cash = PORTFOLIO.initialCapital;
  let commissions = 0;
  const shares = new Map();

  const eligible = symbols.filter(sym => lastIndexAtOrBefore(perSymbolBars[sym], startTs) >= 0);
  const perSymBudget = eligible.length ? cash / eligible.length : 0;

  // buy once
  for (const sym of eligible) {
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, startTs);
    const px = bars[i].close;
    if (!(px > 0)) continue;

    // include commission per buy
    if (cash <= PORTFOLIO.commission) continue;
    const maxShares = Math.floor((perSymBudget - PORTFOLIO.commission) / px);
    if (maxShares <= 0) continue;

    const cost = maxShares * px;
    cash -= cost;
    cash -= PORTFOLIO.commission;
    commissions += PORTFOLIO.commission;
    shares.set(sym, maxShares);
  }

  // value at end
  let equity = cash;
  for (const [sym, sh] of shares.entries()) {
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, endTs);
    if (i < 0) continue;
    equity += sh * bars[i].close;
  }

  return { equity, commissions };
}

async function main() {
  console.log('[record-book] Fetching candles (this may take a bit)...');

  const perSymbol = {};
  for (const sym of UNIVERSE) {
    console.log('[record-book] Fetch', sym);
    const { ysym, candles } = await fetchFullDailyCandles(sym);
    perSymbol[sym] = { ysym, bars: candles };
    console.log('[record-book] OK', sym, { ysym, bars: candles.length, start: toDateISO(candles[0].ts), end: toDateISO(candles.at(-1).ts) });
  }

  // compute per-symbol positions
  const perSymbolPos = {};
  for (const sym of UNIVERSE) {
    const bars = perSymbol[sym].bars;
    perSymbolPos[sym] = computeLongOnlyMonthlyPositionSeries(bars, PARAMS);
  }

  // choose reference calendar (LUMI.TA)
  const refSym = 'LUMI.TA';
  const refRebalances = perSymbolPos[refSym].rebalances
    .filter(r => r.ts <= END_MS)
    .slice();

  // start at first rebalance where any asset has non-zero raw exposure
  let startIdx = 0;
  for (let i = 0; i < refRebalances.length; i++) {
    const ts = refRebalances[i].ts;
    const mk = refRebalances[i].monthKey;
    let sumRaw = 0;
    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      const pos = perSymbolPos[sym].position;
      const execI = lowerBoundTs(bars, ts);
      if (execI >= bars.length) continue;
      if (toMonthKeyUTC(bars[execI].ts) !== mk) continue;
      sumRaw += pos[execI] || 0;
    }
    if (sumRaw > 0) {
      startIdx = i;
      break;
    }
  }

  const startTs = refRebalances[startIdx]?.ts;
  if (!startTs) throw new Error('No valid rebalance start date found.');

  const endTs = END_MS;
  const endValuationTs = Math.max(
    ...UNIVERSE.map(sym => {
      const bars = perSymbol[sym].bars;
      const i = lastIndexAtOrBefore(bars, endTs);
      return i >= 0 ? bars[i].ts : 0;
    })
  );

  // Portfolio simulation
  let cash = PORTFOLIO.initialCapital;
  let commissionsTotal = 0;
  const holdings = new Map(); // symbol -> shares

  const logRows = [];

  for (let rbi = startIdx; rbi < refRebalances.length; rbi++) {
    const rb = refRebalances[rbi];
    const rbTs = rb.ts;
    const rbDate = toDateISO(rbTs);
    const monthKey = rb.monthKey;

    // compute per-symbol execution price + raw exposure
    const exec = {};
    let sumRaw = 0;
    for (const sym of UNIVERSE) {
      const bars = perSymbol[sym].bars;
      const pos = perSymbolPos[sym].position;
      const execI = lowerBoundTs(bars, rbTs);
      if (execI >= bars.length) {
        exec[sym] = { price: NaN, raw: 0, execTs: NaN };
        continue;
      }
      // if symbol doesn't have a bar in this month (halted), skip
      if (toMonthKeyUTC(bars[execI].ts) !== monthKey) {
        exec[sym] = { price: NaN, raw: 0, execTs: NaN };
        continue;
      }
      const price = bars[execI].close;
      const raw = Math.max(0, pos[execI] || 0);
      exec[sym] = { price, raw, execTs: bars[execI].ts };
      sumRaw += raw;
    }

    // valuation at rebalance (use last price <= rbTs)
    let equity = cash;
    for (const sym of UNIVERSE) {
      const sh = holdings.get(sym) || 0;
      if (sh === 0) continue;
      const bars = perSymbol[sym].bars;
      const iVal = lastIndexAtOrBefore(bars, rbTs);
      if (iVal < 0) continue;
      equity += sh * bars[iVal].close;
    }

    // target weights (normalized, no leverage)
    const weights = {};
    if (sumRaw > 0) {
      for (const sym of UNIVERSE) {
        weights[sym] = exec[sym].raw / sumRaw;
      }
    } else {
      for (const sym of UNIVERSE) weights[sym] = 0;
    }

    // desired shares
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

    // track which symbols already logged this rebalance
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
      if (!(px > 0)) {
        // can't price it => hold
        continue;
      }

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

    // holds for completeness
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

  // final valuation at end
  let finalEquity = cash;
  for (const sym of UNIVERSE) {
    const sh = holdings.get(sym) || 0;
    if (sh === 0) continue;
    const bars = perSymbol[sym].bars;
    const i = lastIndexAtOrBefore(bars, endTs);
    if (i < 0) continue;
    finalEquity += sh * bars[i].close;
  }

  const perSymbolBars = Object.fromEntries(UNIVERSE.map(s => [s, perSymbol[s].bars]));
  const bh = buildBuyHold({ startTs, endTs, perSymbolBars });

  const md = buildMarkdown({
    startDate: toDateISO(startTs),
    endDate: toDateISO(endTs),
    endValuationDate: toDateISO(endValuationTs),
    rows: logRows,
    finalEquity: round2(finalEquity),
    totalCommissions: round2(commissionsTotal),
    bhFinalEquity: round2(bh.equity),
    bhTotalCommissions: round2(bh.commissions),
  });

  const outDir = path.resolve(process.cwd(), 'reports', 'tsmom', 'standard');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(outDir, 'Full_TSMOM_Record_Book.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log('[record-book] Wrote', outPath);

  // Electron sometimes returns a non-zero code if we don't exit explicitly.
  process.exit(0);
}

main().catch(err => {
  console.error('[record-book] Failed:', err);
  process.exit(1);
});
