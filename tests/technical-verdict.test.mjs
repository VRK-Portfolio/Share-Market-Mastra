import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateTechnicalVerdict, indicatorAssessments } from "../src/lib/market/technical-verdict.ts";
import { stockAnalysisPrompt, recommendationForMode } from "../src/lib/market/recommendation.ts";
import { indicatorDetails } from "../src/lib/market/indicator-details.ts";
import { calculateShortTermScenarios } from "../src/lib/market/short-term-scenarios.ts";

const now = Date.parse("2026-11-12T11:30:00+05:30");
function analysis(bearish = false) {
  return {
    symbol: "RELIANCE", exchange: "NSE", segment: "CASH", interval: "15minute",
    fetchedAt: new Date(now).toISOString(),
    quote: { price: 100, change: null, changePercent: null, open: 98, high: 102, low: 97,
      previousClose: 99, volume: 1000, lastTradeTime: now },
    candles: Array.from({ length: 60 }, (_, index) => ({
      time: (now - (59 - index) * 900_000) / 1000, open: 98, high: 102, low: 97, close: 100, volume: 100,
    })),
    technical: {
      vwap: bearish ? 102 : 98, rsi: bearish ? 40 : 60, atr: 2,
      ema20: bearish ? 103 : 97, ema50: bearish ? 105 : 95,
      macd: bearish ? { value: -5, signal: -3, histogram: -2 } : { value: 5, signal: 3, histogram: 2 },
      supertrend: { value: bearish ? 104 : 96, direction: bearish ? "bearish" : "bullish" },
      overlays: { vwap: [], ema20: [], supertrend: [] },
    },
  };
}
function fno(bearish = false, instrumentType = "FUT") {
  const data = analysis(bearish);
  return { ...data, segment: "FNO", instrument: {
    tradingSymbol: data.symbol, growwSymbol: "NSE-TEST-23Nov26-FUT", exchange: "NSE", underlying: "RELIANCE",
    instrumentType, expiry: "2026-11-23", strikePrice: instrumentType === "FUT" ? null : 100, lotSize: 50, tickSize: 0.1,
  } };
}
function hold(verdict) {
  assert.equal(verdict.decision, "HOLD");
  assert.equal(verdict.entryPrice, null);
  assert.equal(verdict.stopLoss, null);
  assert.deepEqual(verdict.targetPrices, []);
  assert.equal(verdict.riskRewardRatio, null);
  assert.ok(verdict.reasons.length);
}

test("complete bullish agreement produces a no-LLM entry, 1.5 ATR stop and 2R/3R targets", () => {
  const verdict = calculateTechnicalVerdict(analysis(), "MIS", now);
  assert.equal(verdict.source, "RULES");
  assert.equal(verdict.decision, "BUY");
  assert.equal(verdict.entryPrice, 100);
  assert.equal(verdict.stopLoss, 97);
  assert.deepEqual(verdict.targetPrices, [106, 109]);
  assert.equal(verdict.riskPerUnit, 3);
  assert.equal(verdict.riskRewardRatio, 2);
  assert.equal(verdict.indicatorAssessments.length, 7);
  assert.equal(verdict.indicatorAssessments.find((item) => item.indicator === "ATR").signal, "NEUTRAL");
});

test("cash MIS and futures bearish agreement can suggest shorts, but CNC and options SELL are exit-only", () => {
  for (const [data, mode, exitOnly] of [
    [analysis(true), "MIS", false], [analysis(true), "CNC", true], [fno(true), "MIS", false],
    [fno(true), "NRML", false], [fno(true, "CE"), "MIS", true], [fno(true, "PE"), "NRML", true],
  ]) {
    const verdict = calculateTechnicalVerdict(data, mode, now);
    assert.equal(verdict.decision, "SELL");
    assert.equal(verdict.exitOnly, exitOnly);
    assert.equal(verdict.entryPrice, exitOnly ? null : 100);
    assert.equal(verdict.stopLoss, exitOnly ? null : 103);
    assert.deepEqual(verdict.targetPrices, exitOnly ? [] : [94, 91]);
    assert.equal(verdict.riskRewardRatio, exitOnly ? null : 2);
  }
  for (const type of ["CE", "PE"]) assert.equal(calculateTechnicalVerdict(fno(false, type), "NRML", now).decision, "BUY");
});

