import { z } from "zod";
import { intervals } from "../market/types.ts";
import type { MarketAnalysis, Quote } from "../market/types.ts";
import { fnoInstrumentSchema, stockSymbolSchema } from "./instrument-schemas.ts";
export { stockSymbolSchema } from "./instrument-schemas.ts";

const number = z.number().finite();
const price = number.nonnegative();
export const marketRequestSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  interval: z.enum(intervals).default("15minute"),
  segment: z.enum(["CASH", "FNO"]).default("CASH"),
});

const ohlcSchema = z.object({ open: price, high: price, low: price, close: price })
  .refine((value) => value.high >= value.open && value.low <= value.open && value.high >= value.low,
    "Invalid quote price range.");
const stringOhlcSchema = z.string().transform((value, context): unknown => {
  try {
    // Groww documents both an object and a string with unquoted OHLC keys.
    return JSON.parse(value.replace(/([{,]\s*)(open|high|low|close)\s*:/g, '$1"$2":'));
  } catch {
    context.addIssue({ code: "custom", message: "Invalid quote OHLC." });
    return z.NEVER;
  }
}).pipe(ohlcSchema);

const quoteResponseSchema = z.object({
  status: z.literal("SUCCESS"),
  payload: z.object({
    last_price: price,
    day_change: number,
    day_change_perc: number,
    ohlc: z.union([ohlcSchema, stringOhlcSchema]),
    volume: price.nullish(),
    last_trade_time: price.int().max(8_640_000_000_000_000).nullish(),
  }),
});
function normalizeQuote(payload: z.infer<typeof quoteResponseSchema>["payload"]): Quote {
  return {
  price: payload.last_price,
  change: payload.day_change,
  changePercent: payload.day_change_perc,
  open: payload.ohlc.open,
  high: payload.ohlc.high,
  low: payload.ohlc.low,
  previousClose: payload.ohlc.close,
  volume: payload.volume ?? null,
  lastTradeTime: payload.last_trade_time ?? null,
  };
}
export const growwQuoteSchema = quoteResponseSchema.transform(({ payload }) => normalizeQuote(payload));
export const growwFnoQuoteSchema = quoteResponseSchema.extend({
  payload: quoteResponseSchema.shape.payload.extend({
    open_interest: price.nullish(), oi_day_change: number.nullish(), implied_volatility: price.nullish(),
  }),
}).transform(({ payload }): Quote => ({
  ...normalizeQuote(payload),
  openInterest: payload.open_interest ?? null,
  oiDayChange: payload.oi_day_change ?? null,
  impliedVolatility: payload.implied_volatility ?? null,
}));

const timestampSchema = z.union([
  z.number().int().positive().max(8_640_000_000_000),
  z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/)
    .transform((value) => {
      const iso = value.replace(" ", "T");
      const [year, month, day, hour, minute, second] = iso.slice(0, 19).split(/[-T:]/).map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
          hour > 23 || minute > 59 || second > 59) return NaN;
      // Zone-less exchange timestamps are IST, not the server's local timezone.
      return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}+05:30`) / 1000;
    }).pipe(z.number().finite().positive()),
]);

const candleSchema = z.object({
  time: number.positive(),
  open: price,
  high: price,
  low: price,
  close: price,
  volume: price,
  openInterest: price.nullish(),
}).refine((candle) =>
  candle.high >= Math.max(candle.open, candle.close) &&
  candle.low <= Math.min(candle.open, candle.close),
"Invalid candle price range.");

function candleHistorySchema(fno: boolean) {
  const columns = [timestampSchema, price.nullable(), price.nullable(), price.nullable(), price.nullable(), price.nullable()] as const;
  const tuple = fno ? z.tuple([...columns, price.nullish()]).rest(z.unknown()) : z.tuple(columns).rest(z.unknown());
  return z.object({
  status: z.literal("SUCCESS"),
  payload: z.object({
    candles: z.array(tuple
      .transform(([time, open, high, low, close, volume, openInterest]) => ({
        time,
        candle: open === null || high === null || low === null || close === null
          ? null : { time, open, high, low, close, volume, ...(fno ? { openInterest: openInterest ?? null } : {}) },
      }))
      .pipe(z.object({ time: number.positive(), candle: candleSchema.nullable() }))),
  }),
}).transform(({ payload }) => payload.candles.sort((a, b) => a.time - b.time))
  .refine((candles) => candles.every((candle, index) => !index || candle.time > candles[index - 1].time),
    "Duplicate candle timestamps.")
  .transform((rows) => {
    const candles = rows.flatMap(({ candle }) => candle === null ? [] : [candle]);
    return { candles, omittedCandles: rows.length - candles.length };
  });
}
export const growwCandleHistorySchema = candleHistorySchema(false);
export const growwFnoCandleHistorySchema = candleHistorySchema(true);

export const growwCandlesSchema = growwCandleHistorySchema.transform(({ candles }) => candles);

const overlaySchema = z.array(z.object({ time: number, value: number }));
export const marketAnalysisSchema = z.object({
  segment: z.enum(["CASH", "FNO"]).default("CASH"),
  instrument: fnoInstrumentSchema.optional(),
  symbol: z.string().min(1),
  exchange: z.enum(["NSE", "BSE"]),
  interval: z.enum(intervals),
  fetchedAt: z.iso.datetime(),
  quote: z.object({
    price, change: number.nullable(), changePercent: number.nullable(),
    open: price, high: price, low: price, previousClose: price,
    volume: price.nullable(), lastTradeTime: price.nullable(),
    openInterest: price.nullish(), oiDayChange: number.nullish(), impliedVolatility: price.nullish(),
  }),
  candles: z.array(candleSchema),
  omittedCandles: z.number().int().nonnegative().optional(),
  technical: z.object({
    vwap: number.nullable(), rsi: number.nullable(), atr: number.nullable(),
    ema20: number.nullable(), ema50: number.nullable(),
    macd: z.object({ value: number, signal: number, histogram: number }).nullable(),
    supertrend: z.object({ value: number, direction: z.enum(["bullish", "bearish"]) }).nullable(),
    overlays: z.object({ vwap: overlaySchema, ema20: overlaySchema, supertrend: overlaySchema }),
  }),
}).refine((analysis) => analysis.segment === "CASH" ? !analysis.instrument
  : !!analysis.instrument && analysis.instrument.tradingSymbol === analysis.symbol && analysis.instrument.exchange === analysis.exchange,
  "F&O analysis must identify the matching contract.") satisfies z.ZodType<MarketAnalysis>;
