import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestTechnicalRules, summarizeBacktestTrades } from "../src/lib/market/backtest.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";
import { calculateTechnicalVerdict } from "../src/lib/market/technical-verdict.ts";
import { buildFifteenMinuteHistory, calculateFifteenMinuteOutlook, rsiCloseReferences } from "../src/lib/market/fifteen-minute-outlook.ts";

function fixture({ bearish = false, price = 100 } = {}) {
  const candles = [];
  let date = Date.parse("2026-10-26T09:15:00+05:30");
  while (candles.length < 260) {
    if (![0, 6].includes(new Date(date).getUTCDay())) {
      for (let bar = 0; bar < 25 && candles.length < 260; bar++) {
        const index = candles.length;
        const close = price + (bearish ? -1 : 1) * (index * 0.04 + Math.sin(index * 1.8) * 0.2);
        const open = candles.at(-1)?.close ?? price;
        candles.push({ time: (date + bar * 900_000) / 1000, open, close,
          high: Math.max(open, close) + 0.15, low: Math.min(open, close) - 0.15, volume: 100 });
      }
    }
    date += 86_400_000;
  }
  const now = candles.at(-1).time * 1000 + 900_000;
  return {
    symbol: "TEST", exchange: "NSE", segment: "CASH", interval: "15minute",
    fetchedAt: new Date(now).toISOString(),
    quote: { price, change: null, changePercent: null, open: price, high: price + 1,
      low: price - 1, previousClose: price, volume: 100, lastTradeTime: now },
    candles, technical: calculateIndicators(candles),
  };
}
const run = (data, mode = "MIS") => backtestTechnicalRules(data, mode, Date.parse(data.fetchedAt));
const istDate = (candle) => new Date(candle.time * 1000 + 330 * 60_000).toISOString().slice(0, 10);
function contract(data, instrumentType = "FUT", expiry = "2026-11-26") {
  return { ...data, segment: "FNO", instrument: {
    tradingSymbol: "TEST", exchange: "NSE", growwSymbol: "NSE-TEST-26Nov26-FUT",
    underlying: "TEST", instrumentType, expiry, strikePrice: instrumentType === "FUT" ? null : 100,
    lotSize: 50, tickSize: 0.05,
  } };
}
function frozenAfterEntry(data, mode) {
  const first = run(data, mode).trades[0];
  assert.ok(first);
  for (let index = first.entryIndex; index < data.candles.length; index++) {
    Object.assign(data.candles[index], {
      open: first.entryPrice, close: first.entryPrice,
      high: first.entryPrice + 0.01, low: first.entryPrice - 0.01,
    });
  }
  return first;
}

function studyData(raw = fixture(), rsi = 60) {
  const price = raw.candles.at(-1).close;
  const at = raw.candles.at(-1).time * 1000 + 900_000;
  return {
    ...raw, fetchedAt: new Date(at).toISOString(),
    quote: { ...raw.quote, price, lastTradeTime: at },
    technical: { ...raw.technical, rsi, vwap: price - 2, ema20: price - 3, ema50: price - 5,
      atr: 2, macd: { value: 5, signal: 3, histogram: 2 }, supertrend: { value: price - 4, direction: "bullish" } },
  };
}
const outlookFor = (data, history = buildFifteenMinuteHistory(data), mode = "MIS", now = Date.parse(data.fetchedAt)) =>
  calculateFifteenMinuteOutlook(data, history, calculateTechnicalVerdict(data, mode, now), now);

