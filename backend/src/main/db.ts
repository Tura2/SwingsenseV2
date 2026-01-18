import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

let db: Database.Database;

export function getDB() {
  if (!db) throw new Error("DB not initialized");
  return db;
}

export async function initDB(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const createSQL = `
  PRAGMA foreign_keys = ON;

  -- Backtests are intentionally not persisted anymore.
  -- Drop any legacy tables to remove stored history.
  DROP TABLE IF EXISTS bt_tsmom_equity;
  DROP TABLE IF EXISTS bt_tsmom_runs;
  DROP TABLE IF EXISTS bt_trades;
  DROP TABLE IF EXISTS bt_runs;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Generic persistent cache for computed results (e.g., signal matrices)
  CREATE TABLE IF NOT EXISTS app_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    deps TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_app_cache_updated_at ON app_cache(updated_at);

  -- Wealth / Portfolios
  CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    base_currency TEXT NOT NULL DEFAULT 'ILS' CHECK (base_currency IN ('USD','ILS')),
    strategy_ref TEXT,
    created_at INTEGER NOT NULL,
    meta TEXT
  );

  CREATE TABLE IF NOT EXISTS portfolio_states (
    portfolio_id INTEGER PRIMARY KEY REFERENCES portfolios(id) ON DELETE CASCADE,
    cash_base REAL NOT NULL DEFAULT 0,
    positions_json TEXT NOT NULL DEFAULT '{}',
    universe_mode TEXT NOT NULL DEFAULT 'default' CHECK (universe_mode IN ('default','custom')),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS portfolio_universe (
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (portfolio_id, ticker)
  );

  -- Portfolio-scoped asset metadata (keeps custom universes separate from the global seeded assets table)
  CREATE TABLE IF NOT EXISTS portfolio_assets (
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    name TEXT,
    category TEXT,
    yahoo_symbol TEXT,
    price_multiplier REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    meta TEXT,
    PRIMARY KEY (portfolio_id, ticker)
  );
  CREATE INDEX IF NOT EXISTS idx_portfolio_assets_pid ON portfolio_assets(portfolio_id);

  CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watchlist_symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    UNIQUE (watchlist_id, symbol)
  );

  CREATE TABLE IF NOT EXISTS portfolio_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL DEFAULT 1,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    qty REAL NOT NULL,
    price REAL NOT NULL,
    trade_currency TEXT,
    fx_rate REAL,
    notional_base REAL,
    fee_base REAL,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_portfolio_trades_ts ON portfolio_trades(ts);

  -- TSMOM Command Center
  CREATE TABLE IF NOT EXISTS assets (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    yahoo_symbol TEXT,
    price_multiplier REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

  CREATE TABLE IF NOT EXISTS capital_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL,
    amount REAL NOT NULL,
    currency TEXT,
    fx_rate REAL,
    type TEXT NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAWAL','ADJUSTMENT')),
    description TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_capital_ledger_ts ON capital_ledger(ts);

  CREATE TABLE IF NOT EXISTS portfolio_nav_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    nav_base REAL NOT NULL,
    cash_base REAL NOT NULL,
    holdings_value_base REAL NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_portfolio_nav_pid_ts ON portfolio_nav_history(portfolio_id, ts);

  -- TSMOM Sync observability
  CREATE TABLE IF NOT EXISTS tsmom_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    assets INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    warnings TEXT, -- JSON array
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tsmom_sync_runs_started ON tsmom_sync_runs(started_at);

  CREATE TABLE IF NOT EXISTS tsmom_price_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL, -- e.g. 'SANITY_MOVE'
    severity TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','error')),
    message TEXT NOT NULL,
    move_pct REAL,
    prev_close REAL,
    close REAL,
    acknowledged_at INTEGER,
    meta TEXT,
    UNIQUE(ticker, ts, type)
  );
  CREATE INDEX IF NOT EXISTS idx_tsmom_price_flags_ts ON tsmom_price_flags(ts);
  CREATE INDEX IF NOT EXISTS idx_tsmom_price_flags_ack ON tsmom_price_flags(acknowledged_at);

  CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL, -- e.g., '1d'
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, timeframe, ts)
  );

  -- When new candles are inserted/replaced, bump a version key for cache invalidation.
  CREATE TRIGGER IF NOT EXISTS trg_candles_bump_version
  AFTER INSERT ON candles
  BEGIN
    INSERT OR REPLACE INTO meta(key, value)
    VALUES('candles_version_ms', CAST(strftime('%s','now') AS INTEGER) * 1000);
  END;

  CREATE INDEX IF NOT EXISTS idx_candles_symbol_time ON candles(symbol, timeframe, ts);

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL, -- 'golden_cross'
    ts INTEGER NOT NULL,
    meta TEXT
  );
  `;
  db.exec(createSQL);

  // --- Lightweight migrations: portfolio_states.universe_mode ---
  try {
    const cols = db.prepare("PRAGMA table_info(portfolio_states)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    if (!names.has('universe_mode')) {
      db.prepare("ALTER TABLE portfolio_states ADD COLUMN universe_mode TEXT NOT NULL DEFAULT 'default'").run();
    }
  } catch {
    // ignore
  }

  // seed a default portfolio if none
  try {
    const pCount = db.prepare("SELECT COUNT(*) as c FROM portfolios").get() as { c: number };
    if (Number(pCount?.c || 0) === 0) {
      const now = Date.now();
      db.prepare("INSERT INTO portfolios(id, name, base_currency, strategy_ref, created_at, meta) VALUES(?,?,?,?,?,?)")
        .run(1, 'offir', 'ILS', 'TSMOM_TURBO_V2', now, null);
      db.prepare("INSERT OR IGNORE INTO portfolio_states(portfolio_id, cash_base, positions_json, updated_at) VALUES(?,?,?,?)")
        .run(1, 0, JSON.stringify({}), now);
    }
  } catch {
    // ignore
  }

  // If a user portfolio named 'offir' exists alongside a legacy 'Default' portfolio,
  // remove the legacy one so the UI ends up with only the real portfolio.
  try {
    const rows = db.prepare('SELECT id, name FROM portfolios ORDER BY created_at ASC, id ASC').all() as Array<{ id: number; name: string }>;
    const byLower = new Map(rows.map(r => [String(r.name || '').trim().toLowerCase(), Number(r.id)]));
    const offirId = byLower.get('offir');
    const defaultId = byLower.get('default');
    if (offirId && defaultId && offirId !== defaultId) {
      // Delete portfolio row (will cascade to portfolio_states/universe/nav_history).
      db.prepare('DELETE FROM portfolios WHERE id=?').run(defaultId);
      // These tables don't enforce foreign keys; clean up explicitly.
      try { db.prepare('DELETE FROM portfolio_trades WHERE portfolio_id=?').run(defaultId); } catch {}
      try { db.prepare('DELETE FROM capital_ledger WHERE portfolio_id=?').run(defaultId); } catch {}
    }
  } catch {
    // ignore
  }

  // --- Lightweight migrations: add portfolio_trades v2 columns if missing ---
  try {
    const cols = db.prepare("PRAGMA table_info(portfolio_trades)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    const add = (sql: string) => { try { db.prepare(sql).run(); } catch { /* ignore */ } };
    if (!names.has('portfolio_id')) add("ALTER TABLE portfolio_trades ADD COLUMN portfolio_id INTEGER NOT NULL DEFAULT 1");
    if (!names.has('fee')) add("ALTER TABLE portfolio_trades ADD COLUMN fee REAL");
    if (!names.has('strategy_tag')) add("ALTER TABLE portfolio_trades ADD COLUMN strategy_tag TEXT");
    if (!names.has('notes')) add("ALTER TABLE portfolio_trades ADD COLUMN notes TEXT");
    if (!names.has('meta')) add("ALTER TABLE portfolio_trades ADD COLUMN meta TEXT");
    if (!names.has('trade_currency')) add("ALTER TABLE portfolio_trades ADD COLUMN trade_currency TEXT");
    if (!names.has('fx_rate')) add("ALTER TABLE portfolio_trades ADD COLUMN fx_rate REAL");
    if (!names.has('notional_base')) add("ALTER TABLE portfolio_trades ADD COLUMN notional_base REAL");
    if (!names.has('fee_base')) add("ALTER TABLE portfolio_trades ADD COLUMN fee_base REAL");
  } catch {}

  // --- Lightweight migrations: add capital_ledger portfolio + currency columns ---
  try {
    const cols = db.prepare("PRAGMA table_info(capital_ledger)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    const add = (sql: string) => { try { db.prepare(sql).run(); } catch { /* ignore */ } };
    if (!names.has('portfolio_id')) add("ALTER TABLE capital_ledger ADD COLUMN portfolio_id INTEGER NOT NULL DEFAULT 1");
    if (!names.has('currency')) add("ALTER TABLE capital_ledger ADD COLUMN currency TEXT");
    if (!names.has('fx_rate')) add("ALTER TABLE capital_ledger ADD COLUMN fx_rate REAL");
  } catch {}

  // Backfill legacy NULL portfolio_id rows to default portfolio (id=1)
  // so portfolio-scoped queries and state-cache rebuilds don't miss older rows.
  try {
    db.prepare("UPDATE portfolio_trades SET portfolio_id=1 WHERE portfolio_id IS NULL").run();
  } catch {}
  try {
    db.prepare("UPDATE capital_ledger SET portfolio_id=1 WHERE portfolio_id IS NULL").run();
  } catch {}

  // Create portfolio-scoped indexes after migrations (safe on legacy DBs).
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_portfolio_trades_pid_ts ON portfolio_trades(portfolio_id, ts)");
  } catch {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_capital_ledger_pid_ts ON capital_ledger(portfolio_id, ts)");
  } catch {}

  // Ensure portfolio_states row exists for every portfolio
  try {
    const now = Date.now();
    const portfolios = db.prepare('SELECT id FROM portfolios').all() as Array<{ id: number }>;
    const ins = db.prepare("INSERT OR IGNORE INTO portfolio_states(portfolio_id, cash_base, positions_json, updated_at) VALUES(?,?,?,?)");
    for (const p of portfolios) ins.run(Number(p.id), 0, JSON.stringify({}), now);
  } catch {
    // ignore
  }

  // Backfill universe_mode based on whether a portfolio has any custom universe rows.
  try {
    db.prepare("UPDATE portfolio_states SET universe_mode='custom' WHERE portfolio_id IN (SELECT DISTINCT portfolio_id FROM portfolio_universe)").run();
  } catch {
    // ignore
  }

  // One-time initialization: build portfolio_states cache from existing ledger/trades.
  // This prevents slow full-history replays for snapshot rendering going forward.
  try {
    const key = 'portfolio_states_initialized_v1';
    const has = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined;
    if (!has?.value) {
      const { rebuildPortfolioStateFromHistory } = await import('./services/wealth/portfolioState.js');
      const portfolios = db.prepare('SELECT id FROM portfolios').all() as Array<{ id: number }>;
      for (const p of portfolios) rebuildPortfolioStateFromHistory(Number(p.id));
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(key, String(Date.now()));
    }
  } catch {
    // ignore
  }

  // seed a default watchlist if none
  const count = db.prepare("SELECT COUNT(*) as c FROM watchlists").get() as { c: number };
  if (count.c === 0) {
    db.prepare("INSERT INTO watchlists(name, created_at) VALUES (?, ?)").run("My Watchlist", Date.now());
  }

  // Seed an 'Israel' watchlist with selected symbols if it doesn't exist yet
  const hasIsrael = db.prepare("SELECT id FROM watchlists WHERE name=?").get("Israel") as { id?: number } | undefined;
  if (!hasIsrael?.id) {
    const info = db.prepare("INSERT INTO watchlists(name, created_at) VALUES (?, ?)").run("Israel", Date.now());
    const wid = Number(info.lastInsertRowid);
    const symbols = [
      'ALHE.TA','ARYT.TA','CAMT','ENLT','ENRG.TA','FTAL.TA','GNRS.TA','ISCN.TA','MAXO.TA','MTF.F71','MTRN.TA','MTRX.TA','NICE','ORL.TA','RZR.TA','SKBN.TA','TA35.TA','TA90.TA','TDRN.TA','TRPZ.TA','VRDS.TA'
    ];
    const ins = db.prepare("INSERT OR IGNORE INTO watchlist_symbols(watchlist_id, symbol) VALUES (?, ?)");
    const trx = db.transaction((arr: string[]) => { for (const s of arr) ins.run(wid, s); });
    trx(symbols);
  }

  // Seed a 'US' watchlist with provided symbols if it doesn't exist yet
  const hasUS = db.prepare("SELECT id FROM watchlists WHERE name=?").get("US") as { id?: number } | undefined;
  if (!hasUS?.id) {
    const info = db.prepare("INSERT INTO watchlists(name, created_at) VALUES (?, ?)").run("US", Date.now());
    const wid = Number(info.lastInsertRowid);
    const symbols = [
      'AAPL','GOOGL','TSLA','MSFT','NFLX','META','AMZN','ENRG','ORCL','ENPH','CCL','MA','AMD'
    ];
    const ins = db.prepare("INSERT OR IGNORE INTO watchlist_symbols(watchlist_id, symbol) VALUES (?, ?)");
    const trx = db.transaction((arr: string[]) => { for (const s of arr) ins.run(wid, s); });
    trx(symbols);
  }

  // Seed 'BEST SIGNALS' watchlist with provided symbols if it doesn't exist yet
  const hasBest = db.prepare("SELECT id FROM watchlists WHERE name=?").get("BEST SIGNALS") as { id?: number } | undefined;
  if (!hasBest?.id) {
    const info = db.prepare("INSERT INTO watchlists(name, created_at) VALUES (?, ?)").run("BEST SIGNALS", Date.now());
    const wid = Number(info.lastInsertRowid);
    const symbols = [
      'LUMI.TA','POLI.TA','ESLT.TA','TEVA.TA','MZTF.TA','AZRG.TA','DSCT.TA','NVMI.TA','PHOE.TA','TSEM.TA','ICL.TA','NICE.TA','FIBI.TA','HARL.TA','ORA.TA','NWMD.TA','MLSR.TA','MMHD.TA','CAMT.TA','BEZQ.TA','BIG.TA','OPCE.TA','ENLT.TA','DLEKG.TA','NVPT.TA','CLIS.TA','AMOT.TA','STRS.TA','SAE.TA','SPEN.TA','MVNE.TA','FTAL.TA','DIMRI.TA','ILCO.TA','ENOG.TA','ALHE.TA','ORL.TA','PTNR.TA','CEL.TA','KEN.TA','MAXO.TA'
    ];
    const ins = db.prepare("INSERT OR IGNORE INTO watchlist_symbols(watchlist_id, symbol) VALUES (?, ?)");
    const trx = db.transaction((arr: string[]) => { for (const s of arr) ins.run(wid, s); });
    trx(symbols);
  }
}
