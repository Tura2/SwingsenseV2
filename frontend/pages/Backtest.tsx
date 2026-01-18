import { useEffect, useMemo, useState, Fragment } from 'react';
import { strToU8, zipSync } from 'fflate';
import { useSearchParams } from 'react-router-dom';
import Chart from "../components/Chart";
import type { Candle } from "@shared/types";

type StrategyStats = { trades: number; wins: number; losses: number; successPct: number; avgR: number; medianR: number; expectancy: number; avgHoldDays: number };
type Summary = { perStrategy: Record<string, StrategyStats> };
type TradeRow = {
  seq: number;
  strategy_id: string;
  signal_date: number;
  entry_date: number;
  entry_price: number;
  stop_at_entry: number;
  target_at_entry: number;
  exit_date: number;
  exit_price: number;
  exit_reason: 'target'|'stop'|'gap_target'|'gap_stop'|'time_stop';
  result: 'win'|'loss';
  r_multiple: number;
  days_held: number;
  confidence?: number | null;
  reasons?: string | null;
  factors?: string | null;
  mae_r?: number | null;
  mfe_r?: number | null;
  trail_used?: number | null;
  exit_trail_level?: number | null;
  time_stop_days?: number | null;
  entry_index?: number | null;
  exit_index?: number | null;
  pnl_pct?: number | null;
};

declare global {
  interface Window { api: { backtests: {
    runTicker(ticker: string, opts?: { minRRGlobal?: number; minRROverrides?: Record<string, number>; side?: 'BOTH'|'LONG'|'SHORT' }): Promise<{ runId: number }>;
    getLatestForTicker(ticker: string): Promise<{ runId: number; summary: Summary; trades: TradeRow[]; meta: any } | null>;
  };
    getCandlesByInterval(symbol: string, interval: '4h'|'1d'|'1wk'|'1mo'): Promise<{ candles: Candle[] }>;
    getIndicators(symbol: string, interval: '4h'|'1d'|'1wk'|'1mo'): Promise<{ overlays: { ema20: number[]; ema50: number[]; ema200: number[] } }>;
    getIndicatorBundle(symbol: string, interval: '4h'|'1d'|'1wk'|'1mo'): Promise<{ candles: Candle[]; bundle: any }>;
    getEngineConfig(): Promise<any>;
    listWatchlists(): Promise<{ id: number; name: string; created_at: number }[]>;
    getWatchlistSymbols(watchlistId: number): Promise<string[]>;
  } }
}

