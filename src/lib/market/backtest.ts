import { calculateIndicators } from "./indicators.ts";
import { calculateRuleTradeLevels, calculateTechnicalVerdict } from "./technical-verdict.ts";
import type { AnalysisMode, Candle, Interval, MarketAnalysis } from "./types.ts";

const day = 86_400_000;
const istOffset = 330 * 60_000;
const durations = { "15minute": 900_000, "1hour": 3_600_000, "1day": day };
const sessionStart = (candle: Candle) => Math.floor((candle.time * 1000 + istOffset) / day) * day - istOffset;
const sessionClose = (candle: Candle) => sessionStart(candle) + 930 * 60_000;
const candleEnd = (candle: Candle, interval: Interval) => interval === "1day"
  ? sessionClose(candle) : Math.min(candle.time * 1000 + durations[interval], sessionClose(candle));

export interface BacktestTrade {
  side: "BUY" | "SELL";
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  exitPrice: number;
  reason: "STOP" | "TARGET" | "TIME";
  netReturnPercent: number;
}

export function summarizeBacktestTrades(trades: BacktestTrade[]) {
  const wins = trades.filter((trade) => trade.netReturnPercent > 0).length;
  const total = trades.length;
  if (!total) return { total, wins, winRate: null, confidenceInterval: null };
  const proportion = wins / total;
  const zSquared = 1.96 ** 2;
  const denominator = 1 + zSquared / total;
  const centre = (proportion + zSquared / (2 * total)) / denominator;
  const margin = 1.96 * Math.sqrt(proportion * (1 - proportion) / total + zSquared / (4 * total ** 2)) / denominator;
  return {
    total, wins, winRate: proportion * 100,
    confidenceInterval: [Math.max(0, centre - margin) * 100, Math.min(1, centre + margin) * 100],
  };
}

