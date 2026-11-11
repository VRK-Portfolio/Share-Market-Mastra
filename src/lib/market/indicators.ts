import { ATR, EMA, MACD, RSI, VWAP } from "technicalindicators";
import type { Candle, Overlay, TechnicalAnalysis } from "./types";

const last = (values: number[]) => values.at(-1) ?? null;
const sessionDate = (time: number) =>
  new Date(time * 1000 + 330 * 60_000).toISOString().slice(0, 10);

export function calculateIndicators(candles: Candle[]): TechnicalAnalysis {
  const close = candles.map((candle) => candle.close);
  const high = candles.map((candle) => candle.high);
  const low = candles.map((candle) => candle.low);
  const atr = ATR.calculate({ high, low, close, period: 14 });
  const ema20 = EMA.calculate({ values: close, period: 20 });
  const ema50 = EMA.calculate({ values: close, period: 50 });
  const macd = MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }).at(-1);
  const vwap: Overlay[] = [];
  let session: Candle[] = [];
  let date = "";
  for (const candle of candles) {
    const nextDate = sessionDate(candle.time);
    if (date !== nextDate) {
      session = [];
      date = nextDate;
    }
    session.push(candle);
    // VWAP resets at the start of each Indian trading session.
    const totalVolume = session.reduce((sum, item) => sum + item.volume, 0);
    if (totalVolume > 0) {
      const value = VWAP.calculate({
        high: session.map((item) => item.high),
        low: session.map((item) => item.low),
        close: session.map((item) => item.close),
        volume: session.map((item) => item.volume),
      }).at(-1);
      if (value !== undefined && Number.isFinite(value)) {
        vwap.push({ time: candle.time, value });
      }
    }
  }

  const supertrend = calculateSupertrend(candles);
  const latestVwap = vwap.at(-1);
  return {
    vwap: latestVwap && latestVwap.time === candles.at(-1)?.time ? latestVwap.value : null,
    rsi: last(RSI.calculate({ values: close, period: 14 })),
    atr: last(atr),
    ema20: last(ema20),
    ema50: last(ema50),
    macd:
      macd?.MACD !== undefined &&
      macd.signal !== undefined &&
      macd.histogram !== undefined
        ? { value: macd.MACD, signal: macd.signal, histogram: macd.histogram }
        : null,
    supertrend: supertrend.at(-1) ?? null,
    overlays: {
      vwap,
      ema20: ema20.map((value, index) => ({ time: candles[index + 19].time, value })),
      supertrend: supertrend.map(({ time, value }) => ({ time, value })),
    },
  };
}

export function calculateSupertrend(candles: Candle[], period = 10, multiplier = 3) {
  const atr = ATR.calculate({
    high: candles.map((item) => item.high),
    low: candles.map((item) => item.low),
    close: candles.map((item) => item.close),
    period,
  });
  const result: (Overlay & { direction: "bullish" | "bearish" })[] = [];
  let upper = 0;
  let lower = 0;
  let direction: "bullish" | "bearish" = "bearish";
  for (let index = period; index < candles.length; index++) {
    const candle = candles[index];
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + multiplier * atr[index - period];
    const basicLower = midpoint - multiplier * atr[index - period];
    if (index === period) {
      upper = basicUpper;
      lower = basicLower;
    } else {
      const previousClose = candles[index - 1].close;
      upper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
      lower = basicLower > lower || previousClose < lower ? basicLower : lower;
      direction =
        direction === "bearish"
          ? candle.close > upper ? "bullish" : "bearish"
          : candle.close < lower ? "bearish" : "bullish";
    }
    result.push({
      time: candle.time,
      value: direction === "bullish" ? lower : upper,
      direction,
    });
  }
  return result;
}
