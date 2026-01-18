#!/usr/bin/env node

const symbol = String(process.argv[2] || '').trim();
if (!symbol) {
  console.error('Usage: node scripts/tsmom/probe_yahoo_symbol.mjs <YAHOO_SYMBOL>');
  process.exit(1);
}

const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;

(async () => {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);

  const meta = j?.chart?.result?.[0]?.meta;
  const err = j?.chart?.error;

  if (r.status === 200 && meta) {
    console.log(`OK ${symbol} | ${meta.shortName || meta.longName || ''}`);
    return;
  }

  console.log(`FAIL ${symbol} | HTTP ${r.status} | ${err ? `${err.code}: ${err.description}` : 'no-json'}`);
})().catch(e => {
  console.log(`ERR ${symbol} | ${e?.message || e}`);
  process.exit(1);
});
