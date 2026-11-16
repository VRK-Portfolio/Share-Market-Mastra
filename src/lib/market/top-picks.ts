import { z } from "zod";
import { calculateTechnicalVerdict, indicatorNames } from "./technical-verdict.ts";
import type { MarketAnalysis } from "./types.ts";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";

export const topPicksUniverse = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "LT", "ITC"] as const;
export const topPickSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.literal("NSE"),
  mode: z.enum(["MIS", "CNC"]),
  interval: z.enum(["15minute", "1day"]),
  decision: z.enum(["BUY", "SELL"]),
  price: z.number().finite().positive(),
  entryPrice: z.number().finite().positive(),
  stopLoss: z.number().finite().positive(),
  targetPrices: z.array(z.number().finite().positive()).min(1),
  tradedValue: z.number().finite().positive(),
  lastTradeTime: z.number().finite().nonnegative(),
  summary: z.string(),
}).refine((pick) => pick.mode === "MIS" ? pick.interval === "15minute" : pick.interval === "1day" && pick.decision === "BUY",
  "Pick interval and direction must match the trading mode.");
export type TopPick = z.infer<typeof topPickSchema>;
export type TopPickSelection = Pick<TopPick, "symbol" | "exchange" | "mode" | "interval">;
const screenedStockSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.literal("NSE"),
  mode: z.enum(["MIS", "CNC"]),
  interval: z.enum(["15minute", "1day"]),
  decision: z.enum(["BUY", "SELL", "HOLD"]),
  dataReady: z.boolean(),
  qualified: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
  directionalSignals: z.array(z.object({
    indicator: z.enum(["EMA20/EMA50", ...indicatorNames]),
    signal: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNAVAILABLE"]),
  })),
});
type ScreenedStock = z.infer<typeof screenedStockSchema>;
export const topPicksResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fetchedAt: z.iso.datetime(),
  universe: z.array(stockSymbolSchema),
  intraday: z.array(topPickSchema).max(3),
  carryForward: z.array(topPickSchema).max(3),
  screened: z.number().int().nonnegative(),
  screenedStocks: z.array(screenedStockSchema),
  warnings: z.array(z.object({ symbol: stockSymbolSchema, error: z.string() })),
});
export type TopPicksResponse = z.infer<typeof topPicksResponseSchema>;

export function rankTopPicks(analyses: MarketAnalysis[], mode: "MIS" | "CNC", now = Date.now()): TopPick[] {
  return screenTopPicks(analyses, mode, now).picks;
}

export function screenTopPicks(analyses: MarketAnalysis[], mode: "MIS" | "CNC", now = Date.now()) {
  const interval = mode === "MIS" ? "15minute" : "1day";
  const screenedStocks: ScreenedStock[] = [];
  const picks = analyses.flatMap((analysis): TopPick[] => {
    if (analysis.exchange !== "NSE" || analysis.segment !== "CASH" || analysis.interval !== interval) return [];
    const verdict = calculateTechnicalVerdict(analysis, mode, now);
    const { price, volume, lastTradeTime } = analysis.quote;
    const tradedValue = price * (volume ?? 0);
    const reasons = [...verdict.reasons];
    if (volume === null || volume <= 0) reasons.push("Excluded from picks: positive reported quote volume is required for traded-value ranking.");
    else if (!Number.isFinite(tradedValue) || tradedValue <= 0) reasons.push("Excluded from picks: finite, positive traded value is required for ranking.");
    const qualified = verdict.dataReady && verdict.decision !== "HOLD" && !verdict.exitOnly &&
      verdict.entryPrice !== null && verdict.stopLoss !== null && verdict.targetPrices.length > 0 &&
      lastTradeTime !== null && Number.isFinite(tradedValue) && tradedValue > 0;
    screenedStocks.push({
      symbol: analysis.symbol, exchange: "NSE", mode, interval, decision: verdict.decision,
      dataReady: verdict.dataReady, qualified, summary: verdict.summary, reasons,
      directionalSignals: verdict.directionalSignals,
    });
    if (!qualified || verdict.decision === "HOLD" ||
      verdict.entryPrice === null || verdict.stopLoss === null || !verdict.targetPrices.length ||
      lastTradeTime === null) return [];
    return [{
      symbol: analysis.symbol, exchange: "NSE", mode, interval, decision: verdict.decision,
      price, entryPrice: verdict.entryPrice, stopLoss: verdict.stopLoss, targetPrices: verdict.targetPrices,
      tradedValue, lastTradeTime, summary: verdict.summary,
    }];
  }).sort((a, b) => b.tradedValue - a.tradedValue || a.symbol.localeCompare(b.symbol)).slice(0, 3);
  screenedStocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { picks, screenedStocks };
}
