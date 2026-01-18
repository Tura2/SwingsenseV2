import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import TickerLogo from "../components/TickerLogo";
import type { QuoteLite } from "@shared/types";

type Currency = "USD" | "ILS";

type PortfolioRow = {
  id: number;
  name: string;
  base_currency: Currency;
};

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
  positions: Array<{ ticker: string; qty: number; lastPrice: number | null; assetCurrency: Currency; fxRateToBase: number; valueBase: number }>;
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

type AssetRow = {
  ticker: string;
  name: string | null;
  category: string | null;
  status: string | null;
  yahoo_symbol?: string | null;
};

type PlanItem = {
  ticker: string;
  name: string | null;
  price: number | null;
  targetQty: number;
  currentQty: number;
  deltaQty: number;
  action: "BUY" | "SELL" | "HOLD";
};

type Plan = {
  asOf: string;
  baseCurrency?: Currency;
  items: PlanItem[];
  warnings?: string[];
};

function normalizeTicker(raw: string) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function formatMoney(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(2);
}

function uniq(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const t = normalizeTicker(x);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function Modal(props: { title: string; open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!props.open) return null;
  return (
    <div className="modalBackdrop" onMouseDown={props.onClose} role="dialog" aria-modal="true">
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modalHeader">
          <div className="modalTitle">{props.title}</div>
          <button className="ghost" onClick={props.onClose} title="Close">
            Close
          </button>
        </div>
        <div className="modalBody">{props.children}</div>
      </div>
    </div>
  );
}

export default function Wealth() {
  const navigate = useNavigate();
  const api = (window as any).api as undefined | {
    getQuotes?(symbols: string[]): Promise<QuoteLite[]>;
    portfolios?: {
      list(): Promise<any[]>;
      create(payload: { name: string; baseCurrency?: Currency; strategyRef?: string; meta?: any }): Promise<any>;
      delete(id: number): Promise<{ ok: true }>;
      getSnapshot(opts?: { portfolioId?: number }): Promise<Snapshot>;
      universe: {
        list(opts?: { portfolioId?: number }): Promise<string[]>;
        getMode(opts?: { portfolioId?: number }): Promise<"default" | "custom">;
        addTicker(payload: { portfolioId?: number; ticker: string; skipPreflight?: boolean }): Promise<{ ok: true }>;
        removeTicker(payload: { portfolioId?: number; ticker: string }): Promise<{ ok: true }>;
        setAll(payload: { portfolioId?: number; tickers: string[]; skipPreflight?: boolean }): Promise<{ ok: true }>;
      };
    };
    tsmom?: {
      computePlan(opts?: { portfolioId?: number }): Promise<Plan>;
      executeTrades(payload: any): Promise<{ ok: true }>;
      addLedgerEntry(payload: { portfolioId?: number; ts?: number; amount: number; type: "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT"; description?: string; meta?: any }): Promise<{ id: number; ts: number }>;
      getUniverse(opts?: { portfolioId?: number }): Promise<AssetRow[]>;
      getSignalMatrix(opts?: { portfolioId?: number }): Promise<{ asOf: string; params: any; rows: SignalMatrixRow[] }>;
    };
  };

  if (!api?.portfolios || !api?.tsmom) {
    return (
      <div className="card" style={{ borderColor: "#733", color: "#ffb3b3" }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window.
      </div>
    );
  }

  const portfoliosApi = api.portfolios;
  const tsmomApi = api.tsmom;

  const [portfolios, setPortfolios] = useState<PortfolioRow[]>([]);
  const [portfolioId, setPortfolioId] = useState<number>(() => {
    const v = Number(localStorage.getItem("wealth.portfolioId") || "1");
    return Number.isFinite(v) && v > 0 ? v : 1;
  });

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadingSnap, setLoadingSnap] = useState(false);

  const [universe, setUniverse] = useState<string[]>([]);
  const [universeIsCustom, setUniverseIsCustom] = useState(false);
  const [loadingUniverse, setLoadingUniverse] = useState(false);
  const [universeErr, setUniverseErr] = useState<string | null>(null);
  const [universeCollapsed, setUniverseCollapsed] = useState<boolean>(() => {
    const raw = localStorage.getItem("wealth.universeCollapsed");
    return raw == null ? true : raw === "1";
  });

  const [universeAddOpen, setUniverseAddOpen] = useState(false);
  const [universeAddText, setUniverseAddText] = useState("");
  const [universeAddErr, setUniverseAddErr] = useState<string | null>(null);
  const [universeAddSaving, setUniverseAddSaving] = useState(false);
  const [universeAddReplace, setUniverseAddReplace] = useState(false);
  const [universeAddSkipValidation, setUniverseAddSkipValidation] = useState(true);

  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [signalMatrixRows, setSignalMatrixRows] = useState<SignalMatrixRow[]>([]);
  const [loadingUniverseMeta, setLoadingUniverseMeta] = useState(false);
  const [universeMetaErr, setUniverseMetaErr] = useState<string | null>(null);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [newName, setNewName] = useState("");
  const [newBase, setNewBase] = useState<Currency>("ILS");
  const [createUniverseInput, setCreateUniverseInput] = useState("");
  const [createUniverse, setCreateUniverse] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const [cashModalOpen, setCashModalOpen] = useState(false);
  const [cashMode, setCashMode] = useState<"DEPOSIT" | "WITHDRAWAL">("DEPOSIT");
  const [cashAmount, setCashAmount] = useState<number>(0);
  const [cashDesc, setCashDesc] = useState<string>("");
  const [cashErr, setCashErr] = useState<string | null>(null);
  const [cashSaving, setCashSaving] = useState(false);

  const [confirmExecuted, setConfirmExecuted] = useState(false);
  const [commissionBase, setCommissionBase] = useState(5);
  const [fillQtys, setFillQtys] = useState<Record<string, number>>({});
  const [fillPrices, setFillPrices] = useState<Record<string, number>>({});
  const [fillCostBase, setFillCostBase] = useState<Record<string, number>>({});
  const [fillFxRates, setFillFxRates] = useState<Record<string, number>>({});

  const [quotes, setQuotes] = useState<Record<string, QuoteLite>>({});

  async function loadPortfolios() {
    const rows = await portfoliosApi.list();
    const list = (rows || []).map((p: any) => ({
      id: Number(p.id),
      name: String(p.name),
      base_currency: (String(p.base_currency || "ILS").toUpperCase() === "USD" ? "USD" : "ILS") as Currency,
    }));
    setPortfolios(list);
    if (list.length && !list.some(p => p.id === portfolioId)) {
      setPortfolioId(list[0].id);
    }
  }

  async function loadSnapshot(pid = portfolioId) {
    setLoadingSnap(true);
    try {
      const s = await portfoliosApi.getSnapshot({ portfolioId: pid });
      setSnapshot(s);
    } finally {
      setLoadingSnap(false);
    }
  }

  async function loadUniverse(pid = portfolioId) {
    setLoadingUniverse(true);
    setUniverseErr(null);
    try {
      const [mode, list] = await Promise.all([
        portfoliosApi.universe.getMode({ portfolioId: pid }),
        portfoliosApi.universe.list({ portfolioId: pid }),
      ]);
      setUniverseIsCustom(mode === "custom");
      setUniverse(Array.isArray(list) ? list.map(normalizeTicker).filter(Boolean) : []);
    } catch (e: any) {
      setUniverse([]);
      setUniverseIsCustom(false);
      setUniverseErr(String(e?.message || e || "Failed to load universe"));
    } finally {
      setLoadingUniverse(false);
    }
  }

  async function loadUniverseMeta() {
    setLoadingUniverseMeta(true);
    setUniverseMetaErr(null);
    try {
      const [u, m] = await Promise.all([
        tsmomApi.getUniverse({ portfolioId }),
        tsmomApi.getSignalMatrix({ portfolioId }),
      ]);
      setAssets(Array.isArray(u) ? u : []);
      setSignalMatrixRows(Array.isArray(m?.rows) ? m.rows : []);
    } catch (e: any) {
      setUniverseMetaErr(String(e?.message || e || 'Failed to load universe metadata'));
    } finally {
      setLoadingUniverseMeta(false);
    }
  }

  async function loadAssetsOnly(pid = portfolioId) {
    try {
      const u = await tsmomApi.getUniverse({ portfolioId: pid });
      setAssets(Array.isArray(u) ? u : []);
    } catch {
      // ignore
    }
  }

  async function ensureCustomUniverseForEditing() {
    // If the portfolio has no custom universe rows, it uses the default (assets table).
    // For add/remove editing, materialize the default tickers into a custom universe once.
    if (universeIsCustom) return;
    const u = await tsmomApi.getUniverse({ portfolioId });
    const list = Array.isArray(u) ? u : [];
    if (!assets.length) setAssets(list);
    const defaultTickers = list.map(a => normalizeTicker(a.ticker)).filter(Boolean);
    if (!defaultTickers.length) {
      throw new Error('Default universe is empty; cannot create custom universe.');
    }
    await portfoliosApi.universe.setAll({ portfolioId, tickers: defaultTickers, skipPreflight: true });
    await loadUniverse();
  }

  async function addUniverseTicker(pid: number, ticker: string) {
    const t = normalizeTicker(ticker);
    if (!t) return;
    const shouldAutoExpand = universeCollapsed && universe.length === 0;
    setUniverseErr(null);
    if (!universeIsCustom) await ensureCustomUniverseForEditing();
    await portfoliosApi.universe.addTicker({ portfolioId: pid, ticker: t });
    await loadUniverse(pid);
    if (shouldAutoExpand) setUniverseCollapsed(false);
  }

  async function removeUniverseTicker(pid: number, ticker: string) {
    const t = normalizeTicker(ticker);
    if (!t) return;
    setUniverseErr(null);
    await portfoliosApi.universe.removeTicker({ portfolioId: pid, ticker: t });
    await loadUniverse(pid);
  }

  async function computePlan() {
    const cash = Number(snapshot?.cashBase ?? 0);
    if (!universeTickers.length) {
      alert("Universe is empty. Add tickers first.");
      return;
    }
    if (!(cash > 0)) {
      alert("No cash available. Deposit funds before generating instructions.");
      return;
    }
    setLoadingPlan(true);
    try {
      const p = await tsmomApi.computePlan({ portfolioId });
      setPlan(p);

      // Prefill execution drafts
      const nextQty: Record<string, number> = {};
      const nextPx: Record<string, number> = {};
      const nextCost: Record<string, number> = {};
      const nextFx: Record<string, number> = {};

      const base = (p.baseCurrency || snapshot?.baseCurrency || "ILS") as Currency;

      for (const it of p.items || []) {
        if (it.action === "HOLD" || !Number(it.deltaQty)) continue;

        const absQty = Math.abs(Number(it.deltaQty));
        if (Number.isFinite(absQty) && absQty > 0) nextQty[it.ticker] = absQty;

        const px = Number(it.price);
        if (Number.isFinite(px) && px > 0) nextPx[it.ticker] = px;

        const isUsdAsset = !String(it.ticker).toUpperCase().endsWith(".TA");
        const tradeCcy: Currency = isUsdAsset ? "USD" : "ILS";
        const needsFx = tradeCcy !== base;

        // If we have a snapshot and FX is missing, snapshot warnings will show.
        // Here we only prefill FX rate if we can infer it from snapshot position fxRateToBase.
        if (needsFx) {
          const fxFromSnapshot = snapshot?.positions?.find(pos => pos.ticker === it.ticker)?.fxRateToBase;
          if (Number.isFinite(Number(fxFromSnapshot)) && Number(fxFromSnapshot) > 0) {
            nextFx[it.ticker] = Number(fxFromSnapshot);
          }
          if (Number.isFinite(absQty) && Number.isFinite(px) && absQty > 0 && px > 0 && Number.isFinite(Number(nextFx[it.ticker])) && Number(nextFx[it.ticker]) > 0) {
            nextCost[it.ticker] = absQty * px * Number(nextFx[it.ticker]);
          }
        }
      }

      setFillQtys(prev => ({ ...nextQty, ...prev }));
      setFillPrices(prev => ({ ...nextPx, ...prev }));
      setFillFxRates(prev => ({ ...nextFx, ...prev }));
      setFillCostBase(prev => ({ ...nextCost, ...prev }));
      setConfirmExecuted(false);
    } finally {
      setLoadingPlan(false);
    }
  }

  const instructions = useMemo(() => {
    const items = (plan?.items || [])
      .filter(it => it.action !== "HOLD" && Number(it.deltaQty) !== 0)
      .map(it => {
        const side = it.deltaQty > 0 ? "BUY" : "SELL";
        const qty = Number(fillQtys[it.ticker] ?? Math.abs(Number(it.deltaQty)));
        const price = Number(fillPrices[it.ticker] ?? it.price);
        const notionalBase = Number(fillCostBase[it.ticker]);
        const fxRate = Number(fillFxRates[it.ticker]);
        return { ticker: it.ticker, name: it.name, side, qty, price, notionalBase, fxRate };
      })
      .filter(t => Number.isFinite(t.qty) && t.qty > 0 && Number.isFinite(t.price) && t.price > 0);

    return items;
  }, [plan, fillQtys, fillPrices, fillCostBase, fillFxRates]);

  async function recordExecution() {
    if (!plan) return;
    if (!confirmExecuted) {
      alert("Please confirm you executed these trades in your broker before recording them.");
      return;
    }

    const base = (plan.baseCurrency || snapshot?.baseCurrency || "ILS") as Currency;

    for (const t of instructions) {
      const isUsdAsset = !String(t.ticker).toUpperCase().endsWith(".TA");
      const tradeCurrency: Currency = isUsdAsset ? "USD" : "ILS";
      if (tradeCurrency !== base) {
        const hasBaseCost = Number.isFinite(Number(t.notionalBase)) && Number(t.notionalBase) > 0;
        const hasFxRate = Number.isFinite(Number(t.fxRate)) && Number(t.fxRate) > 0;
        if (!hasBaseCost && !hasFxRate) {
          alert(`Missing FX data for ${t.ticker}. Provide either Cost (${base}) or an FX rate.`);
          return;
        }
      }
    }

    await tsmomApi.executeTrades({
      portfolioId,
      ts: Date.now(),
      strategyTag: "TSMOM_TURBO_V2",
      commissionBase: Number(commissionBase) || 5,
      trades: instructions.map(t => {
        const isIls = String(t.ticker).toUpperCase().endsWith(".TA");
        const tradeCurrency: Currency = isIls ? "ILS" : "USD";
        return {
          ticker: t.ticker,
          side: t.side,
          qty: Number(t.qty),
          price: Number(t.price),
          tradeCurrency,
          ...(Number.isFinite(Number(t.notionalBase)) && Number(t.notionalBase) > 0 ? { notionalBase: Number(t.notionalBase) } : {}),
          ...(Number.isFinite(Number(t.fxRate)) && Number(t.fxRate) > 0 ? { fxRate: Number(t.fxRate) } : {}),
          meta: { source: "wealth-ui", kind: "execution" },
        };
      }),
    });

    alert("Recorded execution.");
    setPlan(null);
    setConfirmExecuted(false);
    await loadSnapshot();
  }

  useEffect(() => {
    void loadPortfolios();
  }, []);

  useEffect(() => {
    localStorage.setItem("wealth.portfolioId", String(portfolioId));
    void loadSnapshot();
    void loadUniverse();
    setAssets([]);
    setSignalMatrixRows([]);
    setQuotes({});
    void loadAssetsOnly(portfolioId);
    setPlan(null);
    setConfirmExecuted(false);
  }, [portfolioId]);

  useEffect(() => {
    localStorage.setItem("wealth.universeCollapsed", universeCollapsed ? "1" : "0");
  }, [universeCollapsed]);

  const baseCurrency: Currency = (snapshot?.baseCurrency || "ILS") as Currency;

  const selectedPortfolio = portfolios.find(p => p.id === portfolioId) || null;
  const canDelete = portfolios.length > 1;
  const universeMode = universeIsCustom ? "Custom universe" : "Default universe";

  const assetsByTicker = useMemo(() => {
    const map: Record<string, AssetRow> = {};
    for (const a of assets) map[normalizeTicker(a.ticker)] = a;
    return map;
  }, [assets]);

  const matrixByTicker = useMemo(() => {
    const map: Record<string, SignalMatrixRow> = {};
    for (const r of signalMatrixRows) map[normalizeTicker(r.ticker)] = r;
    return map;
  }, [signalMatrixRows]);

  const defaultTickers = useMemo(() => assets.map(a => normalizeTicker(a.ticker)).filter(Boolean), [assets]);
  const universeTickers = useMemo(() => {
    const list = universeIsCustom ? universe : defaultTickers;
    if (!universeIsCustom) return list;
    // Keep assets ordering when possible; add unknown tickers alphabetically at end.
    const set = new Set(list);
    const ordered: string[] = [];
    for (const t of defaultTickers) {
      if (set.has(t)) ordered.push(t);
    }
    const extras = list.filter(t => !defaultTickers.includes(t)).sort();
    return [...ordered, ...extras];
  }, [universeIsCustom, universe, defaultTickers]);

  const universeTickersSorted = useMemo(() => {
    const list = [...universeTickers];
    list.sort((a, b) => {
      const ra = matrixByTicker[a]?.rank;
      const rb = matrixByTicker[b]?.rank;
      const aa = ra == null ? Number.POSITIVE_INFINITY : Number(ra);
      const bb = rb == null ? Number.POSITIVE_INFINITY : Number(rb);
      if (aa !== bb) return aa - bb;
      return String(a).localeCompare(String(b));
    });
    return list;
  }, [universeTickers, matrixByTicker]);

  const universeSummary = useMemo(() => {
    if (universeIsCustom) return `${universe.length} tickers`;
    if (assets.length) return `${assets.length} tickers (default)`;
    return 'Using default universe';
  }, [universeIsCustom, universe.length, assets.length]);
  const cashAvailable = Number(snapshot?.cashBase ?? 0);
  const canGenerateInstructions = cashAvailable > 0 && universeTickers.length > 0;

  // Quotes polling (like Watchlists). For large universes, fetch in chunks.
  useEffect(() => {
    if (universeCollapsed) return;
    const getQuotes = api?.getQuotes;
    let timer: any;
    let cancelled = false;

    async function loadQuotes() {
      const fn = getQuotes;
      if (!fn) return;
      const symbols = universeTickers;
      if (!symbols.length) {
        setQuotes({});
        return;
      }
      try {
        const map: Record<string, QuoteLite> = {};
        const chunkSize = 120;
        for (let i = 0; i < symbols.length; i += chunkSize) {
          const chunk = symbols.slice(i, i + chunkSize);
          const data = await fn(chunk);
          if (cancelled) return;
          for (const q of (data || [])) map[String(q.symbol).toUpperCase()] = q;
        }
        setQuotes(map);
      } catch {
        // ignore transient errors
      }
    }

    loadQuotes();
    timer = setInterval(loadQuotes, 300000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [universeCollapsed, universeTickers.join(",")]);

  return (
    <div className="stack wealth">
      <div className="wealth-header">
        <div>
          <h2 className="wealth-title">Wealth</h2>
          <div className="wealth-subtitle">
            {selectedPortfolio ? (
              <>
                <span className="pill">#{selectedPortfolio.id}</span>
                <span className="pill">{selectedPortfolio.base_currency}</span>
                <span className="pill">{universeMode}</span>
              </>
            ) : (
              <span className="pill">Loading…</span>
            )}
          </div>
        </div>

        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={portfolioId} onChange={e => setPortfolioId(Number(e.target.value))}>
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} (#{p.id}, {p.base_currency})
              </option>
            ))}
            {!portfolios.length && <option value={1}>Default (#1)</option>}
          </select>

          <button
            className="ghost"
            onClick={() => {
              void loadSnapshot();
              void loadUniverse();
            }}
            disabled={loadingSnap || loadingUniverse}
            title="Refresh snapshot + universe"
          >
            {loadingSnap || loadingUniverse ? "Refreshing…" : "Refresh"}
          </button>

          <button
            className="ghost"
            onClick={() => {
              setCashMode("DEPOSIT");
              setCashAmount(0);
              setCashDesc("");
              setCashErr(null);
              setCashModalOpen(true);
            }}
            title="Deposit / Withdrawal"
          >
            Deposit / Withdraw
          </button>

          <button className="primary" onClick={() => setCreateOpen(true)}>
            Create
          </button>

          <button
            className="danger"
            disabled={!canDelete || deleting}
            title={canDelete ? "Delete portfolio" : "Cannot delete the last portfolio"}
            onClick={async () => {
              if (!canDelete) return;
              setDeleteErr(null);
              setDeleteOpen(true);
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      <div className="wealth-stats">
        <div className="card stat-card">
          <div className="stat-label">Net Asset Value</div>
          <div className="stat-value">{formatMoney(snapshot?.navBase)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Cash</div>
          <div className="stat-value">{formatMoney(snapshot?.cashBase)} <span className="stat-ccy">{baseCurrency}</span></div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Profit & Loss</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {(() => {
              const dAmt = snapshot?.pnlDailyBase;
              const dPct = snapshot?.pnlDailyPct;
              const dCls = dAmt == null ? '' : dAmt >= 0 ? 'pos' : 'neg';
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>Daily</div>
                  <div className={dCls} style={{ fontWeight: 750 }}>
                    {dAmt == null ? '—' : `${dAmt >= 0 ? '+' : ''}${formatMoney(dAmt)} ${baseCurrency}`}
                    <span style={{ marginLeft: 8, fontWeight: 650, opacity: .9 }}>
                      {dPct == null ? '' : `(${dPct >= 0 ? '+' : ''}${(dPct * 100).toFixed(2)}%)`}
                    </span>
                  </div>
                </div>
              );
            })()}

            {(() => {
              const oAmt = snapshot?.pnlOpenBase;
              const oPct = snapshot?.pnlOpenPct;
              const oCls = oAmt == null ? '' : oAmt >= 0 ? 'pos' : 'neg';
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>Open</div>
                  <div className={oCls} style={{ fontWeight: 750 }}>
                    {oAmt == null ? '—' : `${oAmt >= 0 ? '+' : ''}${formatMoney(oAmt)} ${baseCurrency}`}
                    <span style={{ marginLeft: 8, fontWeight: 650, opacity: .9 }}>
                      {oPct == null ? '' : `(${oPct >= 0 ? '+' : ''}${(oPct * 100).toFixed(2)}%)`}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {!!snapshot?.warnings?.length && (
        <div className="banner warn">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>FX / Data warnings</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {snapshot.warnings.slice(0, 8).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card wealth-card">
        <button
          className="collapsibleHeader"
          onClick={() => {
            const next = !universeCollapsed;
            setUniverseCollapsed(next);
            if (!next && (!assets.length || !signalMatrixRows.length)) {
              void loadUniverseMeta();
            }
          }}
          title={universeCollapsed ? "Expand" : "Collapse"}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <div className="collapsibleTitle">Universe</div>
            <div className="collapsibleSubtitle" style={{ marginTop: 0 }}>{universeSummary}</div>
          </div>
          <div className="collapsibleChevron">{universeCollapsed ? "▸" : "▾"}</div>
        </button>

        {!universeCollapsed && (
          <>
            {(universeErr || universeMetaErr) && (
              <div className="banner error" style={{ marginTop: 10 }}>
                {universeErr}
                {universeErr && universeMetaErr ? '\n' : ''}
                {universeMetaErr}
              </div>
            )}

            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button
                className="primary"
                onClick={() => {
                  setUniverseAddErr(null);
                  setUniverseAddText("");
                  setUniverseAddReplace(!universeIsCustom);
                  setUniverseAddSkipValidation(true);
                  setUniverseAddOpen(true);
                }}
              >
                Add
              </button>

              <button className="ghost" onClick={() => loadUniverse()} disabled={loadingUniverse}>
                {loadingUniverse ? "Loading…" : "Reload"}
              </button>
            </div>

            <div className="bt-table-wrap" style={{ marginTop: 12 }}>
              <table className="table watchlist-table bt-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Last</th>
                    <th className="num">Change %</th>
                    <th>Category</th>
                    <th className="num">Rank</th>
                    <th className="num">Momentum %</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {loadingUniverseMeta && !universeTickers.length && (
                    <tr><td colSpan={7} style={{ color: '#9aa4b2' }}>Loading…</td></tr>
                  )}

                  {universeTickersSorted.map(t => {
                    const a = assetsByTicker[t];
                    const m = matrixByTicker[t];
                    const q = quotes[t];
                    const chPct = q?.changePct;
                    const chColor = (q?.change ?? 0) > 0 ? '#9bff9f' : (q?.change ?? 0) < 0 ? '#ff9b9b' : undefined;
                    const mom = m?.momentum != null ? m.momentum * 100 : null;
                    const momClass = mom == null ? '' : mom >= 0 ? 'pos' : 'neg';
                    const canRemove = true;
                    return (
                      <tr
                        key={t}
                        className={`clickable${m?.isTopK ? ' selected' : ''}`}
                        onClick={() => navigate(`/ticker?symbol=${encodeURIComponent(t)}`)}
                        title="Click to open ticker"
                      >
                        <td className="symcell">
                          <span className="row symwrap">
                            <TickerLogo symbol={t} />
                            <span className="symtext">{t}</span>
                          </span>
                        </td>
                        <td className="num mono">{q?.last == null ? '—' : Number(q.last).toFixed(2)}</td>
                        <td className="num mono" style={{ color: chColor }}>{chPct == null ? '—' : `${Number(chPct).toFixed(2)}%`}</td>
                        <td title={a?.name ?? undefined}>{a?.category ?? '—'}</td>
                        <td className="num mono">{m?.rank ?? '—'}</td>
                        <td className={`num mono ${momClass}`}>{mom != null ? (mom >= 0 ? '+' : '') + mom.toFixed(2) + '%' : '—'}</td>
                        <td>
                          <button
                            className="ghost"
                            disabled={!canRemove}
                            title={universeIsCustom ? 'Remove from portfolio universe' : 'Remove will create a custom universe for this portfolio'}
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                if (!universeIsCustom) await ensureCustomUniverseForEditing();
                                await removeUniverseTicker(portfolioId, t);
                              } catch (err: any) {
                                setUniverseErr(String(err?.message || err || 'Failed to remove'));
                              }
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {!universeTickers.length && !loadingUniverseMeta && (
                    <tr><td colSpan={7} style={{ color: '#9aa4b2' }}>No tickers.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {!universeIsCustom && (
              <p style={{ color: 'var(--muted)', marginBottom: 0 }}>
                Showing the default universe. Add/remove will create a custom universe for this portfolio.
              </p>
            )}
          </>
        )}
      </div>

      <div className="card wealth-card">
        <h3 style={{ marginTop: 0 }}>Positions</h3>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Qty</th>
                <th className="num">Last</th>
                <th className="num">Value ({baseCurrency})</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot?.positions || []).map(p => (
                <tr key={p.ticker}>
                  <td>{p.ticker}</td>
                  <td className="num">{Number(p.qty).toFixed(4)}</td>
                  <td className="num">{p.lastPrice == null ? "—" : Number(p.lastPrice).toFixed(4)}</td>
                  <td className="num">{Number(p.valueBase).toFixed(2)}</td>
                </tr>
              ))}
              {!snapshot?.positions?.length && (
                <tr>
                  <td colSpan={4} style={{ color: "#9aa4b2" }}>No open positions.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card wealth-card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Action Center</h3>
          <button className="primary" onClick={computePlan} disabled={loadingPlan || !canGenerateInstructions}>
            {loadingPlan ? "Generating…" : "Generate instructions"}
          </button>
        </div>

        {!canGenerateInstructions && !loadingPlan && (
          <p style={{ color: "#9aa4b2" }}>
            {universeTickers.length === 0
              ? "Universe is empty. Add tickers to generate instructions."
              : "No cash available. Deposit funds to generate instructions."}
          </p>
        )}

        {!plan && <p style={{ color: "#9aa4b2" }}>Generate instructions to see what to buy/sell.</p>}

        {!!plan?.warnings?.length && (
          <div style={{ marginTop: 10, color: "#f59e0b" }}>
            {plan.warnings.slice(0, 6).map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        {!!plan && (
          <>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <span className="pill">As of: {plan.asOf}</span>
              <span className="pill">Base: {baseCurrency}</span>
              <span className="pill">Trades: {instructions.length}</span>
            </div>

            <div className="tableWrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Symbol</th>
                    <th className="num">Exec Qty</th>
                    <th className="num">Exec Px</th>
                    <th className="num">Exec FX</th>
                    <th className="num">Cost ({baseCurrency})</th>
                  </tr>
                </thead>
                <tbody>
                  {(plan.items || []).filter(it => it.action !== "HOLD" && Number(it.deltaQty) !== 0).map(it => {
                    const actionClass = it.action === "BUY" ? "buy" : "sell";
                    const isUsdAsset = !String(it.ticker).toUpperCase().endsWith(".TA");
                    const tradeCurrency: Currency = isUsdAsset ? "USD" : "ILS";
                    const needsFx = tradeCurrency !== baseCurrency;
                    const needsBaseCost = needsFx;

                    const q = fillQtys[it.ticker];
                    const px = fillPrices[it.ticker];
                    const fx = fillFxRates[it.ticker];
                    const cost = fillCostBase[it.ticker];

                    return (
                      <tr key={it.ticker}>
                        <td><span className={`badge ${actionClass}`}>{it.action}</span></td>
                        <td>{it.ticker}{it.name ? ` — ${it.name}` : ""}</td>
                        <td className="num">
                          <input
                            type="number"
                            step="any"
                            value={q ?? ""}
                            placeholder={String(Math.abs(Number(it.deltaQty) || 0))}
                            onChange={e => setFillQtys(prev => ({ ...prev, [it.ticker]: Number(e.target.value) }))}
                            style={{ width: 120 }}
                          />
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            step="any"
                            value={px ?? ""}
                            placeholder={it.price?.toString() ?? ""}
                            onChange={e => setFillPrices(prev => ({ ...prev, [it.ticker]: Number(e.target.value) }))}
                            style={{ width: 120 }}
                          />
                        </td>
                        <td className="num">
                          {needsFx ? (
                            <input
                              type="number"
                              step="any"
                              value={fx ?? ""}
                              placeholder="FX rate"
                              onChange={e => setFillFxRates(prev => ({ ...prev, [it.ticker]: Number(e.target.value) }))}
                              style={{ width: 120 }}
                              title={`FX rate to convert ${tradeCurrency} -> ${baseCurrency}. Optional if you provide Cost (${baseCurrency}).`}
                            />
                          ) : (
                            <span style={{ color: "#9aa4b2" }}>—</span>
                          )}
                        </td>
                        <td className="num">
                          {needsBaseCost ? (
                            <input
                              type="number"
                              step="any"
                              value={cost ?? ""}
                              placeholder={`Cost in ${baseCurrency}`}
                              onChange={e => setFillCostBase(prev => ({ ...prev, [it.ticker]: Number(e.target.value) }))}
                              style={{ width: 140 }}
                              title={`Provide executed gross cost/proceeds in ${baseCurrency} OR provide an FX rate.`}
                            />
                          ) : (
                            <span style={{ color: "#9aa4b2" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!instructions.length && (
                    <tr>
                      <td colSpan={6} style={{ color: "#9aa4b2" }}>No executable trades (all deltas are 0 or missing prices).</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={confirmExecuted} onChange={e => setConfirmExecuted(e.target.checked)} />
                I executed these trades in my broker
              </label>

              <input
                type="number"
                step="any"
                value={commissionBase}
                onChange={e => setCommissionBase(Number(e.target.value))}
                style={{ width: 160 }}
                title={`Commission per trade (${baseCurrency})`}
              />

              <button className="primary" onClick={recordExecution} disabled={!instructions.length}>
                Record execution
              </button>
            </div>
          </>
        )}
      </div>

      <Modal
        title="Create Portfolio"
        open={createOpen}
        onClose={() => {
          if (creating) return;
          setCreateOpen(false);
        }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name" style={{ minWidth: 240, flex: 1 }} />
            <select value={newBase} onChange={e => setNewBase(e.target.value as Currency)}>
              <option value="ILS">ILS</option>
              <option value="USD">USD</option>
            </select>
          </div>

          <div>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontWeight: 600 }}>Universe (optional)</div>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>Leave empty to use the default universe.</div>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <input
                value={createUniverseInput}
                onChange={e => setCreateUniverseInput(e.target.value)}
                placeholder="Add ticker (e.g. AAPL)"
                style={{ minWidth: 260, flex: 1 }}
              />
              <button
                onClick={() => {
                  const t = normalizeTicker(createUniverseInput);
                  if (!t) return;
                  setCreateUniverse(prev => (prev.includes(t) ? prev : [...prev, t]));
                  setCreateUniverseInput("");
                }}
              >
                Add
              </button>
            </div>

            {!!createUniverse.length && (
              <div className="chiplist" style={{ marginTop: 8 }}>
                {createUniverse.map(t => (
                  <span key={t} className="chip">
                    {t}
                    <button className="chipx" title="Remove" onClick={() => setCreateUniverse(prev => prev.filter(x => x !== t))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {createErr && <div className="banner error">{createErr}</div>}

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="primary"
              disabled={creating}
              onClick={async () => {
                const name = newName.trim();
                if (!name) return;
                setCreating(true);
                setCreateErr(null);
                try {
                  const created = await portfoliosApi.create({ name, baseCurrency: newBase, strategyRef: "TSMOM_TURBO_V2" });
                  const createdId = Number(created?.id);
                  const errors: string[] = [];
                  for (const t of createUniverse) {
                    try {
                      await portfoliosApi.universe.addTicker({ portfolioId: createdId, ticker: t });
                    } catch (e: any) {
                      errors.push(String(e?.message || e || `Failed to add ${t}`));
                    }
                  }

                  await loadPortfolios();
                  if (Number.isFinite(createdId) && createdId > 0) {
                    setPortfolioId(createdId);
                    await loadUniverse(createdId);
                    await loadSnapshot(createdId);
                    if (createUniverse.length) setUniverseCollapsed(false);
                  }

                  setNewName("");
                  setCreateUniverse([]);
                  setCreateUniverseInput("");
                  setCreateOpen(false);

                  if (errors.length) {
                    // Keep a toast-like alert for now
                    alert(errors.slice(0, 4).join("\n"));
                  }
                } catch (e: any) {
                  setCreateErr(String(e?.message || e || "Failed to create portfolio"));
                } finally {
                  setCreating(false);
                }
              }}
            >
              {creating ? "Creating…" : "Create"}
            </button>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Cash/NAV/Holdings are shown in base currency.</div>
          </div>
        </div>
      </Modal>

      <Modal
        title="Add tickers to universe"
        open={universeAddOpen}
        onClose={() => {
          if (universeAddSaving) return;
          setUniverseAddOpen(false);
        }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            Paste tickers separated by commas. Example: <span className="mono">AAPL, MSFT, SPY</span>
          </div>
          <textarea
            value={universeAddText}
            onChange={e => setUniverseAddText(e.target.value)}
            placeholder="AAPL, MSFT, SPY"
            style={{ width: '100%', minHeight: 110, resize: 'vertical', padding: 10, borderRadius: 12, border: '1px solid #222833', background: '#0f1115', color: 'var(--text)' }}
          />

          {(universeAddErr || universeErr) && <div className="banner error">{universeAddErr || universeErr}</div>}

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="primary"
              disabled={universeAddSaving}
              onClick={async () => {
                const parts = uniq(String(universeAddText || '').split(','));
                if (!parts.length) return;
                if (parts.length > 2000) {
                  setUniverseAddErr('Too many tickers (max 2000).');
                  return;
                }
                setUniverseAddErr(null);
                setUniverseAddSaving(true);
                try {
                  let tickersToSet: string[];

                  if (universeAddReplace) {
                    tickersToSet = parts;
                  } else {
                    // Add to the current effective universe.
                    // If we're still on the default universe, materialize it first.
                    if (!universeIsCustom) await ensureCustomUniverseForEditing();
                    tickersToSet = uniq([...universeTickers, ...parts]);
                  }

                  await portfoliosApi.universe.setAll({
                    portfolioId,
                    tickers: tickersToSet,
                    skipPreflight: universeAddSkipValidation,
                  });

                  await loadUniverse();
                  if (!assets.length || !signalMatrixRows.length) await loadUniverseMeta();
                  setUniverseAddText('');
                  setUniverseAddOpen(false);
                } catch (e: any) {
                  setUniverseAddErr(String(e?.message || e || 'Failed to add tickers'));
                } finally {
                  setUniverseAddSaving(false);
                }
              }}
            >
              {universeAddSaving ? 'Adding…' : 'Add'}
            </button>
            <button className="ghost" onClick={() => setUniverseAddOpen(false)} disabled={universeAddSaving}>
              Cancel
            </button>
          </div>

          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={universeAddReplace}
                disabled={universeAddSaving}
                onChange={e => setUniverseAddReplace(e.target.checked)}
              />
              Replace universe (set exactly these tickers)
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={universeAddSkipValidation}
                disabled={universeAddSaving}
                onChange={e => setUniverseAddSkipValidation(e.target.checked)}
              />
              Fast add (skip validation; candles fill in background)
            </label>
          </div>
        </div>
      </Modal>

      <Modal
        title="Delete portfolio"
        open={deleteOpen}
        onClose={() => {
          if (deleting) return;
          setDeleteOpen(false);
        }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <div style={{ color: 'var(--muted)' }}>
            Delete <span className="mono">{selectedPortfolio?.name || `#${portfolioId}`}</span>? This removes its cached state, universe, and NAV history.
          </div>
          {deleteErr && <div className="banner error">{deleteErr}</div>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="danger"
              disabled={!canDelete || deleting}
              onClick={async () => {
                if (!canDelete) return;
                setDeleting(true);
                setDeleteErr(null);
                try {
                  await portfoliosApi.delete(portfolioId);
                  await loadPortfolios();
                  setDeleteOpen(false);
                  // Switch to the first portfolio returned by list
                  const next = await portfoliosApi.list();
                  const first = (next || [])[0];
                  if (first?.id) setPortfolioId(Number(first.id));
                } catch (e: any) {
                  setDeleteErr(String(e?.message || e || 'Failed to delete portfolio'));
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button className="ghost" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        title="Deposit / Withdrawal"
        open={cashModalOpen}
        onClose={() => {
          if (cashSaving) return;
          setCashModalOpen(false);
        }}
      >
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className={cashMode === "DEPOSIT" ? "primary" : "ghost"} onClick={() => setCashMode("DEPOSIT")}>
              Deposit
            </button>
            <button className={cashMode === "WITHDRAWAL" ? "primary" : "ghost"} onClick={() => setCashMode("WITHDRAWAL")}>
              Withdraw
            </button>
            <span className="pill">Cash available: {formatMoney(cashAvailable)} {baseCurrency}</span>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              type="number"
              step="any"
              value={Number.isFinite(Number(cashAmount)) ? cashAmount : 0}
              onChange={e => setCashAmount(Number(e.target.value))}
              placeholder="Amount"
              style={{ minWidth: 180 }}
            />
            <input
              value={cashDesc}
              onChange={e => setCashDesc(e.target.value)}
              placeholder="Description (optional)"
              style={{ minWidth: 260, flex: 1 }}
            />
          </div>

          {cashErr && <div className="banner error">{cashErr}</div>}

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="primary"
              disabled={cashSaving}
              onClick={async () => {
                setCashErr(null);
                const amt = Number(cashAmount);
                if (!Number.isFinite(amt) || amt <= 0) {
                  setCashErr("Enter a positive amount.");
                  return;
                }

                if (cashMode === "WITHDRAWAL") {
                  if (amt > cashAvailable + 1e-9) {
                    setCashErr(`Withdrawal exceeds available cash (${formatMoney(cashAvailable)} ${baseCurrency}).`);
                    return;
                  }
                }

                setCashSaving(true);
                try {
                  const signed = cashMode === "WITHDRAWAL" ? -Math.abs(amt) : Math.abs(amt);
                  await tsmomApi.addLedgerEntry({
                    portfolioId,
                    amount: signed,
                    type: cashMode,
                    description: cashDesc.trim() || undefined,
                    meta: { source: "wealth-ui" },
                  });
                  setCashModalOpen(false);
                  setCashAmount(0);
                  setCashDesc("");
                  await loadSnapshot();
                } catch (e: any) {
                  setCashErr(String(e?.message || e || "Failed to record cash flow"));
                } finally {
                  setCashSaving(false);
                }
              }}
            >
              Save
            </button>
            <button className="ghost" onClick={() => setCashModalOpen(false)} disabled={cashSaving}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
