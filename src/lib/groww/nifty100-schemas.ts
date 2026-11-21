import { z } from "zod";
import { stockSymbolSchema } from "./instrument-schemas.ts";

export const nifty100Source = "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv";
export const nifty100StockSchema = z.object({
  symbol: stockSymbolSchema, name: z.string().trim().min(1).max(200),
  industry: z.string().trim().min(1).max(160), isin: z.string().regex(/^IN[A-Z0-9]{10}$/),
});
export const nifty100Schema = z.object({
  index: z.literal("NIFTY 100"), exchange: z.literal("NSE"), source: z.literal(nifty100Source),
  fetchedAt: z.iso.datetime(),
  stocks: z.array(nifty100StockSchema).length(100).refine(
    stocks => new Set(stocks.map(stock => stock.symbol)).size === stocks.length &&
      new Set(stocks.map(stock => stock.isin)).size === stocks.length,
    "The official NIFTY 100 list must contain 100 unique symbols and ISINs.",
  ),
});
export type Nifty100Stock = z.infer<typeof nifty100StockSchema>;
export type Nifty100 = z.infer<typeof nifty100Schema>;