test("15-minute success counts target attainment, stops and timeouts with an exact one-bar horizon", () => {
  const data = studyData();
  const history = buildFifteenMinuteHistory(data);
  assert.equal(history.available, true);
  const outlook = outlookFor(data, history);
  assert.equal(outlook.available, true);
  const buys = history.observations.filter((sample) => sample.side === "BUY");
  assert.ok(buys.length > 0);
  assert.equal(outlook.trade.total, buys.length);
  assert.equal(outlook.trade.wins, buys.filter((sample) => sample.outcome === "TARGET").length);
  assert.equal(outlook.trade.total, outlook.trade.wins + outlook.trade.stopped + outlook.trade.neither);
  assert.equal(outlook.trade.winRate, outlook.trade.wins / buys.length * 100);
  assert.equal(Date.parse(outlook.endsAt) - Date.parse(data.fetchedAt), 900_000);
  for (const sample of history.observations) {
    const next = data.candles.find((bar) => bar.time * 1000 === sample.time);
    const previous = data.candles.find((bar) => bar.time * 1000 === sample.time - 900_000);
    assert.ok(next && previous);
    assert.equal(istDate(next), istDate(previous));
    assert.equal(sample.returnPercent, (next.close / previous.close - 1) * 100);
  }
});

test("15-minute studies are leakage-free and resolve known gaps before stop-first intrabar ambiguity", () => {
  const data = studyData();
  const baseline = buildFifteenMinuteHistory(data);
  assert.deepEqual(buildFifteenMinuteHistory({
    ...data, technical: { ...data.technical, rsi: null, atr: null }, quote: { ...data.quote, price: 1 },
  }), baseline);
  const sample = baseline.observations.find((item) => item.side === "BUY");
  assert.ok(sample);
  const nextIndex = data.candles.findIndex((bar) => bar.time * 1000 === sample.time);
  const prefix = data.candles.slice(0, nextIndex);
  const signal = calculateTechnicalVerdict({
    ...data, candles: prefix, technical: calculateIndicators(prefix), fetchedAt: new Date(sample.time).toISOString(),
    quote: { ...data.quote, price: prefix.at(-1).close, lastTradeTime: sample.time },
  }, "MIS", sample.time);
  Object.assign(data.candles[nextIndex], {
    open: signal.entryPrice, close: signal.entryPrice, low: signal.stopLoss - 1, high: signal.targetPrices[0] + 1,
  });
  assert.equal(buildFifteenMinuteHistory(data).observations.find((item) => item.time === sample.time).outcome, "STOP");
  Object.assign(data.candles[nextIndex], {
    open: signal.targetPrices[0] + 1, high: signal.targetPrices[0] + 2,
  });
  assert.equal(buildFifteenMinuteHistory(data).observations.find((item) => item.time === sample.time).outcome, "TARGET");
  assert.ok(outlookFor(data).trade.wins > 0);
});

test("RSI extreme transitions count actual opposite-zone closes, not small countertrend price moves", () => {
  for (const overbought of [true, false]) {
    const raw = fixture();
    raw.candles = raw.candles.map((bar, index) => {
      const close = index === 70 ? overbought ? 10 : 3000 : overbought ? 100 + index : 1000 - index;
      return { ...bar, open: close, close, high: close + 1, low: close - 1 };
    });
    const data = studyData(raw, overbought ? 80 : 20);
    const history = buildFifteenMinuteHistory(data);
    const transition = history.observations.find((sample) => sample.time === raw.candles[70].time * 1000);
    assert.ok(overbought ? transition.rsi >= 70 && transition.nextRsi <= 30
      : transition.rsi <= 30 && transition.nextRsi >= 70);
    assert.ok(outlookFor(data, history).reversal.wins > 0);
  }
});

test("RSI reversal rates condition on the current extreme and do not invent a rate for middle RSI or no samples", () => {
  const history = buildFifteenMinuteHistory(studyData());
  for (const rsi of [30, 70]) {
    const outlook = outlookFor(studyData(fixture(), rsi), history);
    const matching = history.observations.filter((sample) => rsi === 70 ? sample.rsi >= 70 : sample.rsi <= 30);
    const hits = matching.filter((sample) => rsi === 70 ? sample.nextRsi <= 30 : sample.nextRsi >= 70).length;
    assert.equal(outlook.reversal.total, matching.length);
    assert.equal(outlook.reversal.wins, hits);
    assert.equal(outlook.reversal.winRate, matching.length ? hits / matching.length * 100 : null);
    if (matching.length) {
      assert.equal(outlook.reversal.confidenceInterval.length, 2);
      assert.ok(outlook.reversal.confidenceInterval[0] <= outlook.reversal.winRate);
      assert.ok(outlook.reversal.confidenceInterval[1] >= outlook.reversal.winRate);
    }
  }
  assert.equal(outlookFor(studyData(fixture(), 60), history).reversal, null);
  const raw = fixture();
  raw.candles = raw.candles.slice(0, 51);
  const empty = outlookFor(studyData(raw, 80));
  assert.equal(empty.available, true);
  assert.equal(empty.reversal.winRate, null);
  assert.equal(empty.reversal.total, 0);
  assert.equal(empty.prices, null);
});

