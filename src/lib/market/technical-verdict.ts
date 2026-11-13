import { z } from "zod";
import type { AnalysisMode, MarketAnalysis } from "./types.ts";

export const indicatorNames = ["VWAP", "RSI", "ATR", "EMA20", "EMA50", "MACD", "SUPERTREND"] as const;
export type IndicatorName = (typeof indicatorNames)[number];
export const indicatorSnapshotSchema = z.object({
  vwap: z.number().finite().nullable(), rsi: z.number().finite().nullable(), atr: z.number().finite().nullable(),
  ema20: z.number().finite().nullable(), ema50: z.number().finite().nullable(),
  macd: z.object({ value: z.number().finite(), signal: z.number().finite(), histogram: z.number().finite() }).nullable(),
  supertrend: z.object({ value: z.number().finite(), direction: z.enum(["bullish", "bearish"]) }).nullable(),
});
export const indicatorAssessmentSchema = z.object({
  indicator: z.enum(indicatorNames),
  signal: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNAVAILABLE"]),
  explanation: z.string().min(1).max(600),
});
export type IndicatorAssessment = z.infer<typeof indicatorAssessmentSchema>;
export function indicatorSnapshot(analysis: MarketAnalysis) {
  return indicatorSnapshotSchema.parse(analysis.technical);
}

export function indicatorAssessments(analysis: MarketAnalysis): IndicatorAssessment[] {
  const values = indicatorSnapshot(analysis);
  const price = analysis.quote.price;
  const compare = (value: number): IndicatorAssessment["signal"] =>
    price > value ? "BULLISH" : price < value ? "BEARISH" : "NEUTRAL";
  return indicatorNames.map((indicator): IndicatorAssessment => {
    const value = { VWAP: values.vwap, RSI: values.rsi, ATR: values.atr, EMA20: values.ema20,
      EMA50: values.ema50, MACD: values.macd, SUPERTREND: values.supertrend }[indicator];
    if (value === null) return { indicator, signal: "UNAVAILABLE", explanation: "Unavailable from the returned candle history; no value is estimated." };
    if (indicator === "RSI" && typeof value === "number") {
      const rsi = value;
      return { indicator, signal: rsi >= 55 && rsi <= 70 ? "BULLISH" : rsi >= 30 && rsi <= 45 ? "BEARISH" : "NEUTRAL",
        explanation: "Momentum rule: 55-70 bullish, 30-45 bearish. Other values do not confirm a trade; extremes alone do not prove reversal." };
    }
    if (indicator === "ATR") return { indicator, signal: "NEUTRAL", explanation: "Volatility, not direction. A positive ATR sets a 1.5xATR minimum risk distance." };
    if (indicator === "MACD" && typeof value === "object" && "histogram" in value) {
      const macd = value;
      return { indicator, signal: macd.value > macd.signal && macd.histogram > 0 ? "BULLISH"
        : macd.value < macd.signal && macd.histogram < 0 ? "BEARISH" : "NEUTRAL",
      explanation: "Line above signal with positive histogram confirms bullish momentum; the inverse confirms bearish momentum." };
    }
    if (indicator === "SUPERTREND" && typeof value === "object" && "direction" in value) {
      const trend = value;
      return { indicator, signal: trend.direction === "bullish" && price > trend.value ? "BULLISH"
        : trend.direction === "bearish" && price < trend.value ? "BEARISH" : "NEUTRAL",
      explanation: "Trend direction and price position relative to the trend line must agree." };
    }
    return { indicator, signal: typeof value === "number" ? compare(value) : "NEUTRAL",
      explanation: indicator === "VWAP" ? "Price above/below session VWAP supplies intraday confirmation."
        : "Price above/below this EMA supplies trend evidence; EMA20/EMA50 ordering must also confirm." };
  });
}

