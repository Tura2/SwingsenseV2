import { useEffect, useMemo, useRef } from "react";
import { createChart, LineStyle, UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@shared/types";

type TradeOverlay = { seq: number; entryIndex: number; exitIndex: number; result: 'win'|'loss'; side?: 'long'|'short' };

export default function Chart({ candles, overlays, trades, highlightSeq, onHoverTradeSeq, allowInteraction = true, visibleTimeRange, onVisibleTimeRangeChange, yRange, autoScaleY = true, support, resistance, checkpoints, activeTrail, showRanges = true, showTrailing = true }: {
  candles: Candle[];
  overlays?: { ema20?: number[]; ema50?: number[]; ema200?: number[] };
  trades?: TradeOverlay[];
  highlightSeq?: number | null;
  onHoverTradeSeq?: (seq: number | null) => void;
  // Enable user zoom/pan interactions
  allowInteraction?: boolean;
  // Programmatic X control (ms-based epoch). If provided, component will treat X range as controlled.
  visibleTimeRange?: { fromMs: number; toMs: number } | undefined;
  onVisibleTimeRangeChange?: (r: { fromMs: number; toMs: number }) => void;
  // Programmatic Y control. If provided with autoScaleY=false, force this Y range.
  yRange?: { min: number; max: number } | undefined;
  autoScaleY?: boolean;
  // Overlay levels for ranges and trailing
  support?: number | undefined;
  resistance?: number | undefined;
  checkpoints?: number[] | undefined;
  activeTrail?: number | null | undefined;
  showRanges?: boolean;
  showTrailing?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candleSeriesRef = useRef<ReturnType<ReturnType<typeof createChart>["addCandlestickSeries"]> | null>(null);
  const overlaySeriesRef = useRef<{ ema20?: any; ema50?: any; ema200?: any }>({});
  const priceLinesRef = useRef<{ support?: any; resistance?: any; checkpoints: any[]; trail?: any }>({ checkpoints: [] });
  const tradeSeriesRef = useRef<Map<number, any>>(new Map());
  const displayedSeqsRef = useRef<Set<number>>(new Set());
  const candlesRef = useRef<Candle[]>([]);
  const tradesRef = useRef<TradeOverlay[]>([]);
  const DEBUG = false;
  const VERBOSE_HOVER = false;
  const lastActionRef = useRef<string>("init");
  const lastSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const roTimerRef = useRef<number | null>(null);
  const timeRangeSubInstalledRef = useRef<boolean>(false);
  const fromVisibleRangePropRef = useRef<boolean>(false);

  const audit = (label: string) => {
    if (!DEBUG) return;
    const chart = chartRef.current;
    const arr = candlesRef.current;
    if (!chart || !arr.length) { console.log('[Chart][AUDIT]', label, { chart: !!chart, candles: arr.length }); return; }
    const ts = chart.timeScale();
    const vr = (ts as any).getVisibleRange?.();
    const lr = (ts as any).getVisibleLogicalRange?.();
    const firstTs = arr[0]?.ts;
    const lastTs = arr[arr.length - 1]?.ts;
    const info = {
      label,
      candles: arr.length,
      firstTs,
      lastTs,
      visRange: vr ? { from: (vr as any).from, to: (vr as any).to } : null,
      visLogical: lr ? { from: (lr as any).from, to: (lr as any).to } : null,
      lastAction: lastActionRef.current,
      timeScaleOptions: (ts as any)?.options?.() ?? undefined,
      containerSize: lastSizeRef.current
    };
    console.log('[Chart][AUDIT]', info);
    // Drift detection
    if (lr && typeof lr.to === 'number') {
      const maxIdx = arr.length - 1;
      if (lr.to > maxIdx + 2) {
        console.warn('[Chart][DRIFT] Logical to beyond last index', { lrTo: lr.to, maxIdx, overBy: lr.to - maxIdx, lastAction: lastActionRef.current });
      }
    }
    if (vr && (vr as any).to) {
      const lastSec = Math.floor(lastTs / 1000);
      const toSec = (vr as any).to as number;
      if (toSec > lastSec + 86400) {
        console.warn('[Chart][DRIFT] Visible time to beyond last candle time', { toSec, lastSec, overByDays: (toSec - lastSec) / 86400, lastAction: lastActionRef.current });
      }
    }
  };

  const freezeRange = (chart: ReturnType<typeof createChart>, candlesArr: Candle[]) => {
    if (DEBUG) console.log('[Chart] freezeRange() start');
    if (!candlesArr.length) return;
    // If consumer provided a controlled time range, use it exclusively
    if (visibleTimeRange && Number.isFinite(visibleTimeRange.fromMs) && Number.isFinite(visibleTimeRange.toMs)) {
      const from = Math.floor(visibleTimeRange.fromMs / 1000) as any;
      const to = Math.floor(visibleTimeRange.toMs / 1000) as any;
      const cur = (chart.timeScale() as any).getVisibleRange?.();
      const same = cur && Math.abs((cur as any).from - from) <= 1 && Math.abs((cur as any).to - to) <= 1;
      if (!same) {
        chart.timeScale().setVisibleRange({ from, to });
        lastActionRef.current = 'freezeRange:propVisibleRange';
      } else {
        lastActionRef.current = 'freezeRange:propSkipNoChange';
      }
      chart.timeScale().applyOptions({ rightOffset: 0 });
      audit('after freezeRange');
      return;
    }
    // If user interactions are allowed and no controlled prop is provided, do not force X range
    if (allowInteraction) {
      lastActionRef.current = 'freezeRange:skippedDueToAllowInteraction';
      audit('after freezeRange');
      return;
    }
    const seriesData = candlesArr.map(c => ({ time: (Math.floor(c.ts/1000) as unknown as UTCTimestamp) }));
    const firstTime = seriesData[0]?.time as any; const lastTime = seriesData[seriesData.length-1]?.time as any;
    try {
      if (firstTime && lastTime && firstTime !== lastTime) {
        // Guard: skip if already in desired range (±1s tolerance)
        const cur = (chart.timeScale() as any).getVisibleRange?.();
        const same = cur && Math.abs((cur as any).from - firstTime) <= 1 && Math.abs((cur as any).to - lastTime) <= 1;
        if (!same) {
          chart.timeScale().setVisibleRange({ from: firstTime, to: lastTime });
          lastActionRef.current = 'freezeRange:setVisibleRange';
        } else {
          lastActionRef.current = 'freezeRange:skipNoChange';
        }
  // Avoid fighting logical range; visible range is enough for fixed window.
  chart.timeScale().applyOptions({ rightOffset: 0 });
  // Avoid scrollToPosition side-effects; range is already set.
        audit('after freezeRange');
      }
    } catch {}
  };

  // Create chart once on mount
  useEffect(() => {
    if (!ref.current) { if (DEBUG) console.warn('[Chart] ref missing'); return; }
    const initialWidth = ref.current.clientWidth || 600;
    const initialHeight = Math.max(0, (ref.current.clientHeight || 300) - 8);
    const chart = createChart(ref.current, {
      width: initialWidth,
      height: initialHeight,
      layout: { background: { color: '#111' }, textColor: '#bbb' },
      rightPriceScale: { borderColor: '#333', autoScale: autoScaleY },
      handleScroll: { mouseWheel: allowInteraction, pressedMouseMove: allowInteraction, horzTouchDrag: allowInteraction, vertTouchDrag: allowInteraction },
      handleScale: { axisPressedMouseMove: allowInteraction, mouseWheel: allowInteraction, pinch: allowInteraction },
      timeScale: { borderColor: '#333', fixLeftEdge: !allowInteraction, fixRightEdge: !allowInteraction, lockVisibleTimeRangeOnResize: true, rightOffset: 0, rightBarStaysOnScroll: allowInteraction }
    });
    chartRef.current = chart;
    const candleSeries = chart.addCandlestickSeries();
    candleSeriesRef.current = candleSeries;
    if (DEBUG) console.log('[Chart] chart created');
    audit('after createChart');

    const ro = new ResizeObserver(() => {
      const el = ref.current!;
      const w = el.clientWidth;
      const h = Math.max(0, el.clientHeight - 8);
      // Bail if no meaningful change
      if (w === lastSizeRef.current.w && h === lastSizeRef.current.h) return;
      lastSizeRef.current = { w, h };
      if (roTimerRef.current) {
        window.clearTimeout(roTimerRef.current);
        roTimerRef.current = null;
      }
      roTimerRef.current = window.setTimeout(() => {
        if (DEBUG) console.log('[Chart] ResizeObserver');
        // Guard: skip if chart was unmounted between schedule and fire
        if (!chartRef.current) return;
        chart.applyOptions({ width: w, height: h });
        lastActionRef.current = 'resize:applyOptions';
        // Only enforce range on resize if interactions are locked or time range is controlled
        freezeRange(chart, candlesRef.current);
      }, 100);
    });
    ro.observe(ref.current);

    // Crosshair hover with proximity filter
    const onMove = (param: any) => {
      if (!onHoverTradeSeq) return;
      if (VERBOSE_HOVER) {
        const now = Date.now();
        (onMove as any)._last = (onMove as any)._last ?? 0;
        if (now - (onMove as any)._last > 200) { (onMove as any)._last = now; console.log('[Chart] onMove start', { time: param?.time }); }
      }
      const t = param?.time; if (!t) { onHoverTradeSeq(null); return; }
      // Map time to index via binary search on candlesRef
      const arr = candlesRef.current; if (!arr.length) { onHoverTradeSeq(null); return; }
      const ts = (t as number) * 1000;
      let lo = 0, hi = arr.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; const v = arr[mid].ts; if (v === ts) { idx = mid; break; } if (v < ts) lo = mid + 1; else hi = mid - 1; }
      if (idx < 0) idx = Math.max(0, Math.min(arr.length - 1, lo));
      const price = (param?.seriesPrices && candleSeriesRef.current) ? param.seriesPrices.get(candleSeriesRef.current) : undefined;
      let found: number | null = null;
      const list = tradesRef.current;
      for (const tr of list) {
        if (idx < tr.entryIndex || idx > tr.exitIndex) continue;
        if (price != null) {
          // Proximity check to segment
          const c0 = arr[tr.entryIndex].close; const c1 = arr[tr.exitIndex].close;
          const x0 = tr.entryIndex, x1 = tr.exitIndex; const x = idx;
          const line = c0 + (c1 - c0) * ((x - x0) / Math.max(1, (x1 - x0)));
          const eps = Math.max(0.005 * line, (arr[idx].high - arr[idx].low) * 0.25);
          if (Math.abs((price as number) - line) > eps) continue;
        }
        found = tr.seq; break;
      }
      if (VERBOSE_HOVER) console.log('[Chart] onMove result', { idx, found });
      onHoverTradeSeq(found);
    };
    chart.subscribeCrosshairMove(onMove);

    // Subscribe to visible time range changes to surface to parent and track user control
    const onTimeRangeChange = (r: any) => {
      if (!r) return;
      if (onVisibleTimeRangeChange) {
        const fromMs = Math.floor((r.from ?? 0) * 1000);
        const toMs = Math.floor((r.to ?? 0) * 1000);
        onVisibleTimeRangeChange({ fromMs, toMs });
      }
    };
    try {
      (chart.timeScale() as any).subscribeVisibleTimeRangeChange?.(onTimeRangeChange);
      timeRangeSubInstalledRef.current = true;
    } catch {}

    return () => {
      try { chart.unsubscribeCrosshairMove(onMove); } catch {}
      ro.disconnect();
      if (roTimerRef.current) { window.clearTimeout(roTimerRef.current); roTimerRef.current = null; }
      try { if (timeRangeSubInstalledRef.current) (chart.timeScale() as any).unsubscribeVisibleTimeRangeChange?.(onTimeRangeChange); } catch {}
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      overlaySeriesRef.current = {};
      tradeSeriesRef.current.clear();
      displayedSeqsRef.current.clear();
    };
  }, []);

  // Update candles without re-init
  useEffect(() => {
    candlesRef.current = candles;
    const chart = chartRef.current; const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries || candles.length < 1) return;
    if (DEBUG) console.log('[Chart] setData start', { points: candles.length, first: candles[0]?.ts, last: candles[candles.length - 1]?.ts });
    const data = candles.map(c => ({ time: (Math.floor(c.ts/1000) as unknown as UTCTimestamp), open: c.open, high: c.high, low: c.low, close: c.close }));
    candleSeries.setData(data);
    lastActionRef.current = 'candles:setData';
    audit('after setData');
    freezeRange(chart, candles);
  }, [candles]);

  // React to allowInteraction changes and controlled visibleTimeRange updates
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    chart.applyOptions({
      handleScroll: { mouseWheel: allowInteraction, pressedMouseMove: allowInteraction, horzTouchDrag: allowInteraction, vertTouchDrag: allowInteraction },
      handleScale: { axisPressedMouseMove: allowInteraction, mouseWheel: allowInteraction, pinch: allowInteraction },
      timeScale: { rightBarStaysOnScroll: allowInteraction, fixLeftEdge: !allowInteraction, fixRightEdge: !allowInteraction }
    } as any);
    // If a controlled range is provided, apply it immediately
    if (visibleTimeRange) {
      const from = Math.floor(visibleTimeRange.fromMs / 1000) as any;
      const to = Math.floor(visibleTimeRange.toMs / 1000) as any;
      try { chart.timeScale().setVisibleRange({ from, to }); lastActionRef.current = 'prop:applyVisibleTimeRange'; audit('after prop visibleTimeRange'); } catch {}
    }
  }, [allowInteraction, visibleTimeRange?.fromMs, visibleTimeRange?.toMs]);

  // Y-axis programmatic control
  useEffect(() => {
    const series = candleSeriesRef.current; const chart = chartRef.current; if (!series || !chart) return;
    try { chart.applyOptions({ rightPriceScale: { autoScale: autoScaleY } } as any); } catch {}
    if (!autoScaleY && yRange && Number.isFinite(yRange.min) && Number.isFinite(yRange.max)) {
      try { (series as any).setAutoscaleInfoProvider?.(() => ({ priceRange: { minValue: yRange.min, maxValue: yRange.max } })); lastActionRef.current = 'yRange:fixed'; audit('after yRange fixed'); } catch {}
    } else {
      try { (series as any).setAutoscaleInfoProvider?.(null); lastActionRef.current = 'yRange:auto'; audit('after yRange auto'); } catch {}
    }
  }, [autoScaleY, yRange?.min, yRange?.max]);

  // Overlays updater (no chart re-init)
  useEffect(() => {
    const chart = chartRef.current; const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries || candles.length < 1) return;
    if (DEBUG) console.log('[Chart] overlays update start', { ema20: overlays?.ema20?.length, ema50: overlays?.ema50?.length, ema200: overlays?.ema200?.length, candles: candles.length });
    const mk = (i: number) => (Math.floor(candles[i].ts/1000) as unknown as UTCTimestamp);
    // EMA20
    if (overlays?.ema20 && overlays.ema20.length === candles.length) {
      if (!overlaySeriesRef.current.ema20) overlaySeriesRef.current.ema20 = chart.addLineSeries({ lineWidth: 1, color: '#00C2A8' });
      overlaySeriesRef.current.ema20.setData(candles.map((c, i) => ({ time: mk(i), value: overlays.ema20![i] })));
    } else if (overlaySeriesRef.current.ema20) { try { chart.removeSeries(overlaySeriesRef.current.ema20); } catch {}; overlaySeriesRef.current.ema20 = undefined; }
    // EMA50
    if (overlays?.ema50 && overlays.ema50.length === candles.length) {
      if (!overlaySeriesRef.current.ema50) overlaySeriesRef.current.ema50 = chart.addLineSeries({ lineWidth: 1, color: '#FFA24C' });
      overlaySeriesRef.current.ema50.setData(candles.map((c, i) => ({ time: mk(i), value: overlays.ema50![i] })));
    } else if (overlaySeriesRef.current.ema50) { try { chart.removeSeries(overlaySeriesRef.current.ema50); } catch {}; overlaySeriesRef.current.ema50 = undefined; }
    // EMA200
    if (overlays?.ema200 && overlays.ema200.length === candles.length) {
      if (!overlaySeriesRef.current.ema200) overlaySeriesRef.current.ema200 = chart.addLineSeries({ lineWidth: 1, color: '#A971FF' });
      overlaySeriesRef.current.ema200.setData(candles.map((c, i) => ({ time: mk(i), value: overlays.ema200![i] })));
    } else if (overlaySeriesRef.current.ema200) { try { chart.removeSeries(overlaySeriesRef.current.ema200); } catch {}; overlaySeriesRef.current.ema200 = undefined; }
    lastActionRef.current = 'overlays:update';
    audit('after overlays update');
  }, [candles, overlays?.ema20?.length, overlays?.ema50?.length, overlays?.ema200?.length]);

  // Trades updater (no chart re-init)
  useEffect(() => {
    const chart = chartRef.current; const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries || candles.length < 1) return;
    if (DEBUG) console.log('[Chart] trades update start', { trades: trades?.length ?? 0, candles: candles.length });
    const mk = (idx: number) => (Math.floor(candles[idx]?.ts / 1000) as unknown as UTCTimestamp);
    tradesRef.current = Array.isArray(trades) ? trades : [];
    // Virtualize: render only trades overlapping current visible logical range (or all if not available)
    const updateVisibleTrades = () => {
      if (DEBUG) console.log('[Chart] updateVisibleTrades start');
      const lr = (chart.timeScale() as any).getVisibleLogicalRange?.();
      const fromIdx = Math.max(0, Math.floor((lr?.from ?? 0)));
      const toIdx = Math.min(candles.length - 1, Math.ceil((lr?.to ?? candles.length - 1)));
      const shouldShow = new Set<number>();
      for (const t of tradesRef.current) {
        if (t.entryIndex > toIdx || t.exitIndex < fromIdx) continue; // no overlap
        shouldShow.add(t.seq);
      }
      // Remove series not needed
      for (const [seq, s] of tradeSeriesRef.current.entries()) {
        if (!shouldShow.has(seq)) { try { chart.removeSeries(s); } catch {}; tradeSeriesRef.current.delete(seq); displayedSeqsRef.current.delete(seq); }
      }
      // Add/update needed series
      const markers: Array<{ time: UTCTimestamp; position: 'aboveBar'|'belowBar'; color: string; shape: 'circle'|'square'|'arrowUp'|'arrowDown'; text: string }> = [];
      for (const t of tradesRef.current) {
        if (!shouldShow.has(t.seq)) continue;
        if (t.entryIndex < 0 || t.exitIndex < 0 || t.entryIndex >= candles.length || t.exitIndex >= candles.length) continue;
        const color = t.result === 'win' ? '#4caf50' : '#f44336';
        let s = tradeSeriesRef.current.get(t.seq);
        if (!s) {
          s = chart.addLineSeries({ color, lineWidth: 1, priceScaleId: 'right' });
          tradeSeriesRef.current.set(t.seq, s);
        } else {
          try { s.applyOptions({ color }); } catch {}
        }
        const p1 = { time: mk(t.entryIndex), value: candles[t.entryIndex].close };
        const p2 = { time: mk(t.exitIndex), value: candles[t.exitIndex].close };
        try { s.setData([p1, p2]); } catch {}
        const entryPos = t.side === 'short' ? 'aboveBar' : 'belowBar';
        const exitPos = t.side === 'short' ? 'belowBar' : 'aboveBar';
        markers.push({ time: mk(t.entryIndex), position: entryPos as any, color: '#2196f3', shape: 'arrowUp', text: `#${t.seq}` });
        markers.push({ time: mk(t.exitIndex), position: exitPos as any, color, shape: 'arrowDown', text: t.result === 'win' ? '✓' : '×' });
        displayedSeqsRef.current.add(t.seq);
      }
      try { candleSeries.setMarkers(markers); } catch {}
      lastActionRef.current = 'trades:updateVisibleTrades';
      audit('after updateVisibleTrades');
    };
    // Initial draw and subscribe to window changes
    updateVisibleTrades();
    let lastRangeTick = 0;
    const onRangeChange = () => {
      const now = Date.now();
      if (now - lastRangeTick < 100) return; // throttle
      lastRangeTick = now;
      updateVisibleTrades();
    };
    const hasSub = (chart.timeScale() as any).subscribeVisibleLogicalRangeChange;
    if (hasSub) { try { (chart.timeScale() as any).subscribeVisibleLogicalRangeChange(onRangeChange); } catch {} }
    return () => { try { if ((chart.timeScale() as any).unsubscribeVisibleLogicalRangeChange) (chart.timeScale() as any).unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch {} };
  }, [candles, trades]);

  // Update highlight without re-creating chart
  useEffect(() => {
    const m = tradeSeriesRef.current;
    if (!m || m.size === 0) return;
    for (const [seq, series] of m.entries()) {
      try { (series as any).applyOptions({ lineWidth: (highlightSeq && highlightSeq === seq) ? 3 : 1 }); } catch {}
    }
  }, [highlightSeq]);

  // Support/Resistance/Checkpoint/Trail price lines updater
  useEffect(() => {
    const chart = chartRef.current; const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) return;
    const removeAll = () => {
      const pl = priceLinesRef.current;
      try { if (pl.support) candleSeries.removePriceLine(pl.support); } catch {}
      try { if (pl.resistance) candleSeries.removePriceLine(pl.resistance); } catch {}
      for (const l of pl.checkpoints) { try { candleSeries.removePriceLine(l); } catch {} }
      try { if (pl.trail) candleSeries.removePriceLine(pl.trail); } catch {}
      priceLinesRef.current = { checkpoints: [] } as any;
    };
    // If no overlays requested, clear and exit
    const hasAny = (showRanges && (Number.isFinite(support) || Number.isFinite(resistance) || (checkpoints && checkpoints.length))) || (showTrailing && Number.isFinite(activeTrail as any));
    if (!hasAny) { removeAll(); return; }
    // Clean existing lines before drawing new
    removeAll();
    const range = (Number.isFinite(resistance as any) && Number.isFinite(support as any)) ? Math.max(0, (resistance as number) - (support as number)) : undefined;
    // Draw Support/Resistance
    if (showRanges && Number.isFinite(support)) {
      try {
        const s = candleSeries.createPriceLine({ price: support as number, color: '#2ecc71', lineStyle: LineStyle.Dashed, lineWidth: 1, title: 'Support' });
        priceLinesRef.current.support = s;
      } catch {}
    }
    if (showRanges && Number.isFinite(resistance)) {
      try {
        const r = candleSeries.createPriceLine({ price: resistance as number, color: '#e74c3c', lineStyle: LineStyle.Dashed, lineWidth: 1, title: 'Resistance' });
        priceLinesRef.current.resistance = r;
      } catch {}
    }
    // Draw checkpoints with fading below activeTrail
    if (showRanges && Array.isArray(checkpoints) && checkpoints.length) {
      const cps: any[] = [];
      const active = Number.isFinite(activeTrail as any) ? (activeTrail as number) : null;
      for (const lvl of checkpoints) {
        if (!Number.isFinite(lvl)) continue;
        const faded = active != null && lvl <= active;
        // Compute label percent if possible
        let title = 'Checkpoint';
        if (range && Number.isFinite(support as any)) {
          const pct = range > 0 ? ((lvl - (support as number)) / range) : 0;
          const pctLabel = Math.round(pct * 100);
          title = `Checkpoint +${pctLabel}%`;
        }
        try {
          const line = candleSeries.createPriceLine({ price: lvl, color: faded ? 'rgba(255,165,0,0.35)' : 'rgba(255,165,0,0.65)', lineStyle: LineStyle.Dashed, lineWidth: 1, title });
          cps.push(line);
        } catch {}
      }
      priceLinesRef.current.checkpoints = cps;
    }
    // Draw active trailing stop as thicker red line
    if (showTrailing && Number.isFinite(activeTrail as any)) {
      try {
        const t = candleSeries.createPriceLine({ price: activeTrail as number, color: '#ff5252', lineStyle: LineStyle.Solid, lineWidth: 2, title: 'Trailing stop' });
        priceLinesRef.current.trail = t;
      } catch {}
    }
    lastActionRef.current = 'overlays:priceLines';
    audit('after overlays:priceLines');
  }, [support, resistance, checkpoints?.length, activeTrail, showRanges, showTrailing]);

  return <div className="chart-wrap" ref={ref} style={{ width: '100%', height: '100%', maxWidth: '100%', overflow: 'hidden', boxSizing: 'border-box', contain: 'layout paint size' }} />;
}
