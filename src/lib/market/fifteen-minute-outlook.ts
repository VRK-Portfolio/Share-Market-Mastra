import { AverageGain, AverageLoss } from "technicalindicators";
import { summarizeBinaryOutcomes } from "./backtest.ts";
import { calculateIndicators } from "./indicators.ts";
import { regularMarketSession } from "./market-session.ts";
import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import type { TechnicalVerdict } from "./technical-verdict.ts";
import type { MarketAnalysis } from "./types.ts";

const duration = 900_000;
type Zone = "OVERBOUGHT" | "OVERSOLD" | "MIDDLE";
const zone = (rsi: number): Zone => rsi >= 70 ? "OVERBOUGHT" : rsi <= 30 ? "OVERSOLD" : "MIDDLE";
type Observation = {
  time: number; rsi: number; nextRsi: number; returnPercent: number;
  side: "BUY" | "SELL" | null; outcome: "TARGET" | "STOP" | "NEITHER" | null;
};

export function rsiCloseReferences(closes: number[], tick: number) {
  const gain = AverageGain.calculate({ values: closes, period: 14 }).at(-1);
  const loss = AverageLoss.calculate({ values: closes, period: 14 }).at(-1);
  const close = closes.at(-1);
  if (gain === undefined || loss === undefined || close === undefined || gain + loss === 0 ||
    !Number.isFinite(tick) || tick < 1e-8) return null;
  const currentRsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  const priceFor = (target: number) => {
    const ratio = target / (100 - target);
    const delta = target >= currentRsi ? 13 * (ratio * loss - gain) : -13 * (gain / ratio - loss);
    const ticks = delta >= 0 ? Math.ceil((close + delta) / tick - 1e-9) : Math.floor((close + delta) / tick + 1e-9);
    const price = Number((ticks * tick).toFixed(8));
    return Number.isSafeInteger(ticks) && Number.isFinite(price) && price > 0 ? price : null;
  };
  return { close, rsi: currentRsi, overbought: priceFor(70), oversold: priceFor(30) };
}

export function buildFifteenMinuteHistory(analysis: MarketAnalysis) {
  const unavailable = (reason: string) => ({ available: false as const, reason });
  if (analysis.interval !== "15minute") return unavailable("A dedicated 15-minute history is required.");
  if (analysis.omittedCandles) return unavailable("History has omitted OHLC candles; unobserved outcomes cannot be counted.");
  const cutoff = Date.parse(analysis.fetchedAt ?? "");
  if (!Number.isFinite(cutoff)) return unavailable("A valid history snapshot time is required.");
  if (analysis.candles.some((bar) => !Number.isFinite(bar.time) || bar.time <= 0 ||
    bar.time * 1000 > 8_640_000_000_000_000)) return unavailable("History contains invalid candle timestamps.");
  const candles = analysis.candles.filter((bar) => {
    const session = regularMarketSession(bar.time * 1000);
    return session.phase === "open" && bar.time * 1000 + duration <= Math.min(cutoff, session.closesAt);
  });
  for (let index = 0; index < candles.length; index++) {
    const bar = candles[index];
    const session = regularMarketSession(bar.time * 1000);
    const previous = candles[index - 1];
    if (![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0) ||
      bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
      (bar.time * 1000 - session.opensAt) % duration !== 0) {
      return unavailable("History contains invalid prices or misaligned 15-minute bars.");
    }
    if (previous) {
      const previousSession = regularMarketSession(previous.time * 1000);
      if (bar.time <= previous.time || (session.date === previousSession.date
        ? (bar.time - previous.time) * 1000 !== duration
        : previous.time * 1000 + duration !== previousSession.closesAt || bar.time * 1000 !== session.opensAt)) {
        return unavailable("History has missing or unordered bars; 15-minute outcomes cannot be inferred across gaps.");
      }
    }
  }
  if (candles.length < 51) return unavailable("At least 50 closed warm-up candles and one completed 15-minute outcome are required.");
  const observations: Observation[] = [];
  let previous: { verdict: TechnicalVerdict; index: number } | null = null;
  for (let index = 49; index < candles.length; index++) {
    const bar = candles[index];
    const at = bar.time * 1000 + duration;
    const prefix = candles.slice(0, index + 1);
    const technical = calculateIndicators(prefix);
    const verdict = calculateTechnicalVerdict({
      ...analysis, candles: prefix, technical, fetchedAt: new Date(at).toISOString(),
      quote: { ...analysis.quote, price: bar.close, lastTradeTime: at },
    }, "MIS", at);
    if (previous) {
      const signalBar = candles[previous.index];
      const signal = previous.verdict;
      const rsi = signal.indicatorSnapshot.rsi;
      if (bar.time * 1000 === signalBar.time * 1000 + duration &&
        regularMarketSession(bar.time * 1000).date === regularMarketSession(signalBar.time * 1000).date &&
        rsi !== null && technical.rsi !== null) {
        const side = signal.decision !== "HOLD" && !signal.exitOnly ? signal.decision : null;
        let outcome: Observation["outcome"] = null;
        if (side && signal.stopLoss !== null && signal.targetPrices[0] !== undefined) {
          const long = side === "BUY";
          // A known opening gap precedes intrabar touches; otherwise ties are stop-first.
          outcome = (long ? bar.open <= signal.stopLoss : bar.open >= signal.stopLoss) ? "STOP"
            : (long ? bar.open >= signal.targetPrices[0] : bar.open <= signal.targetPrices[0]) ? "TARGET"
              : (long ? bar.low <= signal.stopLoss : bar.high >= signal.stopLoss) ? "STOP"
                : (long ? bar.high >= signal.targetPrices[0] : bar.low <= signal.targetPrices[0]) ? "TARGET" : "NEITHER";
        }
        observations.push({
          time: signalBar.time * 1000 + duration, rsi, nextRsi: technical.rsi,
          returnPercent: (bar.close / signalBar.close - 1) * 100, side, outcome,
        });
      }
    }
    previous = { verdict, index };
  }
  return {
    available: true as const, observations, closedCandles: candles.length,
    startTime: candles[0].time * 1000, endTime: candles.at(-1)!.time * 1000 + duration,
    references: rsiCloseReferences(candles.map((bar) => bar.close), analysis.instrument?.tickSize ?? 0.01),
  };
}

