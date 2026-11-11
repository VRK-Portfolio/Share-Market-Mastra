import assert from "node:assert/strict";
import { test } from "node:test";
import { ATR, EMA, MACD, RSI, VWAP } from "technicalindicators";
import { calculateIndicators, calculateSupertrend } from "../src/lib/market/indicators.ts";

function series(count = 100) {
  const start = Date.parse("2026-11-09T09:15:00+05:30") / 1000;
  return Array.from({ length: count }, (_, index) => {
    const close = 200 + index * 0.4 + Math.sin(index / 3) * 5;
    return { time: start + index * 900, open: close - 1, high: close + 2, low: close - 3, close, volume: 100 + index * 5 };
  });
}

test("insufficient candle history returns unavailable values, never synthetic prices", () => {
  const result = calculateIndicators([]);
  for (const key of ["vwap", "rsi", "atr", "ema20", "ema50", "macd", "supertrend"]) {
    assert.equal(result[key], null, key);
  }
  assert.deepEqual(result.overlays, { vwap: [], ema20: [], supertrend: [] });
  const short = calculateIndicators(series(5));
  assert.equal(short.rsi, null);
  assert.equal(short.atr, null);
  assert.equal(short.ema20, null);
  assert.equal(short.macd, null);
});

test("RSI, ATR, EMA and MACD match the installed plugin exactly", () => {
  const candles = series();
  const values = candles.map((candle) => candle.close);
  const result = calculateIndicators(candles);
  assert.equal(result.rsi, RSI.calculate({ values, period: 14 }).at(-1));
  assert.equal(result.ema20, EMA.calculate({ values, period: 20 }).at(-1));
  assert.equal(result.ema50, EMA.calculate({ values, period: 50 }).at(-1));
  assert.equal(result.atr, ATR.calculate({
    high: candles.map((item) => item.high),
    low: candles.map((item) => item.low), close: values, period: 14,
  }).at(-1));
  const macd = MACD.calculate({ values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).at(-1);
  assert.deepEqual(result.macd, { value: macd.MACD, signal: macd.signal, histogram: macd.histogram });
  assert.equal(result.overlays.ema20[0].time, candles[19].time);
});

test("VWAP matches plugin and resets at the next IST session", () => {
  const candles = series(10);
  const result = calculateIndicators(candles);
  assert.equal(result.vwap, VWAP.calculate({
    high: candles.map((item) => item.high), low: candles.map((item) => item.low),
    close: candles.map((item) => item.close), volume: candles.map((item) => item.volume),
  }).at(-1));
  const next = { ...candles[0], time: candles[0].time + 86400, high: 305, low: 295, close: 300 };
  assert.equal(calculateIndicators([...candles, next]).vwap, 300);
  assert.equal(calculateIndicators([{ ...next, volume: 0 }]).vwap, null);
});

test("SuperTrend aligns with ATR warmup and flips on a decisive reversal", () => {
  const up = Array.from({ length: 60 }, (_, index) => ({
    time: index * 900, open: 100 + index * 3, high: 102 + index * 3,
    low: 99 + index * 3, close: 101 + index * 3, volume: 100,
  }));
  const trend = calculateSupertrend(up);
  assert.equal(trend.length, up.length - 10);
  assert.equal(trend[0].time, up[10].time);
  const atr = ATR.calculate({ high: up.map(c => c.high), low: up.map(c => c.low), close: up.map(c => c.close), period: 10 });
  assert.equal(trend[0].value, (up[10].high + up[10].low) / 2 + 3 * atr[0]);
  assert.equal(trend.at(-1).direction, "bullish");
  assert.ok(trend.at(-1).value < up.at(-1).close);
  const reversal = { time: 60 * 900, open: 278, high: 279, low: 100, close: 101, volume: 100 };
  const reversed = calculateSupertrend([...up, reversal]).at(-1);
  assert.equal(reversed.direction, "bearish");
  assert.ok(reversed.value > reversal.close);
});
