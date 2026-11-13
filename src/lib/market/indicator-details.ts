import type { TechnicalAnalysis } from "./types.ts";
import type { IndicatorName } from "./technical-verdict.ts";

export type IndicatorValues = Omit<TechnicalAnalysis, "overlays">;

const descriptions: Record<IndicatorName, string> = {
  VWAP: "Volume-weighted average price, reset each IST trading session. Price above/below VWAP gives intraday bullish/bearish evidence; there is no universal ideal price.",
  RSI: "RSI (14) ranges from 0 to 100. Above 70 is overbought and below 30 is oversold, not a guaranteed reversal. This app requires 55-70 for bullish or 30-45 for bearish momentum.",
  ATR: "ATR (14) is average true range in price units, not a percentage or direction. It measures volatility. The trade plan uses a minimum 1.5xATR stop distance.",
  EMA20: "Exponential average of 20 candle closes. Bullish trend confirmation requires price above EMA20/EMA50 and EMA20 above EMA50; bearish confirmation uses the inverse.",
  EMA50: "Exponential average of 50 candle closes. At least 50 returned candles are needed. Compare with price and EMA20; no fixed EMA value is universally correct.",
  MACD: "MACD uses EMA12 minus EMA26, a 9-period signal and line-minus-signal histogram. Line above signal with positive histogram is bullish evidence; the inverse is bearish.",
  SUPERTREND: "ATR-based trend line using period 10 and multiplier 3. Bullish/bearish direction must agree with price above/below the line. It is not a guaranteed support or stop.",
};

export function indicatorDetails(name: IndicatorName, values: IndicatorValues | null) {
  const value = values ? {
    VWAP: values.vwap, RSI: values.rsi, ATR: values.atr, EMA20: values.ema20,
    EMA50: values.ema50, MACD: values.macd, SUPERTREND: values.supertrend,
  }[name] : null;
  return {
    label: name,
    value: value === null ? "Unavailable: insufficient history or missing volume; no value is estimated."
      : typeof value === "number" ? String(value)
        : "histogram" in value ? `Line: ${value.value}; signal: ${value.signal}; histogram: ${value.histogram}`
          : `Trend line: ${value.value}; direction: ${value.direction}`,
    description: descriptions[name],
  };
}
