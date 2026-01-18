import { useEffect, useMemo, useState, DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Watchlist, QuoteLite } from "@shared/types";
import TickerLogo from "../components/TickerLogo";

export default function Watchlists() {
  const api = (window as any).api as undefined | {
    listWatchlists(): Promise<Watchlist[]>;
    createWatchlist(name: string): Promise<Watchlist>;
    renameWatchlist(id: number, name: string): Promise<void>;
    deleteWatchlist(id: number): Promise<void>;
    getWatchlistSymbols(watchlistId: number): Promise<string[]>;
    addSymbolToWatchlist(watchlistId: number, symbol: string): Promise<void>;
    removeSymbolFromWatchlist(watchlistId: number, symbol: string): Promise<void>;
    getQuotes(symbols: string[]): Promise<QuoteLite[]>;
  };

  if (!api) {
    return (
      <div className="card" style={{ borderColor: "#733", color: "#ffb3b3" }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window, not a normal browser.
      </div>
    );
  }

  const navigate = useNavigate();
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [newListName, setNewListName] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [rename, setRename] = useState("");
  const [quotes, setQuotes] = useState<Record<string, QuoteLite>>({});

  async function refresh() {
    const l = await api!.listWatchlists();
    setLists(l);
    if (selected === null && l.length) setSelected(l[0].id);
  }
  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (selected) api!.getWatchlistSymbols(selected).then(setSymbols);
    else setSymbols([]);
  }, [selected]);

  // Quotes polling every 15s whenever symbols change
  useEffect(() => {
    let timer: any;
    let cancelled = false;
    async function loadQuotes() {
      if (!symbols.length) { setQuotes({}); return; }
      try {
        const data = await api!.getQuotes(symbols);
        if (cancelled) return;
        const map: Record<string, QuoteLite> = {};
        for (const q of data) map[q.symbol] = q;
        setQuotes(map);
      } catch {
        // ignore transient errors
      }
    }
    loadQuotes();
    timer = setInterval(loadQuotes, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbols.join(",")]);

  async function createList() {
    if (!newListName.trim()) return;
    const wl = await api!.createWatchlist(newListName.trim());
    setNewListName("");
    await refresh();
    setSelected(wl.id);
  }
  async function renameList() {
    if (!selected || !rename.trim()) return;
    await api!.renameWatchlist(selected, rename.trim());
    setRename("");
    await refresh();
  }
  async function deleteList() {
    if (!selected) return;
    await api!.deleteWatchlist(selected);
    setSelected(null);
    setSymbols([]);
    await refresh();
  }
  async function add() {
    if (!selected || !newSymbol.trim()) return;
    await api!.addSymbolToWatchlist(selected, newSymbol.trim().toUpperCase());
    setNewSymbol("");
    setSymbols(await api!.getWatchlistSymbols(selected));
  }
  async function remove(sym: string) {
    if (!selected) return;
    await api!.removeSymbolFromWatchlist(selected, sym);
    setSymbols(await api!.getWatchlistSymbols(selected));
  }

  function fmt(n: number | null | undefined, frac = 2) { return (n ?? undefined) === undefined ? "—" : (n as number).toFixed(frac); }

  function onDragSymbol(e: DragEvent, sym: string) {
    e.dataTransfer.setData('text/symbol', sym);
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDropSymbol(e: DragEvent) {
    if (!selected) return;
    const sym = e.dataTransfer.getData('text/symbol');
    if (sym && !symbols.includes(sym)) {
      api!.addSymbolToWatchlist(selected, sym).then(()=> api!.getWatchlistSymbols(selected).then(setSymbols));
    }
  }
  function onDragOver(e: DragEvent) { e.preventDefault(); }

  return (
    <>
      <h2>Watchlists</h2>

  <div className="card no-hover">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Symbols</h3>
          <select value={selected ?? ""} onChange={e => setSelected(Number(e.target.value))}>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input placeholder="Add symbol (e.g. AAPL)" value={newSymbol} onChange={e=>setNewSymbol(e.target.value)} />
          <button onClick={add}>Add</button>
        </div>

  <table className="table watchlist-table" onDragOver={onDragOver} onDrop={onDropSymbol}>
          <thead>
            <tr><th>Symbol</th><th style={{ textAlign: 'right' }}>Last</th><th style={{ textAlign: 'right' }}>Change</th><th style={{ textAlign: 'right' }}>Change %</th><th></th></tr>
          </thead>
          <tbody>
            {symbols.map(s => {
              const q = quotes[s] as QuoteLite | undefined;
              const color = (q?.change ?? 0) > 0 ? "#9bff9f" : (q?.change ?? 0) < 0 ? "#ff9b9b" : undefined;
              return (
                <tr key={s} className="clickable" onClick={() => navigate(`/ticker?symbol=${encodeURIComponent(s)}`)} draggable onDragStart={(e)=>onDragSymbol(e,s)} title="Drag to another list or click to open ticker">
                  <td className="symcell">
                    <span className="row symwrap">
                      <TickerLogo symbol={s} />
                      <span className="symtext">{s}</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(q?.last)}</td>
                  <td style={{ textAlign: 'right', color }}>{fmt(q?.change)}</td>
                  <td style={{ textAlign: 'right', color }}>{q?.changePct === null || q?.changePct === undefined ? '—' : `${q!.changePct!.toFixed(2)}%`}</td>
                  <td>
                    <button className="ghost" onClick={(e) => { e.stopPropagation(); remove(s); }} aria-label={`Remove ${s}`}>Remove</button>
                  </td>
                </tr>
              );
            })}
            {!symbols.length && <tr><td colSpan={5}>No symbols yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Manage Watchlists</h3>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input placeholder="New list name" value={newListName} onChange={e=>setNewListName(e.target.value)} />
          <button className="primary" onClick={createList}>New Watchlist</button>
          <input placeholder="Rename selected…" value={rename} onChange={e=>setRename(e.target.value)} />
          <button onClick={renameList}>Rename</button>
          <button onClick={deleteList} className="ghost">Delete</button>
        </div>
      </div>
    </>
  );
}
