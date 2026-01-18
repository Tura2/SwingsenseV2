import { app } from "electron";
import { mkdirSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { normalizeInputSymbol } from "./symbols.js";
import { httpClient } from "./http/throttledHttpClient.js";

// Node 18+ has global fetch

function symbolBase(sym: string): string {
  // Strip common suffixes/hints like .TA and prefixes like TASE:
  let s = normalizeInputSymbol(sym);
  if (s.startsWith("TASE:")) s = s.slice(5);
  if (s.startsWith("TASE-")) s = s.slice(5);
  if (s.endsWith(".TA")) s = s.slice(0, -3);
  // Only A-Z0-9, drop punctuation (e.g., BRK.B -> BRKB)
  return s.replace(/[^A-Z0-9]/g, "");
}

function hashColor(sym: string): string {
  // Simple deterministic HSL by FNV-like hash
  let h = 2166136261 >>> 0;
  for (let i = 0; i < sym.length; i++) {
    h ^= sym.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 60% 45%)`;
}

function initials(sym: string): string {
  const b = symbolBase(sym);
  // Get letters/digits only and ignore suffixes like ".B" from class shares
  const clean = b.replace(/[^A-Z0-9]/g, "");
  return clean.slice(0, 3) || b.slice(0, 3) || "?";
}

function fallbackSVG(sym: string, size = 64): string {
  const bg = hashColor(sym);
  const text = initials(sym);
  const fontSize = Math.round(size * 0.45);
  const r = Math.round(size / 2);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${r}" cy="${r}" r="${r}" fill="${bg}" />
  <text x="50%" y="55%" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${text}</text>
</svg>`;
  const b64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

function isLikelyImage(buf: Buffer): boolean {
  if (!buf || buf.length < 256) return false; // tiny/invalid
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPG
  if (buf[0] === 0xFF && buf[1] === 0xD8) return true;
  // WebP (RIFF....WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.slice(8,12).toString() === 'WEBP') return true;
  return false;
}

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const res = await httpClient.getBuffer(url, {
      rateLimitKey: "logos",
      rateLimit: { minTimeMs: 120, maxConcurrent: 4 },
      timeoutMs: 4500,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const buf = res.buffer;
    if (!isLikelyImage(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function getLogo(symbol: string): Promise<string> {
  const s = normalizeInputSymbol(symbol);
  if (!s) return fallbackSVG("?");
  const base = symbolBase(s);
  const fileName = `${base}.png`;
  const cacheDir = join(app.getPath("userData"), "logos");
  const filePath = join(cacheDir, fileName);

  // Serve from cache if present and non-empty
  try {
    if (existsSync(filePath) && statSync(filePath).size > 0) {
      return pathToFileURL(filePath).toString();
    }
  } catch { /* ignore */ }

  // Build source URLs (uppercase only per spec)
  const SYM = base; // already uppercase, alphanumeric only
  const urls = [
    `https://cdn.jsdelivr.net/gh/nvstly/icons@main/ticker_icons/${SYM}.png`,
    `https://cdn.statically.io/gh/nvstly/icons/main/ticker_icons/${SYM}.png`,
    `https://raw.githack.com/nvstly/icons/main/ticker_icons/${SYM}.png`,
    `https://financialmodelingprep.com/image-stock/${SYM}.png`
  ];

  // Attempt download
  let buf: Buffer | null = null;
  for (const url of urls) {
    buf = await tryFetch(url);
    if (buf) break;
  }

  if (buf) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(filePath, buf);
      return pathToFileURL(filePath).toString();
    } catch {
      // Fall through to data URL if write fails
    }
  }

  // Fallback SVG
  return fallbackSVG(base);
}
