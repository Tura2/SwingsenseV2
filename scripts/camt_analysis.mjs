#!/usr/bin/env node
// Fetches CAMT.TA (Tel Aviv) candles from Yahoo Finance and computes technical indicators

const SYMBOL = "CAMT.TA";
const YAHOO_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1d&range=6mo&events=div,splits`;

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://finance.yahoo.com/",
};

// ── Indicators ──────────────────────────────────────────────────────────────

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = NaN; continue; }
    cnt++;
    sum += v;
    if (cnt < period) { out[i] = NaN; continue; }
    if (cnt === period) { out[i] = sum / period; continue; }
    out[i] = v * k + out[i - 1] * (1 - k);
  }
  return out;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function macdSeries(values, fast = 12, slow = 26, signalP = 9) {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macdLine = values.map((_, i) => {
    if (!Number.isFinite(emaFast[i]) || !Number.isFinite(emaSlow[i])) return NaN;
    return emaFast[i] - emaSlow[i];
  });
  const signalLine = emaSeries(macdLine, signalP);
  const histogram = macdLine.map((m, i) => {
    if (!Number.isFinite(m) || !Number.isFinite(signalLine[i])) return NaN;
    return m - signalLine[i];
  });
  return { macdLine, signalLine, histogram };
}

function bollingerBands(values, period = 20, mult = 2) {
  const mid = smaSeries(values, period);
  const upper = [], lower = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(mid[i])) { upper.push(NaN); lower.push(NaN); continue; }
    const slice = values.slice(Math.max(0, i - period + 1), i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { upper, mid, lower };
}

function atrSeries(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return smaSeries(tr, period);
}

function detectSupportResistance(candles, lookback = 20, touchTolerance = 0.015) {
  const levels = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const windowH = candles.slice(i - lookback, i + lookback + 1);
    const isSwingHigh = windowH.every(w => w.high <= c.high);
    const isSwingLow = windowH.every(w => w.low >= c.low);
    if (isSwingHigh) levels.push({ price: c.high, type: "resistance", ts: c.ts });
    if (isSwingLow) levels.push({ price: c.low, type: "support", ts: c.ts });
  }
  // Cluster nearby levels
  const clustered = [];
  const used = new Set();
  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    const group = [levels[i]];
    for (let j = i + 1; j < levels.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(levels[j].price - levels[i].price) / levels[i].price < touchTolerance) {
        group.push(levels[j]);
        used.add(j);
      }
    }
    used.add(i);
    const avg = group.reduce((s, l) => s + l.price, 0) / group.length;
    clustered.push({ price: avg, type: levels[i].type, touches: group.length, lastTs: Math.max(...group.map(g => g.ts)) });
  }
  return clustered.sort((a, b) => b.price - a.price);
}

function fibLevels(low, high) {
  const range = high - low;
  return {
    "0.0%":   high,
    "23.6%":  high - range * 0.236,
    "38.2%":  high - range * 0.382,
    "50.0%":  high - range * 0.500,
    "61.8%":  high - range * 0.618,
    "78.6%":  high - range * 0.786,
    "100%":   low,
  };
}

// ── Fetch & Parse ───────────────────────────────────────────────────────────

async function fetchCandles(symbol, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}&events=div,splits`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart result for ${symbol}: ${json?.chart?.error?.description}`);

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number.isFinite(+adj[i]) && adj[i] > 0 ? +adj[i] : +q.close?.[i];
    if (!close || close <= 0) continue;
    candles.push({
      ts: ts[i] * 1000,
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: +q.open?.[i] || close,
      high: +q.high?.[i] || close,
      low: +q.low?.[i] || close,
      close,
      volume: +q.volume?.[i] || 0,
    });
  }
  return { candles, meta: result.meta };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 שולף נתונים עבור ${SYMBOL}...\n`);

  const [{ candles, meta }, { candles: candles1y }] = await Promise.all([
    fetchCandles(SYMBOL, "6mo"),
    fetchCandles(SYMBOL, "1y"),
  ]);

  if (!candles.length) { console.error("אין נתונים"); process.exit(1); }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Meta
  const currentPrice = meta.regularMarketPrice ?? last.close;
  const prevClose = meta.chartPreviousClose ?? prev.close;
  const changeAg = (currentPrice - prevClose);
  const changePct = (changeAg / prevClose * 100);

  // 52w range from 1y data
  const highs1y = candles1y.map(c => c.high);
  const lows1y = candles1y.map(c => c.low);
  const high52w = Math.max(...highs1y);
  const low52w = Math.min(...lows1y);
  const high52wCandle = candles1y[highs1y.indexOf(high52w)];
  const low52wCandle = candles1y[lows1y.indexOf(low52w)];

  // Indicators
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const rsi14 = rsiSeries(closes, 14);
  const { macdLine, signalLine, histogram } = macdSeries(closes);
  const bb = bollingerBands(closes);
  const atr = atrSeries(candles);
  const vol20 = smaSeries(candles.map(c => c.volume), 20);
  const sma20 = smaSeries(closes, 20);

  const n = closes.length - 1;

  // Current values
  const curEma20 = ema20[n];
  const curEma50 = ema50[n];
  const curEma200 = ema200[n];
  const curRsi = rsiSeries(closes, 14)[n];
  const curMacd = macdLine[n];
  const curSignal = signalLine[n];
  const curHist = histogram[n];
  const prevHist = histogram[n - 1];
  const curBbUpper = bb.upper[n];
  const curBbMid = bb.mid[n];
  const curBbLower = bb.lower[n];
  const curAtr = atr[n];
  const curVol = last.volume;
  const curVolMA = vol20[n];

  // Fibonacci from 52w
  const fibs = fibLevels(low52w, high52w);

  // Support/Resistance
  const srLevels = detectSupportResistance(candles1y);
  const nearLevels = srLevels
    .filter(l => Math.abs(l.price - currentPrice) / currentPrice < 0.12)
    .slice(0, 8);

  // Format agorot
  const ag = v => Math.round(v).toLocaleString("he-IL");
  const ils = v => (v / 100).toFixed(2);
  const pct = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

  // ── Output ──
  console.log("═".repeat(60));
  console.log(`  קמטק (${SYMBOL}) — ניתוח טכני מלא`);
  console.log(`  ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`);
  console.log("═".repeat(60));

  console.log("\n📊 מחיר ונתוני שוק");
  console.log(`  מחיר נוכחי:     ${ag(currentPrice)} אגורות (₪${ils(currentPrice)})`);
  console.log(`  סגירה קודמת:    ${ag(prevClose)} אגורות`);
  console.log(`  שינוי יומי:     ${pct(changePct)} (${ag(changeAg)} אגורות)`);
  console.log(`  פתיחה היום:     ${ag(last.open)}`);
  console.log(`  גבוה יומי:      ${ag(last.high)}`);
  console.log(`  נמוך יומי:      ${ag(last.low)}`);
  console.log(`  נפח:            ${(curVol / 1000).toFixed(0)}K (ממוצע 20: ${(curVolMA / 1000).toFixed(0)}K)`);

  console.log("\n📅 טווח 52 שבועות");
  console.log(`  שיא 52w:  ${ag(high52w)} (${high52wCandle?.date})`);
  console.log(`  שפל 52w:  ${ag(low52w)} (${low52wCandle?.date})`);
  console.log(`  מיקום:    ${(((currentPrice - low52w) / (high52w - low52w)) * 100).toFixed(1)}% מהשפל לשיא`);

  console.log("\n📈 ממוצעים נעים");
  const priceVsEma = (e, name) => {
    if (!Number.isFinite(e)) return `  ${name}: N/A`;
    const d = ((currentPrice - e) / e * 100);
    const sig = d > 0 ? "▲ מעל" : "▼ מתחת";
    return `  ${name}: ${ag(e)} — ${sig} ב${Math.abs(d).toFixed(1)}%`;
  };
  console.log(priceVsEma(curEma20, "EMA 20 "));
  console.log(priceVsEma(curEma50, "EMA 50 "));
  console.log(priceVsEma(curEma200, "EMA 200"));

  console.log("\n🔢 אינדיקטורים");
  const rsiText = curRsi > 70 ? "⚠️  קנייה-יתר" : curRsi < 30 ? "⚠️  מכירה-יתר" : curRsi > 55 ? "🟢 חיובי" : curRsi < 45 ? "🔴 שלילי" : "🟡 ניטרלי";
  console.log(`  RSI (14):        ${curRsi.toFixed(1)} — ${rsiText}`);
  const macdText = curHist > 0 && prevHist < 0 ? "🟢 חצייה חיובית!" : curHist > 0 ? "🟢 חיובי" : curHist < 0 && prevHist > 0 ? "🔴 חצייה שלילית!" : "🔴 שלילי";
  console.log(`  MACD:            ${curMacd.toFixed(1)} | Signal: ${curSignal.toFixed(1)} | Hist: ${curHist.toFixed(1)} — ${macdText}`);
  console.log(`  Bollinger Bands: עליון ${ag(curBbUpper)} | אמצע ${ag(curBbMid)} | תחתון ${ag(curBbLower)}`);
  const bbPos = currentPrice > curBbUpper ? "⚠️  מעל הפס העליון" : currentPrice < curBbLower ? "⚠️  מתחת לפס התחתון" : "בתוך הפסים";
  console.log(`  מיקום BB:        ${bbPos}`);
  console.log(`  ATR (14):        ${ag(curAtr)} אגורות (${(curAtr / currentPrice * 100).toFixed(1)}% מהמחיר)`);

  console.log("\n📐 רמות פיבונאצ'י (52 שבועות)");
  const fibEntries = Object.entries(fibs);
  for (const [label, price] of fibEntries) {
    const dist = ((price - currentPrice) / currentPrice * 100);
    const marker = Math.abs(dist) < 3 ? " ◄◄ קרוב!" : "";
    const arrow = price > currentPrice ? "↑ התנגדות" : "↓ תמיכה";
    console.log(`  ${label.padEnd(6)} ${ag(price).padStart(7)} אגורות  ${arrow}  (${dist > 0 ? "+" : ""}${dist.toFixed(1)}%)${marker}`);
  }

  console.log("\n🏔️  אזורי תמיכה/התנגדות (זיהוי אוטומטי)");
  const supports = nearLevels.filter(l => l.price < currentPrice).slice(0, 4);
  const resistances = nearLevels.filter(l => l.price >= currentPrice).slice(0, 4);

  console.log("  התנגדויות:");
  for (const r of resistances) {
    console.log(`    ${ag(r.price).padStart(7)} — ${r.touches} נגיעות`);
  }
  console.log("  תמיכות:");
  for (const s of supports.reverse()) {
    console.log(`    ${ag(s.price).padStart(7)} — ${s.touches} נגיעות`);
  }

  console.log("\n💼 ניהול הפוזיציה שלך");
  const entryPrice = 48900;
  const shares = 20;
  const stopLoss = 44000;
  const t1 = 50500, t2 = 54500, t3 = 59000;
  const pnl = (currentPrice - entryPrice) * shares / 100;
  const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;
  console.log(`  כניסה:           ${ag(entryPrice)} | מניות: ${shares}`);
  console.log(`  מחיר עכשיו:      ${ag(currentPrice)}`);
  console.log(`  רווח/הפסד עכשיו: ${pnl >= 0 ? "+" : ""}₪${pnl.toFixed(0)} (${pct(pnlPct)})`);
  console.log(`  סטופ לוס:        ${ag(stopLoss)} — מרחק ${((currentPrice - stopLoss) / currentPrice * 100).toFixed(1)}%`);
  const riskAg = (entryPrice - stopLoss) * shares;
  const riskIls = riskAg / 100;
  console.log(`  סיכון מקסימלי:   ₪${riskIls.toFixed(0)}`);
  console.log(`  T1 (${ag(t1)}):   R:R ${((t1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)}:1 | רווח ₪${((t1 - entryPrice) * shares / 100).toFixed(0)}`);
  console.log(`  T2 (${ag(t2)}):   R:R ${((t2 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)}:1 | רווח ₪${((t2 - entryPrice) * shares / 100).toFixed(0)}`);
  console.log(`  T3 (${ag(t3)}):   R:R ${((t3 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)}:1 | רווח ₪${((t3 - entryPrice) * shares / 100).toFixed(0)}`);

  console.log("\n🎯 סיכום סנטימנט");
  let bulls = 0, bears = 0;
  if (currentPrice > curEma20) bulls++; else bears++;
  if (currentPrice > curEma50) bulls++; else bears++;
  if (curRsi > 50) bulls++; else bears++;
  if (curHist > 0) bulls++; else bears++;
  if (curVol > curVolMA) bulls++; else bears++;
  if (currentPrice > curBbMid) bulls++; else bears++;
  const total = bulls + bears;
  const sentiment = bulls / total > 0.65 ? "🟢 חיובי" : bulls / total < 0.35 ? "🔴 שלילי" : "🟡 מעורב";
  console.log(`  ${bulls}/${total} אינדיקטורים חיוביים — ${sentiment}`);

  console.log("\n" + "═".repeat(60) + "\n");
}

main().catch(e => { console.error("שגיאה:", e.message); process.exit(1); });