test("every required directional indicator and EMA ordering must agree; ATR is never a directional vote", () => {
  for (const changes of [
    { vwap: 101 }, { rsi: 50 }, { rsi: 71 }, { rsi: 29 }, { ema20: 94 },
    { ema50: 101 }, { macd: { value: 2, signal: 3, histogram: -1 } },
    { supertrend: { value: 104, direction: "bearish" } },
    { supertrend: { value: 101, direction: "bullish" } },
  ]) {
    const data = analysis();
    Object.assign(data.technical, changes);
    hold(calculateTechnicalVerdict(data, "MIS", now));
  }
  const data = analysis();
  data.technical.vwap = null;
  hold(calculateTechnicalVerdict(data, "MIS", now));
  assert.equal(calculateTechnicalVerdict(data, "CNC", now).decision, "BUY");
});

test("RSI thresholds are inclusive and RSI extremes alone never produce a reversal trade", () => {
  for (const [bearish, boundaries, outside] of [[false, [55, 70], [54.99, 70.01]], [true, [30, 45], [29.99, 45.01]]]) {
    for (const rsi of boundaries) {
      const data = analysis(bearish);
      data.technical.rsi = rsi;
      assert.equal(calculateTechnicalVerdict(data, "MIS", now).decision, bearish ? "SELL" : "BUY");
    }
    for (const rsi of outside) {
      const data = analysis(bearish);
      data.technical.rsi = rsi;
      hold(calculateTechnicalVerdict(data, "MIS", now));
    }
  }
});

test("missing indicators, insufficient history, invalid price and zero ATR cannot fabricate plans", () => {
  for (const name of ["vwap", "rsi", "atr", "ema20", "ema50", "macd", "supertrend"]) {
    const data = analysis();
    data.technical[name] = null;
    hold(calculateTechnicalVerdict(data, "MIS", now));
    assert.equal(indicatorAssessments(data).filter((item) => item.signal === "UNAVAILABLE").length, 1);
  }
  for (const mutate of [
    (data) => { data.candles = data.candles.slice(-49); },
    (data) => { data.technical.atr = 0; },
    (data) => { data.quote.price = 0; },
    (data) => { data.fetchedAt = undefined; },
    (data) => { data.fetchedAt = "not-a-date"; },
  ]) {
    const data = analysis();
    mutate(data);
    hold(calculateTechnicalVerdict(data, "MIS", now));
  }
  const data = analysis();
  data.candles = data.candles.slice(-50);
  assert.equal(calculateTechnicalVerdict(data, "MIS", now).decision, "BUY");
});

test("freshness has exact thresholds, rejects missing/future times and expires without a new price tick", () => {
  const data = analysis();
  assert.equal(calculateTechnicalVerdict(data, "MIS", now + 60_000).decision, "BUY");
  hold(calculateTechnicalVerdict(data, "MIS", now + 60_001));
  for (const mutate of [
    (data) => { data.quote.lastTradeTime = null; },
    (data) => { data.quote.lastTradeTime = now + 5001; },
    (data) => { data.candles.at(-1).time = (now + 5001) / 1000; },
    (data) => { data.candles.at(-1).time = (now - 1_800_001) / 1000; },
    (data) => { data.fetchedAt = new Date(now - 1_800_001).toISOString(); },
    (data) => { data.fetchedAt = new Date(now + 5001).toISOString(); },
  ]) {
    const data = analysis();
    mutate(data);
    hold(calculateTechnicalVerdict(data, "MIS", now));
  }
  assert.equal(calculateTechnicalVerdict(analysis(), "CNC", now + 3 * 86_400_000).decision, "BUY");
  hold(calculateTechnicalVerdict(analysis(), "CNC", now + 3 * 86_400_000 + 1));
});

test("interval candle freshness and same Indian trading session are enforced for MIS", () => {
  for (const [interval, duration] of [["15minute", 900_000], ["1hour", 3_600_000], ["1day", 86_400_000]]) {
    const data = analysis();
    data.interval = interval;
    data.candles.at(-1).time = (now - Math.min(2 * duration, 3_600_000)) / 1000;
    assert.equal(calculateTechnicalVerdict(data, "MIS", now).decision, "BUY");
    data.candles.at(-1).time = (now - 2 * duration - 1) / 1000;
    hold(calculateTechnicalVerdict(data, "MIS", now));
  }
});

