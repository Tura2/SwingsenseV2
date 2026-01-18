/**
 * Helpers for handling exchange-specific symbol variants.
 * Currently focuses on TASE (Israel) symbols using Yahoo's ".TA" suffix.
 */

import { fetchYahooSearchQuotes } from "./yahooChartApi.js";

/** Return an uppercase, trimmed version of the input. */
export function normalizeInputSymbol(input: string): string {
  return String(input || "").trim().toUpperCase();
}

/**
 * Generate Yahoo Finance symbol candidates for a given user-entered symbol.
 *
 * Rules:
 * - If the input already ends with ".TA", only try that.
 * - If the input starts with "TASE:" or "TASE-", try only the base with ".TA".
 * - Otherwise, try the input as-is first, then try input + ".TA" as a fallback.
 *
 * Example:
 * - "ICL" -> ["ICL", "ICL.TA"]
 * - "TASE:ICL" -> ["ICL.TA"]
 * - "ICL.TA" -> ["ICL.TA"]
 */
export function yahooCandidatesForSymbol(input: string): string[] {
  const s = normalizeInputSymbol(input);
  if (!s) return [];

  // Explicit TASE hint
  if (s.startsWith("TASE:") || s.startsWith("TASE-")) {
    const base = s.replace(/^TASE[:\-]/, "");
    return base ? [base + ".TA"] : [];
  }

  // Already has .TA
  if (s.endsWith(".TA")) return [s];

  // Heuristic: if it looks like a typical US symbol (letters, dots like BRK.B), don't append .TA.
  // We'll let the market service optionally decide TA based on an exchange lookup.
  return [s];
}

// Simple in-memory cache for canonical exchange resolution results
const exchangeCache = new Map<string, { ysym: string; exchange?: string; ts: number }>();

/**
 * Try to detect the canonical Yahoo symbol and primary exchange. Caches results in-memory.
 * - If input ends with .TA or prefixed TASE:, we assume TASE and return that.
 * - Otherwise, query yahooFinance.quoteSummary minimally (price or price.shortName) to get exchangeName/symbol.
 */
export async function resolveCanonicalYahooSymbol(input: string): Promise<{ candidates: string[]; exchange?: string }>{
  const s = normalizeInputSymbol(input);
  if (!s) return { candidates: [] };

  if (s.startsWith('TASE:') || s.startsWith('TASE-')) {
    const base = s.replace(/^TASE[:\-]/, "");
    return { candidates: [base + '.TA'], exchange: 'TASE' };
  }
  if (s.endsWith('.TA')) return { candidates: [s], exchange: 'TASE' };

  const cached = exchangeCache.get(s);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 60 * 24) {
    // 24h cache
    return { candidates: [cached.ysym], exchange: cached.exchange };
  }

  try {
    const upper = (x: any) => String(x || "").toUpperCase();
    const quotes = await fetchYahooSearchQuotes(s, { quotesCount: 10, enableFuzzyQuery: false }).catch(() => []);
    const taseSymbol = s.endsWith(".TA") ? s : `${s}.TA`;

    const isTaseQuote = (q: any): boolean => {
      const sym = upper(q?.symbol);
      const ex = upper(q?.exchDisp || q?.exchange || q?.market || q?.fullExchangeName);
      return sym.endsWith(".TA") || ex.includes("TEL AVIV") || ex.includes("TASE");
    };

    const exact = quotes.find(q => upper(q?.symbol) === s) || null;
    const tase = quotes.find(q => upper(q?.symbol) === upper(taseSymbol) || isTaseQuote(q)) || null;

    // Prefer exact match when available
    let picked = exact;
    if (!picked && tase && (upper(tase?.symbol).endsWith(".TA") || isTaseQuote(tase))) {
      picked = tase;
    }

    const ysym = upper(picked?.symbol || s);
    const exchange = picked?.fullExchangeName || picked?.exchDisp || picked?.exchange || picked?.market || undefined;

    if (picked && isTaseQuote(picked)) {
      exchangeCache.set(s, { ysym: ysym.endsWith(".TA") ? ysym : taseSymbol, exchange: "TASE", ts: Date.now() });
      return { candidates: [ysym.endsWith(".TA") ? ysym : taseSymbol, s], exchange: "TASE" };
    }

    exchangeCache.set(s, { ysym, exchange, ts: Date.now() });
    return { candidates: [ysym], exchange };
  } catch {
    // On failure, keep conservative default
    return { candidates: [s] };
  }
}

// In-memory cache for search-based resolution (input -> ysym)
const searchCache = new Map<string, { ysym: string; exchange?: string; ts: number }>();

/**
 * Resolve a user input to a fully-qualified Yahoo symbol via Yahoo's finance search endpoint.
 * Picks the best matching quote (exact symbol first, then by exchange hints like TASE/US), caches for 24h.
 */
export async function resolveYahooSymbolViaSearch(input: string): Promise<{ ysym: string; exchange?: string } | null> {
  const s = normalizeInputSymbol(input);
  if (!s) return null;

  const cached = searchCache.get(s);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 60 * 24) {
    return { ysym: cached.ysym, exchange: cached.exchange };
  }

  try {
    const quotes: any[] = await fetchYahooSearchQuotes(s, { quotesCount: 10, enableFuzzyQuery: false });
    if (!quotes.length) return null;

    const upper = (x: any) => String(x || "").toUpperCase();
    const isTase = (q: any): boolean => {
      const sym = upper(q?.symbol);
      const ex = upper(q?.exchDisp || q?.exchange || q?.market || q?.fullExchangeName);
      return sym.endsWith(".TA") || ex.includes("TEL AVIV") || ex.includes("TASE");
    };

    // Prefer exact symbol match (case-insensitive)
    const exact = quotes.find(q => upper(q?.symbol) === s);
    let picked = exact || null;
    if (!picked) {
      // If input already has .TA or starts with TASE, prefer TASE entries
      const preferTase = s.endsWith('.TA') || s.startsWith('TASE:') || s.startsWith('TASE-');
      const tase = quotes.find(q => isTase(q));
      if (preferTase && tase) picked = tase;
    }
    if (!picked) {
      // Otherwise prefer US major exchanges
      const us = quotes.find(q => {
        const ex = upper(q?.exchDisp || q?.exchange || q?.market || q?.fullExchangeName);
        return ex.includes('NASDAQ') || ex.includes('NYSE') || ex.includes('NYSE ARCA') || ex.includes('NYSE MKT');
      });
      picked = us || quotes[0];
    }

    const ysym = upper(picked?.symbol || s);
    const exchange = picked?.fullExchangeName || picked?.exchDisp || picked?.exchange || undefined;
    searchCache.set(s, { ysym, exchange, ts: Date.now() });
    return { ysym, exchange };
  } catch {
    return null;
  }
}
