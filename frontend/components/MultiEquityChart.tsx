import { useEffect, useRef } from 'react';
import { createChart, UTCTimestamp, type LineWidth } from 'lightweight-charts';

export type LinePoint = { ts: number; value: number };

export type LineSeriesSpec = {
  id: string;
  name: string;
  color: string;
  lineStyle?: 0 | 1 | 2 | 3;
  width?: LineWidth;
  points: LinePoint[];
};

export default function MultiEquityChart({ series }: { series: LineSeriesSpec[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<Record<string, any>>({});

  useEffect(() => {
    if (!ref.current) return;

    const w = ref.current.clientWidth || 600;
    const h = Math.max(220, ref.current.clientHeight || 280);

    const chart = createChart(ref.current, {
      width: w,
      height: h,
      layout: { background: { color: '#111' }, textColor: '#bbb' },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333' },
      grid: { vertLines: { color: '#1b1b1b' }, horzLines: { color: '#1b1b1b' } },
      crosshair: { vertLine: { color: '#2a2a2a' }, horzLine: { color: '#2a2a2a' } },
    });

    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      const el = ref.current!;
      chart.applyOptions({ width: el.clientWidth, height: Math.max(220, el.clientHeight || 280) });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Recreate series set for simplicity (small N).
    for (const s of Object.values(seriesRef.current)) {
      try { chart.removeSeries(s); } catch {}
    }
    seriesRef.current = {};

    for (const spec of (series || [])) {
      const s = chart.addLineSeries({
        color: spec.color,
        lineWidth: spec.width ?? 2,
        lineStyle: spec.lineStyle ?? 0,
      });
      seriesRef.current[spec.id] = s;

      const data = (spec.points || [])
        .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.value))
        .map(p => ({ time: (Math.floor(p.ts / 1000) as unknown as UTCTimestamp), value: p.value }));
      s.setData(data);
    }

    chart.timeScale().fitContent();
  }, [series]);

  return <div ref={ref} style={{ width: '100%', height: 300 }} />;
}
