import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';

interface TrendingItem { symbol: string; price: number; changePct: number; volume: number; }
type TrendTab = 'gainers' | 'losers' | 'active';

export default function Home() {
  const navigate = useNavigate();
  const [hasBacktestRoute] = useState(()=> true); // assume route exists; could introspect routes config if exported

  // Trending state
  const [trendTab, setTrendTab] = useState<TrendTab>('gainers');
  const [trendData, setTrendData] = useState<Record<TrendTab, TrendingItem[]>>({ gainers: [], losers: [], active: [] });
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string|undefined>();
  const fetchedRef = useRef<Set<TrendTab>>(new Set());

  const fetchTrending = async (tab: TrendTab, force?: boolean) => {
    // If we previously fetched and have non-empty data, skip unless force
    if (!force && fetchedRef.current.has(tab) && trendData[tab].length) return;
    setTrendLoading(true); setTrendError(undefined);
    try {
      const apiAny = window.api as any; // typed augmentation shim
      const dataRaw = await apiAny.market.getTrending({ list: tab, limit: 12 });
      const data: TrendingItem[] = Array.isArray(dataRaw) ? dataRaw.filter(r => r && r.symbol) : [];
      setTrendData(d => ({ ...d, [tab]: data }));
      fetchedRef.current.add(tab);
      if (!data.length) {
        // allow automatic re-fetch on next tab switch by not caching empties strongly
        setTrendError('No data');
      }
    } catch (e:any) {
      console.error('[trending] fetch failed', e); setTrendError(e?.message || 'Failed');
    } finally { setTrendLoading(false); }
  };

  useEffect(()=>{ fetchTrending('gainers'); /* defer others until tab click */ },[]);

  const carouselRef = useRef<HTMLDivElement|null>(null);
  const scrollCarousel = (dir: number) => {
    const el = carouselRef.current; if (!el) return;
    const delta = el.clientWidth * 0.8 * dir;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: delta, behavior: prefersReduced ? 'auto' : 'smooth' });
  };

  const trendRef = useRef<HTMLDivElement|null>(null);
  const scrollTrend = (dir: number) => {
    const el = trendRef.current; if (!el) return;
    const delta = el.clientWidth * 0.9 * dir;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: delta, behavior: prefersReduced ? 'auto' : 'smooth' });
  };

  const openTicker = (sym: string) => {
    console.log('[telemetry] trending.click', { sym, list: trendTab });
    navigate(`/ticker?symbol=${encodeURIComponent(sym)}`);
  };

  return (
    <div className="home-root" style={{ display:'flex', flexDirection:'column', gap:28 }}>
      {/* Trending moved to top */}
      {/* Trending section temporarily commented out
      <section className="trending" style={{ marginTop: 4 }}>
        <div className="sectionhead" style={{ marginBottom: 4 }}>
          <h2 style={{ fontSize: 20, margin:0 }}>Trending</h2>
          <div className="tabs" role="tablist">
            {(['gainers','losers','active'] as TrendTab[]).map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={trendTab===t}
                className={"tab" + (trendTab===t? ' active':'')}
                onClick={()=>{ setTrendTab(t); fetchTrending(t); }}
              >{labelForTab(t)}</button>
            ))}
          </div>
          <div className="carouselcontrols">
            <button aria-label="Scroll left" onClick={()=>scrollTrend(-1)}>{'‹'}</button>
            <button aria-label="Scroll right" onClick={()=>scrollTrend(1)}>{'›'}</button>
          </div>
        </div>
        <div className="hscroller" ref={trendRef}>
          {trendLoading && !trendData[trendTab].length && (
            <div className="trend-skeleton-row">
              {Array.from({ length: 6 }).map((_,i)=>(
                <div key={i} className="trendcard skeleton">
                  <div className="ticker skeleton-bar" />
                  <div className="price skeleton-bar" />
                  <div className="pct skeleton-bar" />
                  <div className="vol skeleton-bar" />
                </div>
              ))}
            </div>
          )}
          {trendError && !trendData[trendTab].length && <div style={{ padding:16 }}>
            <div style={{ marginBottom:8 }}>{trendError}</div>
            <button onClick={()=>fetchTrending(trendTab, true)}>Retry</button>
          </div>}
          {!trendLoading && !trendError && trendData[trendTab].map(item => (
            <button key={item.symbol} className="trendcard" onClick={()=>openTicker(item.symbol)}>
              <div className="ticker">{item.symbol}</div>
              <div className="price">{fmtPrice(item.price)}</div>
              <div className={"pct " + (item.changePct > 0 ? 'up':'down')}>{(item.changePct ?? 0).toFixed(2)}%</div>
              <div className="vol">{fmtVol(item.volume)}</div>
            </button>
          ))}
          {!trendLoading && !trendError && !trendData[trendTab].length && <div style={{ padding:16 }}>No data</div>}
        </div>
      </section>
      */}

      {/* Single Quick Access grid */}
      <div className="cardgrid" style={{ marginTop: -4 }}>
        <div className="card">
          <h3>Ticker</h3>
          <p>Interactive chart with EMA/RSI, daily candles from Yahoo.</p>
          <Link to="/ticker"><button className="primary">Open</button></Link>
        </div>
        <div className="card">
          <h3>Watchlists</h3>
          <p>Create lists and manage symbols. Used for scanning signals.</p>
          <Link to="/watchlists"><button className="primary">Open</button></Link>
        </div>
        <div className="card">
          <h3>Portfolio</h3>
          <p>Record trades, see positions & P/L against last close.</p>
          <Link to="/portfolio"><button className="primary">Open</button></Link>
        </div>
        <div className="card">
          <h3>Signals</h3>
          <p>Momentum & squeeze strategy alerts.</p>
          <Link to="/signals"><button className="primary">Open</button></Link>
        </div>
        {hasBacktestRoute && <div className="card">
          <h3>Backtest</h3>
          <p>Objective & discretionary engine metrics.</p>
          <Link to="/backtest"><button className="primary">Open</button></Link>
        </div>}
      </div>
    </div>
  );
}

function labelForTab(t: TrendTab) { return t === 'gainers' ? 'Gainers' : t === 'losers' ? 'Losers' : 'Most Active'; }
function fmtVol(v: number) { if (!v) return '-'; const units = [['T',1e12],['B',1e9],['M',1e6],['K',1e3]] as const; for (const [s,val] of units) if (v>=val) return (v/val).toFixed(1)+s; return String(v); }
function fmtPrice(p: number) { return p>=100 ? p.toFixed(2) : p.toFixed(3); }
