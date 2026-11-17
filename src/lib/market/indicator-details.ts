import type { IndicatorName } from "./technical-verdict.ts";

const references: Record<IndicatorName, string> = {
  VWAP: "Bullish: price > session VWAP.\nBearish: price < session VWAP.",
  RSI: "Bullish: RSI 55-70 (inclusive).\nBearish: RSI 30-45 (inclusive).\nOther values: no momentum confirmation.",
  ATR: "ATR must be > 0 for risk sizing.\nMinimum stop distance: 1.5xATR.\nNo fixed ideal value or bullish/bearish direction.",
  EMA20: "Bullish: price > EMA20 > EMA50.\nBearish: price < EMA20 < EMA50.",
  EMA50: "Bullish: price > EMA20 > EMA50.\nBearish: price < EMA20 < EMA50.",
  MACD: "Bullish: MACD line > signal and histogram > 0.\nBearish: MACD line < signal and histogram < 0.",
  SUPERTREND: "Bullish: bullish direction and price > trend line.\nBearish: bearish direction and price < trend line.",
};

const descriptions: Record<IndicatorName, string> = {
  VWAP: "Volume-weighted average price, reset each IST trading session. Price above/below VWAP gives intraday bullish/bearish evidence; there is no universal ideal price.",
  RSI: "RSI (14) ranges from 0 to 100. Above 70 is overbought and below 30 is oversold, not a guaranteed reversal. This app requires 55-70 for bullish or 30-45 for bearish momentum.",
  ATR: "ATR (14) is average true range in price units, not a percentage or direction. It measures volatility. The trade plan uses a minimum 1.5xATR stop distance.",
  EMA20: "Exponential average of 20 candle closes. Bullish trend confirmation requires price above EMA20/EMA50 and EMA20 above EMA50; bearish confirmation uses the inverse.",
  EMA50: "Exponential average of 50 candle closes. At least 50 returned candles are needed. Compare with price and EMA20; no fixed EMA value is universally correct.",
  MACD: "MACD uses EMA12 minus EMA26, a 9-period signal and line-minus-signal histogram. Line above signal with positive histogram is bullish evidence; the inverse is bearish.",
  SUPERTREND: "ATR-based trend line using period 10 and multiplier 3. Bullish/bearish direction must agree with price above/below the line. It is not a guaranteed support or stop.",
};

export function indicatorDetails(name: IndicatorName) {
  return {
    label: name,
    reference: references[name],
    description: descriptions[name],
  };
}