export function backtestTechnicalRules(analysis: MarketAnalysis, mode: AnalysisMode, now = Date.now()) {
  const roundTripCostPercent = 0.2;
  const trades: BacktestTrade[] = [];
  let pending = 0;
  let excludedOffSession = 0;
  const result = (error: string | null, candles: Candle[]) => ({
    error, roundTripCostPercent, trades, pending,
    buy: summarizeBacktestTrades(trades.filter((trade) => trade.side === "BUY")),
    sell: summarizeBacktestTrades(trades.filter((trade) => trade.side === "SELL")),
    sellEligible: mode !== "CNC" && analysis.instrument?.instrumentType !== "CE" && analysis.instrument?.instrumentType !== "PE",
    excludedOffSession, closedCandles: candles.length,
    startTime: candles[0]?.time ?? null, endTime: candles.at(-1)?.time ?? null,
  });
  const fetchedAt = Date.parse(analysis.fetchedAt ?? "");
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 5000) return result("A valid historical snapshot timestamp is required.", []);
  if (analysis.omittedCandles) return result("History contains omitted OHLC candles; their unobserved price path cannot be backtested safely.", []);
  if (mode === "MIS" && analysis.interval === "1day") return result("Intraday backtesting requires 15-minute or 1-hour candles.", []);
  if ((analysis.segment === "FNO" ? !analysis.instrument || mode === "CNC" ||
    analysis.instrument.tradingSymbol !== analysis.symbol || analysis.instrument.exchange !== analysis.exchange
    : !!analysis.instrument || mode === "NRML")) {
    return result("The contract and trading mode must match the market segment.", []);
  }
  const expiryTime = analysis.instrument ? Date.parse(`${analysis.instrument.expiry}T15:30:00+05:30`) : Infinity;
  if (analysis.instrument && !Number.isFinite(expiryTime)) return result("A valid contract expiry is required.", []);
  const sessionCandles = analysis.candles.filter((candle) => analysis.interval === "1day" ||
    (candle.time * 1000 >= sessionStart(candle) + 555 * 60_000 && candle.time * 1000 < sessionClose(candle)));
  excludedOffSession = analysis.candles.length - sessionCandles.length;
  const candles = sessionCandles.filter((candle) => candleEnd(candle, analysis.interval) <= Math.min(now, fetchedAt, expiryTime));
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (![candle.open, candle.high, candle.low, candle.close].every((price) => Number.isFinite(price) && price > 0) ||
      candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      return result("History contains invalid or non-positive OHLC prices.", candles);
    }
    if (previous && candle.time <= previous.time) return result("History must contain unique, chronologically ordered candles.", candles);
    if (analysis.interval !== "1day") {
      if (previous && (sessionStart(candle) === sessionStart(previous)
        ? candle.time * 1000 !== candleEnd(previous, analysis.interval)
        : candleEnd(previous, analysis.interval) !== sessionClose(previous) ||
          candle.time * 1000 !== sessionStart(candle) + 555 * 60_000)) {
        return result("History has missing intraday bars or session boundaries; outcomes could be unobserved.", candles);
      }
    }
  }
  if (candles.length < 51) return result("At least 50 closed warm-up candles and a subsequent entry candle are required.", candles);
  for (let index = 49; index < candles.length - 1; index++) {
    const candle = candles[index];
    const entryCandle = candles[index + 1];
    if (mode === "MIS" && sessionStart(candle) !== sessionStart(entryCandle)) continue;
    const time = candleEnd(candle, analysis.interval);
    const history = candles.slice(0, index + 1);
    const verdict = calculateTechnicalVerdict({
      ...analysis, candles: history, technical: calculateIndicators(history), fetchedAt: new Date(time).toISOString(),
      quote: { ...analysis.quote, price: candle.close, lastTradeTime: time },
    }, mode, time);
    if (verdict.decision === "HOLD" || verdict.exitOnly || verdict.indicatorSnapshot.atr === null) continue;
    const long = verdict.decision === "BUY";
    const levels = calculateRuleTradeLevels(entryCandle.open, verdict.indicatorSnapshot.atr, analysis.instrument?.tickSize ?? 0.01, long);
    if ("error" in levels) continue;
    let sessions = 1;
    let closed = false;
    for (let exitIndex = index + 1; exitIndex < candles.length; exitIndex++) {
      const bar = candles[exitIndex];
      if (exitIndex > index + 1 && sessionStart(bar) !== sessionStart(candles[exitIndex - 1])) sessions++;
      let exitPrice: number | null = null;
      let reason: BacktestTrade["reason"] = "STOP";
      // Opening gaps are observed before intrabar ranges; otherwise ambiguous bars are stop-first.
      if (long ? bar.open <= levels.stopLoss : bar.open >= levels.stopLoss) exitPrice = bar.open;
      else if (long ? bar.open >= levels.targetPrices[0] : bar.open <= levels.targetPrices[0]) {
        exitPrice = levels.targetPrices[0];
        reason = "TARGET";
      } else if (long ? bar.low <= levels.stopLoss : bar.high >= levels.stopLoss) exitPrice = levels.stopLoss;
      else if (long ? bar.high >= levels.targetPrices[0] : bar.low <= levels.targetPrices[0]) {
        exitPrice = levels.targetPrices[0];
        reason = "TARGET";
      } else if ((mode === "MIS" || sessions >= 5 || candleEnd(bar, analysis.interval) === expiryTime) &&
        candleEnd(bar, analysis.interval) === sessionClose(bar)) {
        exitPrice = bar.close;
        reason = "TIME";
      }
      if (exitPrice === null) continue;
      const grossProfit = (exitPrice - levels.entryPrice) * (long ? 1 : -1);
      const costs = (levels.entryPrice + exitPrice) * roundTripCostPercent / 200;
      trades.push({
        side: verdict.decision, entryIndex: index + 1, exitIndex, entryPrice: levels.entryPrice,
        stopLoss: levels.stopLoss, targetPrice: levels.targetPrices[0], exitPrice, reason,
        netReturnPercent: (grossProfit - costs) / levels.entryPrice * 100,
      });
      index = exitIndex - 1;
      closed = true;
      break;
    }
    if (!closed) {
      pending++;
      break;
    }
  }
  return result(null, candles);
}
