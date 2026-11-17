import { regularMarketSession } from "./market-session.ts";
import type { AnalysisMode, MarketAnalysis, Quote } from "./types.ts";
import type { BenchmarkSnapshot } from "../groww/benchmark-schemas.ts";
import { assessNewsSentiment } from "./news-sentiment.ts";
import type { NewsSentiment } from "./news-sentiment.ts";

const duration = 900_000;
type Side = "BUY" | "SELL";
type Level = { price: number; source: string; kind: "support" | "resistance" };
type Missing = { available: false; reason: string };

export function assessMarketDepth(quote: Quote | undefined, now: number) {
  const missing = (reason: string): Missing => ({ available: false, reason });
  if (!quote?.depth) return missing("Top-five depth is not supplied.");
  const age = now - Date.parse(quote.depthFetchedAt ?? "");
  if (!Number.isFinite(age) || age < -5000 || age > 15_000) {
    return missing("Depth receipt is missing or older than 15 seconds; LTP ticks do not refresh the book.");
  }
  const bids = quote.depth.buy.filter((level) => level.price > 0 && level.quantity > 0)
    .sort((a, b) => b.price - a.price).slice(0, 5);
  const asks = quote.depth.sell.filter((level) => level.price > 0 && level.quantity > 0)
    .sort((a, b) => a.price - b.price).slice(0, 5);
  if (bids.length < 5 || asks.length < 5) return missing("Fewer than five non-empty bid/ask levels are reported.");
  if (new Set(bids.map((level) => level.price)).size !== 5 || new Set(asks.map((level) => level.price)).size !== 5 ||
    bids[0].price >= asks[0].price) return missing("Depth is duplicated, locked or crossed; pressure is not inferred.");
  const bidQuantity = bids.reduce((sum, level) => sum + level.quantity, 0);
  const askQuantity = asks.reduce((sum, level) => sum + level.quantity, 0);
  if (!Number.isSafeInteger(bidQuantity + askQuantity)) return missing("Depth quantities cannot be aggregated safely.");
  const imbalance = (bidQuantity - askQuantity) / (bidQuantity + askQuantity);
  const spreadPercent = (asks[0].price - bids[0].price) / (bids[0].price + (asks[0].price - bids[0].price) / 2) * 100;
  return {
    available: true as const, bids, asks, bidQuantity, askQuantity, spreadPercent, imbalance,
    pressure: imbalance >= 0.2 ? "BULLISH" as const : imbalance <= -0.2 ? "BEARISH" as const : "NEUTRAL" as const,
  };
}

export function assessSectorBenchmark(benchmark: BenchmarkSnapshot | null, now: number) {
  const missing = (reason: string): Missing => ({ available: false, reason });
  if (!benchmark) return missing("No user-selected sector-index benchmark is loaded.");
  const age = benchmark.lastTradeTime === null ? Infinity : now - benchmark.lastTradeTime;
  const receiptAge = now - Date.parse(benchmark.fetchedAt);
  if (!Number.isFinite(age) || !Number.isFinite(receiptAge) || age < -5000 || age > 60_000 ||
    receiptAge < -5000 || receiptAge > 60_000 ||
    regularMarketSession(benchmark.lastTradeTime ?? 0).date !== regularMarketSession(now).date) {
    return missing("Benchmark quote is stale; refresh it separately from the stock.");
  }
  const changePercent = (benchmark.price / benchmark.previousClose - 1) * 100;
  if (!Number.isFinite(changePercent)) return missing("Benchmark day change is invalid.");
  return {
    available: true as const, symbol: benchmark.symbol, exchange: benchmark.exchange, changePercent,
    bias: changePercent > 0 ? "BULLISH" as const : changePercent < 0 ? "BEARISH" as const : "NEUTRAL" as const,
  };
}

export interface PriceActionVerdict {
  action: "WAIT" | "CONDITIONAL BUY" | "CONDITIONAL SELL";
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  reasons: string[]; missing: string[]; patterns: string[];
  openingRange: { high: number; low: number } | null;
  volume: { ratio: number | null; baseline: number | null; samples: number; reason: string };
  boundary: { price: number; source: string } | null;
  supports: Level[]; resistances: Level[]; zoneTolerance: number;
  depth: ReturnType<typeof assessMarketDepth>;
  sector: ReturnType<typeof assessSectorBenchmark>;
  sentiment: ReturnType<typeof assessNewsSentiment>;
  confirmedAt: number | null;
}

