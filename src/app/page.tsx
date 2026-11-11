import { Dashboard } from "../components/dashboard/dashboard";
import { calculateIndicators } from "../lib/market/indicators";
import { sampleCandles, sampleQuote } from "../lib/market/sample-data";
import type { Interval, MarketAnalysis } from "../lib/market/types";

function createSampleAnalysis(interval: Interval): MarketAnalysis {
  const candles = sampleCandles[interval];
  return {
    symbol: "RELIANCE",
    exchange: "NSE",
    interval,
    quote: sampleQuote,
    candles,
    technical: calculateIndicators(candles),
  };
}

export default function Home() {
  return <Dashboard samples={{
    "15minute": createSampleAnalysis("15minute"),
    "1hour": createSampleAnalysis("1hour"),
    "1day": createSampleAnalysis("1day"),
  }} />;
}
