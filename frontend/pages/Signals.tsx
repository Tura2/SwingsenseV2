import { useEffect, useMemo, useState } from "react";
import type { Interval } from "@shared/types";
import TickerLogo from "../components/TickerLogo";

type Filters = { watchlistId?: number; timeframe: Interval; direction?: 'LONG'|'SHORT'; strategy?: string; minConfidence?: number; minRR?: number };

export default function Signals() {
  const api = (window as any).api as undefined | any;
  if (!api) {
    return (
      <div className="card" style={{ borderColor: "#733", color: "#ffb3b3" }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window, not a normal browser.
      </div>
    );
  }

  const [watchlists, setWatchlists] = useState<{ id: number; name: string }[]>([]);
  const [filters, setFilters] = useState<Filters>({ timeframe: '1d', minConfidence: 0, minRR: 0.5 });
  const [data, setData] = useState<{ stats: { scanned: number; signaled: number; durationMs: number }, results: { watchlistId: number; name: string; cards: any[] }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    api.listWatchlists().then((w: any[]) => setWatchlists(w.map(x => ({ id: x.id, name: x.name }))));
  }, []);

  async function runScan() {
    setLoading(true);
    try {
      const res = await api.scanWatchlistsSignals(filters);
      setData(res);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runScan(); }, [JSON.stringify(filters)]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(runScan, 60_000);
    return () => clearInterval(t);
  }, [autoRefresh, JSON.stringify(filters)]);

  const sortedResults = useMemo(() => {
    if (!data) return null;
    // Default sort: newest first
    const sorted = data.results.map(r => ({
      ...r,
      cards: [...r.cards].sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0))
    }));
    return sorted;
  }, [data]);

  return (
    <>
      <h2>Signals</h2>
      <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={filters.watchlistId ?? ''} onChange={e => setFilters(f => ({ ...f, watchlistId: e.target.value ? Number(e.target.value) : undefined }))}>
          <option value="">All Watchlists</option>
          {watchlists.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={filters.timeframe} onChange={e => setFilters(f => ({ ...f, timeframe: e.target.value as Interval }))}>
          {(['4h','1d','1wk','1mo'] as Interval[]).map(iv => <option key={iv} value={iv}>{iv.toUpperCase()}</option>)}
        </select>
        <select value={filters.direction ?? ''} onChange={e => setFilters(f => ({ ...f, direction: e.target.value ? e.target.value as any : undefined }))}>
          <option value="">Any Direction</option>
          <option value="LONG">Long</option>
          <option value="SHORT">Short</option>
        </select>
        <input placeholder="Strategy filter (e.g. MACD)" value={filters.strategy ?? ''} onChange={e => setFilters(f => ({ ...f, strategy: e.target.value || undefined }))} />
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          Min Confidence
          <input type="number" min={0} max={100} value={filters.minConfidence ?? 0} onChange={e => setFilters(f => ({ ...f, minConfidence: Number(e.target.value) }))} style={{ width: 80 }} />
        </label>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          Min R:R
          <input type="number" step={0.1} min={0} max={10} value={filters.minRR ?? 0.5} onChange={e => setFilters(f => ({ ...f, minRR: Number(e.target.value) }))} style={{ width: 80 }} />
        </label>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} /> Auto refresh (1m)
        </label>
        <button className="primary" onClick={runScan} disabled={loading}>{loading ? 'Scanning…' : 'Refresh'}</button>
      </div>

      {!sortedResults ? (
        <div className="card">Loading…</div>
      ) : (
        sortedResults.map(section => (
          <section key={section.watchlistId} style={{ marginBottom: 16 }}>
            <h3>{section.name}</h3>
            {section.cards.length ? (
              <div className="cardgrid">
                {section.cards.map((c, idx) => (
                  <div
                    key={`${c.symbol}-${c.strategy}-${idx}`}
                    className="card"
                    style={{ padding: 10, cursor: 'pointer' }}
                    onClick={() => window.open(`#/ticker?symbol=${encodeURIComponent(c.symbol)}`, '_self')}
                  >
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <TickerLogo symbol={c.symbol} />
                        <strong>{c.symbol}</strong>
                        <span>• {c.direction} • {c.timeframe.toUpperCase()}</span>
                      </div>
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.strategy}</div>
                    <div style={{ fontSize: 13, color: '#9aa4b2', marginBottom: 8 }}>{c.rationale || '—'}</div>
                    <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                      <span>Entry: {c.entry.toFixed(2)}</span>
                      <span>Stop: {c.stop.toFixed(2)}</span>
                      <span>Target: {c.target.toFixed(2)}</span>
                      {Number.isFinite(c.rr) && <span>R:R {c.rr!.toFixed(2)}</span>}
                    </div>
                    <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 12, color: '#9aa4b2', flexWrap: 'wrap' }}>
                      <span>Confidence: {c.confidence}%</span>
                      <span>{new Date(c.triggeredAt).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card">No active signals.</div>
            )}
          </section>
        ))
      )}
    </>
  );
}
