import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Chart from "../components/Chart";
import TickerLogo from "../components/TickerLogo";
import type { Candle, Interval, StrategySignal } from "@shared/types";

export default function Ticker() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialSym = (searchParams.get("symbol") || "AAPL").toUpperCase();
  const [symbol, setSymbol] = useState(initialSym);
  const [interval, setInterval] = useState<Interval>(() => {
    const k = `iv:${initialSym}`;
    const v = localStorage.getItem(k) as Interval | null;
    return (v === '4h' || v === '1d' || v === '1wk' || v === '1mo') ? v : '1d';
  });
  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [overlays, setOverlays] = useState<{ ema20: number[]; ema50: number[]; ema200: number[] } | undefined>();
  const [partial, setPartial] = useState(false);
  const [intradayAvail, setIntradayAvail] = useState<boolean | undefined>(undefined);
  const [noIntradaySymbols, setNoIntradaySymbols] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('noIntradaySymbols') || '{}') ?? {}; } catch { return {}; }
  });
  const [effectiveInterval, setEffectiveInterval] = useState<Interval | undefined>(undefined);
  const [ind, setInd] = useState<any | null>(null);
  const [strats, setStrats] = useState<StrategySignal[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ipcWarn, setIpcWarn] = useState(false);

  // Debounced symbol to avoid spamming IPC when typing
  const [debouncedSymbol, setDebouncedSymbol] = useState(symbol);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSymbol(symbol), 300);
    return () => clearTimeout(t);
  }, [symbol]);

  async function load(sym?: string, iv?: Interval) {
    setLoading(true); setErr(null);
    const started = performance.now();
    try {
      const s = (sym ?? symbol).trim().toUpperCase();
      const i = iv ?? interval;
      console.log(`[Ticker] load start`, { symbol: s, interval: i });
      const resp = await (window as any).api.getCandlesByInterval(s, i);
      const { candles, partialRange, intradayAvailable, interval: effIv } = resp || {};
      console.log(`[Ticker] candles fetched`, { count: candles?.length, intervalRequested: i, intervalEffective: effIv || i, first: candles?.[0]?.ts && new Date(candles[0].ts).toISOString(), last: candles?.[candles.length-1]?.ts && new Date(candles[candles.length-1].ts).toISOString() });
      setCandles(candles);
      setPartial(!!partialRange);
      setIntradayAvail(intradayAvailable);
      setEffectiveInterval((effIv || i) as Interval);
      // Remember if intraday is not available for this symbol
      if (i === '4h' && intradayAvailable === false) {
        setNoIntradaySymbols(prev => {
          const next = { ...prev, [s]: true };
          localStorage.setItem('noIntradaySymbols', JSON.stringify(next));
          return next;
        });
      }
      const effective = (effIv || i) as Interval;
      const { overlays, snapshot } = await (window as any).api.getIndicators(s, effective);
      console.log(`[Ticker] indicators computed`, { haveOverlays: !!overlays, ema20: overlays?.ema20?.length, ema50: overlays?.ema50?.length, ema200: overlays?.ema200?.length });
      setOverlays(overlays);
      setInd(snapshot);
      const strat = await (window as any).api.getStrategies(s, effective);
      setStrats(Array.isArray(strat) ? strat : []);
      console.log(`[Ticker] strategies computed`, { count: Array.isArray(strat) ? strat.length : 0, tookMs: Math.round(performance.now()-started) });
    } catch (e:any) {
      console.error(`[Ticker] load error`, e);
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  // Preload presence check (non-blocking)
  useEffect(() => {
    const ok = typeof (window as any)?.api?.getCandlesByInterval === 'function' || typeof (window as any)?.api?.getCandles === 'function';
    setIpcWarn(!ok);
  }, []);

  // Reload when symbol or interval changes (debounced on symbol)
  useEffect(() => { load(debouncedSymbol, interval); }, [debouncedSymbol, interval]);

  // React to search param changes (when navigating from watchlists)
  useEffect(() => {
    const s = searchParams.get("symbol");
    if (s && s.toUpperCase() !== symbol) setSymbol(s.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <>
      <h2>Ticker</h2>
      <div className="row" style={{gap: 12, marginBottom: 10, alignItems: 'center'}}>
        <TickerLogo symbol={symbol} size={32} />
        <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="Symbol e.g. AAPL" />
        <div className="row" style={{ gap: 6 }}>
          {(['4h','1d','1wk','1mo'] as Interval[]).map(iv => {
            const disabled = iv==='4h' && (noIntradaySymbols[symbol] === true);
            return (
              <button
                key={iv}
                className={iv===interval? 'primary':''}
                onClick={() => { if (!disabled) { setInterval(iv); localStorage.setItem(`iv:${symbol}`, iv); } }}
                disabled={disabled}
                title={disabled ? '4H not available for this symbol on Yahoo' : undefined}
              >
                {iv.toUpperCase()}
              </button>
            );
          })}
        </div>
        <button className="primary" onClick={() => load(symbol, interval)} disabled={loading}>Refresh</button>
        <button onClick={() => navigate(`/backtest?symbol=${symbol.toUpperCase()}`)} title="Open Backtests for this ticker">Go to Backtest</button>
      </div>
      {ipcWarn && (
        <div className="card" style={{ borderColor: '#665a00', color: '#ffe58f', marginBottom: 8 }}>
          Preload missing—IPC not available. Some features may not work until preload is properly wired.
        </div>
      )}
      {partial && <div className="badge" style={{ background: '#333951', color: '#cfe3ff', display:'inline-block', marginBottom: 8 }}>Max available history</div>}
      {interval==='4h' && intradayAvail===false && (
        <div className="badge" style={{ background: '#514533', color: '#ffe6c1', display:'inline-block', marginBottom: 8 }}>
          4H not available for this symbol on Yahoo — showing 1D
        </div>
      )}
      {err && (
        <div className="card" style={{ borderColor: "#733", color: "#ffb3b3"}}>
          <div>{err}</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>Tip: rate limits happen; try again in ~1–2 minutes.</div>
        </div>
      )}
      {loading ? (
        <div className="card">Loading…</div>
      ) : candles.length ? (
        <Chart candles={candles} overlays={overlays} />
      ) : (
        <div className="card">
          No data{interval==='4h' ? ' — intraday may be restricted; try 1D/1W/1M.' : ''}
        </div>
      )}

      {/* Indicators panel */}
      {ind && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Indicators</h3>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <span>EMA20: {ind.ema20.toFixed(2)} ({ind.ema20Slope>=0? '↗':'↘'})</span>
            <span>EMA50: {ind.ema50.toFixed(2)} ({ind.ema50Slope>=0? '↗':'↘'})</span>
            <span>EMA200: {ind.ema200.toFixed(2)} ({ind.ema200Slope>=0? '↗':'↘'})</span>
            <span>RSI(14): {ind.rsi14.toFixed(1)}</span>
            <span>MACD: {ind.macd.line.toFixed(2)} / {ind.macd.signal.toFixed(2)} ({ind.macd.hist>=0?'+':'-'})</span>
            <span>Donchian20: [{ind.donchian20.low.toFixed(2)} , {ind.donchian20.high.toFixed(2)}]</span>
            {ind.fib.levels && <span>Fib: 38.2 {ind.fib.levels['38.2'].toFixed(2)} • 50 {ind.fib.levels['50'].toFixed(2)} • 61.8 {ind.fib.levels['61.8'].toFixed(2)} ({ind.fib.region})</span>}
          </div>
        </div>
      )}

      {/* Strategies panel */}
      <div className="card" style={{ marginTop: 12 }}>
        <h3>Strategies</h3>
        {!strats.length ? (
          <div>No active strategies on this interval.</div>
        ) : (
          <div className="cardgrid">
            {strats.map(s => (
              <div key={`${s.name}-${s.timestamp}`} className="card" style={{ padding: 10 }}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 13, color: '#9aa4b2' }}>{new Date(s.timestamp).toLocaleString()}</div>
                <div className="row" style={{ gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                  <span>Entry: {s.entryPrice.toFixed(2)}</span>
                  <span>Stop: {s.stopPrice.toFixed(2)}</span>
                  <span>Targets: {s.targets.map(t=>t.toFixed(2)).join(', ')}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13 }}>{s.rationale}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
