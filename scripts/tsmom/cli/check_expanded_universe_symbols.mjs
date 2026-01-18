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

function toIsoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function safeReadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

async function tryFetchCandles(ysym, startMs, endMs) {
  const candles = await fetchYahooCandlesByPeriod(ysym, '1d', startMs, endMs, true);
  const bars = (candles || []).filter(c => Number.isFinite(c.ts) && Number.isFinite(c.close));
  if (!bars.length) throw new Error('No candles returned');
  return bars.length;
}

function is404(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('HTTP 404') || msg.includes('Not Found');
}

async function checkOneSymbol(inputSymbol, startMs, endMs) {
  const original = normalizeInputSymbol(inputSymbol);

  // Attempt direct candidates (the same logic used by our runner)
  const resolved = await resolveCanonicalYahooSymbol(original).catch(() => ({ candidates: yahooCandidatesForSymbol(original) }));
  const candidates = resolved.candidates?.length ? resolved.candidates : yahooCandidatesForSymbol(original);

  let lastErr = null;
  for (const ysym of candidates) {
    try {
      const count = await tryFetchCandles(ysym, startMs, endMs);
      return { ok: true, yahooSymbol: ysym, bars: count };
    } catch (e) {
      lastErr = e;
      // keep trying other candidates
    }
  }

  return { ok: false, lastError: String(lastErr?.message || lastErr || 'Unknown error'), is404: is404(lastErr) };
}

async function suggestYahooSymbol(originalInput, startMs, endMs) {
  const normalized = normalizeInputSymbol(originalInput);
  const resolved = await resolveCanonicalYahooSymbol(normalized).catch(() => null);
  const candidates = resolved?.candidates?.length ? resolved.candidates : [];

  for (const ysym of candidates) {
    try {
      await tryFetchCandles(ysym, startMs, endMs);
      return ysym;
    } catch {
      // ignore
    }
  }

  return null;
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

async function main() {
  const repoRoot = process.cwd();
  const cfgPath = path.join(repoRoot, 'data', 'tsmom_turbo_expanded_universe.json');
  const cfg = safeReadJson(cfgPath);

  const start = new Date(cfg.window?.start || '2020-01-01');
  const end = new Date(cfg.window?.end || new Date());

  // Keep this a small probe window to reduce throttling.
  // We probe the last ~6 months ending at cfg.window.end.
  const probeEnd = end;
  const probeStart = new Date(probeEnd);
  probeStart.setUTCMonth(probeStart.getUTCMonth() - 6);

  const startMs = probeStart.getTime();
  const endMs = probeEnd.getTime();

  const universe = flattenExpandedUniverse(cfg);

  const checks = [];

  // Benchmark first
  const benchSymbol = getBenchmarkYahooSymbol(cfg);
  if (benchSymbol) {
    const benchRes = await checkOneSymbol(benchSymbol, startMs, endMs);
    checks.push({
      kind: 'benchmark',
      group: 'Benchmark',
      label: cfg.benchmark?.name || 'Benchmark',
      input: benchSymbol,
      yahoo: benchSymbol,
      ...benchRes,
      suggestedYahoo: !benchRes.ok ? await suggestYahooSymbol(benchSymbol, startMs, endMs) : null,
    });
  }

  for (const item of universe) {
    const symbolToCheck = item.yahoo?.trim() ? item.yahoo.trim() : item.input;
    const res = await checkOneSymbol(symbolToCheck, startMs, endMs);

    let suggestedYahoo = null;
    if (!res.ok) {
      // Suggest based on the input field if yahoo was blank; otherwise suggest based on yahoo.
      const suggestFrom = item.yahoo?.trim() ? item.yahoo.trim() : item.input;
      suggestedYahoo = await suggestYahooSymbol(suggestFrom, startMs, endMs);
    }

    checks.push({
      kind: 'asset',
      group: item.group,
      label: item.label,
      input: item.input,
      yahoo: item.yahoo,
      checked: symbolToCheck,
      ...res,
      suggestedYahoo,
    });
  }

  const notOk = checks.filter(c => !c.ok);
  const notFound = notOk.filter(c => c.is404);

  const outDir = path.join(repoRoot, 'reports', 'tsmom', 'turbo', 'expanded');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `Universe_Fetch_Check_${toIsoDate(new Date())}.md`);

  const lines = [];
  lines.push(`# Expanded Universe — Yahoo Fetch Check`);
  lines.push('');
  lines.push(`Config: data/tsmom_turbo_expanded_universe.json`);
  lines.push(`Probe window: **${toIsoDate(probeStart)} → ${toIsoDate(probeEnd)}**`);
  lines.push('');
  lines.push(`Total checked: **${checks.length}**`);
  lines.push(`Failures: **${notOk.length}**`);
  lines.push(`HTTP 404s: **${notFound.length}**`);
  lines.push('');

  const renderTable = (rows, title) => {
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Kind | Group | Label | Input | Yahoo (configured) | Checked | Error | Suggested Yahoo |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(
        `| ${mdEscape(r.kind)} | ${mdEscape(r.group)} | ${mdEscape(r.label)} | ${mdEscape(r.input)} | ${mdEscape(r.yahoo)} | ${mdEscape(r.checked || r.input)} | ${mdEscape(r.lastError)} | ${mdEscape(r.suggestedYahoo || '')} |`
      );
    }
    lines.push('');
  };

  renderTable(notFound, '404 (Not Found)');

  const other = notOk.filter(c => !c.is404);
  if (other.length) renderTable(other, 'Other Failures (non-404)');

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  // Console summary (for quick copy/paste)
  console.log(`[check] wrote ${outPath}`);
  console.log('');
  console.log('404 list:');
  for (const r of notFound) {
    const key = r.kind === 'benchmark' ? `[BENCH] ${r.label}` : `[ASSET] ${r.label}`;
    console.log(`- ${key}: checked=${r.checked || r.input} (input=${r.input || ''}, yahoo=${r.yahoo || ''})`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