test("F&O levels round outward to actual tick size, preserve direction and recompute reward/risk", () => {
  for (const bearish of [false, true]) {
    const data = fno(bearish);
    data.quote.price = 100.06;
    data.technical.atr = 2.01;
    const verdict = calculateTechnicalVerdict(data, "NRML", now);
    assert.equal(verdict.entryPrice, 100.1);
    assert.equal(verdict.stopLoss, bearish ? 103.2 : 97);
    assert.deepEqual(verdict.targetPrices, bearish ? [93.9, 90.8] : [106.3, 109.4]);
    assert.ok(verdict.riskPerUnit >= 1.5 * data.technical.atr);
    assert.ok(Math.abs(verdict.riskRewardRatio - 2) < 1e-10);
    for (const price of [verdict.entryPrice, verdict.stopLoss, ...verdict.targetPrices]) {
      assert.ok(Math.abs(price / data.instrument.tickSize - Math.round(price / data.instrument.tickSize)) < 1e-8);
    }
  }
});

test("expired/mismatched contracts and impossible positive prices force HOLD", () => {
  for (const [data, mode] of [
    [fno(), "CNC"], [analysis(), "NRML"],
    [{ ...fno(), instrument: undefined }, "MIS"],
    [{ ...fno(), instrument: { ...fno().instrument, expiry: "2026-11-11" } }, "NRML"],
    [{ ...fno(), instrument: { ...fno().instrument, tradingSymbol: "OTHER" } }, "NRML"],
  ]) hold(calculateTechnicalVerdict(data, mode, now));
  for (const bearish of [false, true]) {
    const data = analysis(bearish);
    data.technical.atr = 100;
    hold(calculateTechnicalVerdict(data, "MIS", now));
  }
});

test("Gemini prompt has no raw candles/overlays, contains precomputed parameters, and model output needs no indicator explanations", () => {
  const data = analysis();
  const prompt = stockAnalysisPrompt(data, "MIS");
  const input = JSON.parse(prompt);
  assert.equal(input.candles, undefined);
  assert.equal(input.technical.overlays, undefined);
  assert.equal(input.technical.rsi, data.technical.rsi);
  assert.deepEqual(input.technical.macd, data.technical.macd);
  assert.equal(input.coverage.candleSampleCount, 0);
  assert.equal(input.signals.length, 7);
  assert.ok(input.ruleVerdict);
  const previousSizedPrompt = JSON.stringify({ ...input, candles: data.candles, signals: undefined, ruleVerdict: undefined });
  assert.ok(prompt.length < previousSizedPrompt.length * 0.65);
  assert.ok(!JSON.stringify(recommendationForMode("MIS").toJSONSchema()).includes("indicatorAssessments"));
});

test("indicator tooltips preserve supplied precision and explain periods, units and interpretation rules", () => {
  const data = analysis();
  data.technical.rsi = 60.12345678901234;
  data.technical.macd = { value: 5.123456789, signal: 3.987654321, histogram: 1.135802468 };
  assert.equal(indicatorDetails("RSI", data.technical).value, "60.12345678901234");
  assert.match(indicatorDetails("RSI", data.technical).description, /55-70.*30-45/);
  assert.equal(indicatorDetails("MACD", data.technical).value,
    "Line: 5.123456789; signal: 3.987654321; histogram: 1.135802468");
  assert.match(indicatorDetails("MACD", data.technical).description, /EMA12.*EMA26.*9-period/);
  assert.equal(indicatorDetails("SUPERTREND", data.technical).value, "Trend line: 96; direction: bullish");
  assert.match(indicatorDetails("SUPERTREND", data.technical).description, /period 10.*multiplier 3/);
  assert.match(indicatorDetails("ATR", data.technical).description, /price units.*not a percentage or direction/);
  for (const name of ["VWAP", "RSI", "ATR", "EMA20", "EMA50", "MACD", "SUPERTREND"]) {
    assert.match(indicatorDetails(name, null).value, /Unavailable/);
    assert.ok(indicatorDetails(name, data.technical).description.length);
  }
  data.technical.rsi = null;
  assert.match(indicatorDetails("RSI", data.technical).value, /no value is estimated/);
});

