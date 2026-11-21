import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";
import { stockAnalysisLinkSchema } from "./stock-screener.ts";
import type { AnalysisMode, MarketSegment } from "./types.ts";

const exchangeSchema = z.enum(["NSE", "BSE"]).default("NSE");
export const analysisLinkSchema = z.discriminatedUnion("segment", [
  stockAnalysisLinkSchema.extend({ segment: z.literal("CASH"), exchange: exchangeSchema }),
  z.object({
    segment: z.literal("FNO"), symbol: stockSymbolSchema, exchange: exchangeSchema,
    mode: z.enum(["MIS", "NRML"]).default("MIS"),
  }),
]);
export type AnalysisLink = z.infer<typeof analysisLinkSchema>;

export function analysisLinkUrl(href: string, selection: {
  symbol: string; exchange: "NSE" | "BSE"; mode: AnalysisMode; segment: MarketSegment;
}) {
  const url = new URL(href);
  for (const name of ["symbol", "exchange", "mode"]) url.searchParams.delete(name);
  if (selection.symbol) {
    const parsed = analysisLinkSchema.parse(selection);
    url.searchParams.set("symbol", parsed.symbol);
    url.searchParams.set("exchange", parsed.exchange);
    url.searchParams.set("mode", parsed.mode);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
