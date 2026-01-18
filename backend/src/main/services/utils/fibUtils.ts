// Simple Fibonacci helpers
export function activeUpLegPivot(closes: number[]): { swingLowIdx:number; swingHighIdx:number } {
  const n = closes.length; if (n < 10) return { swingLowIdx:0, swingHighIdx:n-1 };
  // Naive: find last local minimum then subsequent maximum
  let lowIdx = n-10; let lowVal = closes[lowIdx];
  for (let i=n-10;i<n;i++){ if (closes[i] < lowVal){ lowVal=closes[i]; lowIdx=i; } }
  let highIdx = lowIdx; let highVal = closes[highIdx];
  for (let i=lowIdx;i<n;i++){ if (closes[i] > highVal){ highVal=closes[i]; highIdx=i; } }
  return { swingLowIdx: lowIdx, swingHighIdx: highIdx };
}

export function inFibZone(price: number, low: number, high: number, z1=0.382, z2=0.618): boolean {
  if (high <= low) return false;
  const r = (price - low)/(high-low);
  return r >= z1 && r <= z2;
}
