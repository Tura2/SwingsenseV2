import { useEffect, useRef } from 'react';
import { createChart, UTCTimestamp } from 'lightweight-charts';

export type EquityPoint = { ts: number; equity: number; bench_equity: number; position?: number };

export default function EquityChart({ points }: { points: EquityPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const stratRef = useRef<any>(null);
  const benchRef = useRef<any>(null);

  useEffect(() => {
    if (!ref.current) return;
    const w = ref.current.clientWidth || 600;
    const h = Math.max(180, ref.current.clientHeight || 220);
    const chart = createChart(ref.current, {
      width: w,
      height: h,
      layout: { background: { color: '#111' }, textColor: '#bbb' },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333' },
      grid: { vertLines: { color: '#1b1b1b' }, horzLines: { color: '#1b1b1b' } },
    });
    chartRef.current = chart;

    const strat = chart.addLineSeries({ color: '#4ade80', lineWidth: 2 });
    const bench = chart.addLineSeries({ color: '#60a5fa', lineWidth: 2, lineStyle: 2 });
    stratRef.current = strat;
    benchRef.current = bench;

    const ro = new ResizeObserver(() => {
      const el = ref.current!;
      chart.applyOptions({ width: el.clientWidth, height: Math.max(180, el.clientHeight || 220) });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      stratRef.current = null;
      benchRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const strat = stratRef.current;
    const bench = benchRef.current;
    if (!chart || !strat || !bench) return;
    if (!points?.length) {
      strat.setData([]);
      bench.setData([]);
      return;
    }

    const dataStrat = points.map(p => ({ time: (Math.floor(p.ts / 1000) as unknown as UTCTimestamp), value: p.equity }));
    const dataBench = points.map(p => ({ time: (Math.floor(p.ts / 1000) as unknown as UTCTimestamp), value: p.bench_equity }));
    strat.setData(dataStrat);
    bench.setData(dataBench);
    chart.timeScale().fitContent();
  }, [points]);

  return <div ref={ref} style={{ width: '100%', height: 240 }} />;
}