export function calculatePriceActionConfluence(
  analysis: MarketAnalysis | null, mode: AnalysisMode, benchmark: BenchmarkSnapshot | null = null, now = Date.now(),
  news: NewsSentiment | null = null,
): PriceActionVerdict {
  const depth = assessMarketDepth(analysis?.quote, now);
  const sector = assessSectorBenchmark(benchmark, now);
  const sentiment = assessNewsSentiment(news, analysis?.symbol, analysis?.exchange, now);
  const result: PriceActionVerdict = {
    action: "WAIT", bias: "NEUTRAL", reasons: [], patterns: [],
    missing: ["Market-wide advance/decline feed is not connected.", "Executed order flow is not available from OHLCV or resting depth."],
    openingRange: null, volume: { ratio: null, baseline: null, samples: 0, reason: "Volume confirmation not assessed." },
    boundary: null, supports: [], resistances: [], zoneTolerance: 0, depth, sector, sentiment, confirmedAt: null,
  };
  if (!depth.available) result.missing.push(depth.reason);
  if (!sector.available) result.missing.push(sector.reason);
  if (!sentiment.available) result.missing.push(sentiment.reason);
  const wait = (reason: string) => { result.reasons.push(reason); return result; };
  if (!analysis) return wait("A verified 15-minute snapshot is required.");
  if ((analysis.segment ?? "CASH") !== "CASH" || mode !== "MIS" || analysis.interval !== "15minute") {
    return wait("This separate 30-minute ORB strategy supports CASH intraday with 15-minute candles only.");
  }
  const session = regularMarketSession(now);
  if (session.phase !== "open") return wait("Regular weekday session only: 09:15-15:30 IST; holidays are not verified.");
  const fetchedAt = Date.parse(analysis.fetchedAt ?? "");
  const age = analysis.quote.lastTradeTime === null ? Infinity : now - analysis.quote.lastTradeTime;
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 5000 || now - fetchedAt > 2 * duration ||
    !Number.isFinite(age) || age < -5000 || age > 60_000 ||
    regularMarketSession(analysis.quote.lastTradeTime ?? 0).date !== session.date ||
    !Number.isFinite(analysis.quote.price) || analysis.quote.price <= 0) return wait("Quote or snapshot is stale/invalid. Refresh market data.");
  if (analysis.omittedCandles) return wait("Omitted OHLC bars prevent a reliable structural assessment.");
  if (analysis.candles.some((bar) => !Number.isFinite(bar.time) || bar.time <= 0 || bar.time * 1000 > 8_640_000_000_000_000 - 86_400_000)) {
    return wait("Candle timestamps are invalid.");
  }
  const closed = analysis.candles.filter((bar) => {
    const barSession = regularMarketSession(bar.time * 1000);
    return barSession.phase === "open" && bar.time * 1000 + duration <= Math.min(now, fetchedAt, barSession.closesAt);
  });
  for (let index = 0; index < closed.length; index++) {
    const bar = closed[index];
    const previous = closed[index - 1];
    const barSession = regularMarketSession(bar.time * 1000);
    if (![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0) ||
      bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
      (bar.time * 1000 - barSession.opensAt) % duration !== 0 ||
      previous && (bar.time <= previous.time || regularMarketSession(previous.time * 1000).date === barSession.date &&
        bar.time - previous.time !== duration / 1000)) return wait("History has invalid, missing, unordered or misaligned intraday bars.");
  }
  const today = closed.filter((bar) => regularMarketSession(bar.time * 1000).date === session.date);
  if (now < session.opensAt + 2 * duration) return wait("Wait for the complete 09:15-09:45 IST opening range.");
  if (today.length < 2 || today[0].time * 1000 !== session.opensAt || today[1].time * 1000 !== session.opensAt + duration) {
    return wait("Both closed opening-range candles (09:15 and 09:30 IST) are required.");
  }
  result.openingRange = {
    high: Math.max(today[0].high, today[1].high), low: Math.min(today[0].low, today[1].low),
  };
  const current = today.at(-1)!;
  result.confirmedAt = current.time * 1000 + duration;
  if (now - result.confirmedAt > duration) return wait("The last closed price-action candle is stale. Refresh market data.");
  result.bias = current.close > result.openingRange.high ? "BULLISH" : current.close < result.openingRange.low ? "BEARISH" : "NEUTRAL";
  if (today.length < 3) return wait("The 30-minute range is ready; wait for a later 15-minute candle to confirm a setup.");
  const previous = today.at(-2)!;
  const prior = closed.slice(0, -1);
  const tolerance = Math.max(analysis.quote.price * 0.001, 0.01);
  result.zoneTolerance = tolerance;
  const levels: Level[] = [
    { price: result.openingRange.high, source: "30m opening-range high", kind: "resistance" },
    { price: result.openingRange.low, source: "30m opening-range low", kind: "support" },
    { price: Math.max(...today.slice(0, -1).map((bar) => bar.high)), source: "Prior intraday high", kind: "resistance" },
    { price: Math.min(...today.slice(0, -1).map((bar) => bar.low)), source: "Prior intraday low", kind: "support" },
  ];
  const previousDate = prior.filter((bar) => regularMarketSession(bar.time * 1000).date !== session.date).at(-1);
  const previousDay = previousDate ? prior.filter((bar) =>
    regularMarketSession(bar.time * 1000).date === regularMarketSession(previousDate.time * 1000).date) : [];
  if (previousDay.length === 25) levels.push(
    { price: Math.max(...previousDay.map((bar) => bar.high)), source: "Previous full-session high", kind: "resistance" },
    { price: Math.min(...previousDay.map((bar) => bar.low)), source: "Previous full-session low", kind: "support" },
  );
  const swings = prior.slice(-150);
  for (let index = 2; index < swings.length - 2; index++) {
    const bar = swings[index];
    const neighbours = [swings[index - 2], swings[index - 1], swings[index + 1], swings[index + 2]];
    if (neighbours.some((item) => regularMarketSession(item.time * 1000).date !== regularMarketSession(bar.time * 1000).date)) continue;
    if (neighbours.every((item) => bar.low < item.low)) levels.push({ price: bar.low, source: "Confirmed two-sided swing low", kind: "support" });
    if (neighbours.every((item) => bar.high > item.high)) levels.push({ price: bar.high, source: "Confirmed two-sided swing high", kind: "resistance" });
  }
  const uniqueLevels = levels.filter((level, index) => !levels.slice(0, index)
    .some((previousLevel) => previousLevel.price === level.price && previousLevel.kind === level.kind));
  result.supports = uniqueLevels.filter((level) => level.price < analysis.quote.price).sort((a, b) => b.price - a.price).slice(0, 2);
  result.resistances = uniqueLevels.filter((level) => level.price > analysis.quote.price).sort((a, b) => a.price - b.price).slice(0, 2);
  const slot = current.time * 1000 - session.opensAt;
  const comparable = prior.filter((bar) => {
    const barSession = regularMarketSession(bar.time * 1000);
    return barSession.date !== session.date && bar.time * 1000 - barSession.opensAt === slot;
  }).slice(-5);
  result.volume.samples = comparable.length;
  if (current.volume === null || comparable.some((bar) => bar.volume === null)) {
    result.volume.reason = "Volume is missing in the signal candle or same-slot baseline; it is not treated as zero.";
  } else if (comparable.length < 5) {
    result.volume.reason = "Five previous sessions with the same 15-minute slot are required for volume comparison.";
  } else {
    const baseline = comparable.reduce((sum, bar) => sum + (bar.volume ?? 0), 0) / comparable.length;
    if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(current.volume) || current.volume < 0) {
      result.volume.reason = "A positive, finite baseline and valid signal-candle volume are required.";
    } else {
      result.volume.baseline = baseline;
      const ratio = current.volume / baseline;
      result.volume.ratio = Number.isFinite(ratio) ? ratio : null;
      result.volume.reason = Number.isFinite(ratio)
        ? "Signal-candle volume / mean of the same slot in the previous five observed sessions; confirmation requires 1.5x."
        : "Relative volume cannot be represented safely.";
    }
  }
  const range = current.high - current.low;
  const body = Math.abs(current.close - current.open);
  const bullishWick = range > 0 && Math.min(current.open, current.close) - current.low >= 2 * body &&
    current.close >= current.low + 2 * range / 3;
  const bearishWick = range > 0 && current.high - Math.max(current.open, current.close) >= 2 * body &&
    current.close <= current.low + range / 3;
  const bullishEngulf = previous.close < previous.open && current.close > current.open && current.open <= previous.close && current.close >= previous.open;
  const bearishEngulf = previous.close > previous.open && current.close < current.open && current.open >= previous.close && current.close <= previous.open;
  if (bullishWick) result.patterns.push("Bullish rejection wick");
  if (bearishWick) result.patterns.push("Bearish rejection wick");
  if (bullishEngulf) result.patterns.push("Bullish body engulfing");
  if (bearishEngulf) result.patterns.push("Bearish body engulfing");
  if (current.high < previous.high && current.low > previous.low) result.patterns.push("Inside bar: compression, not a directional entry alone");
  const setups: { side: Side; level: Level; name: string }[] = [];
  for (const level of uniqueLevels) {
    if (level.kind === "resistance" && previous.close <= level.price && current.close > level.price) {
      setups.push({ side: "BUY", level, name: "Closed-candle resistance breakout" });
    }
    if (level.kind === "support" && previous.close >= level.price && current.close < level.price) {
      setups.push({ side: "SELL", level, name: "Closed-candle support breakdown" });
    }
    const reclaimedOrbHigh = level.source === "30m opening-range high" && previous.close >= level.price;
    const lostOrbLow = level.source === "30m opening-range low" && previous.close <= level.price;
    if ((level.kind === "support" || reclaimedOrbHigh) && Math.abs(current.low - level.price) <= tolerance &&
      current.close > level.price && (bullishWick || bullishEngulf)) {
      setups.push({ side: "BUY", level, name: "Rejection/engulfing at a support band" });
    }
    if ((level.kind === "resistance" || lostOrbLow) && Math.abs(current.high - level.price) <= tolerance &&
      current.close < level.price && (bearishWick || bearishEngulf)) {
      setups.push({ side: "SELL", level, name: "Rejection/engulfing at a resistance band" });
    }
  }
  const mother = today.at(-3)!;
  if (previous.high < mother.high && previous.low > mother.low) {
    for (const level of uniqueLevels) {
      if (Math.abs(mother.high - level.price) <= tolerance && current.close > mother.high) {
        setups.push({ side: "BUY", level, name: "Inside-bar upside break at a structural band" });
        if (!result.patterns.includes("Inside-bar upside break at a structural band")) result.patterns.push("Inside-bar upside break at a structural band");
      }
      if (Math.abs(mother.low - level.price) <= tolerance && current.close < mother.low) {
        setups.push({ side: "SELL", level, name: "Inside-bar downside break at a structural band" });
        if (!result.patterns.includes("Inside-bar downside break at a structural band")) result.patterns.push("Inside-bar downside break at a structural band");
      }
    }
  }
  if (!setups.length) return wait("No new closed-candle breakout or boundary-qualified rejection/inside-bar break. Patterns alone are not entries.");
  if (new Set(setups.map((setup) => setup.side)).size > 1) return wait("Bullish and bearish structural setups conflict.");
  const setup = setups.sort((a, b) => Math.abs(a.level.price - analysis.quote.price) - Math.abs(b.level.price - analysis.quote.price))[0];
  result.boundary = { price: setup.level.price, source: setup.level.source };
  result.reasons.push(setup.name);
  if (result.volume.ratio === null) return wait(result.volume.reason);
  if (result.volume.ratio < 1.5) return wait("Volume is below 1.5x the same-slot baseline: breakout/reversal is unconfirmed, not a proven trap.");
  if (setup.side === "BUY" ? analysis.quote.price <= setup.level.price : analysis.quote.price >= setup.level.price) {
    return wait("The live quote has not held beyond the confirmed structural boundary.");
  }
  const desired = setup.side === "BUY" ? "BULLISH" : "BEARISH";
  if (sentiment.available) result.reasons.push(`Company-headline sentiment is ${sentiment.bias}; it cannot create an entry by itself.`);
  if (sentiment.available && sentiment.bias !== "NEUTRAL" && sentiment.bias !== desired) return wait("Recent company-news sentiment opposes this setup.");
  if (sector.available && sector.bias !== "NEUTRAL" && sector.bias !== desired) return wait("The selected benchmark's day direction opposes this setup.");
  if (depth.available && depth.spreadPercent > 0.2) return wait("The reported bid/ask spread exceeds the 0.2% liquidity filter.");
  if (depth.available && depth.pressure !== "NEUTRAL" && depth.pressure !== desired) return wait("Reported top-five resting-book pressure opposes this setup.");
  result.action = setup.side === "BUY" ? "CONDITIONAL BUY" : "CONDITIONAL SELL";
  result.reasons.push("Structure and volume agree; missing market context prevents a fully confirmed verdict.");
  return result;
}
