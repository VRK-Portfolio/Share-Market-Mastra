import { z } from "zod";
import { marketAnalysisSchema } from "../groww/market-schemas.ts";
import { paperIdentityFields, paperSegment, validPaperProduct } from "./paper-instruments.ts";
import { closedSessionCandles } from "./closed-candles.ts";
import { calculateIndicators } from "./indicators.ts";
import { regularMarketSession } from "./market-session.ts";
import { requiredScreenerClose } from "./stock-screener.ts";
import { PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount, PaperPosition } from "./paper-trading.ts";
import type { Candle } from "./types.ts";

type PaperFill = PaperAccount["fills"][number];
const verdictSchema = z.enum(["FAVOURABLE", "MIXED", "RISKY", "UNAVAILABLE"]);
const metric = z.number().finite();
const frameSchema = z.object({
  interval: z.enum(["15minute", "1day"]), verdict: verdictSchema,
  reasons: z.array(z.string()), count: z.number().int().nonnegative(),
  requiredCount: z.literal(50), expectedClosedAt: metric, lastClosedAt: metric.nullable(),
  metrics: z.object({ ema20: metric, ema50: metric, rsi: metric, atr: metric,
    rangeLow: metric, rangeHigh: metric }).nullable(),
  candles: marketAnalysisSchema.shape.candles.max(5),
});
export const paperEntryRequestSchema = z.object({
  ...paperIdentityFields, entryId: z.uuid(),
}).strict().refine(validPaperProduct, "Use CASH MIS/CNC or F&O MIS/NRML.");
export const paperEntryQualitySchema = z.object({
  ...paperIdentityFields, entryId: z.uuid(), entrySide: z.enum(["BUY", "SELL"]),
  entryAt: z.number().int().positive(), entryPrice: z.number().safe().int().positive(),
  assessedAt: z.iso.datetime(), verdict: verdictSchema, summary: z.string(),
  coverage: z.enum(["FULL", "INTRADAY_ONLY", "DAILY_ONLY", "NONE"]),
  primaryInterval: z.enum(["15minute", "1day"]), headline: z.string(),
  intraday: frameSchema, daily: frameSchema,
});
export type PaperEntryQuality = z.infer<typeof paperEntryQualitySchema>;
type Frame = z.infer<typeof frameSchema>;
export type PaperEntryHistory = { candles: Candle[]; omittedCandles: number };
export const paperEntryVerdictLabels = {
  FAVOURABLE: "Favourable", MIXED: "Mixed", RISKY: "Risky", UNAVAILABLE: "Unavailable",
};

export function paperEntryContext(account: PaperAccount, position: PaperPosition) {
  let quantity = 0, additions = 0;
  let entry: PaperFill | undefined;
  for (const fill of account.fills) {
    if (positionKey(fill) !== positionKey(position)) continue;
    if (quantity === 0) { entry = fill; additions = 0; }
    else if (Math.sign(quantity) === (fill.side === "BUY" ? 1 : -1)) additions++;
    quantity += (fill.side === "BUY" ? 1 : -1) * fill.quantity;
    if (quantity === 0) entry = undefined;
  }
  if (!entry || quantity !== position.quantity) {
    throw new PaperTradingError("The opening fill cannot be reconciled with this position. Refresh the paper account.");
  }
  return { entry, additions };
}