test("historical analogue price ranges require 30 same-zone samples and scale to the live reference without changing observations", () => {
  const raw = fixture();
  const history = buildFifteenMinuteHistory(studyData(raw));
  const groups = new Map();
  for (const sample of history.observations) {
    const key = sample.rsi >= 70 ? 80 : sample.rsi <= 30 ? 10 : Math.floor(sample.rsi / 10) * 10 + 5;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const [rsi, total] = [...groups].sort((a, b) => b[1] - a[1])[0];
  assert.ok(total >= 30);
  const data = studyData(raw, rsi);
  const first = outlookFor(data, history);
  assert.equal(first.priceSamples, total);
  assert.ok(first.prices.lower <= first.prices.median && first.prices.median <= first.prices.upper);
  const scaled = outlookFor({ ...data, quote: { ...data.quote, price: data.quote.price * 2 } }, history);
  assert.equal(scaled.priceSamples, total);
  assert.ok(Math.abs(scaled.prices.median - first.prices.median * 2) <= 0.02);
  const small = { ...history, observations: history.observations.filter((sample) =>
    rsi === 80 ? sample.rsi >= 70 : rsi === 10 ? sample.rsi <= 30 : Math.floor(sample.rsi / 10) === Math.floor(rsi / 10)).slice(0, 29) };
  const insufficient = outlookFor(data, small);
  assert.equal(insufficient.prices, null);
  assert.match(insufficient.priceReason, /29.*30/);
});

test("15-minute evidence rejects missing, stale or wrong-timeframe data and respects the exact session horizon", () => {
  const data = studyData();
  const history = buildFifteenMinuteHistory(data);
  assert.equal(buildFifteenMinuteHistory({ ...data, interval: "1hour" }).available, false);
  assert.equal(buildFifteenMinuteHistory({ ...data, omittedCandles: 1 }).available, false);
  assert.equal(buildFifteenMinuteHistory({ ...data, candles: data.candles.filter((_, index) => index !== 60) }).available, false);
  assert.equal(buildFifteenMinuteHistory({ ...data, candles: [{ ...data.candles[0], time: NaN }] }).available, false);
  const unfinished = { ...data.candles.at(-1), time: Date.parse(data.fetchedAt) / 1000, close: 1, low: 1 };
  assert.deepEqual(buildFifteenMinuteHistory({ ...data, candles: [...data.candles, unfinished] }), history);
  const now = Date.parse(data.fetchedAt);
  assert.equal(outlookFor(data, history, "MIS", now + 60_000).available, true);
  assert.equal(outlookFor(data, history, "MIS", now + 60_001).available, false);
  assert.equal(calculateFifteenMinuteOutlook({ ...data, quote: { ...data.quote, lastTradeTime: NaN } }, history, null, now).available, false);
  assert.equal(outlookFor({ ...data, technical: { ...data.technical, rsi: null } }, history).available, false);
  assert.equal(outlookFor(data, history, "CNC").trade, null);
  const raw = fixture();
  raw.candles = raw.candles.slice(0, 249);
  const closing = studyData(raw);
  const closingTime = Date.parse(closing.fetchedAt);
  assert.equal(new Date(closingTime + 330 * 60_000).toISOString().slice(11, 16), "15:15");
  assert.equal(outlookFor(closing).available, true);
  assert.equal(outlookFor(closing, buildFifteenMinuteHistory(closing), "MIS", closingTime + 1).available, false);
});

test("RSI hypothetical prices solve Wilder RSI for the next close, not an arbitrary ATR prediction", () => {
  const closes = Array.from({ length: 70 }, (_, index) => 100 + index * 0.03 + Math.sin(index * 1.8));
  const references = rsiCloseReferences(closes, 0.000001);
  assert.ok(references);
  for (const [target, price] of [[70, references.overbought], [30, references.oversold]]) {
    const candles = [...closes, price].map((close, index) => ({
      time: index * 900 + 1, open: close, close, high: close + 1, low: close - 1, volume: 100,
    }));
    assert.ok(Math.abs(calculateIndicators(candles).rsi - target) <= 0.01);
  }
  assert.equal(rsiCloseReferences(Array(60).fill(100), 0.01), null);
  assert.equal(rsiCloseReferences(closes, 0), null);
  const nearZero = closes.map((close) => close - 100 + 2);
  assert.equal(rsiCloseReferences(nearZero, 0.01).oversold, null);
});

test("walk-forward signals use closed prefixes, enter next-open and ignore current live indicators", () => {
  const data = fixture();
  const baseline = run(data);
  assert.equal(baseline.error, null);
  assert.ok(baseline.buy.total > 0);
  const first = baseline.trades[0];
  assert.ok(first.entryIndex >= 50);
  assert.equal(first.entryPrice, Math.round(data.candles[first.entryIndex].open * 100) / 100);
  assert.notEqual(first.entryPrice, Math.round(data.candles[first.entryIndex].close * 100) / 100);
  data.technical = { ...data.technical, rsi: null, ema50: null, atr: null };
  data.quote.price = 1;
  assert.deepEqual(run(data), baseline);
  const last = data.candles.at(-1);
  Object.assign(last, { close: 1000, high: 1001, low: 1 });
  assert.deepEqual(run(data).trades[0], first);
  for (let index = 1; index < baseline.trades.length; index++) {
    assert.ok(baseline.trades[index].entryIndex > baseline.trades[index - 1].exitIndex);
  }
});

test("same-bar stop and target ambiguity is stop-first for both BUY and SELL", () => {
  for (const bearish of [false, true]) {
    const data = fixture({ bearish, price: bearish ? 200 : 100 });
    const first = run(data).trades[0];
    assert.ok(first);
    Object.assign(data.candles[first.entryIndex], {
      high: Math.max(first.stopLoss, first.targetPrice) + 1,
      low: Math.min(first.stopLoss, first.targetPrice) - 1,
    });
    const trade = run(data).trades[0];
    assert.equal(trade.reason, "STOP");
    assert.equal(trade.exitIndex, first.entryIndex);
    assert.equal(trade.exitPrice, first.stopLoss);
    assert.ok(trade.netReturnPercent < 0);
  }
});

test("adverse stop gaps fill at the open; favourable target gaps do not inflate profits", () => {
  for (const bearish of [false, true]) {
    for (const stop of [true, false]) {
      const data = fixture({ bearish, price: bearish ? 200 : 100 });
      const first = run(data).trades[0];
      const bar = data.candles[first.entryIndex + 1];
      const open = stop ? first.stopLoss + (bearish ? 1 : -1) : first.targetPrice + (bearish ? -1 : 1);
      Object.assign(bar, { open, high: Math.max(open, bar.close) + 0.15, low: Math.min(open, bar.close) - 0.15 });
      const trade = run(data).trades[0];
      assert.equal(trade.reason, stop ? "STOP" : "TARGET");
      assert.equal(trade.exitPrice, stop ? open : first.targetPrice);
    }
  }
});

test("win rate counts net profitable trades, including timed exits, and honestly reports 0%", () => {
  const ordinary = run(fixture());
  const expensive = run(fixture({ price: 10_000 }));
  assert.ok(ordinary.buy.wins > 0);
  assert.ok(expensive.buy.total > 0);
  assert.ok(expensive.trades.some((trade) => trade.exitPrice > trade.entryPrice && trade.netReturnPercent < 0));
  assert.equal(expensive.buy.winRate, 0);
  assert.equal(expensive.buy.wins, 0);
  const trade = ordinary.trades[0];
  const expected = ((trade.exitPrice - trade.entryPrice) - (trade.entryPrice + trade.exitPrice) * 0.001) / trade.entryPrice * 100;
  assert.ok(Math.abs(trade.netReturnPercent - expected) < 1e-10);
});

test("MIS closes at session end; carry-forward closes after five observed sessions", () => {
  for (const mode of ["MIS", "CNC"]) {
    const data = fixture();
    frozenAfterEntry(data, mode);
    const trade = run(data, mode).trades[0];
    assert.equal(trade.reason, "TIME");
    const sessions = new Set(data.candles.slice(trade.entryIndex, trade.exitIndex + 1).map(istDate));
    assert.equal(sessions.size, mode === "MIS" ? 1 : 5);
    assert.equal(new Date(data.candles[trade.exitIndex].time * 1000 + 330 * 60_000).toISOString().slice(11, 16), "15:15");
  }
});

test("delivery and option SELL are exit-only; futures shorts use the actual contract and stop at expiry", () => {
  const bearish = fixture({ bearish: true, price: 200 });
  assert.equal(run(bearish, "CNC").sellEligible, false);
  assert.equal(run(bearish, "CNC").sell.total, 0);
  for (const type of ["CE", "PE"]) {
    const result = run(contract(bearish, type), "NRML");
    assert.equal(result.sellEligible, false);
    assert.equal(result.sell.total, 0);
    assert.ok(run(contract(fixture(), type), "NRML").buy.total > 0);
  }
  const future = contract(bearish);
  assert.ok(run(future, "NRML").sell.total > 0);
  const first = frozenAfterEntry(future, "NRML");
  const expiry = istDate(future.candles[first.entryIndex + 25]);
  future.instrument.expiry = expiry;
  const expired = run(future, "NRML");
  assert.equal(expired.trades[0].reason, "TIME");
  assert.equal(istDate(future.candles[expired.trades[0].exitIndex]), expiry);
  assert.ok(expired.trades.every((trade) => istDate(future.candles[trade.exitIndex]) <= expiry));
});

test("unfinished trades and the current incomplete candle are excluded, not forced into winning statistics", () => {
  const data = fixture();
  const first = frozenAfterEntry(data, "CNC");
  data.candles = data.candles.slice(0, first.entryIndex + 2);
  const result = run(data, "CNC");
  assert.equal(result.pending, 1);
  assert.equal(result.buy.total, 0);
  assert.equal(result.buy.winRate, null);
  const partial = fixture();
  partial.fetchedAt = new Date(partial.candles.at(-1).time * 1000 + 450_000).toISOString();
  const baseline = run(partial);
  Object.assign(partial.candles.at(-1), { high: 1_000_000, low: 1 });
  assert.deepEqual(run(partial), baseline);
  assert.equal(baseline.closedCandles, partial.candles.length - 1);
});

test("missing history, incorrect modes and unsafe data surface explicit errors rather than percentages", () => {
  for (const mutate of [
    (data) => { data.omittedCandles = 1; },
    (data) => { data.candles.splice(60, 1); },
    (data) => { data.candles[60].time = data.candles[59].time; },
    (data) => { data.candles[60].low = 0; },
    (data) => { data.fetchedAt = "invalid"; },
    (data) => { data.candles = data.candles.slice(0, 50); },
  ]) {
    const data = fixture();
    mutate(data);
    const result = run(data);
    assert.ok(result.error);
    assert.equal(result.buy.winRate, null);
    assert.equal(result.sell.winRate, null);
  }
  assert.match(run(fixture(), "NRML").error, /contract and trading mode/);
  const daily = fixture();
  daily.interval = "1day";
  assert.match(run(daily).error, /Intraday backtesting/);
  const mismatched = contract(fixture());
  mismatched.instrument.tradingSymbol = "OTHER";
  assert.match(run(mismatched).error, /contract and trading mode/);
});

test("off-session candles are excluded before warm-up and signals, preserving regular CASH and F&O results", () => {
  for (const [data, mode] of [[fixture(), "MIS"], [contract(fixture(), "CE"), "MIS"], [contract(fixture()), "NRML"]]) {
    const baseline = run(data, mode);
    const regularCount = data.candles.length;
    const extra = { ...data.candles[0], open: 1000, close: 1000, high: 1001, low: 999, volume: null };
    data.candles.push(
      { ...extra, time: Date.parse("2026-10-26T09:00:00+05:30") / 1000 },
      { ...extra, time: Date.parse("2026-10-26T15:30:00+05:30") / 1000 },
      { ...extra, time: Date.parse("2026-11-01T18:00:00+05:30") / 1000 },
    );
    data.candles.sort((a, b) => a.time - b.time);
    const snapshot = structuredClone(data);
    const result = run(data, mode);
    assert.equal(result.error, null);
    assert.equal(result.excludedOffSession, 3);
    assert.equal(result.closedCandles, regularCount);
    assert.deepEqual(result.trades, baseline.trades);
    assert.deepEqual(result.buy, baseline.buy);
    assert.deepEqual(result.sell, baseline.sell);
    assert.deepEqual(data, snapshot);
    assert.equal(new Date(data.candles[1].time * 1000 + 330 * 60_000).toISOString().slice(11, 16), "09:15");
  }
});

test("excluded off-hours cannot satisfy warm-up or hide missing regular-session observations", () => {
  const data = fixture();
  data.candles = Array.from({ length: 60 }, (_, index) => ({
    ...data.candles[0], time: Date.parse("2026-10-26T08:00:00+05:30") / 1000 + index,
  }));
  const empty = run(data);
  assert.equal(empty.closedCandles, 0);
  assert.equal(empty.excludedOffSession, 60);
  assert.match(empty.error, /50 closed warm-up candles/);
  assert.equal(empty.buy.winRate, null);
  const missing = fixture();
  missing.candles.splice(60, 1);
  missing.candles.push({ ...missing.candles[0], time: Date.parse("2026-10-26T15:30:00+05:30") / 1000 });
  missing.candles.sort((a, b) => a.time - b.time);
  const unsafe = run(missing);
  assert.equal(unsafe.excludedOffSession, 1);
  assert.match(unsafe.error, /missing intraday bars/);
  assert.equal(unsafe.buy.winRate, null);
});

test("missing volume excludes VWAP-dependent intraday setups without blocking price-only carry-forward", () => {
  const data = fixture();
  data.candles.forEach((candle) => { candle.volume = null; });
  assert.equal(run(data).buy.total, 0);
  assert.equal(run(data).sell.total, 0);
  assert.ok(run(data, "CNC").buy.total > 0);
});

test("win rates include closed losses and report uncertainty even for all wins or all losses", () => {
  const base = run(fixture()).trades[0];
  const sample = [1, 1, -1].map((netReturnPercent) => ({ ...base, netReturnPercent }));
  const summary = summarizeBacktestTrades(sample);
  assert.equal(summary.total, 3);
  assert.equal(summary.wins, 2);
  assert.ok(Math.abs(summary.winRate - 200 / 3) < 1e-10);
  assert.ok(summary.confidenceInterval[0] < summary.winRate);
  assert.ok(summary.confidenceInterval[1] > summary.winRate);
  assert.equal(summarizeBacktestTrades([]).winRate, null);
  assert.ok(summarizeBacktestTrades([{ ...base, netReturnPercent: 1 }]).confidenceInterval[0] < 100);
  assert.ok(summarizeBacktestTrades([{ ...base, netReturnPercent: -1 }]).confidenceInterval[1] > 0);
});