export type FifteenMinuteHistory = ReturnType<typeof buildFifteenMinuteHistory>;

const quantile = (sorted: number[], proportion: number) => {
  const index = (sorted.length - 1) * proportion;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
};

export function calculateFifteenMinuteOutlook(
  analysis: MarketAnalysis | null, history: FifteenMinuteHistory | null, plan: TechnicalVerdict | null, now = Date.now(),
) {
  const unavailable = (reason: string) => ({ available: false as const, reason });
  if (!analysis || !history) return unavailable("Load a verified 15-minute snapshot and its history.");
  if (!history.available) return history;
  if (analysis.interval !== "15minute") return unavailable("Hourly/daily history cannot estimate a 15-minute outcome.");
  const session = regularMarketSession(now);
  if (session.phase !== "open" || now + duration > session.closesAt) {
    return unavailable("A full next 15 minutes within the regular 09:15-15:30 IST weekday session is required.");
  }
  const fetchedAt = Date.parse(analysis.fetchedAt ?? "");
  const quoteAge = analysis.quote.lastTradeTime === null ? Infinity : now - analysis.quote.lastTradeTime;
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > 2 * duration || fetchedAt > now + 5000 ||
    !Number.isFinite(quoteAge) || quoteAge > 60_000 || quoteAge < -5000 ||
    regularMarketSession(analysis.quote.lastTradeTime ?? 0).date !== session.date ||
    now - history.endTime > duration || history.endTime > now + 5000 ||
    !Number.isFinite(analysis.quote.price) || analysis.quote.price <= 0) {
    return unavailable("Quote/history is stale or invalid. Refresh market data; a current-day trade within 60 seconds is required.");
  }
  const rsi = analysis.technical.rsi;
  if (rsi === null || !Number.isFinite(rsi) || rsi < 0 || rsi > 100) return unavailable("A valid 15-minute RSI is unavailable.");
  const currentZone = zone(rsi);
  const matches = history.observations.filter((sample) => zone(sample.rsi) === currentZone &&
    (currentZone !== "MIDDLE" || Math.floor(sample.rsi / 10) === Math.floor(rsi / 10)));
  const reversals = matches.filter((sample) => currentZone === "OVERBOUGHT" ? sample.nextRsi <= 30
    : currentZone === "OVERSOLD" ? sample.nextRsi >= 70 : false).length;
  const reversal = currentZone === "MIDDLE" ? null : summarizeBinaryOutcomes(reversals, matches.length);
  const planReady = plan?.mode === "MIS" && plan.dataReady && plan.decision !== "HOLD" && !plan.exitOnly &&
    plan.symbol === analysis.symbol && plan.exchange === analysis.exchange && plan.segment === (analysis.segment ?? "CASH");
  const planMatches = planReady ? history.observations.filter((sample) => sample.side === plan.decision) : [];
  const trade = planReady ? {
    side: plan.decision, ...summarizeBinaryOutcomes(planMatches.filter((sample) => sample.outcome === "TARGET").length, planMatches.length),
    stopped: planMatches.filter((sample) => sample.outcome === "STOP").length,
    neither: planMatches.filter((sample) => sample.outcome === "NEITHER").length,
  } : null;
  const returns = matches.map((sample) => sample.returnPercent).sort((a, b) => a - b);
  const tick = analysis.instrument?.tickSize ?? 0.01;
  let prices: { lower: number; median: number; upper: number } | null = null;
  if (returns.length >= 30 && Number.isFinite(tick) && tick >= 1e-8) {
    const rounded = ([0.1, 0.5, 0.9] as const).map((percentile, index) => {
      const value = analysis.quote.price * (1 + quantile(returns, percentile) / 100) / tick;
      const ticks = index === 0 ? Math.floor(value + 1e-9) : index === 2 ? Math.ceil(value - 1e-9) : Math.round(value);
      return Number.isSafeInteger(ticks) ? Number((ticks * tick).toFixed(8)) : NaN;
    });
    if (rounded.every((price) => Number.isFinite(price) && price > 0)) {
      prices = { lower: rounded[0], median: rounded[1], upper: rounded[2] };
    }
  }
  return {
    available: true as const, rsi, zone: currentZone, reversal, trade, prices, priceSamples: matches.length,
    priceReason: prices ? null : returns.length < 30
      ? `Only ${returns.length} matching observations; at least 30 are required for a price range.`
      : "Positive, tick-aligned historical price bounds could not be represented safely.",
    referencePrice: analysis.quote.price, endsAt: new Date(now + duration).toISOString(),
    provisional: analysis.candles.some((bar) => bar.time * 1000 <= fetchedAt && bar.time * 1000 + duration > fetchedAt),
    history,
  };
}