function assessFrame(entry: PaperFill, history: PaperEntryHistory, interval: Frame["interval"]): Frame {
  const candles = closedSessionCandles(history.candles, interval, entry.at);
  const last = candles.at(-1);
  const lastClosedAt = last ? interval === "1day"
    ? regularMarketSession(last.time * 1000).closesAt : last.time * 1000 + 900_000 : null;
  const expectedClosedAt = requiredScreenerClose(interval === "15minute" ? "MIS" : "CNC", entry.at);
  const base = { interval, count: candles.length, requiredCount: 50 as const, expectedClosedAt, lastClosedAt, candles: candles.slice(-5) };
  const unavailable = (reason: string): Frame =>
    ({ ...base, verdict: "UNAVAILABLE", reasons: [reason], metrics: null });
  if (history.omittedCandles) {
    return unavailable(`Groww omitted OHLC data for ${history.omittedCandles} completed pre-entry candle(s). History is incomplete.`);
  }
  if (candles.some((bar, index) =>
    [bar.open, bar.high, bar.low, bar.close].some(price => !Number.isFinite(price) || price <= 0) ||
    bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
    index > 0 && (bar.time <= candles[index - 1].time || interval === "15minute" &&
      regularMarketSession(bar.time * 1000).date === regularMarketSession(candles[index - 1].time * 1000).date &&
      bar.time - candles[index - 1].time !== 900))) {
    return { ...unavailable("Missing, invalid or unordered historical candles prevent a reliable entry assessment."), candles: [] };
  }
  if (candles.length < base.requiredCount) {
    return unavailable(`Only ${candles.length}/${base.requiredCount} completed pre-entry candles were returned; EMA50 cannot be confirmed.${
      paperSegment(entry) === "FNO" ? " Exact contracts can have short listing histories; underlying data is not substituted." : ""}`);
  }
  if (lastClosedAt === null || lastClosedAt < expectedClosedAt) {
    const time = (at: number) => new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    return unavailable(`History stops at ${lastClosedAt === null ? "an unknown close" : time(lastClosedAt)} IST; the expected last close is ${time(expectedClosedAt)} IST. Entry timing is unverified (weekday calendar; holidays are not verified).`);
  }
  const { ema20, ema50, rsi, atr } = calculateIndicators(candles);
  if (ema20 === null || ema50 === null || rsi === null || atr === null ||
    ![ema20, ema50, rsi, atr].every(Number.isFinite) || atr <= 0) {
    return unavailable("Trend, RSI or volatility could not be calculated reliably from pre-entry history.");
  }
  const range = candles.slice(-20);
  const rangeLow = Math.min(...range.map(bar => bar.low));
  const rangeHigh = Math.max(...range.map(bar => bar.high));
  const price = entry.price / 100;
  const direction = entry.side === "BUY" ? 1 : -1;
  const trendAligned = direction * (ema20 - ema50) > 0 && direction * (price - ema20) >= 0;
  const trendAgainst = direction * (ema20 - ema50) < 0 && direction * (price - ema20) < 0;
  const momentumAligned = direction > 0 ? rsi >= 50 && rsi <= 70 : rsi >= 30 && rsi <= 50;
  const overheated = direction > 0 ? rsi > 70 : rsi < 30;
  const stretched = direction * (price - ema20) > 2 * atr;
  const boundaryDistance = direction > 0 ? rangeHigh - price : price - rangeLow;
  const nearBoundary = boundaryDistance >= 0 && boundaryDistance <= 0.5 * atr;
  const reasons = [
    trendAligned ? "Entry and EMA20/EMA50 trend aligned with the trade."
      : trendAgainst ? "Entry was against the EMA20/EMA50 trend." : "Entry and EMA trend gave mixed confirmation.",
    overheated ? `RSI was ${direction > 0 ? "above 70: the buy risked chasing an overbought move" : "below 30: the short risked chasing an oversold move"}.`
      : momentumAligned ? "RSI supported the trade direction without an extreme reading." : "RSI did not confirm the trade direction.",
  ];
  if (stretched) reasons.push("Entry was over 2 ATR beyond EMA20 in the trade direction: a stretched entry.");
  if (nearBoundary) reasons.push(`Entry was within 0.5 ATR of the prior 20-bar ${direction > 0 ? "high (resistance reference)" : "low (support reference)"}: limited room before that level.`);
  return { ...base, metrics: { ema20, ema50, rsi, atr, rangeLow, rangeHigh }, reasons,
    verdict: trendAgainst || overheated || stretched || nearBoundary ? "RISKY"
      : trendAligned && momentumAligned ? "FAVOURABLE" : "MIXED" };
}

export function assessPaperEntry(entry: PaperFill, history: { intraday: PaperEntryHistory; daily: PaperEntryHistory }): PaperEntryQuality {
  const intraday = assessFrame(entry, history.intraday, "15minute");
  const daily = assessFrame(entry, history.daily, "1day");
  const verdict = intraday.verdict === "UNAVAILABLE" || daily.verdict === "UNAVAILABLE" ? "UNAVAILABLE"
    : intraday.verdict === "RISKY" || daily.verdict === "RISKY" ? "RISKY"
      : intraday.verdict === "FAVOURABLE" && daily.verdict === "FAVOURABLE" ? "FAVOURABLE" : "MIXED";
  const summaries = {
    FAVOURABLE: "Both timeframes supported the entry without the measured stretch/range warnings. This does not guarantee a profitable trade.",
    MIXED: "The historical signals did not fully agree. The entry was not clearly confirmed across both timeframes.",
    RISKY: "At least one timeframe flagged an opposing trend, extreme RSI, stretched price or nearby historical barrier.",
  };
  const intradayReady = intraday.verdict !== "UNAVAILABLE", dailyReady = daily.verdict !== "UNAVAILABLE";
  const coverage = intradayReady && dailyReady ? "FULL" : intradayReady ? "INTRADAY_ONLY" : dailyReady ? "DAILY_ONLY" : "NONE";
  const primaryInterval = entry.product === "MIS" ? "15minute" : "1day";
  const available = intradayReady ? intraday : dailyReady ? daily : null;
  const availableLabel = intradayReady ? "Intraday" : "Daily";
  const mainAvailable = available?.interval === primaryInterval;
  const headline = coverage === "FULL" ? `Entry quality: ${paperEntryVerdictLabels[verdict]}`
    : available ? `${availableLabel}${mainAvailable ? "-only entry view" : " context only"}: ${paperEntryVerdictLabels[available.verdict]} (partial)`
      : "Entry quality unavailable";
  const missing = ([["Intraday", intraday], ["Daily", daily]] as const)
    .filter(([, frame]) => frame.verdict === "UNAVAILABLE")
    .map(([label, frame]) => `${label}: ${frame.reasons.join(" ")}`).join(" ");
  const summary = verdict !== "UNAVAILABLE" ? summaries[verdict]
    : `${available ? `${availableLabel} evidence is available, but this is not a full two-timeframe verdict. ${
      !mainAvailable ? `${primaryInterval === "15minute" ? "Intraday entry timing" : "Daily entry context"} remains unverified. ` : ""}` : ""}${missing}`;
  return paperEntryQualitySchema.parse({
    symbol: entry.symbol, exchange: entry.exchange, product: entry.product, segment: paperSegment(entry),
    entryId: entry.id, entrySide: entry.side, entryAt: entry.at, entryPrice: entry.price,
    assessedAt: new Date().toISOString(), verdict, coverage, primaryInterval, headline, summary, intraday, daily,
  });
}
