import { useEffect, useState } from "react";
import type { Position, Trade } from "@shared/types";
import TickerLogo from "../components/TickerLogo";

export default function Portfolio() {
  const api = (window as any).api as undefined | {
    addTrade(trade: Trade): Promise<void>;
    listTrades(): Promise<Trade[]>;
    getPositions(): Promise<Position[]>;
    deleteTrade(id: number): Promise<void>;
  };

  if (!api) {
    return (
      <div className="card" style={{ borderColor: "#733", color: "#ffb3b3" }}>
        Electron bridge unavailable. Please run this app via the Electron desktop window, not a normal browser.
      </div>
    );
  }
  // From here, api is defined
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);

  const [symbol, setSymbol] = useState("AAPL");
  const [side, setSide] = useState<"BUY"|"SELL">("BUY");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(100);

  async function load() {
    setTrades(await api!.listTrades());
    setPositions(await api!.getPositions());
  }
  useEffect(() => { load(); }, []);

  async function addTrade() {
    await api!.addTrade({
      symbol: symbol.trim().toUpperCase(),
      side,
      qty: Number(qty),
      price: Number(price),
      ts: Date.now()
    });
    setTrades(await api!.listTrades());
    setPositions(await api!.getPositions());
  }

  return (
    <>
      <h2>Portfolio</h2>

      <div className="card">
        <h3>New Trade</h3>
        <div className="row" style={{ gap: 8 }}>
          <input value={symbol} onChange={e=>setSymbol(e.target.value)} />
          <select value={side} onChange={e=>setSide(e.target.value as any)}>
            <option>BUY</option>
            <option>SELL</option>
          </select>
          <input type="number" step="any" value={qty} onChange={e=>setQty(+e.target.value)} placeholder="Qty" />
          <input type="number" step="any" value={price} onChange={e=>setPrice(+e.target.value)} placeholder="Price" />
          <button className="primary" onClick={addTrade}>Add</button>
        </div>
      </div>

      <div className="card">
        <h3>Positions</h3>
        <table className="table">
          <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&L</th></tr></thead>
          <tbody>
            {positions.map(p => (
              <tr key={p.symbol}>
                <td>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <TickerLogo symbol={p.symbol} />
                    <span>{p.symbol}</span>
                  </span>
                </td>
                <td>{p.qty}</td>
                <td>{p.avgPrice.toFixed(2)}</td>
                <td>{p.lastClose?.toFixed(2) ?? "—"}</td>
                <td style={{ color: (p.pnl ?? 0) >= 0 ? "#9bff9f" : "#ff9b9b" }}>{p.pnl?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
            {!positions.length && <tr><td colSpan={5}>No open positions.</td></tr>}
          </tbody>
        </table>
        <p style={{ color: "#9aa4b2" }}>Last close is taken from your cached daily candles. Visit Ticker to refresh a symbol.</p>
      </div>

      <div className="card">
        <h3>Trades</h3>
        <table className="table">
          <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th></th></tr></thead>
          <tbody>
            {trades.map(t => (
              <tr key={t.id}>
                <td>{new Date(t.ts).toLocaleString()}</td>
                <td>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <TickerLogo symbol={t.symbol} />
                    <span>{t.symbol}</span>
                  </span>
                </td>
                <td><span className={`badge ${t.side === "BUY" ? "buy" : "sell"}`}>{t.side}</span></td>
                <td>{t.qty}</td>
                <td>{t.price}</td>
                <td>
                  <button
                    className="secondary"
                    onClick={async () => {
                      if (!t.id) return;
                      await api!.deleteTrade(t.id);
                      // refresh both trades and positions
                      setTrades(await api!.listTrades());
                      setPositions(await api!.getPositions());
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!trades.length && <tr><td colSpan={6}>No trades yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
