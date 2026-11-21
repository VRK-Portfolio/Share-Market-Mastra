import type { FnoInstrument } from "../groww/instrument-schemas.ts";
import type { BenchmarkSnapshot } from "../groww/benchmark-schemas.ts";
import type { OptionTrend } from "../groww/fno-guide-schemas.ts";
import { calculateIndicators } from "./indicators.ts";
import { closedSessionCandles } from "./closed-candles.ts";
import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import { intradayEntryCutoff, regularMarketSession } from "./market-session.ts";
import type { MarketAnalysis } from "./types.ts";

export function nearbyOptionContracts(contracts: FnoInstrument[], spot: number, reference = spot) {
  const listed = [...new Set(contracts.flatMap(item => item.strikePrice === null ? [] : [item.strikePrice]))].sort((a, b) => a - b);
  const byDistance = (price: number) => [...listed].sort((a, b) => Math.abs(a - price) - Math.abs(b - price) || a - b);
  const strikes = byDistance(reference).slice(0, 7);
  return {
    nearestStrike: byDistance(spot)[0] ?? null, strikes: listed,
    contracts: contracts.filter(item => item.strikePrice !== null && strikes.includes(item.strikePrice))
      .sort((a, b) => a.strikePrice! - b.strikePrice! || a.tradingSymbol.localeCompare(b.tradingSymbol)),
  };
}

export function optionStrikeMoneyness(type: "CE" | "PE", strike: number, spot: number) {
  return strike === spot ? "ATM" : (type === "CE" ? strike < spot : strike > spot) ? "ITM" : "OTM";
}

export function optionIndexTrend(analysis: Omit<MarketAnalysis, "technical">, now: number): OptionTrend {
  const snapshotAt = Date.parse(analysis.fetchedAt ?? "");
  if (!Number.isFinite(snapshotAt)) return {
    bias: "NEUTRAL", closedThrough: null, reasons: ["A valid underlying candle snapshot timestamp is required."],
  };
  const candles = closedSessionCandles(analysis.candles, "15minute", Math.min(now, snapshotAt));
  const closedThrough = candles.length ? candles.at(-1)!.time * 1000 + 900_000 : null;
  if (analysis.segment !== "CASH" || analysis.interval !== "15minute" || analysis.omittedCandles ||
    candles.length < 50 || !closedThrough || regularMarketSession(closedThrough - 1).date !== regularMarketSession(now).date ||
    now - closedThrough > 1_800_000) {
    return { bias: "NEUTRAL", closedThrough, reasons: ["At least 50 complete regular-session 15m candles and a recent close from today are required."] };
  }
  const verdict = calculateTechnicalVerdict({ ...analysis, candles, technical: calculateIndicators(candles) }, "MIS", now);
  // Spot indices may have no traded volume; use the four volume-independent trend checks.
  const checks = verdict.directionalSignals.filter(check => check.indicator !== "VWAP");
  const bias = checks.every(check => check.signal === "BULLISH") ? "BULLISH"
    : checks.every(check => check.signal === "BEARISH") ? "BEARISH" : "NEUTRAL";
  return { bias, closedThrough, reasons: checks.map(check => `${check.indicator}: ${check.signal}`) };
}

export function optionSideGuidance(spot: BenchmarkSnapshot, trend: OptionTrend, type: "CE" | "PE", now: number) {
  const session = regularMarketSession(now);
  const time = spot.lastTradeTime;
  const snapshotAt = Date.parse(spot.fetchedAt);
  const fresh = time !== null && time <= now + 5000 && now - time <= 60_000 &&
    regularMarketSession(time).date === session.date && snapshotAt <= now + 5000 && now - snapshotAt <= 60_000;
  if (!fresh) return { action: "WAIT", preferred: null, reason: "Underlying price is stale, missing a trade time or from another session. Refresh before using nearby strikes as current." } as const;
  if (session.phase !== "open" || now >= intradayEntryCutoff(now)) return {
    action: "WAIT", preferred: null, reason: "Intraday guidance requires the regular session before 15:20 IST.",
  } as const;
  if (trend.error || !trend.closedThrough || now - trend.closedThrough > 1_800_000 || trend.closedThrough > now ||
    regularMarketSession(trend.closedThrough - 1).date !== session.date || trend.bias === "NEUTRAL") return {
    action: "WAIT", preferred: null, reason: trend.error ?? "Underlying trend is mixed or insufficient. Neither CE nor PE is confirmed.",
  } as const;
  const preferred = trend.bias === "BULLISH" ? "CE" : "PE";
  return { action: type === preferred ? "CONDITIONAL BUY" : "WAIT", preferred,
    reason: type === preferred ? `${trend.bias} underlying trend aligns with buying ${type}; confirm the option's own setup and risk first.`
      : `${trend.bias} underlying trend favors ${preferred}, not a new ${type} buy. SELL is only an exit for owned options.` } as const;
}
