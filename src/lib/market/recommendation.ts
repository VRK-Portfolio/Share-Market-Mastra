import { z } from "zod";
import { marketRequestSchema } from "../groww/market-schemas.ts";
import type { AnalysisMode, MarketAnalysis } from "./types.ts";
import { fnoInstrumentSchema } from "../groww/instrument-schemas.ts";
import type { FnoInstrument } from "../groww/instrument-schemas.ts";

export const stockAnalysisModel = "google/gemini-3.8-flash";
export const recommendationRequestSchema = marketRequestSchema.extend({
  mode: z.enum(["MIS", "CNC", "NRML"]),
}).refine((value) => value.segment === "FNO" ? value.mode !== "CNC" : value.mode !== "NRML",
  "Use MIS/CNC for CASH or MIS/NRML for F&O.");

const price = z.number().finite().positive();
const explanation = z.string().trim().min(1).max(600);
export const indicatorNames = ["VWAP", "RSI", "ATR", "EMA20", "EMA50", "MACD", "SUPERTREND"] as const;
export const indicatorSnapshotSchema = z.object({
  vwap: z.number().finite().nullable(), rsi: z.number().finite().nullable(), atr: z.number().finite().nullable(),
  ema20: z.number().finite().nullable(), ema50: z.number().finite().nullable(),
  macd: z.object({ value: z.number().finite(), signal: z.number().finite(), histogram: z.number().finite() }).nullable(),
  supertrend: z.object({ value: z.number().finite(), direction: z.enum(["bullish", "bearish"]) }).nullable(),
});
const recommendationSchema = z.object({
  decision: z.enum(["BUY", "SELL", "HOLD"]),
  confidencePercent: z.number().int().min(0).max(100),
  summary: explanation,
  entryPrice: price.nullable(),
  targetPrices: z.array(price).max(3),
  stopLoss: price.nullable(),
  supportLevels: z.array(price).max(3),
  resistanceLevels: z.array(price).max(3),
  rationale: z.array(explanation).min(1).max(6),
  indicatorAssessments: z.array(z.object({
    indicator: z.enum(indicatorNames),
    signal: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNAVAILABLE"]),
    explanation,
  })).length(indicatorNames.length).refine((items) => new Set(items.map((item) => item.indicator)).size === indicatorNames.length,
    "Explain each indicator exactly once."),
  risks: z.array(explanation).min(1).max(6),
  invalidation: explanation,
  gtt: z.object({
    entryTriggerPrice: price,
    targetTriggerPrice: price,
    stopLossTriggerPrice: price,
    note: explanation,
  }).nullable(),
});
type Recommendation = z.infer<typeof recommendationSchema>;

function validateLevels(value: Recommendation, mode: AnalysisMode, context: z.RefinementCtx, instrumentType?: FnoInstrument["instrumentType"]) {
  const trade = value.decision === "BUY" || (value.decision === "SELL" && mode !== "CNC" &&
    (!instrumentType || instrumentType === "FUT"));
  if (!trade) {
    if (value.entryPrice !== null || value.stopLoss !== null || value.targetPrices.length || value.gtt !== null) {
      context.addIssue({ code: "custom", message: "HOLD, delivery SELL/avoid and option SELL/exit must not suggest a new trade or GTT." });
    }
    return;
  }
  const { entryPrice, stopLoss, targetPrices } = value;
  if (entryPrice === null || stopLoss === null || !targetPrices.length) {
    context.addIssue({ code: "custom", message: "A trade requires an entry, target and stop-loss." });
    return;
  }
  const long = value.decision === "BUY";
  if (long ? stopLoss >= entryPrice : stopLoss <= entryPrice) {
    context.addIssue({ code: "custom", path: ["stopLoss"], message: "Stop-loss is on the wrong side of entry." });
  }
  if (!targetPrices.every((target, index) => long
    ? target > (index ? targetPrices[index - 1] : entryPrice)
    : target < (index ? targetPrices[index - 1] : entryPrice))) {
    context.addIssue({ code: "custom", path: ["targetPrices"], message: "Targets must progress away from entry in the trade direction." });
  }
  if (value.gtt !== null && (mode !== "CNC" || !long ||
    value.gtt.entryTriggerPrice !== entryPrice ||
    value.gtt.targetTriggerPrice !== targetPrices[0] ||
    value.gtt.stopLossTriggerPrice !== stopLoss)) {
    context.addIssue({ code: "custom", path: ["gtt"], message: "GTT suggestions must match a delivery BUY plan; GTT is unavailable for MIS." });
  }
}

