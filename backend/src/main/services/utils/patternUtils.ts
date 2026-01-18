// Lightweight pattern helpers (heuristic, not exhaustive)
export function detectFlagPennant(closes: number[], highs: number[], lows: number[], ema20: number[]): { isFlag:boolean; pivotIdx:number; widthPct:number } {
  const n = closes.length;
  if (n < 15) return { isFlag:false, pivotIdx:-1, widthPct:0 };
  // Look back max 20 bars for a mild downward/sideways consolidation after an upswing.
  const look = Math.min(20, n-1);
  let highIdx = n-1; for (let i=n-look;i<n;i++) if (highs[i] >= highs[highIdx]) highIdx=i;
  let lowLocal = Infinity, lowIdx=-1; for (let i=highIdx;i<n;i++){ if (lows[i] < lowLocal){ lowLocal = lows[i]; lowIdx=i; } }
  const flagRange = (Math.max(...highs.slice(highIdx,n)) - Math.min(...lows.slice(highIdx,n))) || 1;
  const price = closes[n-1];
  // Flag should generally sit near EMA20 and not exceed ~15% height of prior swing (simplified)
  const emaNow = ema20[n-1];
  const nearEma = Math.abs(price-emaNow)/emaNow < 0.05;
  const widthPct = (flagRange / closes[highIdx]) * 100;
  const isFlag = nearEma && widthPct <= 12 && lowIdx > highIdx && lowIdx !== -1;
  return { isFlag, pivotIdx: highIdx, widthPct: Math.round(widthPct*10)/10 };
}

export function detectCupHandle(closes: number[]): { isCup:boolean; handlePivotIdx:number; cupDepthPct:number } {
  const n = closes.length; if (n < 40) return { isCup:false, handlePivotIdx:-1, cupDepthPct:0 };
  // Rough: find highest close last 60 bars, then lowest after it → cup depth
  const look = Math.min(120, n);
  const slice = closes.slice(n-look);
  const relHigh = Math.max(...slice); const relHighIdx = slice.lastIndexOf(relHigh) + (n-look);
  let lowAfter = Infinity, lowIdx = -1; for (let i=relHighIdx;i<n;i++){ if (closes[i] < lowAfter){ lowAfter=closes[i]; lowIdx=i; } }
  if (lowIdx === -1 || lowIdx === n-1) return { isCup:false, handlePivotIdx:-1, cupDepthPct:0 };
  const depthPct = ((relHigh - lowAfter)/relHigh)*100;
  // Handle: last ~15 bars form a smaller pullback less than 40% of cup depth
  const handleLook = Math.min(25, n- lowIdx -1);
  const handleSlice = closes.slice(n-handleLook);
  const handleLow = Math.min(...handleSlice);
  const handlePct = ((relHigh - handleLow)/relHigh)*100;
  const handleOk = handlePct <= depthPct*0.45;
  const isCup = depthPct >= 8 && depthPct <= 45 && handleOk;
  return { isCup, handlePivotIdx: n-1, cupDepthPct: Math.round(depthPct*10)/10 };
}

export function detectContractions(atr5: number[]): { peaks:number[]; descending:boolean } {
  const peaks:number[] = [];
  for (let i=2;i<atr5.length-2;i++) {
    const a=atr5[i]; if (a>atr5[i-1] && a>atr5[i-2] && a>atr5[i+1] && a>atr5[i+2]) peaks.push(i);
  }
  let descending = true;
  for (let i=1;i<peaks.length;i++) {
    if (!(atr5[peaks[i]] <= atr5[peaks[i-1]]*0.9)) { descending=false; break; }
  }
  return { peaks, descending: peaks.length>=2 && descending };
}

export function isTight(widthPct: number, maxPct=5): boolean { return widthPct <= maxPct; }
