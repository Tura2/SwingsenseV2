import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run() {
  try {
    const svcUrl = pathToFileURL(path.resolve('dist-electron/src/main/services/market.js')).href;
    const { getCandlesByInterval } = await import(svcUrl);

    const tests = [
      { symbol: 'AAPL', interval: '4h' },
      { symbol: 'AAPL', interval: '1d' },
      { symbol: 'ICL.TA', interval: '4h' },
      { symbol: 'ICL.TA', interval: '1d' },
    ];

    for (const t of tests) {
      const res = await getCandlesByInterval(t.symbol, t.interval);
      const first = res.candles?.[0]?.ts ? new Date(res.candles[0].ts).toISOString() : undefined;
      const last = res.candles?.length ? new Date(res.candles.at(-1).ts).toISOString() : undefined;
      console.log('[SMOKE]', t, {
        count: res.candles?.length || 0,
        effectiveInterval: res.interval || t.interval,
        intradayAvailable: res.intradayAvailable,
        partialRange: res.partialRange,
        history: { first, last }
      });
    }
    process.exit(0);
  } catch (e) {
    console.error('[SMOKE] error', e);
    process.exit(1);
  }
}

run();
