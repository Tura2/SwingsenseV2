import { z } from "zod";

export const ZSymbol = z.string().trim().toUpperCase().min(1).max(15);
export const ZWatchlistName = z.string().trim().min(1).max(40);
export const ZTrade = z.object({
  symbol: ZSymbol,
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().positive(),
  price: z.number().positive(),
  ts: z.number().int().positive()
});