export default function BacktestPage() {
  const [searchParams] = useSearchParams();
  const initial = (searchParams.get('symbol') || 'AAPL').toUpperCase();
  const [symbol, setSymbol] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | 'ALL'>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [overlays, setOverlays] = useState<{ ema20: number[]; ema50: number[]; ema200: number[] } | undefined>();
  const [hoverSeq, setHoverSeq] = useState<number | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  // Range / trailing UI state
  const [showRanges, setShowRanges] = useState(true);
  const [showTrailing, setShowTrailing] = useState(true);
  const [supportLevel, setSupportLevel] = useState<number | undefined>();
  const [resistanceLevel, setResistanceLevel] = useState<number | undefined>();
  const [checkpointLevels, setCheckpointLevels] = useState<number[] | undefined>(undefined);
  const [activeTrailLevel, setActiveTrailLevel] = useState<number | null>(null);
  const [controlledRange, setControlledRange] = useState<{ fromMs: number; toMs: number } | undefined>();
  const [minRRGlobal, setMinRRGlobal] = useState<number>(0);
  const [sideFilter, setSideFilter] = useState<'BOTH'|'LONG'|'SHORT'>('LONG');
  const [minRROverrides, setMinRROverrides] = useState<Record<string, string>>({});
  const [strategyList, setStrategyList] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadedMeta, setLoadedMeta] = useState<any | null>(null);

  async function loadLatest() {
    setError(null);
    try {
  console.log('[Backtests] loadLatest start', { symbol });
      const res = await window.api.backtests.getLatestForTicker(symbol);
      if (res && res.summary) {
        console.log('[Backtests] loadLatest received', { trades: res.trades?.length, perStrategy: Object.keys(res.summary?.perStrategy||{}).length });
        setSummary(res.summary as Summary);
        setTrades(res.trades as TradeRow[]);
        setRunId(res.runId);
        setLoadedMeta(res.meta || null);
        setLastRunAt(Date.now());
        await loadChartData(symbol);
      } else {
        setSummary(null); setTrades([]);
        setRunId(null);
        setLoadedMeta(null);
      }
    } catch (e:any) {
      setError(e?.message || String(e));
    }
  }

  async function runNow() {
    setLoading(true); setError(null);
    try {
  console.log('[Backtests] runNow', { symbol });
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(minRROverrides)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) cleaned[k] = Math.min(5, Math.max(0, Number((Math.round(n*10)/10).toFixed(1))));
      }
  await window.api.backtests.runTicker(symbol, { minRRGlobal, minRROverrides: cleaned, side: sideFilter });
      await loadLatest();
    } catch (e:any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }

  function downloadBlobFromBuffer(buf: Uint8Array | ArrayBuffer, mime: string, filename: string) {
    let ab: ArrayBuffer;
    if (buf instanceof Uint8Array) {
      ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
    } else {
      // Ensure a plain ArrayBuffer copy (not SharedArrayBuffer) for Blob
      ab = buf.slice(0);
    }
    const blob = new Blob([ab], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  async function exportArtifacts() {
    try {
      if (!summary || !trades?.length) return;
      const run = runId ?? 'latest';
      // Fetch bundle and config
      const [{ candles: allCandles, bundle }, engineCfg] = await Promise.all([
        window.api.getIndicatorBundle(symbol, '1d'),
        window.api.getEngineConfig()
      ]);
  const bars = (allCandles || []).slice(-1260);
  // Bars file
  const barsOut = bars.map(b => ({ ts: b.ts, iso: new Date(b.ts).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, tf: '1d' }));

      // Indicators aligned to bars length
      const L = bars.length;
      const trunc = (arr?: number[]) => Array.isArray(arr) ? arr.slice(-L) : [];
      const indicatorsOut = {
        tf: '1d',
        ema20: trunc(bundle?.ema?.[20]),
        ema50: trunc(bundle?.ema?.[50]),
        ema100: trunc(bundle?.ema?.[100]),
        ema200: trunc(bundle?.ema?.[200]),
        rsi14: trunc(bundle?.rsi14),
        macd: {
          line: trunc(bundle?.macd?.macd),
          signal: trunc(bundle?.macd?.signal),
          hist: trunc(bundle?.macd?.hist)
        },
        bb: {
          upper: trunc(bundle?.bb?.upper),
          middle: trunc(bundle?.bb?.middle),
          lower: trunc(bundle?.bb?.lower),
          width: trunc(bundle?.bb?.width),
          widthRank120: trunc(bundle?.bb?.widthRank120)
        },
        atr14: trunc(bundle?.atr14),
        volMA20: trunc(bundle?.volMA20),
        donchian20: { hi: trunc(bundle?.donchian20?.hi), lo: trunc(bundle?.donchian20?.lo) }
      };

      // Trades file (normalized)
      const tradesOut = trades.map(t => {
        const side = (t.target_at_entry > t.entry_price && t.stop_at_entry < t.entry_price) ? 'LONG' : 'SHORT';
        return {
          seq: t.seq,
          symbol,
          tf: '1d',
          strategy: t.strategy_id,
          side,
          ts_open: t.entry_date,
          ts_close: t.exit_date,
          open_iso: new Date(t.entry_date).toISOString(),
          close_iso: new Date(t.exit_date).toISOString(),
          entry: t.entry_price,
          stop: t.stop_at_entry,
          target: t.target_at_entry,
          exit_price: t.exit_price,
          exit_reason: t.exit_reason,
          R: t.r_multiple,
          pct: t.pnl_pct,
          days: t.days_held,
          mae_R: t.mae_r,
          mfe_R: t.mfe_r,
          confidence: t.confidence ?? undefined
        };
      });

      // Equity curve per bar (step function, changes at exits)
      const eq: { ts: number; ts_iso: string; equity: number; drawdown: number; exposure_pct: number }[] = [];
      let equity = 1;
      let peak = 1;
      const byExitIndex = new Map<number, TradeRow>();
      for (const t of trades) if (typeof t.exit_index === 'number') byExitIndex.set(t.exit_index!, t);
  const offset = Math.max(0, allCandles.length - 1260);
      for (let i = offset; i < allCandles.length; i++) {
        const bar = allCandles[i];
  const rel = i - offset; // index within last-1260 window
        const inPos = trades.some(tr => (tr.entry_index ?? -1) <= rel && rel <= (tr.exit_index ?? -1));
        if (byExitIndex.has(rel)) {
          const t = byExitIndex.get(rel)!;
          const pct = (t.pnl_pct ?? 0) / 100;
          equity = equity * (1 + pct);
          peak = Math.max(peak, equity);
        }
        const dd = peak > 0 ? (equity / peak - 1) * 100 : 0;
        eq.push({ ts: bar.ts, ts_iso: new Date(bar.ts).toISOString(), equity: Number(equity.toFixed(6)), drawdown: Number(dd.toFixed(4)), exposure_pct: inPos ? 100 : 0 });
      }

      // Runtime config snapshot
      const configOut = {
        generatedAt: new Date().toISOString(),
        symbol,
        runId,
        timeframe: '1d',
        engineConfig: engineCfg || {},
        minRR: { global: loadedMeta?.minRRGlobal ?? 0, overrides: loadedMeta?.minRROverrides ?? {} }
      };
      // Build a single zip containing all artifacts
      const files: Record<string, Uint8Array> = {
        [`${symbol}_bars_${run}.json`]: strToU8(JSON.stringify(barsOut, null, 2)),
        [`${symbol}_indicators_${run}.json`]: strToU8(JSON.stringify(indicatorsOut, null, 2)),
        [`${symbol}_trades_${run}.json`]: strToU8(JSON.stringify(tradesOut, null, 2)),
        [`${symbol}_equity_${run}.json`]: strToU8(JSON.stringify(eq, null, 2)),
        [`${symbol}_config_${run}.json`]: strToU8(JSON.stringify(configOut, null, 2))
      };
      const zipped = zipSync(files, { level: 6 });
      downloadBlobFromBuffer(zipped, 'application/zip', `${symbol}_backtest_${run}.zip`);
    } catch (e) {
      console.warn('[Backtests] exportArtifacts failed', e);
      setError((e as any)?.message || String(e));
    }
  }

  async function batchExportBestSignals() {
    try {
      setError(null);
      const wls = await window.api.listWatchlists();
      const wl = wls.find(w => w.name.toUpperCase() === 'BEST SIGNALS');
      if (!wl) { setError('Watchlist "BEST SIGNALS" not found'); return; }
      const symbols = await window.api.getWatchlistSymbols(wl.id);
      if (!symbols?.length) { setError('"BEST SIGNALS" watchlist has no symbols'); return; }
      // Prepare cleaned overrides once
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(minRROverrides)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) cleaned[k] = Math.min(5, Math.max(0, Number((Math.round(n*10)/10).toFixed(1))));
      }
      for (const sym of symbols) {
        const s = sym.trim().toUpperCase();
        try {
          // Run backtest with current controls
          await window.api.backtests.runTicker(s, { minRRGlobal, minRROverrides: cleaned, side: sideFilter });
          const res = await window.api.backtests.getLatestForTicker(s);
          if (!res) continue;
          const tradesLocal = res.trades as TradeRow[];
          const sumPct = tradesLocal.reduce((acc, t) => acc + (t.pnl_pct ?? 0), 0);
          // Build artifacts for this symbol
          const [{ candles: allCandles, bundle }, engineCfg] = await Promise.all([
            window.api.getIndicatorBundle(s, '1d'),
            window.api.getEngineConfig()
          ]);
          const bars = (allCandles || []).slice(-1260);
          const barsOut = bars.map(b => ({ ts: b.ts, iso: new Date(b.ts).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, tf: '1d' }));
          const L = bars.length;
          const trunc = (arr?: number[]) => Array.isArray(arr) ? arr.slice(-L) : [];
          const indicatorsOut = {
            tf: '1d',
            ema20: trunc(bundle?.ema?.[20]),
            ema50: trunc(bundle?.ema?.[50]),
            ema100: trunc(bundle?.ema?.[100]),
            ema200: trunc(bundle?.ema?.[200]),
            rsi14: trunc(bundle?.rsi14),
            macd: { line: trunc(bundle?.macd?.macd), signal: trunc(bundle?.macd?.signal), hist: trunc(bundle?.macd?.hist) },
            bb: { upper: trunc(bundle?.bb?.upper), middle: trunc(bundle?.bb?.middle), lower: trunc(bundle?.bb?.lower), width: trunc(bundle?.bb?.width), widthRank120: trunc(bundle?.bb?.widthRank120) },
            atr14: trunc(bundle?.atr14),
            volMA20: trunc(bundle?.volMA20),
            donchian20: { hi: trunc(bundle?.donchian20?.hi), lo: trunc(bundle?.donchian20?.lo) }
          };
          const tradesOut = tradesLocal.map(t => {
            const side = (t.target_at_entry > t.entry_price && t.stop_at_entry < t.entry_price) ? 'LONG' : 'SHORT';
            return {
              seq: t.seq, symbol: s, tf: '1d', strategy: t.strategy_id, side,
              ts_open: t.entry_date, ts_close: t.exit_date,
              open_iso: new Date(t.entry_date).toISOString(), close_iso: new Date(t.exit_date).toISOString(),
              entry: t.entry_price, stop: t.stop_at_entry, target: t.target_at_entry,
              exit_price: t.exit_price, exit_reason: t.exit_reason,
              R: t.r_multiple, pct: t.pnl_pct, days: t.days_held,
              mae_R: t.mae_r, mfe_R: t.mfe_r, confidence: t.confidence ?? undefined
            };
          });
          const eq: { ts: number; ts_iso: string; equity: number; drawdown: number; exposure_pct: number }[] = [];
          let equity = 1; let peak = 1;
          const byExitIndex = new Map<number, TradeRow>();
          for (const t of tradesLocal) if (typeof t.exit_index === 'number') byExitIndex.set(t.exit_index!, t);
          const offset = Math.max(0, allCandles.length - 1260);
          for (let i = offset; i < allCandles.length; i++) {
            const bar = allCandles[i];
            const rel = i - offset;
            const inPos = tradesLocal.some(tr => (tr.entry_index ?? -1) <= rel && rel <= (tr.exit_index ?? -1));
            if (byExitIndex.has(rel)) {
              const t = byExitIndex.get(rel)!;
              const pct = (t.pnl_pct ?? 0) / 100;
              equity = equity * (1 + pct);
              peak = Math.max(peak, equity);
            }
            const dd = peak > 0 ? (equity / peak - 1) * 100 : 0;
            eq.push({ ts: bar.ts, ts_iso: new Date(bar.ts).toISOString(), equity: Number(equity.toFixed(6)), drawdown: Number(dd.toFixed(4)), exposure_pct: inPos ? 100 : 0 });
          }
          const configOut = {
            generatedAt: new Date().toISOString(), symbol: s, runId: res.runId, timeframe: '1d', engineConfig: engineCfg || {},
            minRR: { global: res.meta?.minRRGlobal ?? 0, overrides: res.meta?.minRROverrides ?? {} }, side: res.meta?.side ?? undefined
          };
          // Zip and download with name including cumulative percent
          const files: Record<string, Uint8Array> = {
            [`${s}_bars_${res.runId}.json`]: strToU8(JSON.stringify(barsOut, null, 2)),
            [`${s}_indicators_${res.runId}.json`]: strToU8(JSON.stringify(indicatorsOut, null, 2)),
            [`${s}_trades_${res.runId}.json`]: strToU8(JSON.stringify(tradesOut, null, 2)),
            [`${s}_equity_${res.runId}.json`]: strToU8(JSON.stringify(eq, null, 2)),
            [`${s}_config_${res.runId}.json`]: strToU8(JSON.stringify(configOut, null, 2))
          };
          const zipped = zipSync(files, { level: 6 });
          const pctLabel = `${sumPct >= 0 ? '+' : ''}${sumPct.toFixed(2)}pct`;
          downloadBlobFromBuffer(zipped, 'application/zip', `${s}_${pctLabel}.zip`);
        } catch (err) {
          console.warn('[BatchExport] failed for', s, err);
          // continue with next symbol
        }
      }
    } catch (e:any) {
      setError(e?.message || String(e));
    }
  }

  async function loadChartData(sym: string) {
    try {
      const s = sym.trim().toUpperCase();
      console.log('[Backtests] loadChartData start', { symbol: s });
      const resp = await window.api.getCandlesByInterval(s, '1d');
      const { candles } = resp || {};
  const last1260 = Array.isArray(candles) ? candles.slice(-1260) : [];
  console.log('[Backtests] candles fetched', { total: candles?.length ?? 0, showing: last1260.length, first: last1260[0]?.ts, last: last1260[last1260.length-1]?.ts });
  setCandles(last1260);
      const { overlays } = await window.api.getIndicators(s, '1d');
      console.log('[Backtests] overlays fetched', { ema20: overlays?.ema20?.length, ema50: overlays?.ema50?.length, ema200: overlays?.ema200?.length });
      setOverlays(overlays);
    } catch (e) {
      console.warn('[Backtests] failed to load chart data', e);
      setCandles([]); setOverlays(undefined);
    }
  }

  // Load strategy list (for overrides) on symbol change
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const diag = await (window as any).api.strategiesDiagnostics(symbol);
        if (!mounted) return;
        const ids: string[] = Array.isArray(diag?.strategies) ? diag.strategies.map((s:any)=>s.id) : [];
        ids.sort();
        setStrategyList(ids);
      } catch (e) {
        console.warn('[Backtests] strategiesDiagnostics failed', e);
        setStrategyList([]);
      }
    })();
    return () => { mounted = false; };
  }, [symbol]);

  // Available years from trades (by entry date)
  const yearsAvailable = useMemo(() => {
    const ys = Array.from(new Set(trades.map(t => new Date(t.entry_date).getFullYear())));
    ys.sort((a,b)=>b-a); // newest first
    return ys;
  }, [trades]);

  // Strategy success bars computed from trades, filtered by selected year
  const strategyBars = useMemo(() => {
    const pool = (selectedYear === 'ALL') ? trades : trades.filter(t => new Date(t.entry_date).getFullYear() === selectedYear);
    const by: Record<string, { n: number; w: number }> = {};
    for (const t of pool) {
      const sid = t.strategy_id;
      if (!by[sid]) by[sid] = { n: 0, w: 0 };
      by[sid].n += 1;
      if ((t.r_multiple ?? 0) >= 0 || t.result === 'win') by[sid].w += 1;
    }
    const items = Object.entries(by).map(([id, {n,w}]) => ({ id, trades: n, success: n ? (w/n)*100 : 0 }));
    items.sort((a,b)=>b.success - a.success);
    return items;
  }, [trades, selectedYear]);

  const filteredTrades = useMemo(() => {
    const byYear = (selectedYear === 'ALL') ? trades : trades.filter(t => new Date(t.entry_date).getFullYear() === selectedYear);
    return selectedStrategy ? byYear.filter(t=>t.strategy_id===selectedStrategy) : byYear;
  }, [trades, selectedStrategy, selectedYear]);

  // Group filtered trades by entry year for table sections
  const tradesByYear = useMemo(() => {
    const map = new Map<number, TradeRow[]>();
    for (const t of filteredTrades) {
      const y = new Date(t.entry_date).getFullYear();
      if (!map.has(y)) map.set(y, []);
      map.get(y)!.push(t);
    }
    const entries = Array.from(map.entries());
    entries.sort((a,b)=>a[0]-b[0]); // ascending chronological
    for (const [, arr] of entries) arr.sort((a,b)=>a.seq - b.seq);
    return entries; // [ [year, TradeRow[]], ... ]
  }, [filteredTrades]);

  // Per-year summary: success % and cumulative %
  const perYearStats = useMemo(() => {
    const map = new Map<number, { total: number; wins: number; sumPct: number }>();
    for (const t of trades) {
      const y = new Date(t.entry_date).getFullYear();
      const e = map.get(y) || { total: 0, wins: 0, sumPct: 0 };
      e.total += 1;
      if ((t.r_multiple ?? 0) >= 0 || t.result === 'win') e.wins += 1;
      e.sumPct += (t.pnl_pct ?? 0);
      map.set(y, e);
    }
    const out = Array.from(map.entries()).map(([year, { total, wins, sumPct }]) => ({ year, total, wins, success: total ? (wins/total)*100 : 0, cumPct: sumPct }));
    out.sort((a,b)=>a.year - b.year); // ascending like 2023 then 2024
    return out;
  }, [trades]);

  const tradeOverlays = useMemo(() => filteredTrades.map(t => ({
    seq: t.seq,
    entryIndex: t.entry_index ?? -1,
    exitIndex: t.exit_index ?? -1,
    result: (t.r_multiple ?? 0) >= 0 ? 'win' as const : 'loss' as const,
  })), [filteredTrades]);

  // Separate hovered vs selected trades; overlays use either, zoom only on selected
  const hoveredTrade = useMemo(() => filteredTrades.find(t => t.seq === hoverSeq), [filteredTrades, hoverSeq]);
  const selectedTradeObj = useMemo(() => filteredTrades.find(t => t.seq === selectedSeq), [filteredTrades, selectedSeq]);
  const overlayTrade = hoveredTrade || selectedTradeObj;
  useEffect(() => {
    if (!overlayTrade) { setActiveTrailLevel(null); return; }
    if (overlayTrade.exit_trail_level != null && Number.isFinite(overlayTrade.exit_trail_level)) setActiveTrailLevel(overlayTrade.exit_trail_level);
    else setActiveTrailLevel(null);
  }, [overlayTrade]);

  // Extract support/resistance & checkpoints; fallback to 60-bar percentile if meta missing (overlays for hovered or selected)
  useEffect(() => {
    if (!overlayTrade) { setSupportLevel(undefined); setResistanceLevel(undefined); setCheckpointLevels(undefined); return; }
    const sup = (loadedMeta?.perTrade?.[overlayTrade.seq]?.rcSup);
    const res = (loadedMeta?.perTrade?.[overlayTrade.seq]?.rcRes);
    const chks = (loadedMeta?.perTrade?.[overlayTrade.seq]?.rcCheckpoints);
    let supFinal: number | undefined = Number.isFinite(sup) ? sup : undefined;
    let resFinal: number | undefined = Number.isFinite(res) ? res : undefined;
    let chkFinal: number[] | undefined = Array.isArray(chks) ? chks.filter((v: any) => Number.isFinite(v)).map((v: any) => Number(v)) : undefined;

    // Fallback: derive from candles around entry if missing
    if ((!Number.isFinite(supFinal as any) || !Number.isFinite(resFinal as any)) && candles.length && overlayTrade.entry_index != null && overlayTrade.entry_index >= 0) {
      const end = Math.min(candles.length - 1, overlayTrade.entry_index);
      const start = Math.max(0, end - 60);
      const lows = candles.slice(start, end + 1).map(c => c.low).filter(n => Number.isFinite(n));
      const highs = candles.slice(start, end + 1).map(c => c.high).filter(n => Number.isFinite(n));
      const pct = (arr: number[], p: number) => {
        if (!arr.length) return NaN;
        const s = [...arr].sort((a,b)=>a-b);
        const pos = (s.length - 1) * p;
        const base = Math.floor(pos);
        const frac = pos - base;
        if (s[base+1] != null) return s[base] + frac * (s[base+1] - s[base]);
        return s[base];
      };
      const supGuess = pct(lows, 0.10);
      const resGuess = pct(highs, 0.90);
      if (Number.isFinite(supGuess) && Number.isFinite(resGuess) && resGuess > supGuess) {
        const width = (resGuess - supGuess) / Math.max(1e-9, supGuess);
        if (width <= 0.30) {
          supFinal = supFinal ?? supGuess;
          resFinal = resFinal ?? resGuess;
        }
      }
    }
    if ((!chkFinal || !chkFinal.length) && Number.isFinite(supFinal as any) && Number.isFinite(resFinal as any) && (resFinal as number) > (supFinal as number)) {
      const range = (resFinal as number) - (supFinal as number);
      chkFinal = [0.25, 0.5, 0.75, 1.0].map(p => (supFinal as number) + range * p);
    }
    setSupportLevel(supFinal);
    setResistanceLevel(resFinal);
    setCheckpointLevels(chkFinal);
  }, [overlayTrade, loadedMeta, candles]);

  // Zoom only on explicit selection (not hover): center +/-10 trading days
  useEffect(() => {
    if (!selectedTradeObj) return;
    if (selectedTradeObj.entry_index == null || selectedTradeObj.exit_index == null) return;
    const entryIdx = selectedTradeObj.entry_index;
    const exitIdx = selectedTradeObj.exit_index;
    if (entryIdx < 0 || exitIdx < 0 || candles.length < 1) return;
    const fromIdx = Math.max(0, entryIdx - 10);
    const toIdx = Math.min(candles.length - 1, exitIdx + 10);
    const fromMs = candles[fromIdx].ts;
    const toMs = candles[toIdx].ts;
    setControlledRange({ fromMs, toMs });
    // Scroll details panel into view (best-effort)
    const el = document.querySelector('.bt-table-wrap');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedTradeObj, candles]);

  return (
    <div style={{ padding:16, display:'flex', flexDirection:'column', gap:16 }}>
  <h2>Backtests — 5Y Daily (single position)</h2>
      <div className="bt-controls">
        <label style={{ fontSize:12 }}>Ticker
          <input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} style={{ display:'block', marginTop:4, width:140 }}/>
        </label>
        <label style={{ fontSize:12 }}>Min R:R to start
          <input type="number" step={0.1} min={0} max={5} value={minRRGlobal}
            onChange={e=> setMinRRGlobal(Math.min(5, Math.max(0, Number(e.target.value))))}
            title="Trades will only be entered if the initial plan’s R:R meets or exceeds this value."
            style={{ display:'block', marginTop:4, width:120 }} />
        </label>
        <label style={{ fontSize:12 }}>Side
          <select value={sideFilter} onChange={e=> setSideFilter(e.target.value as any)} style={{ display:'block', marginTop:4, width:120 }} title="Filter entries by side">
            <option value="BOTH">Both</option>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
        </label>
        <button onClick={()=>setShowAdvanced(s=>!s)} style={{ alignSelf:'center' }}>{showAdvanced ? 'Hide' : 'Advanced'} overrides</button>
        <button onClick={runNow} disabled={loading}>
          {loading ? 'Running…' : 'Run'}
        </button>
        <button onClick={loadLatest} disabled={loading}>Use Last Result</button>
  <button onClick={exportArtifacts} disabled={!summary || !trades?.length} title="Export bars, indicators, trades, equity, and config as separate JSON files">Export</button>
    <button onClick={batchExportBestSignals} disabled={loading} title="Run and export all symbols from the 'BEST SIGNALS' watchlist">Batch: BEST SIGNALS</button>
        <div style={{ fontSize:12, opacity:0.7 }}>
          {lastRunAt ? `Last loaded: ${new Date(lastRunAt).toLocaleString()}` : 'No result loaded'}
        </div>
      </div>
      {/* Advanced: per-strategy overrides */}
      {showAdvanced && (
        <div style={{ border:'1px solid #eee', padding:8, borderRadius:6 }}>
          <div style={{ fontWeight:600, marginBottom:6 }}>Per-strategy overrides (blank = use global)</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:8 }}>
            {strategyList.map(id => (
              <div key={id} style={{ display:'flex', gap:6, alignItems:'center' }}>
                <div style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis' }} title={id}>{id}</div>
                <input type="number" step={0.1} min={0} max={5}
                  placeholder="-"
                  value={minRROverrides[id] ?? ''}
                  onChange={e=> setMinRROverrides(prev => ({ ...prev, [id]: e.target.value }))}
                  style={{ width:70 }}/>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Result badge and mismatch note */}
      {loadedMeta && (
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <span className="bt-badge">
            Min R:R: {Number(loadedMeta.minRRGlobal ?? 0).toFixed(1)} (overrides applied to {loadedMeta.overridesCount ?? 0} strategies)
          </span>
          {(() => {
            const cleaned: Record<string, number> = {};
            for (const [k, v] of Object.entries(minRROverrides)) {
              const n = Number(v);
              if (Number.isFinite(n) && n >= 0) cleaned[k] = Math.min(5, Math.max(0, Number((Math.round(n*10)/10).toFixed(1))));
            }
            const sameGlobal = Number(loadedMeta.minRRGlobal ?? 0) === Number(minRRGlobal ?? 0);
            const saved = loadedMeta.minRROverrides || {};
            const sameKeys = Object.keys(saved).length === Object.keys(cleaned).length && Object.keys(saved).every(k => cleaned[k] === saved[k]);
            const mismatch = !(sameGlobal && sameKeys);
            return mismatch ? (
              <span className="bt-badge warn">
                Results use Min R:R = {Number(loadedMeta.minRRGlobal ?? 0).toFixed(1)}; press Run to recompute with current controls.
              </span>
            ) : null;
          })()}
        </div>
      )}
      {error && (
        <div style={{ background:'#fee', color:'#900', padding:8, border:'1px solid #f99' }}>
          {error} <button onClick={()=>setError(null)} style={{ marginLeft:12 }}>Dismiss</button>
        </div>
      )}

      {!summary && !loading && (
        <div style={{ opacity:0.7 }}>Empty state: Run a backtest to see results.</div>
      )}
      {summary && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <h3>Success Rate by Strategy</h3>
              <label style={{ fontSize:12 }}>Year
                <select value={String(selectedYear)} onChange={e=> setSelectedYear(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))} style={{ display:'block', marginTop:4, width:120 }}>
                  <option value="ALL">All</option>
                  {yearsAvailable.map(y => (<option key={y} value={String(y)}>{y}</option>))}
                </select>
              </label>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {strategyBars.map(b => (
                <div key={b.id} style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }} onClick={()=> setSelectedStrategy(s => s===b.id ? null : b.id)}>
                  <div style={{ width:140, fontSize:12, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }} title={b.id}>{b.id}</div>
                  <div style={{ flex:1, background:'#eee', height:12, position:'relative' }}>
                    <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${Math.min(100, Math.max(0, b.success))}%`, background:'#4caf50' }}></div>
                  </div>
                  <div style={{ width:80, textAlign:'right', fontSize:12 }}>{b.success.toFixed(1)}%</div>
                  <div style={{ width:60, textAlign:'right', fontSize:12 }}>n={b.trades}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3>Daily Chart</h3>
            <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:4 }}>
              <label style={{ fontSize:11, display:'flex', gap:4, alignItems:'center' }}>
                <input type="checkbox" checked={showRanges} onChange={e=> setShowRanges(e.target.checked)} /> Ranges
              </label>
              <label style={{ fontSize:11, display:'flex', gap:4, alignItems:'center' }}>
                <input type="checkbox" checked={showTrailing} onChange={e=> setShowTrailing(e.target.checked)} /> Trailing
              </label>
              {selectedTradeObj && (
                <span style={{ fontSize:11, opacity:0.7 }}>Trade #{selectedTradeObj.seq} zoomed</span>
              )}
            </div>
            <div className="chart-wrap" style={{ height:300 }}>
              <Chart
                candles={candles}
                overlays={overlays}
                trades={tradeOverlays}
                highlightSeq={hoverSeq ?? selectedSeq}
                onHoverTradeSeq={setHoverSeq}
                support={supportLevel}
                resistance={resistanceLevel}
                checkpoints={checkpointLevels}
                activeTrail={activeTrailLevel}
                showRanges={showRanges}
                showTrailing={showTrailing}
                visibleTimeRange={controlledRange}
              />
            </div>
            {/* Per-year and overall summaries below the chart */}
            <div className="bt-year-stats" style={{ fontSize:13 }}>
              {/* Per-year breakdown */}
              {perYearStats.map(s => (
                <div key={s.year} className="bt-year-stat">
                  <div className="year">{s.year}</div>
                  <div><strong>Success rate:</strong> {s.success.toFixed(1)}%</div>
                  <div><strong>Cumulative % profit:</strong> {s.cumPct.toFixed(2)}%</div>
                </div>
              ))}
              {/* Overall */}
              {(() => {
                const total = trades.length;
                const wins = trades.filter(t => (t.r_multiple ?? 0) >= 0 || t.result === 'win').length;
                const success = total ? (wins / total) * 100 : 0;
                const sumPct = trades.reduce((acc, t) => acc + (t.pnl_pct ?? 0), 0);
                return (
                  <div className="bt-year-stat">
                    <div className="year">All</div>
                    <div><strong>Success rate:</strong> {success.toFixed(1)}%</div>
                    <div><strong>Cumulative % profit:</strong> {sumPct.toFixed(2)}%</div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      {summary && (
        <div>
          <h3>Trades</h3>
          <div className="bt-table-wrap">
          <table className="bt-table">
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th>Seq</th>
                <th>Open Date</th>
                <th>Strategy</th>
                <th className="num">Entry</th>
                <th className="num">Stop</th>
                <th className="num">Target</th>
                <th>Exit Date</th>
                <th>Exit Reason</th>
                <th className="num">R</th>
                <th className="num">%</th>
                <th className="num">Days</th>
                <th className="num">Conf</th>
                <th className="num">MAE</th>
                <th className="num">MFE</th>
              </tr>
            </thead>
            <tbody>
              {tradesByYear.map(([year, arr]) => (
                <Fragment key={year}>
                  <tr className="year-row">
                    <td colSpan={14}>{year}</td>
                  </tr>
                  {arr.map(t => {
                    const selected = (selectedStrategy && t.strategy_id===selectedStrategy) || (hoverSeq===t.seq) || (selectedSeq===t.seq);
                    return (
                      <tr
                        key={t.seq}
                        className={`clickable${selected ? ' selected' : ''}`}
                        onMouseEnter={() => setHoverSeq(t.seq)}
                        onMouseLeave={() => setHoverSeq(s => s===t.seq ? null : s)}
                        onClick={() => setSelectedSeq(s => s===t.seq ? null : t.seq)}
                      >
                        <td>{t.seq}</td>
                        <td>{new Date(t.entry_date).toLocaleDateString()}</td>
                        <td className="mono">{t.strategy_id}</td>
                        <td className="num">{t.entry_price.toFixed(2)}</td>
                        <td className="num">{t.stop_at_entry.toFixed(2)}</td>
                        <td className="num">{t.target_at_entry.toFixed(2)}</td>
                        <td>{new Date(t.exit_date).toLocaleDateString()}</td>
                        <td>{t.exit_reason}</td>
                        <td className={`num ${t.r_multiple >= 0 ? 'pos' : 'neg'}`}>{t.r_multiple.toFixed(2)}</td>
                        <td className={`num ${(t.pnl_pct ?? 0) >= 0 ? 'pos' : 'neg'}`}>{t.pnl_pct != null ? t.pnl_pct.toFixed(2) + '%' : '-'}</td>
                        <td className="num">{t.days_held}</td>
                        <td className="num">{t.confidence ? Math.round(t.confidence) : '-'}</td>
                        <td className="num">{t.mae_r != null ? t.mae_r.toFixed(2) : '-'}</td>
                        <td className="num">{t.mfe_r != null ? t.mfe_r.toFixed(2) : '-'}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
          {selectedSeq != null && (
            (() => {
              const st = filteredTrades.find(t => t.seq === selectedSeq);
              if (!st) return null;
              return (
                <div style={{ marginTop:12, border:'1px solid #eee', padding:12, borderRadius:6 }}>
                  <div style={{ fontWeight:600, marginBottom:8 }}>Trade Details #{st.seq}</div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:8, fontSize:13 }}>
                    <div><strong>R Multiple:</strong> {st.r_multiple.toFixed(2)}</div>
                    <div><strong>% PnL:</strong> {st.pnl_pct != null ? st.pnl_pct.toFixed(2) + '%' : '-'}</div>
                    <div><strong>MAE:</strong> {st.mae_r != null ? st.mae_r.toFixed(2) : '-'}</div>
                    <div><strong>MFE:</strong> {st.mfe_r != null ? st.mfe_r.toFixed(2) : '-'}</div>
                    <div><strong>Trail Used:</strong> {st.trail_used ? 'Yes' : 'No'}</div>
                    <div><strong>Exit Trail:</strong> {st.exit_trail_level != null ? st.exit_trail_level.toFixed(2) : '-'}</div>
                    <div><strong>Time Stop:</strong> {st.time_stop_days ?? '-'}</div>
                    <div><strong>Exit Reason:</strong> {st.exit_reason}</div>
                    <div><strong>Strategy:</strong> {st.strategy_id}</div>
                    <div><strong>Confidence:</strong> {st.confidence != null ? Math.round(st.confidence) : '-'}</div>
                  </div>
                  {st.reasons && (
                    <div style={{ marginTop:8 }}>
                      <div style={{ fontWeight:600 }}>Reasons</div>
                      <pre style={{ whiteSpace:'pre-wrap', margin:0 }}>{st.reasons}</pre>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
}

