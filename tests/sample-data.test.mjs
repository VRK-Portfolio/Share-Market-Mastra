import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleCandles, sampleQuote } from "../src/lib/market/sample-data.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";

test("sample candles have fixed, finite prices and ordered trading-session timestamps", () => {
  for (const candles of Object.values(sampleCandles)) {
    assert.ok(candles.length >= 50);
    for (const [index, candle] of candles.entries()) {
      for (const value of Object.values(candle)) assert.ok(Number.isFinite(value));
      assert.ok(candle.high >= Math.max(candle.open, candle.close));
      assert.ok(candle.low <= Math.min(candle.open, candle.close));
      assert.ok(candle.volume > 0);
      if (index) assert.ok(candle.time > candles[index - 1].time);
      const date = new Date(candle.time * 1000);
      assert.notEqual(date.getUTCDay(), 0);
      assert.notEqual(date.getUTCDay(), 6);
      const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes() + 330;
      assert.ok(minuteOfDay >= 555 && minuteOfDay <= 915);
    }
    assert.equal(candles.at(-1).close, 2840.50);
  }
});

test("sample quote agrees with the final 15-minute session", () => {
  const candles = sampleCandles["15minute"];
  const session = candles.slice(-25);
  assert.equal(sampleQuote.price, session.at(-1).close);
  assert.equal(sampleQuote.open, session[0].open);
  assert.equal(sampleQuote.high, Math.max(...session.map((candle) => candle.high)));
  assert.equal(sampleQuote.low, Math.min(...session.map((candle) => candle.low)));
  assert.equal(sampleQuote.volume, session.reduce((sum, candle) => sum + candle.volume, 0));
  assert.equal(sampleQuote.previousClose, candles.at(-26).close);
  assert.equal(sampleQuote.change, Number((sampleQuote.price - sampleQuote.previousClose).toFixed(2)));
});

test("every sample interval produces populated indicator cards and overlays", () => {
  for (const candles of Object.values(sampleCandles)) {
    const result = calculateIndicators(candles);
    for (const key of ["vwap", "rsi", "atr", "ema20", "ema50"]) {
      assert.equal(typeof result[key], "number", key);
      assert.ok(Number.isFinite(result[key]), key);
    }
    assert.ok(result.macd);
    assert.ok(result.supertrend);
    for (const points of Object.values(result.overlays)) {
      assert.ok(points.length);
      assert.equal(points.at(-1).time, candles.at(-1).time);
    }
  }
});
