import { useEffect, useMemo, useState } from "react";
import EquityChart from "../components/EquityChart";

type AssetRow = {
  ticker: string;
  name: string | null;
  category: string | null;
  status: "active" | "inactive";
  yahoo_symbol: string | null;
  price_multiplier: number;
};

type PlanItem = {
  ticker: string;
  name: string | null;
  category: string | null;
  price: number | null;
  momentum: number | null;
  sigmaAnn: number | null;
  targetWeight: number;
  targetQty: number;
  currentQty: number;
  deltaQty: number;
  action: "BUY" | "SELL" | "HOLD";
};

type RebalancePlan = {
  asOf: string;
  params: {
    lookbackTradingDays: number;
    skipRecentTradingDays: number;
    volCenterDaysCOM: number;
    targetVolAnn: number;
    topK: number;
    maxLeverage: number;
    commissionNIS: number;
  };
  equityNIS: number;
  cashNIS: number;
  holdingsValueNIS: number;
  items: PlanItem[];
  warnings: string[];
};

type SignalMatrixRow = {
  ticker: string;
  name: string | null;
  category: string | null;
  status: "active" | "inactive";
  price: number | null;
  momentum: number | null;
  sigmaAnn: number | null;
  rank: number | null;
  isTopK: boolean;
};

type SignalMatrix = {
  asOf: string;
  params: {
    lookbackTradingDays: number;
    skipRecentTradingDays: number;
    volCenterDaysCOM: number;
    topK: number;
  };
  rows: SignalMatrixRow[];
};

type PerformancePoint = { ts: number; equity: number; bench_equity: number };

type SandboxResult = {
  asOf: string;
  benchmark: string | null;
  params: any;
  summary: {
    start: string;
    end: string;
    years: number;
    cagr: number | null;
    volAnn: number | null;
    sharpe: number | null;
    maxDrawdown: number | null;
    benchCagr: number | null;
  };
  points: PerformancePoint[];
  warnings: string[];
};

type LedgerRow = {
  id: number;
  ts: number;
  amount: number;
  type: "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT";
  description: string | null;
  meta: string | null;
};

type TradeRow = {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts: number;
  fee?: number | null;
  strategy_tag?: string | null;
  notes?: string | null;
  meta?: string | null;
};

type SyncRunRow = {
  id: number;
  started_at: number;
  finished_at: number | null;
  assets: number;
  updated: number;
  status: "running" | "completed" | "failed";
  warnings: string | null;
};

type PriceFlagRow = {
  id: number;
  ticker: string;
  ts: number;
  type: string;
  severity: "info" | "warn" | "error";
  message: string;
  move_pct: number | null;
  prev_close: number | null;
  close: number | null;
  acknowledged_at: number | null;
  meta: string | null;
};

