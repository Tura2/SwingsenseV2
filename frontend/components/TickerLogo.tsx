import { useEffect, useRef, useState } from "react";

// Simple in-memory cache for already resolved logo URLs (includes fallback SVGs)
const logoCache = new Map<string,string>();

export default function TickerLogo({ symbol, size = 28, className = "" }: { symbol: string; size?: number; className?: string }) {
  const sym = (symbol || '').toUpperCase();
  const [src, setSrc] = useState<string | null>(logoCache.get(sym) || null);
  const didRequestRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const key = sym;
    if (logoCache.has(key)) { setSrc(logoCache.get(key)!); return; }
    if (didRequestRef.current) return; // guard against double strict-mode effects
    didRequestRef.current = true;
    (async () => {
      try {
        const url = await (window as any).api.getLogo(sym);
        if (cancelled) return;
        if (url) { logoCache.set(key, url); setSrc(url); }
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();
    return () => { cancelled = true; };
  }, [sym]);

  const letters = sym.slice(0, 3);
  const fontSize = Math.max(11, Math.round(size * 0.48));

  return (
    <span
      className={`ticker-logo ${className}`}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        position: 'relative',
        overflow: 'hidden',
        background: src ? 'transparent' : 'linear-gradient(135deg,#243140,#1c2530)',
        boxShadow: '0 0 0 1px #25313f'
      }}
      aria-label={sym + ' logo'}
    >
      {src ? (
        <img
          src={src}
          alt={sym}
          width={size}
            height={size}
          style={{
            width: '100%', height: '100%', objectFit: 'contain', padding: 3,
            filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.4))'
          }}
          draggable={false}
          loading="lazy"
        />
      ) : (
        <span style={{
          fontSize,
          lineHeight: 1,
          color: '#dbe6f2',
          fontWeight: 600,
          letterSpacing: '.5px',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)'
        }}>{letters}</span>
      )}
    </span>
  );
}
