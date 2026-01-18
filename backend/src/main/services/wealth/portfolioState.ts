import { getDB } from '../../db.js';

export type Currency = 'USD' | 'ILS';

export type PortfolioState = {
  portfolioId: number;
  cashBase: number;
  positions: Record<string, number>; // ticker -> qty
  updatedAt: number;
};

function parsePositions(jsonText: string | null | undefined): Record<string, number> {
  if (!jsonText) return {};
  try {
    const obj = JSON.parse(String(jsonText));
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as any)) {
      const ticker = String(k || '').toUpperCase();
      const qty = Number(v);
      if (!ticker) continue;
      if (!Number.isFinite(qty) || qty === 0) continue;
      out[ticker] = qty;
    }
    return out;
  } catch {
    return {};
  }
}

function serializePositions(map: Record<string, number>): string {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const ticker = String(k || '').toUpperCase();
    const qty = Number(v);
    if (!ticker) continue;
    if (!Number.isFinite(qty) || qty === 0) continue;
    clean[ticker] = qty;
  }
  return JSON.stringify(clean);
}

export function getDefaultPortfolioId(): number {
  return 1;
}

export function ensurePortfolioStateRow(portfolioId: number) {
  const db = getDB();
  const pid = Number(portfolioId);
  const row = db.prepare('SELECT portfolio_id FROM portfolio_states WHERE portfolio_id=?').get(pid) as any;
  if (row?.portfolio_id) return;
  db.prepare('INSERT OR IGNORE INTO portfolio_states(portfolio_id, cash_base, positions_json, updated_at) VALUES(?,?,?,?)')
    .run(pid, 0, JSON.stringify({}), Date.now());
}

export function getPortfolioState(portfolioId: number): PortfolioState {
  const db = getDB();
  const pid = Number(portfolioId);
  ensurePortfolioStateRow(pid);
  const row = db.prepare('SELECT portfolio_id, cash_base, positions_json, updated_at FROM portfolio_states WHERE portfolio_id=?')
    .get(pid) as any;
  return {
    portfolioId: pid,
    cashBase: Number(row?.cash_base || 0),
    positions: parsePositions(row?.positions_json),
    updatedAt: Number(row?.updated_at || 0),
  };
}

export type ApplyLedgerOpts = {
  portfolioId: number;
  deltaCashBase: number;
  ts?: number;
};

export function applyLedgerToState(opts: ApplyLedgerOpts) {
  const db = getDB();
  const pid = Number(opts.portfolioId);
  const delta = Number(opts.deltaCashBase);
  const now = Number(opts.ts ?? Date.now());

  if (!Number.isFinite(pid) || pid <= 0) throw new Error('Invalid portfolioId');
  if (!Number.isFinite(delta)) throw new Error('Invalid deltaCashBase');

  const cur = getPortfolioState(pid);
  const nextCash = Number(cur.cashBase) + delta;

  db.prepare('UPDATE portfolio_states SET cash_base=?, positions_json=?, updated_at=? WHERE portfolio_id=?')
    .run(nextCash, serializePositions(cur.positions), now, pid);
}

export type ApplyTrade = {
  ticker: string;
  side: 'BUY' | 'SELL';
  qty: number;
  notionalBase: number; // gross amount in portfolio base currency
  feeBase: number; // fee in base currency
};

export type ApplyTradesOpts = {
  portfolioId: number;
  trades: ApplyTrade[];
  ts?: number;
};

export function applyTradesToState(opts: ApplyTradesOpts) {
  const db = getDB();
  const pid = Number(opts.portfolioId);
  const now = Number(opts.ts ?? Date.now());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('Invalid portfolioId');

  const cur = getPortfolioState(pid);
  const pos = { ...cur.positions };
  let cash = Number(cur.cashBase);

  for (const t of opts.trades) {
    const ticker = String(t.ticker || '').toUpperCase();
    const qty = Number(t.qty);
    const notionalBase = Number(t.notionalBase);
    const feeBase = Number(t.feeBase);
    if (!ticker) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(notionalBase) || notionalBase < 0) continue;

    const signedQty = t.side === 'BUY' ? qty : -qty;
    pos[ticker] = Number(pos[ticker] || 0) + signedQty;
    if (!Number.isFinite(pos[ticker]) || pos[ticker] === 0) delete pos[ticker];

    const fee = Number.isFinite(feeBase) ? feeBase : 0;
    if (t.side === 'BUY') cash -= notionalBase + fee;
    else cash += notionalBase - fee;
  }

  db.prepare('UPDATE portfolio_states SET cash_base=?, positions_json=?, updated_at=? WHERE portfolio_id=?')
    .run(cash, serializePositions(pos), now, pid);
}

export function rebuildPortfolioStateFromHistory(portfolioId: number) {
  const db = getDB();
  const pid = Number(portfolioId);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('Invalid portfolioId');

  // Ledger amounts are assumed to already be in base currency.
  const ledger = db
    .prepare('SELECT amount FROM capital_ledger WHERE portfolio_id=? ORDER BY ts ASC, id ASC')
    .all(pid) as Array<{ amount: number }>;
  const ledgerSum = ledger.reduce((a, r) => a + (Number(r.amount) || 0), 0);

  const trades = db
    .prepare('SELECT symbol, side, qty, notional_base, price, fee_base, fee FROM portfolio_trades WHERE portfolio_id=? ORDER BY ts ASC, id ASC')
    .all(pid) as any[];

  const pos: Record<string, number> = {};
  let cash = ledgerSum;

  for (const t of trades) {
    const symbol = String(t.symbol || '').toUpperCase();
    const side = String(t.side || '').toUpperCase() as 'BUY'|'SELL';
    const qty = Number(t.qty);
    if (!symbol || !Number.isFinite(qty)) continue;

    const signedQty = side === 'BUY' ? qty : -qty;
    pos[symbol] = (pos[symbol] || 0) + signedQty;
    if (pos[symbol] === 0) delete pos[symbol];

    const feeBase = Number.isFinite(Number(t.fee_base)) ? Number(t.fee_base) : (Number.isFinite(Number(t.fee)) ? Number(t.fee) : 0);

    let notionalBase = Number(t.notional_base);
    if (!Number.isFinite(notionalBase) || notionalBase < 0) {
      const price = Number(t.price);
      notionalBase = (Number.isFinite(price) ? price : 0) * qty;
    }

    if (side === 'BUY') cash -= notionalBase + feeBase;
    else cash += notionalBase - feeBase;
  }

  const now = Date.now();
  ensurePortfolioStateRow(pid);
  db.prepare('UPDATE portfolio_states SET cash_base=?, positions_json=?, updated_at=? WHERE portfolio_id=?')
    .run(cash, serializePositions(pos), now, pid);
}
