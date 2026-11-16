import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";
import type { Quote } from "./types.ts";

export const marketMoversUniverse = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "LT", "ITC"] as const;
const moverSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.literal("NSE"),
  price: z.number().finite().positive(),
  change: z.number().finite(),
  changePercent: z.number().finite(),
  lastTradeTime: z.number().int().positive().max(8_640_000_000_000_000 - 330 * 60_000),
});
export type MarketMover = z.infer<typeof moverSchema>;
export const marketMoversResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fetchedAt: z.iso.datetime(),
  universe: z.array(stockSymbolSchema),
  gainers: z.array(moverSchema),
  losers: z.array(moverSchema),
  unchanged: z.number().int().nonnegative(),
  warnings: z.array(z.object({ symbol: stockSymbolSchema, error: z.string() })),
});
export type MarketMoversResponse = z.infer<typeof marketMoversResponseSchema>;

export function rankMarketMovers(quotes: { symbol: string; quote: Quote }[], now = Date.now()) {
  const date = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  const warnings: MarketMoversResponse["warnings"] = [];
  const movers = quotes.flatMap(({ symbol, quote }): MarketMover[] => {
    const parsed = moverSchema.safeParse({ symbol, exchange: "NSE", ...quote });
    if (!parsed.success || quote.previousClose <= 0 ||
      parsed.data.lastTradeTime > now + 5000 ||
      new Date(parsed.data.lastTradeTime + 330 * 60_000).toISOString().slice(0, 10) !== date) {
      warnings.push({ symbol, error: "No valid quote traded today (IST) with an available day change and previous close." });
      return [];
    }
    return [parsed.data];
  });
  return {
    gainers: movers.filter((stock) => stock.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent || a.symbol.localeCompare(b.symbol)),
    losers: movers.filter((stock) => stock.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent || a.symbol.localeCompare(b.symbol)),
    unchanged: movers.filter((stock) => stock.changePercent === 0).length,
    warnings,
  };
}
