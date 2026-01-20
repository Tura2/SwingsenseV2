import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import MultiEquityChart, { type LineSeriesSpec } from '../components/MultiEquityChart';
import type { QuoteLite } from '@shared/types';

type Currency = 'USD' | 'ILS';

type Snapshot = {
  portfolioId: number;
  baseCurrency: Currency;
  cashBase: number;
  holdingsValueBase: number;
  navBase: number;
  pnlDailyBase: number | null;
  pnlDailyPct: number | null;
  pnlOpenBase: number | null;
  pnlOpenPct: number | null;
  positions: Array<{ ticker: string; qty: number; lastPrice: number | null; avgBuyPrice: number | null; costBasisBase: number | null; pnlOpenBase: number | null; assetCurrency: Currency; fxRateToBase: number; valueBase: number }>;
  warnings: string[];
};

type PortfolioRow = { id: number; name: string; base_currency: Currency };

type TradeRow = {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  ts: number;
  trade_currency?: Currency | null;
  fx_rate?: number | null;
  notional_base?: number | null;
  fee_base?: number | null;
  fee?: number | null;
  strategy_tag?: string | null;
  notes?: string | null;
  meta?: string | null;
};

type PerfPoint = { ts: number; equity: number; bench_equity: number };
type LedgerRow = { id: number; ts: number; amount: number; type: 'DEPOSIT'|'WITHDRAWAL'|'ADJUSTMENT'; description?: string | null };

type CandleRow = { ts: number; close: number };

type RecordBookRow =
  | { kind: 'trade'; ts: number; trade: TradeRow }
  | { kind: 'ledger'; ts: number; ledger: LedgerRow };

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function format2(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(2);
}

function formatDateTime(ts: number) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString();
}