export default function TsmomCommandCenter() {
  const api = (window as any).api as undefined | {
    tsmom: {
      getUniverse(): Promise<AssetRow[]>;
      computePlan(): Promise<RebalancePlan>;
      getSignalMatrix(): Promise<SignalMatrix>;
      getPerformance(opts?: { years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: PerformancePoint[] }>;
      sandboxRun(opts?: { years?: number; benchmark?: string | null; params?: any }): Promise<SandboxResult>;
      sandboxCompare(opts: { years?: number; benchmark?: string | null; runs: Array<{ label: string; params: any }> }): Promise<any>;
      executeTrades(payload: any): Promise<{ ok: true }>;
      listLedger(opts?: { limit?: number }): Promise<LedgerRow[]>;
      addLedgerEntry(payload: any): Promise<{ id: number; ts: number }>;
      deleteLedgerEntry(id: number): Promise<{ ok: true }>;
      listTrades(opts?: { limit?: number; strategyTagPrefix?: string }): Promise<TradeRow[]>;

      getSyncStatus(): Promise<{ lastRun: SyncRunRow | null; openFlags: number }>;
      listSyncRuns(opts?: { limit?: number }): Promise<SyncRunRow[]>;
      listPriceFlags(opts?: { limit?: number; onlyUnacknowledged?: boolean; types?: string[]; ticker?: string }): Promise<PriceFlagRow[]>;
      ackPriceFlag(id: number): Promise<{ ok: true }>;

      applyCorporateAction(flagId: number): Promise<{ ok: true; ticker: string; factor: number; cutoffTs: number; updatedCandles: number }>;
    };
  };

  if (!api) {
    return (
      <div className="card" style={{ borderColor: "#733", color: "#ffb3b3" }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window, not a normal browser.
      </div>
    );
  }

  // From here on, the Electron bridge is available.
  const tsmom = api.tsmom;

  const [universe, setUniverse] = useState<AssetRow[]>([]);
  const [plan, setPlan] = useState<RebalancePlan | null>(null);
  const [loadingUniverse, setLoadingUniverse] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);

  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

  const [cashType, setCashType] = useState<LedgerRow["type"]>("DEPOSIT");
  const [cashAmount, setCashAmount] = useState<number>(50000);
  const [cashDesc, setCashDesc] = useState<string>("Initial deposit");

  const [includeExecCashFlow, setIncludeExecCashFlow] = useState(false);
  const [execCashType, setExecCashType] = useState<LedgerRow["type"]>("DEPOSIT");
  const [execCashAmount, setExecCashAmount] = useState<number>(0);
  const [execCashDesc, setExecCashDesc] = useState<string>("Rebalance cash flow");

  const [syncStatus, setSyncStatus] = useState<{ lastRun: SyncRunRow | null; openFlags: number } | null>(null);
  const [syncRuns, setSyncRuns] = useState<SyncRunRow[]>([]);
  const [priceFlags, setPriceFlags] = useState<PriceFlagRow[]>([]);
  const [loadingSync, setLoadingSync] = useState(false);

  const [signalMatrix, setSignalMatrix] = useState<SignalMatrix | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [matrixFilter, setMatrixFilter] = useState('');

  const [perf, setPerf] = useState<{ benchmark: string | null; points: PerformancePoint[] } | null>(null);
  const [loadingPerf, setLoadingPerf] = useState(false);

  const [sbYears, setSbYears] = useState(5);
  const [sbTargetVol, setSbTargetVol] = useState(0.9);
  const [sbTopK, setSbTopK] = useState(5);
  const [sbLookback, setSbLookback] = useState(63);
  const [sbSkip, setSbSkip] = useState(10);
  const [sbCom, setSbCom] = useState(20);
  const [sbMaxLev, setSbMaxLev] = useState(1);
  const [sbCommission, setSbCommission] = useState(5);
  const [sbResult, setSbResult] = useState<SandboxResult | null>(null);
  const [sbLoading, setSbLoading] = useState(false);
  const [sbCompare, setSbCompare] = useState<Array<{ label: string; res: SandboxResult }>>([]);

  const [confirmExecuted, setConfirmExecuted] = useState(false);
  const [notes, setNotes] = useState("TSMOM Turbo v2 rebalance");
  const [commissionNIS, setCommissionNIS] = useState(5);

  const [fillPrices, setFillPrices] = useState<Record<string, number>>({});

  async function loadUniverse() {
    setLoadingUniverse(true);
    try {
      setUniverse(await tsmom.getUniverse());
    } finally {
      setLoadingUniverse(false);
    }
  }

  async function computePlan() {
    setLoadingPlan(true);
    try {
      const p = await tsmom.computePlan();
      setPlan(p);

      const next: Record<string, number> = {};
      for (const it of p.items) {
        if (it.action === "HOLD") continue;
        if (typeof it.price === "number" && Number.isFinite(it.price) && it.price > 0) {
          next[it.ticker] = it.price;
        }
      }
      setFillPrices(prev => ({ ...next, ...prev }));
      setConfirmExecuted(false);
    } finally {
      setLoadingPlan(false);
    }
  }

  async function loadLedger() {
    setLoadingLedger(true);
    try {
      setLedger(await tsmom.listLedger({ limit: 500 }));
    } finally {
      setLoadingLedger(false);
    }
  }

  async function loadTrades() {
    setLoadingTrades(true);
    try {
      setTrades(await tsmom.listTrades({ limit: 1000, strategyTagPrefix: "TSMOM" }));
    } finally {
      setLoadingTrades(false);
    }
  }

  async function loadSync() {
    setLoadingSync(true);
    try {
      setSyncStatus(await tsmom.getSyncStatus());
      setSyncRuns(await tsmom.listSyncRuns({ limit: 25 }));
      setPriceFlags(await tsmom.listPriceFlags({ limit: 200, onlyUnacknowledged: true }));
    } finally {
      setLoadingSync(false);
    }
  }

  async function loadSignalMatrix() {
    setLoadingMatrix(true);
    try {
      setSignalMatrix(await tsmom.getSignalMatrix());
    } finally {
      setLoadingMatrix(false);
    }
  }

  async function loadPerformance() {
    setLoadingPerf(true);
    try {
      setPerf(await tsmom.getPerformance({ years: 5, benchmark: null }));
    } finally {
      setLoadingPerf(false);
    }
  }

  async function runSandbox() {
    setSbLoading(true);
    try {
      const res = await tsmom.sandboxRun({
        years: sbYears,
        benchmark: null,
        params: {
          targetVolAnn: sbTargetVol,
          topK: sbTopK,
          lookbackTradingDays: sbLookback,
          skipRecentTradingDays: sbSkip,
          volCenterDaysCOM: sbCom,
          maxLeverage: sbMaxLev,
          commissionNIS: sbCommission,
        },
      });
      setSbResult(res);
    } finally {
      setSbLoading(false);
    }
  }

  async function addCashFlow() {
    const amount = Number(cashAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      alert("Amount must be a non-zero number.");
      return;
    }
    await tsmom.addLedgerEntry({
      ts: Date.now(),
      amount,
      type: cashType,
      description: cashDesc || undefined,
      meta: { source: "tsmom-ui" },
    });
    await loadLedger();
    // Cash changed; plan should be recomputed.
    setPlan(null);
  }

  useEffect(() => {
    loadUniverse();
    loadLedger();
    loadTrades();
    loadSync();
    loadSignalMatrix();
    loadPerformance();
  }, []);

  const pulse = useMemo(() => {
    const equity = Number(plan?.equityNIS);
    const cash = Number(plan?.cashNIS);
    const holdings = Number(plan?.holdingsValueNIS);
    const hasPlan = plan && Number.isFinite(equity) && Number.isFinite(cash) && Number.isFinite(holdings);

    const grossTarget = plan?.items?.reduce((a, it) => a + Math.abs(Number(it.targetWeight || 0)), 0) ?? 0;
    const risk = Math.max(0, Math.min(1, grossTarget));

    // Monthly return from performance series (approx 21 trading days)
    let mtdPct: number | null = null;
    if (perf?.points?.length) {
      const pts = perf.points;
      const last = pts[pts.length - 1];
      const idx = Math.max(0, pts.length - 1 - 21);
      const prev = pts[idx];
      if (last && prev && Number.isFinite(last.equity) && Number.isFinite(prev.equity) && prev.equity > 0) {
        mtdPct = ((last.equity / prev.equity) - 1) * 100;
      }
    }

    return {
      hasPlan,
      equity,
      cash,
      holdings,
      grossTarget,
      risk,
      mtdPct,
    };
  }, [plan, perf]);

  const filteredMatrix = useMemo(() => {
    const rows = signalMatrix?.rows || [];
    const q = matrixFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => {
      return (
        r.ticker.toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q)
      );
    });
  }, [signalMatrix, matrixFilter]);

  const tradeDraft = useMemo(() => {
    if (!plan) return [];
    return plan.items
      .filter(it => it.action !== "HOLD" && it.deltaQty !== 0)
      .map(it => {
        const side = it.deltaQty > 0 ? "BUY" : "SELL";
        const qty = Math.abs(it.deltaQty);
        const price = Number(fillPrices[it.ticker]);
        return { ticker: it.ticker, side, qty, price };
      })
      .filter(t => Number.isFinite(t.price) && t.price > 0);
  }, [plan, fillPrices]);

  async function executeTrades() {
    if (!plan) return;
    if (!confirmExecuted) {
      alert("Please confirm you executed these trades in your bank before recording them.");
      return;
    }

    const cashFlows: any[] = [];
    if (includeExecCashFlow) {
      const amount = Number(execCashAmount);
      if (!Number.isFinite(amount) || amount === 0) {
        alert('Cash flow amount must be a non-zero number (or disable the option).');
        return;
      }
      cashFlows.push({
        ts: Date.now(),
        amount,
        type: execCashType,
        description: execCashDesc || undefined,
        meta: { source: 'tsmom-ui', kind: 'execution' },
      });
    }

    const payload = {
      ts: Date.now(),
      strategyTag: "TSMOM_TURBO_V2",
      notes: notes || undefined,
      commissionNIS: Number(commissionNIS) || 5,
      trades: tradeDraft.map(t => ({
        ticker: t.ticker,
        side: t.side,
        qty: t.qty,
        price: t.price,
        meta: { source: "tsmom-ui" },
      })),
      ...(cashFlows.length ? { cashFlows } : {}),
    };

    await tsmom.executeTrades(payload);
    alert("Recorded trades. Re-compute plan to see updated deltas.");
    setConfirmExecuted(false);
    await loadTrades();
  }

  function exportTradesMarkdown() {
    const rows = trades.slice().sort((a, b) => b.ts - a.ts);
    const md: string[] = [];
    md.push(`# TSMOM Trade Journal`);
    md.push("");
    md.push(`Generated: ${new Date().toISOString()}`);
    md.push("");
    md.push(`| Time | Symbol | Side | Qty | Price | Fee | Strategy | Notes |`);
    md.push(`| --- | --- | --- | ---: | ---: | ---: | --- | --- |`);
    for (const t of rows) {
      const time = new Date(t.ts).toLocaleString();
      const fee = (t.fee ?? "");
      const strat = (t.strategy_tag ?? "");
      const notes = (t.notes ?? "").replaceAll("|", "\\|");
      md.push(`| ${time} | ${t.symbol} | ${t.side} | ${Number(t.qty)} | ${Number(t.price)} | ${fee} | ${strat} | ${notes} |`);
    }
    const text = md.join("\n");
    void navigator.clipboard.writeText(text);
    alert("Copied Markdown to clipboard.");
  }

  return (
    <div className="stack">
      <h2 style={{ marginTop: 0 }}>TSMOM Command Center</h2>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Portfolio Pulse</h3>
          <button className="ghost" onClick={computePlan} disabled={loadingPlan}>
            {loadingPlan ? 'Computing…' : 'Refresh plan'}
          </button>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="bt-badge">Equity: {pulse.hasPlan ? pulse.equity.toFixed(0) + ' NIS' : '—'}</span>
          <span className="bt-badge">Cash: {pulse.hasPlan ? pulse.cash.toFixed(0) + ' NIS' : '—'}</span>
          <span className="bt-badge">Holdings: {pulse.hasPlan ? pulse.holdings.toFixed(0) + ' NIS' : '—'}</span>
          <span className="bt-badge">Monthly P&L: {pulse.mtdPct == null ? '—' : (pulse.mtdPct >= 0 ? '+' : '') + pulse.mtdPct.toFixed(2) + '%'}</span>
          <span className={`bt-badge ${syncStatus?.openFlags ? 'warn' : ''}`}>Open flags: {syncStatus?.openFlags ?? '—'}</span>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9aa4b2', fontSize: 12 }}>
            <span>Risk gauge (gross target exposure)</span>
            <span>{(pulse.grossTarget * 100).toFixed(0)}%</span>
          </div>
          <div style={{ height: 10, borderRadius: 999, background: '#121821', border: '1px solid #1f2a38', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round(pulse.risk * 100)}%`,
                background: pulse.risk > 0.9 ? '#f59e0b' : '#4ade80',
              }}
            />
          </div>
          {!plan && (
            <p style={{ color: '#9aa4b2', marginBottom: 0 }}>
              Load a plan to compute equity/cash/holdings and risk.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Backtesting Sandbox</h3>
          <button className="ghost" onClick={runSandbox} disabled={sbLoading}>
            {sbLoading ? 'Running…' : 'Run'}
          </button>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <label className="row" style={{ gap: 6 }}>
            Years
            <input type="number" min={1} max={10} value={sbYears} onChange={e => setSbYears(Number(e.target.value))} style={{ width: 90 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            TargetVol
            <input type="number" step="0.05" min={0.1} max={5} value={sbTargetVol} onChange={e => setSbTargetVol(Number(e.target.value))} style={{ width: 110 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            TopK
            <input type="number" min={1} max={50} value={sbTopK} onChange={e => setSbTopK(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            Lookback
            <input type="number" min={5} max={2000} value={sbLookback} onChange={e => setSbLookback(Number(e.target.value))} style={{ width: 90 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            Skip
            <input type="number" min={0} max={365} value={sbSkip} onChange={e => setSbSkip(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            COM
            <input type="number" min={1} max={365} value={sbCom} onChange={e => setSbCom(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            MaxLev
            <input type="number" step="0.1" min={0.1} max={50} value={sbMaxLev} onChange={e => setSbMaxLev(Number(e.target.value))} style={{ width: 90 }} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            Fee
            <input type="number" step="1" min={0} max={500} value={sbCommission} onChange={e => setSbCommission(Number(e.target.value))} style={{ width: 80 }} />
          </label>
        </div>

        {!!sbResult && (
          <>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <span className="bt-badge">Range: {sbResult.summary.start} → {sbResult.summary.end}</span>
              <span className="bt-badge">CAGR: {sbResult.summary.cagr == null ? '—' : (sbResult.summary.cagr * 100).toFixed(2) + '%'}</span>
              <span className="bt-badge">Vol: {sbResult.summary.volAnn == null ? '—' : (sbResult.summary.volAnn * 100).toFixed(2) + '%'}</span>
              <span className="bt-badge">Sharpe: {sbResult.summary.sharpe == null ? '—' : sbResult.summary.sharpe.toFixed(2)}</span>
              <span className="bt-badge">MaxDD: {sbResult.summary.maxDrawdown == null ? '—' : (sbResult.summary.maxDrawdown * 100).toFixed(2) + '%'}</span>
              <span className="bt-badge">Bench CAGR: {sbResult.summary.benchCagr == null ? '—' : (sbResult.summary.benchCagr * 100).toFixed(2) + '%'}</span>
              <button
                className="secondary"
                onClick={() => {
                  const label = `TV=${sbTargetVol}, K=${sbTopK}, L=${sbLookback}, S=${sbSkip}, COM=${sbCom}`;
                  setSbCompare(prev => [{ label, res: sbResult }, ...prev].slice(0, 8));
                }}
              >
                Add to comparison
              </button>
            </div>

            {!!sbResult.warnings?.length && (
              <ul style={{ marginTop: 8, color: '#ffd7a6' }}>
                {sbResult.warnings.slice(0, 6).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="chart-wrap" style={{ height: 260, marginTop: 10 }}>
              <EquityChart points={(sbResult.points || []) as any} />
            </div>
          </>
        )}

        {!!sbCompare.length && (
          <>
            <h4 style={{ marginTop: 12, marginBottom: 6 }}>Comparison</h4>
            <div className="bt-table-wrap">
              <table className="bt-table">
                <thead>
                  <tr>
                    <th>Config</th>
                    <th className="num">CAGR</th>
                    <th className="num">Vol</th>
                    <th className="num">Sharpe</th>
                    <th className="num">MaxDD</th>
                  </tr>
                </thead>
                <tbody>
                  {sbCompare.map((x, i) => (
                    <tr key={i}>
                      <td className="mono">{x.label}</td>
                      <td className="num mono">{x.res.summary.cagr == null ? '—' : (x.res.summary.cagr * 100).toFixed(2) + '%'}</td>
                      <td className="num mono">{x.res.summary.volAnn == null ? '—' : (x.res.summary.volAnn * 100).toFixed(2) + '%'}</td>
                      <td className="num mono">{x.res.summary.sharpe == null ? '—' : x.res.summary.sharpe.toFixed(2)}</td>
                      <td className="num mono">{x.res.summary.maxDrawdown == null ? '—' : (x.res.summary.maxDrawdown * 100).toFixed(2) + '%'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Data Integrity / Sync</h3>
          <button className="ghost" onClick={loadSync} disabled={loadingSync}>
            {loadingSync ? "Loading…" : "Reload"}
          </button>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <span className="bt-badge">
            Last sync: {syncStatus?.lastRun ? new Date(syncStatus.lastRun.started_at).toLocaleString() : "—"}
          </span>
          <span className="bt-badge">
            Status: {syncStatus?.lastRun?.status ?? "—"}
          </span>
          <span className="bt-badge">
            Updated: {syncStatus?.lastRun ? `${syncStatus.lastRun.updated}/${syncStatus.lastRun.assets}` : "—"}
          </span>
          <span className={`bt-badge ${syncStatus?.openFlags ? 'warn' : ''}`}>
            Open flags: {syncStatus?.openFlags ?? "—"}
          </span>
        </div>

        <h4 style={{ marginBottom: 6 }}>Open Price Flags</h4>
        <div className="bt-table-wrap">
          <table className="bt-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Ticker</th>
                <th>Type</th>
                <th className="num">Move%</th>
                <th>Message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {priceFlags.map(f => (
                <tr key={f.id}>
                  <td className="mono">{new Date(f.ts).toLocaleDateString()}</td>
                  <td>{f.ticker}</td>
                  <td>{f.type}</td>
                  <td className="num">{f.move_pct != null ? f.move_pct.toFixed(1) : "—"}</td>
                  <td title={f.message}>{f.message}</td>
                  <td>
                    {f.type === 'CORP_ACTION_SUSPECT' && (
                      <button
                        className="secondary"
                        style={{ marginRight: 8 }}
                        onClick={async () => {
                          if (!confirm(`Apply suggested corporate action adjustment for ${f.ticker}? This rescales historical candles before the flagged date.`)) return;
                          const res = await tsmom.applyCorporateAction(f.id);
                          alert(`Applied factor=${res.factor} for ${res.ticker}. Updated candles: ${res.updatedCandles}`);
                          await loadSync();
                          // Prices changed; plan should be recomputed.
                          setPlan(null);
                        }}
                      >
                        Apply
                      </button>
                    )}
                    <button
                      className="secondary"
                      onClick={async () => {
                        await tsmom.ackPriceFlag(f.id);
                        await loadSync();
                      }}
                    >
                      Ack
                    </button>
                  </td>
                </tr>
              ))}
              {!priceFlags.length && (
                <tr>
                  <td colSpan={6}>No open flags.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", color: "#9aa4b2" }}>Recent sync runs</summary>
          <table className="table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Assets</th>
                <th>Updated</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.map(r => {
                let warnCount = 0;
                try {
                  warnCount = Array.isArray(JSON.parse(r.warnings || '[]')) ? JSON.parse(r.warnings || '[]').length : 0;
                } catch {
                  warnCount = 0;
                }
                return (
                  <tr key={r.id}>
                    <td>{new Date(r.started_at).toLocaleString()}</td>
                    <td>{r.status}</td>
                    <td>{r.assets}</td>
                    <td>{r.updated}</td>
                    <td>{warnCount}</td>
                  </tr>
                );
              })}
              {!syncRuns.length && (
                <tr>
                  <td colSpan={5}>No sync runs recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </details>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Signal Matrix</h3>
          <div className="row" style={{ gap: 8 }}>
            <input
              value={matrixFilter}
              onChange={e => setMatrixFilter(e.target.value)}
              placeholder="Filter ticker / name / category"
              style={{ minWidth: 240 }}
            />
            <button className="ghost" onClick={loadSignalMatrix} disabled={loadingMatrix}>
              {loadingMatrix ? 'Loading…' : 'Reload'}
            </button>
          </div>
        </div>

        <div className="bt-table-wrap" style={{ marginTop: 10 }}>
          <table className="bt-table">
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th>Ticker</th>
                <th>Name</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th className="num">Momentum</th>
                <th className="num">Vol</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatrix.map(r => {
                const mom = r.momentum != null ? r.momentum * 100 : null;
                const momClass = mom == null ? '' : mom >= 0 ? 'pos' : 'neg';
                return (
                  <tr key={r.ticker} className={r.isTopK ? 'selected' : ''}>
                    <td className="num mono">{r.rank ?? '—'}</td>
                    <td className="mono">{r.ticker}</td>
                    <td title={r.name ?? undefined}>{r.name ?? '—'}</td>
                    <td>{r.category ?? '—'}</td>
                    <td className="num mono">{r.price != null ? r.price.toFixed(3) : '—'}</td>
                    <td className={`num mono ${momClass}`}>{mom != null ? (mom >= 0 ? '+' : '') + mom.toFixed(2) + '%' : '—'}</td>
                    <td className="num mono">{r.sigmaAnn != null ? r.sigmaAnn.toFixed(3) : '—'}</td>
                  </tr>
                );
              })}
              {!filteredMatrix.length && (
                <tr>
                  <td colSpan={7}>No rows.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p style={{ color: '#9aa4b2', marginBottom: 0 }}>
          Top {signalMatrix?.params.topK ?? 5} positive-momentum assets are highlighted.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Performance Analytics</h3>
          <button className="ghost" onClick={loadPerformance} disabled={loadingPerf}>
            {loadingPerf ? 'Loading…' : 'Reload'}
          </button>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="bt-badge">Benchmark: {perf?.benchmark ?? '—'}</span>
          <span className="bt-badge">Points: {perf?.points?.length ?? 0}</span>
        </div>

        <div className="chart-wrap" style={{ height: 260, marginTop: 10 }}>
          <EquityChart points={(perf?.points || []) as any} />
        </div>

        {!perf?.points?.length && (
          <p style={{ color: '#9aa4b2', marginBottom: 0 }}>
            Need benchmark candles in the DB (tries TA125.TA, TA35.TA, SPY).
          </p>
        )}
      </div>

      <div className="card">
        <h3>Universe</h3>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ color: "#9aa4b2" }}>
            DB-owned universe seeded from expanded JSON.
          </div>
          <button className="ghost" onClick={loadUniverse} disabled={loadingUniverse}>
            {loadingUniverse ? "Loading…" : "Reload"}
          </button>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Name</th>
              <th>Category</th>
              <th>Status</th>
              <th>Yahoo</th>
              <th>Multiplier</th>
            </tr>
          </thead>
          <tbody>
            {universe.map(a => (
              <tr key={a.ticker}>
                <td>{a.ticker}</td>
                <td>{a.name ?? "—"}</td>
                <td>{a.category ?? "—"}</td>
                <td>{a.status}</td>
                <td>{a.yahoo_symbol ?? "—"}</td>
                <td>{Number(a.price_multiplier ?? 1).toFixed(4)}</td>
              </tr>
            ))}
            {!universe.length && (
              <tr>
                <td colSpan={6}>Universe is empty (seed may not have run yet).</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Capital Ledger</h3>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ color: "#9aa4b2" }}>Track deposits/withdrawals to match your bank.</div>
          <button className="ghost" onClick={loadLedger} disabled={loadingLedger}>
            {loadingLedger ? "Loading…" : "Reload"}
          </button>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <select value={cashType} onChange={e => setCashType(e.target.value as any)}>
            <option value="DEPOSIT">DEPOSIT</option>
            <option value="WITHDRAWAL">WITHDRAWAL</option>
            <option value="ADJUSTMENT">ADJUSTMENT</option>
          </select>
          <input
            type="number"
            step="any"
            value={cashAmount}
            onChange={e => setCashAmount(Number(e.target.value))}
            placeholder="Amount (NIS)"
            style={{ width: 160 }}
          />
          <input
            value={cashDesc}
            onChange={e => setCashDesc(e.target.value)}
            placeholder="Description"
            style={{ minWidth: 260 }}
          />
          <button className="primary" onClick={addCashFlow}>Add cash flow</button>
        </div>

        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {ledger.map(l => (
              <tr key={l.id}>
                <td>{new Date(l.ts).toLocaleString()}</td>
                <td>{l.type}</td>
                <td style={{ color: l.amount >= 0 ? "#9bff9f" : "#ff9b9b" }}>{Number(l.amount).toFixed(2)}</td>
                <td>{l.description ?? "—"}</td>
                <td>
                  <button
                    className="secondary"
                    onClick={async () => {
                      if (!confirm(`Delete ledger entry #${l.id}?`)) return;
                      await tsmom.deleteLedgerEntry(l.id);
                      await loadLedger();
                      setPlan(null);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!ledger.length && (
              <tr>
                <td colSpan={5}>No cash flows yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Trade Record Book</h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={loadTrades} disabled={loadingTrades}>
              {loadingTrades ? "Loading…" : "Reload"}
            </button>
            <button className="primary" onClick={exportTradesMarkdown} disabled={!trades.length}>
              Copy Markdown
            </button>
          </div>
        </div>

        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Fee</th>
              <th>Strategy</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => (
              <tr key={t.id}>
                <td>{new Date(t.ts).toLocaleString()}</td>
                <td>{t.symbol}</td>
                <td><span className={`badge ${t.side === "BUY" ? "buy" : "sell"}`}>{t.side}</span></td>
                <td>{Number(t.qty)}</td>
                <td>{Number(t.price)}</td>
                <td>{t.fee ?? "—"}</td>
                <td>{t.strategy_tag ?? "—"}</td>
                <td>{t.notes ?? "—"}</td>
              </tr>
            ))}
            {!trades.length && (
              <tr>
                <td colSpan={8}>No TSMOM trades recorded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Turbo v2 Plan</h3>
          <button className="primary" onClick={computePlan} disabled={loadingPlan}>
            {loadingPlan ? "Computing…" : "Compute plan"}
          </button>
        </div>

        {!plan && <p style={{ color: "#9aa4b2" }}>Compute a plan to see target weights and deltas.</p>}

        {plan && (
          <>
            <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
              <span className="bt-badge">As of: {plan.asOf}</span>
              <span className="bt-badge">Equity: {plan.equityNIS.toFixed(2)} NIS</span>
              <span className="bt-badge">Cash: {plan.cashNIS.toFixed(2)} NIS</span>
              <span className="bt-badge">Holdings: {plan.holdingsValueNIS.toFixed(2)} NIS</span>
              <span className="bt-badge">TopK: {plan.params.topK}</span>
              <span className="bt-badge">TargetVol: {plan.params.targetVolAnn}</span>
              <span className="bt-badge">EWMA COM: {plan.params.volCenterDaysCOM}</span>
              <span className="bt-badge">Lookback/Skip: {plan.params.lookbackTradingDays}/{plan.params.skipRecentTradingDays}</span>
            </div>

            {!!plan.warnings?.length && (
              <div className="bt-year-stats">
                {plan.warnings.map((w, i) => (
                  <div key={i} className="bt-badge warn">{w}</div>
                ))}
              </div>
            )}

            <div className="bt-table-wrap" style={{ marginTop: 12 }}>
              <table className="bt-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Ticker</th>
                    <th className="num">Px</th>
                    <th className="num">Mom</th>
                    <th className="num">Sigma</th>
                    <th className="num">W</th>
                    <th className="num">Cur</th>
                    <th className="num">Tgt</th>
                    <th className="num">Δ</th>
                    <th className="num">Fill Px</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map(it => {
                    const fillPx = fillPrices[it.ticker];
                    const actionClass = it.action === "BUY" ? "pos" : it.action === "SELL" ? "neg" : "";
                    return (
                      <tr key={it.ticker}>
                        <td className={actionClass}>{it.action}</td>
                        <td title={it.name ?? undefined}>{it.ticker}</td>
                        <td className="num">{it.price?.toFixed(3) ?? "—"}</td>
                        <td className="num">{it.momentum != null ? (it.momentum * 100).toFixed(2) + "%" : "—"}</td>
                        <td className="num">{it.sigmaAnn != null ? it.sigmaAnn.toFixed(3) : "—"}</td>
                        <td className="num">{(it.targetWeight * 100).toFixed(2)}%</td>
                        <td className="num">{it.currentQty}</td>
                        <td className="num">{it.targetQty}</td>
                        <td className={`num ${actionClass}`}>{it.deltaQty}</td>
                        <td className="num">
                          {it.action === "HOLD" ? (
                            "—"
                          ) : (
                            <input
                              type="number"
                              step="any"
                              value={fillPx ?? ""}
                              placeholder={it.price?.toString() ?? ""}
                              onChange={e => {
                                const v = Number(e.target.value);
                                setFillPrices(prev => ({ ...prev, [it.ticker]: v }));
                              }}
                              style={{ width: 110 }}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!plan.items.length && (
                    <tr>
                      <td colSpan={10}>No plan items (need candles + active assets).</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <h3>Record Executed Trades</h3>
              <p style={{ color: "#9aa4b2", marginTop: 0 }}>
                This only records fills to your local journal. It does not place orders.
              </p>

              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <label className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={confirmExecuted} onChange={e => setConfirmExecuted(e.target.checked)} />
                  I executed these trades in my bank
                </label>

                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={includeExecCashFlow}
                    onChange={e => setIncludeExecCashFlow(e.target.checked)}
                  />
                  Also record a cash flow
                </label>

                <input
                  style={{ minWidth: 280 }}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Notes"
                />

                <input
                  type="number"
                  step="any"
                  value={commissionNIS}
                  onChange={e => setCommissionNIS(Number(e.target.value))}
                  style={{ width: 140 }}
                  title="Commission per trade (NIS)"
                />

                <button className="primary" onClick={executeTrades} disabled={!tradeDraft.length}>
                  Record {tradeDraft.length} trades
                </button>
              </div>

              {includeExecCashFlow && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <select value={execCashType} onChange={e => setExecCashType(e.target.value as any)}>
                    <option value="DEPOSIT">DEPOSIT</option>
                    <option value="WITHDRAWAL">WITHDRAWAL</option>
                    <option value="ADJUSTMENT">ADJUSTMENT</option>
                  </select>
                  <input
                    type="number"
                    step="any"
                    value={execCashAmount}
                    onChange={e => setExecCashAmount(Number(e.target.value))}
                    style={{ width: 160 }}
                    placeholder="Amount"
                    title="Cash flow amount (NIS)"
                  />
                  <input
                    style={{ minWidth: 280 }}
                    value={execCashDesc}
                    onChange={e => setExecCashDesc(e.target.value)}
                    placeholder="Description"
                  />
                </div>
              )}

              {!tradeDraft.length && (
                <p style={{ color: "#9aa4b2" }}>
                  No executable trades yet (fill prices missing or all deltas are 0).
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
