import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

function safeReadJson(absPath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function inferMultiplier(yahooSymbol: string, cfg: any): number {
  const y = String(yahooSymbol || '').trim();
  const multMap = cfg?.priceOverrides?.multiplierByYahooSymbol;
  if (multMap && typeof multMap === 'object') {
    if (Object.prototype.hasOwnProperty.call(multMap, y)) {
      const v = Number(multMap[y]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    const isTase = y.toUpperCase().endsWith('.TA');
    if (isTase && Object.prototype.hasOwnProperty.call(multMap, '*.TA')) {
      const v = Number(multMap['*.TA']);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return y.toUpperCase().endsWith('.TA') ? 0.01 : 1;
}

function flattenExpandedUniverse(cfg: any): Array<{ category: string; ticker: string; name: string; yahooSymbol: string }> {
  const out: Array<{ category: string; ticker: string; name: string; yahooSymbol: string }> = [];
  for (const group of cfg?.assets || []) {
    const category = String(group?.group || '').trim();
    for (const item of group?.items || []) {
      const ticker = String(item?.input || '').trim();
      if (!ticker) continue;
      const name = String(item?.label || ticker).trim();
      const yahooSymbol = String(item?.yahoo || ticker).trim();
      out.push({ category, ticker, name, yahooSymbol });
    }
  }
  return out;
}

export type SeedOptions = {
  db: Database.Database;
  jsonPathCandidates: string[];
};

export function ensureAssetsSeededFromExpandedUniverseJson(opts: SeedOptions): { seeded: boolean; usedPath: string | null; count: number } {
  const { db } = opts;

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  const seededMeta = db.prepare('SELECT value FROM meta WHERE key=?').get('tsmom_assets_seeded') as { value?: string } | undefined;
  const alreadySeeded = seededMeta?.value === '1';

  const countRow = db.prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number };
  if (alreadySeeded && countRow.c > 0) return { seeded: false, usedPath: null, count: countRow.c };

  let usedPath: string | null = null;
  let cfg: any = null;
  for (const p of opts.jsonPathCandidates) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) continue;
    const j = safeReadJson(abs);
    if (j) {
      usedPath = abs;
      cfg = j;
      break;
    }
  }

  if (!cfg) return { seeded: false, usedPath: null, count: countRow.c };

  const now = Date.now();
  const rows = flattenExpandedUniverse(cfg);

  const ins = db.prepare(`
    INSERT OR REPLACE INTO assets(ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta)
    VALUES(@ticker, @name, @category, @status, @yahoo_symbol, @price_multiplier, @created_at, @updated_at, @meta)
  `);

  const trx = db.transaction((arr: typeof rows) => {
    for (const r of arr) {
      ins.run({
        ticker: r.ticker,
        name: r.name,
        category: r.category,
        status: 'active',
        yahoo_symbol: r.yahooSymbol,
        price_multiplier: inferMultiplier(r.yahooSymbol, cfg),
        created_at: now,
        updated_at: now,
        meta: null,
      });
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('tsmom_assets_seeded', '1');
  });

  trx(rows);

  const after = db.prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number };
  return { seeded: true, usedPath, count: after.c };
}
