#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { fetchYahooCandlesByPeriod } from '../../../dist-electron/src/main/services/yahooChartApi.js';
import {
  normalizeInputSymbol,
  resolveCanonicalYahooSymbol,
  yahooCandidatesForSymbol,
} from '../../../dist-electron/src/main/services/symbols.js';

import { flattenExpandedUniverse, getBenchmarkYahooSymbol } from '../lib/expandedUniverse.mjs';

function parseArgv(argv) {
  const out = {};
  for (const a of argv) {
    if (!a || typeof a !== 'string') continue;
    if (a === '--noReset' || a === '--no-reset') out.noReset = true;
    else if (a.startsWith('--start=')) out.start = a.slice('--start='.length);
    else if (a.startsWith('--end=')) out.end = a.slice('--end='.length);
    else if (a.startsWith('--outDir=')) out.outDir = a.slice('--outDir='.length);
    else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
  }
  return out;
}

function yearFromISO(iso) {
  const m = /^\d{4}/.exec(String(iso || '').trim());
  return m ? m[0] : '????';
}

function safeSlug(s) {
  return String(s || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

function formatMoney(x, { currency }) {
  if (!Number.isFinite(x)) return 'n/a';
  const cur = String(currency || '').trim().toUpperCase();
  // Avoid Intl currency formatting edge cases; keep it stable for markdown.
  const num = x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${num} ${cur}` : num;
}

function safeReadJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function applyManualOverrides({ yahooSymbol, bars, overrides }) {
  if (!overrides) return bars;

  const bySym = overrides.replaceCloseByYahooSymbolAndDate?.[yahooSymbol];
  if (!bySym) return bars;

  const map = new Map(Object.entries(bySym));
  if (!map.size) return bars;

  return bars.map(b => {
    const iso = toDateISO(b.ts);
    if (!map.has(iso)) return b;
    const c = Number(map.get(iso));
    if (!Number.isFinite(c) || c <= 0) return b;
    return { ...b, open: c, high: c, low: c, close: c };
  });
}

function inferPxMultiplier(yahooSymbol, overrides) {
  const isTase = String(yahooSymbol || '').toUpperCase().endsWith('.TA');
  let pxMult = isTase ? 0.01 : 1;

  const multMap = overrides?.multiplierByYahooSymbol;
  if (multMap && typeof multMap === 'object') {
    if (Object.prototype.hasOwnProperty.call(multMap, yahooSymbol)) {
      const v = Number(multMap[yahooSymbol]);
      if (Number.isFinite(v) && v > 0) pxMult = v;
    } else if (isTase && Object.prototype.hasOwnProperty.call(multMap, '*.TA')) {
      const v = Number(multMap['*.TA']);
      if (Number.isFinite(v) && v > 0) pxMult = v;
    }
  }

  return pxMult;
}

async function fetchFullDailyCandles(inputSymbol, { startMs, endMs, overrides }) {
  const original = normalizeInputSymbol(inputSymbol);
  const resolved = await resolveCanonicalYahooSymbol(original).catch(() => ({ candidates: yahooCandidatesForSymbol(original) }));
  const candidates = resolved.candidates?.length ? resolved.candidates : yahooCandidatesForSymbol(original);

  let lastErr = null;
  for (const ysym of candidates) {
    try {
      const candles = await fetchYahooCandlesByPeriod(ysym, '1d', startMs, endMs, true);
      const pxMult = inferPxMultiplier(ysym, overrides);

      const cleaned = (candles || [])
        .filter(c => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0)
        .filter(c => c.ts >= startMs && c.ts <= endMs)
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

      const finalBars = applyManualOverrides({ yahooSymbol: ysym, bars: dedup, overrides });
      if (finalBars.length) return { yahooSymbol: ysym, bars: finalBars };
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`No candles for ${original}. Last error: ${lastErr?.message || lastErr}`);
}

function precomputeCloseAndSigma(bars, { volCenterDays, minSigmaAnn }) {
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

  // enforce minimum
  for (let i = 0; i < sigmaAnn.length; i++) {
    if (!Number.isFinite(sigmaAnn[i]) || sigmaAnn[i] < minSigmaAnn) sigmaAnn[i] = minSigmaAnn;
  }

  return { close, sigmaAnn };
}

function momentumAtExec(close, execI, { lookbackTradingDays, skipRecentTradingDays }) {
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

function sizeFromSigma(sigmaAnn, execI, { targetVolAnn, maxLeverage, minSigmaAnn }) {
  const sig = sigmaAnn[execI];
  const denom = Math.max(minSigmaAnn, Number.isFinite(sig) ? sig : 0);
  if (!(denom > 0)) return 0;
  return clamp(targetVolAnn / denom, 0, maxLeverage);
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

function computeEquityAtTs({ ts, holdings, cash, perSymbolBars }) {
  let eq = cash;
  for (const [sym, sh] of holdings.entries()) {
    if (!sh) continue;
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, ts);
    if (i < 0) continue;
    eq += sh * bars[i].close;
  }
  return eq;
}

function computeDrawdownStats(equityCurve) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (!Number.isFinite(p)) continue;
    if (p > peak) peak = p;
    if (peak > 0) {
      const dd = (p / peak) - 1;
      if (dd < maxDD) maxDD = dd;
    }
  }
  return { maxDrawdown: maxDD };
}

function regressionAlphaBeta(portR, benchR) {
  const n = Math.min(portR.length, benchR.length);
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) {
    const x = benchR[i];
    const y = portR[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 10) return { alphaDaily: NaN, beta: NaN };

  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) * (xs[i] - mx);
  }
  const beta = vx > 0 ? cov / vx : NaN;
  const alphaDaily = my - (Number.isFinite(beta) ? beta * mx : NaN);
  return { alphaDaily, beta };
}

function simulateTurboExpanded({
  universe,
  perSymbol,
  perSymInputs,
  benchmarkSymbol,
  startTs,
  endTs,
  params,
  portfolio,
}) {
  const perSymbolBars = Object.fromEntries(Object.entries(perSymbol).map(([sym, obj]) => [sym, obj.bars]));

  // calendar source: benchmark if available, else first symbol
  const refSym = perSymbol[benchmarkSymbol]?.bars?.length ? benchmarkSymbol : universe[0];
  const refBars = perSymbolBars[refSym];

  const rebalances = buildMonthlyRebalanceCalendar(refBars, startTs, endTs);

  let cash = portfolio.initialCapitalNIS;
  const holdings = new Map();
  let commissionsTotal = 0;

  const tradeRows = [];
  const daily = [];

  // walk day-by-day using reference bars as the trading calendar
  // and rebalance on first trading day of each month.
  const rebByTs = new Map(rebalances.map(r => [r.ts, r]));

  // seed holdings map for all symbols
  for (const sym of universe) holdings.set(sym, 0);

  for (let di = 0; di < refBars.length; di++) {
    const dayTs = refBars[di].ts;
    if (dayTs < startTs || dayTs > endTs) continue;

    const rb = rebByTs.get(dayTs);
    if (rb) {
      const monthKey = rb.monthKey;

      // snapshot momentum+size at exec within this month
      const snap = [];
      for (const sym of universe) {
        const bars = perSymbolBars[sym];
        const { close, sigmaAnn } = perSymInputs[sym];
        if (!bars?.length) continue;

        const execI = lowerBoundTs(bars, dayTs);
        if (execI >= bars.length) continue;
        if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;

        const mom = momentumAtExec(close, execI, params);
        if (params.longOnly && !(mom > 0)) continue;

        const size = sizeFromSigma(sigmaAnn, execI, params);
        if (!(size > 0)) continue;

        snap.push({ sym, execPrice: bars[execI].close, mom, size });
      }

      snap.sort((a, b) => b.mom - a.mom);
      const selected = snap.slice(0, portfolio.topK);

      // weights: size normalized to 100% (cash-only)
      let sumRaw = 0;
      for (const x of selected) sumRaw += x.size;

      const weights = new Map();
      for (const sym of universe) weights.set(sym, 0);
      if (sumRaw > 0) {
        for (const x of selected) weights.set(x.sym, x.size / sumRaw);
      }

      // equity at rebalance
      const equity = computeEquityAtTs({ ts: dayTs, holdings, cash, perSymbolBars });

      // desired shares (whole)
      const desired = new Map();
      for (const sym of universe) {
        const w = weights.get(sym) || 0;
        const x = selected.find(s => s.sym === sym) || null;
        const px = x?.execPrice;
        if (!(px > 0) || !(w > 0)) {
          desired.set(sym, 0);
          continue;
        }
        desired.set(sym, Math.floor((equity * w) / px));
      }

      // sells first
      for (const sym of universe.slice().sort()) {
        const cur = holdings.get(sym) || 0;
        const tgt = desired.get(sym) || 0;
        if (tgt >= cur) continue;

        const bars = perSymbolBars[sym];
        const execI = lowerBoundTs(bars, dayTs);
        if (execI >= bars.length) continue;
        if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;
        const px = bars[execI].close;
        if (!(px > 0)) continue;

        const qty = cur - tgt;
        const proceeds = qty * px;
        cash += proceeds;
        cash -= portfolio.commissionNIS;
        commissionsTotal += portfolio.commissionNIS;
        holdings.set(sym, tgt);

        tradeRows.push({
          date: toDateISO(dayTs),
          action: tgt === 0 ? 'Sell' : 'Partial Sell',
          symbol: sym,
          qty,
          price: round2(px),
          tradeValue: round2(proceeds),
          commission: portfolio.commissionNIS,
          cashAfter: round2(cash),
        });
      }

      // buys
      for (const sym of universe.slice().sort()) {
        const cur = holdings.get(sym) || 0;
        const tgt = desired.get(sym) || 0;
        if (tgt <= cur) continue;

        const bars = perSymbolBars[sym];
        const execI = lowerBoundTs(bars, dayTs);
        if (execI >= bars.length) continue;
        if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;
        const px = bars[execI].close;
        if (!(px > 0)) continue;

        const want = tgt - cur;
        if (cash <= portfolio.commissionNIS) continue;
        const maxAffordable = Math.floor((cash - portfolio.commissionNIS) / px);
        const qty = Math.min(want, Math.max(0, maxAffordable));
        if (qty <= 0) continue;

        const cost = qty * px;
        cash -= cost;
        cash -= portfolio.commissionNIS;
        commissionsTotal += portfolio.commissionNIS;
        holdings.set(sym, cur + qty);

        tradeRows.push({
          date: toDateISO(dayTs),
          action: 'Buy',
          symbol: sym,
          qty,
          price: round2(px),
          tradeValue: round2(cost),
          commission: portfolio.commissionNIS,
          cashAfter: round2(cash),
        });
      }
    }

    const equity = computeEquityAtTs({ ts: dayTs, holdings, cash, perSymbolBars });
    const benchBars = perSymbolBars[benchmarkSymbol];
    let benchClose = NaN;
    if (benchBars?.length) {
      const bi = lastIndexAtOrBefore(benchBars, dayTs);
      if (bi >= 0) benchClose = benchBars[bi].close;
    }

    daily.push({ ts: dayTs, date: toDateISO(dayTs), equity, benchClose });
  }

  // metrics
  const eqSeries = daily.map(d => d.equity);
  const dd = computeDrawdownStats(eqSeries);

  const startEq = eqSeries.find(Number.isFinite);
  const endEq = eqSeries.length ? eqSeries[eqSeries.length - 1] : NaN;

  const days = daily.length;
  const years = days / 365.25;
  const cagr = (Number.isFinite(startEq) && Number.isFinite(endEq) && startEq > 0 && years > 0)
    ? Math.pow(endEq / startEq, 1 / years) - 1
    : NaN;

  const rets = [];
  const benchRets = [];
  for (let i = 1; i < daily.length; i++) {
    const a = daily[i - 1].equity;
    const b = daily[i].equity;
    rets.push((a > 0 && b > 0) ? (b / a - 1) : NaN);

    const ba = daily[i - 1].benchClose;
    const bb = daily[i].benchClose;
    benchRets.push((ba > 0 && bb > 0) ? (bb / ba - 1) : NaN);
  }

  const mu = mean(rets.filter(Number.isFinite));
  const sd = stdev(rets.filter(Number.isFinite));
  const sharpe = sd > 0 ? (Math.sqrt(261) * mu / sd) : NaN;

  const { alphaDaily, beta } = regressionAlphaBeta(rets, benchRets);
  const alphaAnn = Number.isFinite(alphaDaily) ? alphaDaily * 261 : NaN;

  // end valuation date is last available price date among universe
  const endValuationTs = Math.max(
    ...universe.map(sym => {
      const bars = perSymbolBars[sym];
      const i = lastIndexAtOrBefore(bars, endTs);
      return i >= 0 ? bars[i].ts : 0;
    })
  );

  // compute current portfolio snapshot (as of endTs)
  const current = [];
  for (const sym of universe) {
    const sh = holdings.get(sym) || 0;
    if (!sh) continue;
    const bars = perSymbolBars[sym];
    const i = lastIndexAtOrBefore(bars, endTs);
    if (i < 0) continue;
    current.push({ symbol: sym, shares: sh, lastClose: round2(bars[i].close) });
  }

  // determine top-5 momentum list at the last rebalance <= endTs
  let lastRbTs = -1;
  for (const r of rebalances) if (r.ts <= endTs) lastRbTs = Math.max(lastRbTs, r.ts);
  let lastTop5 = [];
  if (lastRbTs > 0) {
    const monthKey = toMonthKeyUTC(lastRbTs);
    const snap = [];
    for (const sym of universe) {
      const bars = perSymbolBars[sym];
      const { close } = perSymInputs[sym];
      const execI = lowerBoundTs(bars, lastRbTs);
      if (execI >= bars.length) continue;
      if (toMonthKeyUTC(bars[execI].ts) !== monthKey) continue;
      const mom = momentumAtExec(close, execI, params);
      snap.push({ sym, mom });
    }
    snap.sort((a, b) => (b.mom ?? -Infinity) - (a.mom ?? -Infinity));
    lastTop5 = snap.slice(0, portfolio.topK);
  }

  return {
    startDate: toDateISO(startTs),
    endDate: toDateISO(endTs),
    endValuationDate: toDateISO(endValuationTs),
    finalEquity: round2(endEq),
    commissionsTotal: round2(commissionsTotal),
    cagr,
    sharpe,
    maxDrawdown: dd.maxDrawdown,
    alphaAnn,
    beta,
    trades: tradeRows,
    daily,
    currentHoldings: current.sort((a, b) => b.lastClose * b.shares - a.lastClose * a.shares),
    lastRebalanceTop5: lastTop5,
    benchmarkSymbol,
  };
}

function renderRecordBook({ title, result, universeResolved, failures }) {
  const money = x => formatMoney(x, { currency: result.currency });
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Window: **${result.startDate} → ${result.endDate}**`);
  lines.push('');
  lines.push('Turbo strategy:');
  lines.push('- Top 5 by momentum (3-1)');
  lines.push('- Disqualify negative momentum (weight goes to cash)');
  lines.push('- Target vol 80% (EWMA vol, 60D COM), cash-only normalization');
  lines.push(`- Monthly rebalance (first trading day), ${money(result.commissionPerTrade)} commission per execution, whole shares`);
  lines.push('');

  lines.push('## Universe');
  lines.push(`- Resolved: **${universeResolved.length}**`);
  lines.push(`- Failed: **${failures.length}**`);
  if (failures.length) {
    lines.push('');
    lines.push('### Failed Symbols');
    for (const f of failures) lines.push(`- ${f.input}${f.yahooTried ? ` (tried: ${f.yahooTried.join(', ')})` : ''}: ${f.error}`);
  }

  lines.push('');
  lines.push('## Performance Summary');
  lines.push('');
  lines.push(`- Final valuation uses last available closes on: **${result.endValuationDate}**`);
  lines.push(`- Final equity (Turbo): **${money(result.finalEquity)}**`);
  lines.push(`- Total commissions paid: **${money(result.commissionsTotal)}**`);
  lines.push(`- CAGR: **${Number.isFinite(result.cagr) ? (result.cagr * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push(`- Sharpe (daily): **${Number.isFinite(result.sharpe) ? result.sharpe.toFixed(2) : 'n/a'}**`);
  lines.push(`- Max Drawdown: **${Number.isFinite(result.maxDrawdown) ? (result.maxDrawdown * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push(`- Alpha vs ${result.benchmarkSymbol} (ann): **${Number.isFinite(result.alphaAnn) ? (result.alphaAnn * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push('');

  lines.push(`## Current Portfolio (as of ${result.endDate})`);
  lines.push('');
  if (!result.currentHoldings.length) {
    lines.push('- (empty)');
  } else {
    lines.push(`| Symbol | Shares | Last Close (${result.currency}) | Market Value (${result.currency}) |`);
    lines.push('|---|---:|---:|---:|');
    for (const h of result.currentHoldings) {
      const mv = h.shares * (h.lastClose || 0);
      lines.push(`| ${h.symbol} | ${h.shares} | ${money(h.lastClose)} | ${money(mv)} |`);
    }
  }

  lines.push('');
  lines.push('## Latest Rebalance Top-5 (Momentum ranking)');
  lines.push('');
  if (!result.lastRebalanceTop5.length) {
    lines.push('- n/a');
  } else {
    lines.push('| Rank | Symbol | Momentum (3-1) |');
    lines.push('|---:|---|---:|');
    result.lastRebalanceTop5.forEach((x, i) => {
      lines.push(`| ${i + 1} | ${x.sym} | ${Number.isFinite(x.mom) ? (x.mom * 100).toFixed(2) + '%' : 'n/a'} |`);
    });
  }

  lines.push('');
  lines.push('## Trade Log');
  lines.push('');
  lines.push('| Date | Action | Symbol | Quantity | Price | Trade Value | Commission | Cash Balance |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|');
  for (const r of result.trades) {
    lines.push(`| ${r.date} | ${r.action} | ${r.symbol} | ${r.qty} | ${money(r.price)} | ${money(r.tradeValue)} | ${money(r.commission)} | ${money(r.cashAfter)} |`);
  }

  return lines.join('\n') + '\n';
}

function renderReport({ title, result, universeResolved, failures, recordBookFile, summaryFile }) {
  const money = x => formatMoney(x, { currency: result.currency });
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Window: **${result.startDate} → ${result.endDate}** (valuation: **${result.endValuationDate}**)`);
  lines.push('');
  lines.push('## Snapshot');
  lines.push('');
  lines.push(`- Resolved assets: **${universeResolved.length}**`);
  lines.push(`- Failed assets: **${failures.length}**`);
  lines.push(`- Final equity: **${money(result.finalEquity)}**`);
  lines.push(`- CAGR: **${Number.isFinite(result.cagr) ? (result.cagr * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push(`- Sharpe (daily): **${Number.isFinite(result.sharpe) ? result.sharpe.toFixed(2) : 'n/a'}**`);
  lines.push(`- Max drawdown: **${Number.isFinite(result.maxDrawdown) ? (result.maxDrawdown * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push(`- Alpha vs ${result.benchmarkSymbol || 'benchmark'} (ann): **${Number.isFinite(result.alphaAnn) ? (result.alphaAnn * 100).toFixed(2) + '%' : 'n/a'}**`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- Record book: ${recordBookFile}`);
  lines.push(`- Summary (json): ${summaryFile}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  const cfgPath = path.resolve(
    process.cwd(),
    args.config || path.join('data', 'tsmom_turbo_expanded_universe.json'),
  );
  const cfg = safeReadJson(cfgPath);
  if (!cfg) {
    console.error('[expanded] Missing config:', cfgPath);
    process.exit(1);
  }

  const windowStart = args.start || cfg.window?.start;
  const windowEnd = args.end || cfg.window?.end;
  if (!windowStart || !windowEnd) {
    console.error('[expanded] Missing window.start/window.end (or pass --start=YYYY-MM-DD --end=YYYY-MM-DD)');
    process.exit(1);
  }

  const startTs = Date.parse(`${windowStart}T00:00:00Z`);
  const endTs = Date.parse(`${windowEnd}T23:59:59Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs >= endTs) {
    console.error('[expanded] Invalid window:', { start: windowStart, end: windowEnd });
    process.exit(1);
  }

  const portfolio = {
    initialCapitalNIS: Number(cfg.portfolio.initialCapitalNIS || 50000),
    commissionNIS: Number(cfg.portfolio.commissionNIS || 5),
    topK: Number(cfg.portfolio.topK || 5),
  };

  const currency = String(cfg.portfolio?.currency || 'NIS').trim().toUpperCase();

  const params = {
    lookbackTradingDays: Number(cfg.turbo.lookbackTradingDays || 63),
    skipRecentTradingDays: Number(cfg.turbo.skipRecentTradingDays || 21),
    targetVolAnn: Number(cfg.turbo.targetVolAnn || 0.8),
    volCenterDays: Number(cfg.turbo.volCenterDays || 60),
    maxLeverage: Number(cfg.turbo.maxLeverage || 5),
    minSigmaAnn: Number(cfg.turbo.minSigmaAnn || 0.01),
    longOnly: cfg.turbo.longOnly !== false,
  };

  const benchmarkSymbol = getBenchmarkYahooSymbol(cfg);

  const requested = flattenExpandedUniverse(cfg).map(x => ({
    input: x.input,
    yahoo: x.yahoo,
    label: x.label,
  }));

  const failures = [];
  const perSymbol = {};

  // Build universe list (yahoo override if present else input)
  const toFetch = requested.map(x => ({
    input: x.input,
    fetchSymbol: x.yahoo || x.input,
    label: x.label,
  }));

  // Include benchmark if provided
  if (benchmarkSymbol) {
    toFetch.push({ input: benchmarkSymbol, fetchSymbol: benchmarkSymbol, label: 'BENCHMARK' });
  }

  console.log('[expanded] Fetching candles for', toFetch.length, 'symbols...');

  for (const a of toFetch) {
    const key = a.fetchSymbol;
    if (perSymbol[key]) continue;
    try {
      console.log('[expanded] Fetch', a.fetchSymbol);
      const got = await fetchFullDailyCandles(a.fetchSymbol, {
        startMs: Date.parse('1990-01-01T00:00:00Z'),
        endMs: endTs,
        overrides: cfg.priceOverrides,
      });
      perSymbol[key] = { yahooSymbol: got.yahooSymbol, bars: got.bars };
      console.log('[expanded] OK', got.yahooSymbol, { bars: got.bars.length, start: toDateISO(got.bars[0].ts), end: toDateISO(got.bars.at(-1).ts) });
    } catch (e) {
      failures.push({ input: a.fetchSymbol, error: e?.message || String(e) });
      console.log('[expanded] FAIL', a.fetchSymbol, e?.message || e);
    }
  }

  // universe: use the fetched symbols that are NOT benchmark and NOT failed
  const universeResolved = requested
    .map(x => x.yahoo || x.input)
    .filter(sym => perSymbol[sym]?.bars?.length);

  if (universeResolved.length < 5) {
    console.error('[expanded] Not enough resolved assets to run Top-5. Resolved:', universeResolved.length);
    process.exit(1);
  }

  const perSymInputs = {};
  for (const sym of universeResolved) {
    perSymInputs[sym] = precomputeCloseAndSigma(perSymbol[sym].bars, params);
  }

  // Benchmark bars (if fetched)
  if (benchmarkSymbol && perSymbol[benchmarkSymbol]?.bars?.length) {
    perSymInputs[benchmarkSymbol] = precomputeCloseAndSigma(perSymbol[benchmarkSymbol].bars, params);
  }

  const result = simulateTurboExpanded({
    universe: universeResolved,
    perSymbol,
    perSymInputs,
    benchmarkSymbol: (benchmarkSymbol && perSymbol[benchmarkSymbol]?.bars?.length) ? benchmarkSymbol : '',
    startTs,
    endTs,
    params,
    portfolio,
  });

  // attach currency for rendering
  result.currency = currency;
  result.commissionPerTrade = portfolio.commissionNIS;

  const outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.resolve(process.cwd(), 'reports', 'tsmom', 'turbo', 'expanded');
  fs.mkdirSync(outDir, { recursive: true });

  const startY = yearFromISO(windowStart);
  const endY = yearFromISO(windowEnd);
  const runTag = safeSlug(`${startY}_${endY}_${args.noReset ? 'NoReset' : 'Run'}`);

  const recordBookTitle = `TSMOM Turbo — Expanded Universe (${windowStart} → ${windowEnd})${args.noReset ? ' — No Reset' : ''}`;
  const md = renderRecordBook({ title: recordBookTitle, result, universeResolved, failures });

  const recordBookFile = `TSMOM_Turbo_Expanded_Record_Book_${runTag}.md`;
  const recordBookPath = path.resolve(outDir, recordBookFile);
  fs.writeFileSync(recordBookPath, md, 'utf8');
  console.log('[expanded] Wrote', recordBookPath);

  const summary = {
    window: { start: result.startDate, end: result.endDate, valuation: result.endValuationDate },
    finalEquityNIS: result.finalEquity,
    commissionsNIS: result.commissionsTotal,
    cagr: result.cagr,
    sharpe: result.sharpe,
    maxDrawdown: result.maxDrawdown,
    alphaAnn: result.alphaAnn,
    beta: result.beta,
    benchmark: result.benchmarkSymbol,
    resolvedAssets: universeResolved.length,
    failedAssets: failures.length,
  };

  const summaryFile = `TSMOM_Turbo_Expanded_Summary_${runTag}.json`;
  const summaryPath = path.resolve(outDir, summaryFile);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('[expanded] Wrote', summaryPath);

  // Keep a stable "latest" pointer file for convenience.
  fs.writeFileSync(path.resolve(outDir, 'TSMOM_Turbo_Expanded_Summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('[expanded] Wrote TSMOM_Turbo_Expanded_Summary.json');

  const reportTitle = `TSMOM Turbo — Expanded Universe Report (${windowStart} → ${windowEnd})${args.noReset ? ' — No Reset' : ''}`;
  const reportMd = renderReport({ title: reportTitle, result, universeResolved, failures, recordBookFile, summaryFile });
  const reportFile = `TSMOM_Turbo_Expanded_Report_${runTag}.md`;
  const reportPath = path.resolve(outDir, reportFile);
  fs.writeFileSync(reportPath, reportMd, 'utf8');
  console.log('[expanded] Wrote', reportPath);

  process.exit(0);
}

main().catch(err => {
  console.error('[expanded] Failed:', err);
  process.exit(1);
});
