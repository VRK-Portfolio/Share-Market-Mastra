import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestTechnicalRules, summarizeBacktestTrades } from "../src/lib/market/backtest.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";

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
