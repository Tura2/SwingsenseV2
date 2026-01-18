import type { QuoteLite } from "../../shared/types.js";
import { normalizeInputSymbol, resolveCanonicalYahooSymbol } from "./symbols.js";
import { fetchQuoteLiteFromChart } from "./yahooChartApi.js";

/**
 * getQuoteSafe(symbol): resilient quote fetcher that:
 * - Resolves symbol via search to exchange-qualified Yahoo symbol
 * - Uses the Yahoo v8 chart endpoint (works even when quote endpoints are blocked)
 */
export async function getQuoteSafe(inputSymbol: string): Promise<QuoteLite> {
  const s = normalizeInputSymbol(inputSymbol);
  const resolved = await resolveCanonicalYahooSymbol(s).catch(() => ({ candidates: [s] }));
  const ysym = resolved?.candidates?.[0] || s;

  try {
    const q = await fetchQuoteLiteFromChart(ysym);
    console.log('[quotes] getQuoteSafe chart ok', { input: s, ysym });
    return q;
  } catch (e: any) {
    console.error('[quotes] getQuoteSafe failed', { input: s, ysym, name: e?.name, message: e?.message });
    // Structured failure — return minimal shape with nulls
    return { symbol: s, last: null, change: null, changePct: null, ts: null };
  }
}

/** Fetch lightweight quotes for an array of symbols. */
export async function getQuotes(symbols: string[]): Promise<QuoteLite[]> {
  const input = (symbols || []).map(normalizeInputSymbol).filter(Boolean);
  // Resolve symbols via search and fetch each safely
  const out: QuoteLite[] = [];
  for (const s of input) {
    const safe = await getQuoteSafe(s);
    out.push(safe.symbol ? { ...safe, symbol: s } : safe);
  }
  return out;
}
