export function flattenExpandedUniverse(cfg) {
  const out = [];
  for (const group of (cfg?.assets || [])) {
    for (const item of (group?.items || [])) {
      const input = String(item?.input || '').trim();
      if (!input) continue;
      const yahoo = String(item?.yahoo || '').trim();
      out.push({
        group: String(group?.group || '').trim(),
        label: String(item?.label || input).trim(),
        input,
        yahoo: yahoo || null,
      });
    }
  }
  return out;
}

export function getBenchmarkYahooSymbol(cfg) {
  const s = String(cfg?.benchmark?.yahooSymbol || '').trim();
  return s || null;
}