test("15/30 minute continuation scenarios use 15-minute ATR, agreement and outward price rounding", () => {
  const bullish = calculateShortTermScenarios(analysis(), now);
  assert.equal(bullish.available, true);
  assert.equal(bullish.bias, "BULLISH");
  assert.equal(bullish.referencePrice, 100);
  assert.equal(bullish.atr, 2);
  assert.deepEqual(bullish.rows.map((row) => [row.minutes, row.lowerPrice, row.upperPrice]),
    [[15, 99, 102], [30, 98.58, 102.83]]);
  assert.equal(Date.parse(bullish.rows[0].endsAt), now + 900_000);
  assert.equal(Date.parse(bullish.rows[1].endsAt), now + 1_800_000);
  const bearish = calculateShortTermScenarios(analysis(true), now);
  assert.equal(bearish.bias, "BEARISH");
  assert.deepEqual(bearish.rows.map((row) => [row.lowerPrice, row.upperPrice]), [[98, 101], [97.17, 101.42]]);
  const mixed = analysis();
  mixed.technical.rsi = 50;
  const neutral = calculateShortTermScenarios(mixed, now);
  assert.equal(neutral.bias, "NEUTRAL");
  assert.deepEqual(neutral.rows.map((row) => [row.lowerPrice, row.upperPrice]), [[98, 102], [97.17, 102.83]]);
  assert.equal(calculateTechnicalVerdict(mixed, "MIS", now).decision, "HOLD");
  assert.equal(calculateTechnicalVerdict(mixed, "MIS", now).dataReady, true);
});

test("short-term estimates never substitute hourly/daily ATR or fabricated missing/stale data", () => {
  assert.equal(calculateShortTermScenarios(null, now).available, false);
  for (const interval of ["1hour", "1day"]) {
    const response = calculateShortTermScenarios({ ...analysis(), interval }, now);
    assert.equal(response.available, false);
    assert.match(response.reason, /cannot be substituted/);
  }
  for (const mutate of [
    (data) => { data.technical.atr = null; },
    (data) => { data.technical.atr = 0; },
    (data) => { data.technical.ema50 = null; },
    (data) => { data.quote.lastTradeTime = now - 60_001; },
    (data) => { data.candles = []; },
  ]) {
    const data = analysis();
    mutate(data);
    const response = calculateShortTermScenarios(data, now);
    assert.equal(response.available, false);
    assert.ok(response.reason);
    assert.equal(response.rows, undefined);
    assert.equal(calculateTechnicalVerdict(data, "MIS", now).dataReady, false);
  }
});

function rebased(at) {
  const data = analysis();
  data.quote.lastTradeTime = at;
  data.fetchedAt = new Date(at).toISOString();
  data.candles = data.candles.map((candle) => ({ ...candle, time: candle.time + (at - now) / 1000 }));
  return data;
}

test("scenario horizons cannot cross the regular session close; one horizon can remain available", () => {
  for (const [time, first, second] of [
    ["2026-11-12T15:00:00+05:30", true, true],
    ["2026-11-12T15:00:00.001+05:30", true, false],
    ["2026-11-12T15:15:00+05:30", true, false],
    ["2026-11-12T15:20:00+05:30", false, false],
  ]) {
    const at = Date.parse(time);
    const response = calculateShortTermScenarios(rebased(at), at);
    assert.equal(response.available, first || second);
    if (!response.available) {
      assert.match(response.reason, /session close/);
      continue;
    }
    assert.equal(response.rows[0].available, first);
    assert.equal(response.rows[1].available, second);
    for (const row of response.rows.filter((row) => !row.available)) assert.match(row.reason, /session close/);
  }
  for (const time of ["2026-11-12T09:14:59+05:30", "2026-11-12T15:30:00+05:30", "2026-11-14T11:30:00+05:30"]) {
    const at = Date.parse(time);
    assert.equal(calculateShortTermScenarios(rebased(at), at).available, false);
  }
});

test("F&O scenario ranges refer to contract premiums/prices and use actual tick size, not underlying prices", () => {
  for (const type of ["FUT", "CE", "PE"]) {
    const data = fno(false, type);
    const response = calculateShortTermScenarios(data, now);
    assert.equal(response.available, true);
    assert.equal(response.referencePrice, data.quote.price);
    assert.deepEqual(response.rows.map((row) => [row.lowerPrice, row.upperPrice]), [[99, 102], [98.5, 102.9]]);
    for (const row of response.rows) {
      for (const price of [row.lowerPrice, row.upperPrice]) {
        assert.ok(Math.abs(price / data.instrument.tickSize - Math.round(price / data.instrument.tickSize)) < 1e-8);
      }
    }
  }
  const expired = fno();
  expired.instrument.expiry = "2026-11-11";
  assert.equal(calculateShortTermScenarios(expired, now).available, false);
});

test("large volatility does not invent zero/negative scenario prices", () => {
  const data = analysis();
  data.technical.atr = 300;
  const response = calculateShortTermScenarios(data, now);
  assert.equal(response.available, false);
  assert.match(response.reason, /Positive, finite/);
  assert.equal(response.rows, undefined);
});