export interface TechnicalVerdict {
  source: "RULES";
  dataReady: boolean;
  decision: "BUY" | "SELL" | "HOLD";
  symbol: string;
  exchange: MarketAnalysis["exchange"];
  segment: "CASH" | "FNO";
  instrument?: MarketAnalysis["instrument"];
  mode: AnalysisMode;
  snapshotAt: string | null;
  referencePrice: number;
  entryPrice: number | null;
  stopLoss: number | null;
  targetPrices: number[];
  riskRewardRatio: number | null;
  riskPerUnit: number | null;
  supportLevels: number[];
  resistanceLevels: number[];
  indicatorAssessments: IndicatorAssessment[];
  indicatorSnapshot: z.infer<typeof indicatorSnapshotSchema>;
  summary: string;
  reasons: string[];
  exitOnly: boolean;
}

const day = 86_400_000;
const istDate = (time: number) => new Date(time + 330 * 60_000).toISOString().slice(0, 10);
const intervalMs = { "15minute": 900_000, "1hour": 3_600_000, "1day": day };

export function calculateTechnicalVerdict(analysis: MarketAnalysis, mode: AnalysisMode, now = Date.now()): TechnicalVerdict {
  const values = indicatorSnapshot(analysis);
  const assessments = indicatorAssessments(analysis);
  const candles = analysis.candles.slice(-20);
  const recentLow = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
  const recentHigh = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
  const result: TechnicalVerdict = {
    source: "RULES", dataReady: false, decision: "HOLD", symbol: analysis.symbol, exchange: analysis.exchange,
    segment: analysis.segment ?? "CASH", instrument: analysis.instrument, mode,
    snapshotAt: analysis.fetchedAt ?? null, referencePrice: analysis.quote.price,
    entryPrice: null, stopLoss: null, targetPrices: [], riskRewardRatio: null, riskPerUnit: null,
    supportLevels: recentLow !== null && recentLow > 0 ? [recentLow] : [],
    resistanceLevels: recentHigh !== null && recentHigh > 0 ? [recentHigh] : [],
    indicatorAssessments: assessments, indicatorSnapshot: values,
    summary: "HOLD: indicator agreement and fresh data are required.", reasons: [], exitOnly: false,
  };
  const { price, lastTradeTime } = analysis.quote;
  const lastCandle = analysis.candles.at(-1)?.time;
  const candleTime = lastCandle === undefined ? null : lastCandle * 1000;
  if (result.segment === "FNO" ? !analysis.instrument || mode === "CNC" ||
    analysis.instrument.tradingSymbol !== analysis.symbol || analysis.instrument.exchange !== analysis.exchange
    : !!analysis.instrument || mode === "NRML") {
    result.reasons.push("Contract metadata and analysis mode must match the market segment.");
  }
  if (analysis.instrument && analysis.instrument.expiry < istDate(now)) result.reasons.push("This derivative contract is expired.");
  if (!Number.isFinite(price) || price <= 0) result.reasons.push("A positive verified reference price is required.");
  if (analysis.candles.length < 50) result.reasons.push("At least 50 complete candles are required for EMA50 confirmation.");
  if (assessments.some((item) => (mode === "MIS" || item.indicator !== "VWAP") && item.signal === "UNAVAILABLE")) {
    result.reasons.push("A required indicator is unavailable; no trade levels are estimated.");
  }
  if (values.atr === null || values.atr <= 0) result.reasons.push("A positive ATR is required for risk sizing.");
  const tradeAge = lastTradeTime === null ? Infinity : now - lastTradeTime;
  const candleAge = candleTime === null ? Infinity : now - candleTime;
  if (tradeAge < -5000 || candleAge < -5000 || tradeAge > (mode === "MIS" ? 60_000 : 3 * day) ||
    candleAge > (mode === "MIS" ? 2 * intervalMs[analysis.interval] : 3 * day) ||
    (mode === "MIS" && (lastTradeTime === null || istDate(lastTradeTime) !== istDate(now) ||
      candleTime === null || istDate(candleTime) !== istDate(now)))) {
    result.reasons.push("Quote/candle timestamps are missing or stale for this mode. Refresh market data.");
  }
  if (!analysis.fetchedAt || !Number.isFinite(Date.parse(analysis.fetchedAt)) ||
    Date.parse(analysis.fetchedAt) > now + 5000 ||
    now - Date.parse(analysis.fetchedAt) > (mode === "MIS" ? 2 * intervalMs[analysis.interval] : 3 * day)) {
    result.reasons.push("A valid, recent market snapshot timestamp is required.");
  }
  if (result.reasons.length || values.atr === null) {
    result.summary = "HOLD: data quality or freshness checks did not pass.";
    return result;
  }
  result.dataReady = true;
  const emaDirection = values.ema20 !== null && values.ema50 !== null && price > values.ema20 && price > values.ema50 && values.ema20 > values.ema50
    ? "BULLISH" : values.ema20 !== null && values.ema50 !== null && price < values.ema20 && price < values.ema50 && values.ema20 < values.ema50
      ? "BEARISH" : "NEUTRAL";
  const directions = [emaDirection, ...assessments.filter((item) =>
    item.indicator === "RSI" || item.indicator === "MACD" || item.indicator === "SUPERTREND" ||
    (mode === "MIS" && item.indicator === "VWAP")).map((item) => item.signal)];
  if (!directions.every((signal) => signal === "BULLISH") && !directions.every((signal) => signal === "BEARISH")) {
    result.reasons.push("EMA trend, RSI, MACD and SuperTrend must agree; intraday also requires VWAP agreement.");
    return result;
  }
  const long = directions[0] === "BULLISH";
  result.decision = long ? "BUY" : "SELL";
  result.exitOnly = !long && (mode === "CNC" || analysis.instrument?.instrumentType === "CE" || analysis.instrument?.instrumentType === "PE");
  result.summary = result.exitOnly ? "SELL / EXIT OR AVOID: bearish indicators agree. No new short position is suggested."
    : `${result.decision}: required indicators agree. This is a conditional reference-price setup, not an execution guarantee.`;
  result.reasons.push("All required directional signals agree; this rule agreement is not a probability of profit.");
  if (result.exitOnly) return result;
  const tickSize = analysis.instrument?.tickSize ?? 0.01;
  const entryTicks = Math.round(price / tickSize);
  const riskTicks = Math.ceil((1.5 * values.atr) / tickSize - 1e-9);
  const direction = long ? 1 : -1;
  const stopTicks = entryTicks - direction * riskTicks;
  const targetTicks = [entryTicks + direction * 2 * riskTicks, entryTicks + direction * 3 * riskTicks];
  if (!Number.isFinite(tickSize) || tickSize < 1e-8 || !Number.isSafeInteger(entryTicks) ||
    !Number.isSafeInteger(riskTicks) || !Number.isSafeInteger(stopTicks) || entryTicks <= 0 || riskTicks <= 0 || stopTicks <= 0 ||
    !targetTicks.every((ticks) => Number.isSafeInteger(ticks) && ticks > 0)) {
    result.decision = "HOLD";
    result.summary = "HOLD: positive, tick-aligned risk levels cannot be represented safely.";
    result.reasons.push("ATR risk distance or tick size does not permit a valid positive-price plan.");
    return result;
  }
  const amount = (ticks: number) => Number((ticks * tickSize).toFixed(8));
  const entry = amount(entryTicks);
  const stop = amount(stopTicks);
  const targets = targetTicks.map(amount);
  if (![entry, stop, ...targets].every((level) => Number.isFinite(level) && level > 0) ||
    (long ? stop >= entry || targets[0] <= entry || targets[1] <= targets[0]
      : stop <= entry || targets[0] >= entry || targets[1] >= targets[0])) {
    result.decision = "HOLD";
    result.summary = "HOLD: rounded risk levels are invalid.";
    result.reasons.push("Finite, directional entry, stop-loss and targets could not be calculated.");
    return result;
  }
  result.entryPrice = entry;
  result.stopLoss = stop;
  result.targetPrices = targets;
  result.riskPerUnit = Math.abs(result.entryPrice - result.stopLoss);
  result.riskRewardRatio = Math.abs(result.targetPrices[0] - result.entryPrice) / result.riskPerUnit;
  result.reasons.push("Entry is the reference price rounded to tick size; risk is at least 1.5xATR, with targets at 2R and 3R.");
  if (!analysis.instrument) result.reasons.push("CASH levels use paise precision; the order review verifies the exchange's actual tick size.");
  return result;
}
