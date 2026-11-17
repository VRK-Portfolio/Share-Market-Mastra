import type { ZodError } from "zod";
import { growwJson } from "./client.ts";
import { historicalRequests } from "./historical-requests.ts";
import { growwCandleHistorySchema, growwFnoCandleHistorySchema, growwQuoteSchema, growwFnoQuoteSchema, marketAnalysisSchema } from "./market-schemas.ts";
import { calculateIndicators } from "../market/indicators.ts";
import type { FnoInstrument } from "./instrument-schemas.ts";
import type { Interval, MarketSegment } from "../market/types.ts";

export class MarketValidationError extends Error {
  readonly stage: "quote" | "candles" | "analysis";
  readonly validation: ZodError;

  constructor(stage: "quote" | "candles" | "analysis", validation: ZodError) {
    super(`Groww returned invalid ${stage} data.`);
    this.stage = stage;
    this.validation = validation;
  }
}

export async function loadMarketAnalysis(
  token: string,
  selection: { symbol: string; exchange: "NSE" | "BSE"; interval: Interval; segment: MarketSegment },
  signal: AbortSignal,
  instrument?: FnoInstrument,
) {
  const { symbol, exchange, interval, segment } = selection;
  const quoteUrl = new URL("https://api.groww.in/v1/live-data/quote");
  quoteUrl.search = new URLSearchParams({ exchange, segment, trading_symbol: symbol }).toString();
  const end = Math.floor(Date.now() / 1000);
  const lookbackDays = { "15minute": 14, "1hour": 45, "1day": 179 };
  const candlesUrl = new URL("https://api.groww.in/v1/historical/candles");
  candlesUrl.search = new URLSearchParams({
    exchange, segment, groww_symbol: instrument?.growwSymbol ?? `${exchange}-${symbol}`,
    start_time: String(end - lookbackDays[interval] * 86400),
    end_time: String(end), candle_interval: interval,
  }).toString();
  const [rawQuote, rawCandles] = await Promise.all([
    growwJson(quoteUrl, token, "quote", signal).then((body) => ({ body, receivedAt: new Date(Date.now()).toISOString() })),
    historicalRequests.run(token, signal, () => growwJson(candlesUrl, token, "historical candles", signal)),
  ]);
  const quote = (segment === "FNO" ? growwFnoQuoteSchema : growwQuoteSchema).safeParse(rawQuote.body);
  if (!quote.success) throw new MarketValidationError("quote", quote.error);
  const history = (segment === "FNO" ? growwFnoCandleHistorySchema : growwCandleHistorySchema).safeParse(rawCandles);
  if (!history.success) throw new MarketValidationError("candles", history.error);
  const analysis = marketAnalysisSchema.safeParse({
    ...selection, instrument, fetchedAt: new Date(Date.now()).toISOString(),
    quote: { ...quote.data, ...(quote.data.depth ? { depthFetchedAt: rawQuote.receivedAt } : {}) },
    ...history.data, technical: calculateIndicators(history.data.candles),
  });
  if (!analysis.success) throw new MarketValidationError("analysis", analysis.error);
  return analysis.data;
}