function SquarePenIcon({ size = 16 }: { size?: number }) {
  // lucide "square-pen" (inline SVG)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

export default function RecordBook() {
  const navigate = useNavigate();
  const q = useQuery();

  const sandboxRunId = useMemo(() => {
    const v = Number(q.get('sandboxRunId') || '');
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [q]);

  const api = (window as any).api as undefined | {
    getCandles?(symbol: string, range?: '1M' | '6M' | '1Y' | '5Y'): Promise<CandleRow[]>;
    getQuotes?(symbols: string[]): Promise<QuoteLite[]>;
    portfolios?: {
      list(): Promise<any[]>;
      getSnapshot(opts?: { portfolioId?: number }): Promise<Snapshot>;
    };
    tsmom?: {
      getPerformance(opts?: { portfolioId?: number; years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: PerfPoint[] }>;
      listTrades(opts?: { portfolioId?: number; limit?: number; strategyTagPrefix?: string }): Promise<TradeRow[]>;
      listLedger(opts?: { portfolioId?: number; limit?: number }): Promise<LedgerRow[]>;
      updateTradeNotes?(payload: { tradeId: number; notes: string | null }): Promise<{ ok: true }>;

      sandboxEaRecordBook?(opts: { runId: number }): Promise<{ run: any; trades: any[]; ledger: any[] }>;
    };
  };

  if (!api?.portfolios || !api?.tsmom) {
    return (
      <div className="card" style={{ borderColor: '#733', color: '#ffb3b3' }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window.
      </div>
    );
  }

  const portfoliosApi = api.portfolios;
  const tsmomApi = api.tsmom;

  const [portfolios, setPortfolios] = useState<PortfolioRow[]>([]);
  const [portfolioId, setPortfolioId] = useState<number>(() => {
    const fromQ = Number(q.get('portfolioId') || '1');
    return Number.isFinite(fromQ) && fromQ > 0 ? fromQ : 1;
  });

  const [sandboxRun, setSandboxRun] = useState<any | null>(null);
  const [sandboxTrades, setSandboxTrades] = useState<TradeRow[]>([]);
  const [sandboxLedger, setSandboxLedger] = useState<LedgerRow[]>([]);
  const [sandboxLoading, setSandboxLoading] = useState(false);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [years, setYears] = useState(5);
  const [perf, setPerf] = useState<{ sp500: PerfPoint[]; portfolio: PerfPoint[] } | null>(null);
  const [ta35, setTa35] = useState<Array<{ ts: number; value: number }> | null>(null);
  const [ta90, setTa90] = useState<Array<{ ts: number; value: number }> | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTrade, setEditTrade] = useState<TradeRow | null>(null);
  const [editText, setEditText] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  async function loadPortfolios() {
    const rows = await portfoliosApi.list();
    const list = (rows || []).map((p: any) => ({
      id: Number(p.id),
      name: String(p.name),
      base_currency: (String(p.base_currency || 'ILS').toUpperCase() === 'USD' ? 'USD' : 'ILS') as Currency,
    }));
    setPortfolios(list);
    if (list.length && !list.some(p => p.id === portfolioId)) setPortfolioId(list[0].id);
  }

  function normalizeCandleSeries(bars: CandleRow[] | null | undefined): Array<{ ts: number; value: number }> {
    const clean = (bars || [])
      .map(b => ({ ts: Number((b as any).ts), close: Number((b as any).close) }))
      .filter(b => Number.isFinite(b.ts) && Number.isFinite(b.close));
    if (!clean.length) return [];
    const base = clean[0].close;
    if (!Number.isFinite(base) || base === 0) return [];
    return clean.map(b => ({ ts: b.ts, value: b.close / base }));
  }

  async function loadAll() {
    setLoading(true);
    try {
      const [snap, trows, lrows] = await Promise.all([
        portfoliosApi.getSnapshot({ portfolioId }),
        tsmomApi.listTrades({ portfolioId, limit: 2000 }),
        tsmomApi.listLedger({ portfolioId, limit: 2000 }),
      ]);
      setSnapshot(snap);
      setTrades((trows || []).slice().sort((a, b) => Number(b.ts) - Number(a.ts)));
      setLedger((lrows || []).slice().sort((a: any, b: any) => Number(b.ts) - Number(a.ts)));

      // Portfolio + S&P 500 benchmark via backend performance (normalized series)
      const perfRes = await tsmomApi.getPerformance({ portfolioId, years, benchmark: '^GSPC' });
      const pts = perfRes?.points || [];
      setPerf({
        portfolio: pts.map(p => ({ ts: p.ts, equity: p.equity, bench_equity: p.bench_equity })),
        sp500: pts.map(p => ({ ts: p.ts, equity: p.bench_equity, bench_equity: p.bench_equity })),
      });

      // TA35 / TA90 from candle closes (normalized)
      const getCandles = api?.getCandles;
      if (getCandles) {
        const [c35, c90] = await Promise.all([
          getCandles('TA35.TA', '5Y').catch(() => []),
          getCandles('TA90.TA', '5Y').catch(() => []),
        ]);
        setTa35(normalizeCandleSeries(c35));
        setTa90(normalizeCandleSeries(c90));
      } else {
        setTa35([]);
        setTa90([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadSandbox() {
    if (!sandboxRunId) return;
    setSandboxLoading(true);
    try {
      if (!tsmomApi.sandboxEaRecordBook) {
        throw new Error('sandboxEaRecordBook API not available yet.');
      }
      const res = await tsmomApi.sandboxEaRecordBook({ runId: sandboxRunId });
      setSandboxRun(res.run);
      setSandboxTrades(
        (res.trades || []).map((t: any) => ({
          id: Number(t.id),
          symbol: String(t.symbol),
          side: (String(t.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as TradeRow['side'],
          qty: Number(t.qty),
          price: Number(t.price_base),
          ts: Number(t.ts),
          notional_base: Number(t.notional_base),
          fee_base: Number(t.fee_base),
          strategy_tag: t.strategy_tag ? String(t.strategy_tag) : null,
          notes: null,
          meta: t.meta ? String(t.meta) : null,
        }))
      );
      setSandboxLedger(
        (res.ledger || []).map((l: any) => ({
          id: Number(l.id),
          ts: Number(l.ts),
          amount: Number(l.amount),
          type: (String(l.type).toUpperCase() === 'WITHDRAWAL'
            ? 'WITHDRAWAL'
            : String(l.type).toUpperCase() === 'ADJUSTMENT'
              ? 'ADJUSTMENT'
              : 'DEPOSIT') as LedgerRow['type'],
          description: l.description ? String(l.description) : null,
        }))
      );
    } finally {
      setSandboxLoading(false);
    }
  }

  useEffect(() => {
    if (sandboxRunId) return;
    void loadPortfolios();
  }, []);

  useEffect(() => {
    if (sandboxRunId) {
      void loadSandbox();
      const next = new URLSearchParams();
      next.set('sandboxRunId', String(sandboxRunId));
      navigate({ pathname: '/recordbook', search: `?${next.toString()}` }, { replace: true });
      return;
    }

    void loadAll();
    // keep URL in sync
    const next = new URLSearchParams();
    next.set('portfolioId', String(portfolioId));
    navigate({ pathname: '/recordbook', search: `?${next.toString()}` }, { replace: true });
  }, [portfolioId, years, sandboxRunId]);

  const baseCurrency: Currency = (snapshot?.baseCurrency || 'ILS') as Currency;

  const sandboxBaseCurrency: Currency = useMemo(() => {
    const c = String(sandboxRun?.base_currency || sandboxRun?.baseCurrency || 'ILS').toUpperCase();
    return c === 'USD' ? 'USD' : 'ILS';
  }, [sandboxRun]);

  const summary = useMemo(() => {
    if (sandboxRunId) {
      const totalFees = sandboxTrades.reduce((acc, t) => acc + (Number(t.fee_base) || 0), 0);
      const firstTs = sandboxTrades.length ? Math.min(...sandboxTrades.map(t => Number(t.ts) || Infinity)) : null;
      const lastTs = sandboxTrades.length ? Math.max(...sandboxTrades.map(t => Number(t.ts) || 0)) : null;
      const deposits = sandboxLedger.filter(l => l.type === 'DEPOSIT').reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
      const withdrawals = sandboxLedger.filter(l => l.type === 'WITHDRAWAL').reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
      const adjustments = sandboxLedger.filter(l => l.type === 'ADJUSTMENT').reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
      const netContributions = deposits + withdrawals + adjustments;
      return {
        totalFees,
        buyNotional: sandboxTrades.filter(t => t.side === 'BUY').reduce((acc, t) => acc + (Number(t.notional_base) || 0), 0),
        sellNotional: sandboxTrades.filter(t => t.side === 'SELL').reduce((acc, t) => acc + (Number(t.notional_base) || 0), 0),
        firstTs,
        lastTs,
        holdings: 0,
        cash: 0,
        equity: 0,
        tradesCount: sandboxTrades.length,
        deposits,
        withdrawals,
        adjustments,
        netContributions,
      };
    }

    const totalFees = trades.reduce((acc, t) => acc + (Number(t.fee_base) || 0), 0);
    const buys = trades.filter(t => t.side === 'BUY');
    const sells = trades.filter(t => t.side === 'SELL');
    const buyNotional = buys.reduce((acc, t) => acc + (Number(t.notional_base) || 0), 0);
    const sellNotional = sells.reduce((acc, t) => acc + (Number(t.notional_base) || 0), 0);
    const firstTs = trades.length ? Math.min(...trades.map(t => Number(t.ts) || Infinity)) : null;
    const lastTs = trades.length ? Math.max(...trades.map(t => Number(t.ts) || 0)) : null;
    const holdings = Number(snapshot?.navBase || 0);
    const cash = Number(snapshot?.cashBase || 0);
    const equity = holdings + cash;

    const deposits = ledger
      .filter(l => l.type === 'DEPOSIT')
      .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const withdrawals = ledger
      .filter(l => l.type === 'WITHDRAWAL')
      .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const adjustments = ledger
      .filter(l => l.type === 'ADJUSTMENT')
      .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const netContributions = deposits + withdrawals + adjustments;

    return {
      totalFees,
      buyNotional,
      sellNotional,
      firstTs,
      lastTs,
      holdings,
      cash,
      equity,
      tradesCount: trades.length,
      deposits,
      withdrawals,
      adjustments,
      netContributions,
    };
  }, [trades, ledger, snapshot, sandboxTrades, sandboxLedger, sandboxRunId]);

  const recordBookRows: RecordBookRow[] = useMemo(() => {
    const useTrades = sandboxRunId ? sandboxTrades : trades;
    const useLedger = sandboxRunId ? sandboxLedger : ledger;

    const out: RecordBookRow[] = [];
    for (const t of useTrades) out.push({ kind: 'trade', ts: Number(t.ts), trade: t });
    for (const l of useLedger) out.push({ kind: 'ledger', ts: Number(l.ts), ledger: l });
    return out
      .filter(r => Number.isFinite(r.ts) && r.ts > 0)
      .sort((a, b) => b.ts - a.ts);
  }, [trades, ledger, sandboxTrades, sandboxLedger, sandboxRunId]);

  const chartSeries: LineSeriesSpec[] = useMemo(() => {
    const out: LineSeriesSpec[] = [];

    const portfolioPts = perf?.portfolio || [];
    if (portfolioPts.length) {
      out.push({
        id: 'portfolio',
        name: 'Portfolio',
        color: '#4ade80',
        width: 2,
        points: portfolioPts.map(p => ({ ts: p.ts, value: p.equity })),
      });
    }

    const sp = perf?.sp500 || [];
    if (sp.length) {
      out.push({
        id: 'sp500',
        name: 'S&P 500',
        color: '#60a5fa',
        lineStyle: 2,
        width: 2,
        points: sp.map(p => ({ ts: p.ts, value: p.equity })),
      });
    }

    if (ta35?.length) {
      out.push({
        id: 'ta35',
        name: 'TA35',
        color: '#f59e0b',
        lineStyle: 2,
        width: 2,
        points: ta35,
      });
    }

    if (ta90?.length) {
      out.push({
        id: 'ta90',
        name: 'TA90',
        color: '#a78bfa',
        lineStyle: 2,
        width: 2,
        points: ta90,
      });
    }

    return out;
  }, [perf, ta35, ta90]);

  async function saveNotes() {
    if (!editTrade) return;
    if (sandboxRunId) return;
    const tradeId = Number(editTrade.id);
    const notes = editText.trim();
    setSavingNote(true);
    try {
      if (!tsmomApi.updateTradeNotes) {
        alert('updateTradeNotes API not available yet.');
        return;
      }
      await tsmomApi.updateTradeNotes({ tradeId, notes: notes ? notes : null });
      setEditOpen(false);
      setEditTrade(null);
      setEditText('');
      await loadAll();
    } finally {
      setSavingNote(false);
    }
  }

  if (sandboxRunId) {
    const base = sandboxBaseCurrency;
    return (
      <div className="stack wealth">
        <div className="wealth-header">
          <div>
            <h2 className="wealth-title">Record Book</h2>
            <div className="wealth-subtitle">
              <span className="pill">Sandbox run #{sandboxRunId}</span>
              <span className="pill">Base: {base}</span>
              <span className="pill">Trades: {summary.tradesCount}</span>
            </div>
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="ghost" onClick={() => navigate('/tsmom')}>Back to Sandbox</button>
            <button className="ghost" onClick={loadSandbox} disabled={sandboxLoading}>
              {sandboxLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="wealth-stats">
          <div className="card stat-card">
            <div className="stat-label">Net Contributions</div>
            <div className="stat-value">{format2(summary.netContributions)} <span className="stat-ccy">{base}</span></div>
          </div>
          <div className="card stat-card">
            <div className="stat-label">Total Fees</div>
            <div className="stat-value">{format2(summary.totalFees)} <span className="stat-ccy">{base}</span></div>
          </div>
          <div className="card stat-card">
            <div className="stat-label">Start</div>
            <div className="stat-value">{sandboxRun?.start_ts ? new Date(Number(sandboxRun.start_ts)).toLocaleDateString() : '—'}</div>
          </div>
          <div className="card stat-card">
            <div className="stat-label">Valuation</div>
            <div className="stat-value">{sandboxRun?.valuation_ts ? new Date(Number(sandboxRun.valuation_ts)).toLocaleDateString() : '—'}</div>
          </div>
        </div>

        <div className="card wealth-card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Trade Record Book</h3>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              Sandbox-only; does not affect Wealth.
            </div>
          </div>

          <div className="tableWrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Price ({base})</th>
                  <th className="num">Notional ({base})</th>
                  <th className="num">Fee ({base})</th>
                  <th>Strategy</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {!recordBookRows.length && (
                  <tr>
                    <td colSpan={9} style={{ color: '#9aa4b2' }}>No record book rows.</td>
                  </tr>
                )}
                {recordBookRows.map(r => {
                  if (r.kind === 'trade') {
                    const t = r.trade;
                    const fee = Number.isFinite(Number(t.fee_base)) ? Number(t.fee_base) : null;
                    return (
                      <tr key={`t-${t.id}`}>
                        <td className="mono">{formatDateTime(t.ts)}</td>
                        <td>{t.symbol}</td>
                        <td><span className={`badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                        <td className="num mono">{format2(t.qty)}</td>
                        <td className="num mono">{format2(t.price)}</td>
                        <td className="num mono">{format2(t.notional_base)}</td>
                        <td className="num mono">{format2(fee)}</td>
                        <td className="mono">{t.strategy_tag || '—'}</td>
                        <td className="mono">—</td>
                      </tr>
                    );
                  }

                  const l = r.ledger;
                  const type = l.type;
                  const badgeClass = type === 'DEPOSIT' ? 'buy' : type === 'WITHDRAWAL' ? 'sell' : '';
                  return (
                    <tr key={`l-${l.id}`}>
                      <td className="mono">{formatDateTime(l.ts)}</td>
                      <td className="mono">CASH</td>
                      <td><span className={`badge ${badgeClass}`}>{type}</span></td>
                      <td className="num mono">—</td>
                      <td className="num mono">—</td>
                      <td className="num mono">{format2(l.amount)}</td>
                      <td className="num mono">—</td>
                      <td className="mono">—</td>
                      <td className="mono">{l.description || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack wealth">
      <div className="wealth-header">
        <div>
          <h2 className="wealth-title">Record Book</h2>
          <div className="wealth-subtitle">
            <span className="pill">Portfolio #{portfolioId}</span>
            <span className="pill">Base: {baseCurrency}</span>
            <span className="pill">Trades: {summary.tradesCount}</span>
          </div>
        </div>

        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={portfolioId} onChange={e => setPortfolioId(Number(e.target.value))}>
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} (#{p.id}, {p.base_currency})
              </option>
            ))}
            {!portfolios.length && <option value={1}>Default (#1)</option>}
          </select>

          <select value={years} onChange={e => setYears(Number(e.target.value))}>
            <option value={1}>1Y</option>
            <option value={3}>3Y</option>
            <option value={5}>5Y</option>
            <option value={10}>10Y</option>
          </select>

          <button className="ghost" onClick={() => navigate(`/wealth?portfolioId=${portfolioId}`)}>
            Back to Wealth
          </button>

          <button className="ghost" onClick={loadAll} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="wealth-stats">
        <div className="card stat-card">
          <div className="stat-label">Holdings (NAV)</div>
          <div className="stat-value">{format2(snapshot?.navBase)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Cash</div>
          <div className="stat-value">{format2(snapshot?.cashBase)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Net Contributions</div>
          <div className="stat-value">{format2(summary.netContributions)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Total Fees</div>
          <div className="stat-value">{format2(summary.totalFees)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
      </div>

      <div className="card wealth-card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Performance Benchmark</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(chartSeries || []).map(s => (
              <span key={s.id} className="pill">{s.name}</span>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <MultiEquityChart series={chartSeries} />
        </div>
      </div>

      <div className="card wealth-card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Trade Record Book</h3>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            Fees are recorded per trade (not deducted from portfolio cash).
          </div>
        </div>

        <div className="tableWrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Notional ({baseCurrency})</th>
                <th className="num">FX</th>
                <th className="num">Fee ({baseCurrency})</th>
                <th>Strategy</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!recordBookRows.length && (
                <tr>
                  <td colSpan={11} style={{ color: '#9aa4b2' }}>No record book rows.</td>
                </tr>
              )}
              {recordBookRows.map(r => {
                if (r.kind === 'trade') {
                  const t = r.trade;
                  const fee = Number.isFinite(Number(t.fee_base)) ? Number(t.fee_base) : (Number.isFinite(Number(t.fee)) ? Number(t.fee) : null);
                  return (
                    <tr key={`t-${t.id}`}>
                      <td className="mono">{formatDateTime(t.ts)}</td>
                      <td>{t.symbol}</td>
                      <td><span className={`badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                      <td className="num mono">{format2(t.qty)}</td>
                      <td className="num mono">{format2(t.price)}</td>
                      <td className="num mono">{format2(t.notional_base)}</td>
                      <td className="num mono">{format2(t.fx_rate)}</td>
                      <td className="num mono">{format2(fee)}</td>
                      <td className="mono">{t.strategy_tag || '—'}</td>
                      <td style={{ maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={t.notes || ''}>
                        {t.notes || '—'}
                      </td>
                      <td>
                        <button
                          className="ghost"
                          title="Edit notes"
                          onClick={() => {
                            setEditTrade(t);
                            setEditText(t.notes || '');
                            setEditOpen(true);
                          }}
                        >
                          <SquarePenIcon size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                }

                const l = r.ledger;
                const type = l.type;
                const badgeClass = type === 'DEPOSIT' ? 'buy' : type === 'WITHDRAWAL' ? 'sell' : '';
                return (
                  <tr key={`l-${l.id}`}>
                    <td className="mono">{formatDateTime(l.ts)}</td>
                    <td className="mono">CASH</td>
                    <td><span className={`badge ${badgeClass}`}>{type}</span></td>
                    <td className="num mono">—</td>
                    <td className="num mono">—</td>
                    <td className="num mono">{format2(l.amount)}</td>
                    <td className="num mono">—</td>
                    <td className="num mono">—</td>
                    <td className="mono">—</td>
                    <td style={{ maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.description || ''}>
                      {l.description || '—'}
                    </td>
                    <td></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editOpen && (
        <div className="modalBackdrop" onMouseDown={() => (savingNote ? null : setEditOpen(false))} role="dialog" aria-modal="true">
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Edit trade notes</div>
              <button className="ghost" onClick={() => setEditOpen(false)} disabled={savingNote}>Close</button>
            </div>
            <div className="modalBody">
              <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
                Trade #{editTrade?.id} — {editTrade?.symbol} {editTrade?.side}
              </div>
              <textarea
                value={editText}
                onChange={e => setEditText(e.target.value)}
                rows={6}
                style={{ width: '100%', resize: 'vertical', background: '#131720', color: 'var(--text)', border: '1px solid #262b36', borderRadius: 8, padding: 10 }}
                placeholder="Write notes..."
              />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                <button className="primary" onClick={saveNotes} disabled={savingNote}>
                  {savingNote ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