export function recommendationForMode(mode: AnalysisMode, instrumentType?: FnoInstrument["instrumentType"]) {
  return recommendationSchema.superRefine((value, context) => validateLevels(value, mode, context, instrumentType));
}

export const recommendationResponseSchema = recommendationSchema.extend({
  symbol: z.string().min(1),
  exchange: z.enum(["NSE", "BSE"]),
  interval: marketRequestSchema.shape.interval,
  mode: z.enum(["MIS", "CNC", "NRML"]),
  segment: z.enum(["CASH", "FNO"]).default("CASH"),
  instrument: fnoInstrumentSchema.optional(),
  model: z.literal(stockAnalysisModel),
  generatedAt: z.iso.datetime(),
  snapshotAt: z.iso.datetime(),
  referencePrice: z.number().finite().nonnegative(),
  lastTradeTime: z.number().finite().nonnegative().nullable(),
  lastCandleTime: z.number().finite().positive().nullable(),
  candleCount: z.number().int().nonnegative(),
  candleSampleCount: z.number().int().nonnegative().max(120),
  omittedCandles: z.number().int().nonnegative(),
  riskRewardRatio: z.number().finite().positive().nullable(),
  indicatorSnapshot: indicatorSnapshotSchema,
}).superRefine((value, context) => {
  validateLevels(value, value.mode, context, value.instrument?.instrumentType);
  if (value.segment === "FNO" ? value.mode === "CNC" || !value.instrument ||
    value.instrument.tradingSymbol !== value.symbol || value.instrument.exchange !== value.exchange
    : value.mode === "NRML" || !!value.instrument) {
    context.addIssue({ code: "custom", message: "Recommendation contract, segment and mode must match." });
  }
});

export type StockRecommendation = z.infer<typeof recommendationResponseSchema>;

export function indicatorSnapshot(analysis: MarketAnalysis) {
  return indicatorSnapshotSchema.parse(analysis.technical);
}

export function stockAnalysisPrompt(analysis: MarketAnalysis, mode: AnalysisMode) {
  const candles = analysis.candles.slice(-120);
  const technical = analysis.technical;
  return JSON.stringify({
    mode,
    segment: analysis.segment ?? "CASH",
    instrument: analysis.instrument,
    horizon: mode === "MIS" ? "Intraday; close any position within the trading session."
      : mode === "NRML" ? "Overnight derivative scenario, bounded by the selected contract expiry."
      : "Delivery swing scenario, not a long-term fundamental valuation.",
    task: "Build a conditional indicator-based price scenario. Explain every supplied indicator's actual values, how the signals agree or conflict, and how ATR and candle support/resistance justify entry, targets and stop-loss. Do not claim a guaranteed prediction.",
    requestedAt: new Date().toISOString(),
    symbol: analysis.symbol,
    exchange: analysis.exchange,
    interval: analysis.interval,
    snapshotAt: analysis.fetchedAt,
    quote: analysis.quote,
    coverage: {
      candleCount: analysis.candles.length,
      candleSampleCount: candles.length,
      omittedCandles: analysis.omittedCandles ?? 0,
      firstCandleTime: analysis.candles[0]?.time ?? null,
      lastCandleTime: analysis.candles.at(-1)?.time ?? null,
    },
    technical: {
      vwap: technical.vwap, rsi: technical.rsi, atr: technical.atr,
      ema20: technical.ema20, ema50: technical.ema50,
      macd: technical.macd, supertrend: technical.supertrend,
    },
    candles,
  });
}
