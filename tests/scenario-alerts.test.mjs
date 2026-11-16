import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeScenarioAlerts, createScenarioAlerts, mergeScenarioAlerts,
  scenarioAlertsStorageKey, updateStoredScenarioAlerts,
} from "../src/lib/market/scenario-alerts.ts";
import { calculateShortTermScenarios } from "../src/lib/market/short-term-scenarios.ts";

const now = Date.parse("2026-11-16T10:50:00+05:30");
function analysis(bias = "BULLISH") {
  const bearish = bias === "BEARISH";
  return {
    symbol: "RELIANCE", exchange: "NSE", segment: "CASH", interval: "15minute",
    fetchedAt: new Date(now).toISOString(),
    quote: { price: 100, change: 1, changePercent: 1, open: 98, high: 102, low: 97,
      previousClose: 99, volume: 1000, lastTradeTime: now },
    candles: Array.from({ length: 60 }, (_, index) => ({
      time: (now - (59 - index) * 900_000) / 1000, open: 98, high: 102, low: 97, close: 100, volume: 100,
    })),
    technical: {
      vwap: bearish ? 102 : 98, rsi: bias === "NEUTRAL" ? 50 : bearish ? 40 : 60, atr: 2,
      ema20: bearish ? 103 : 97, ema50: bearish ? 105 : 95,
      macd: bearish ? { value: -5, signal: -3, histogram: -2 } : { value: 5, signal: 3, histogram: 2 },
      supertrend: { value: bearish ? 104 : 96, direction: bearish ? "bearish" : "bullish" },
      overlays: { vwap: [], ema20: [], supertrend: [] },
    },
  };
}
function saved(bias = "BULLISH", data = analysis(bias)) {
  return createScenarioAlerts(data, calculateShortTermScenarios(data, now), now);
}
function observation(alert, price, tradeTime = now + 1000) {
  return { symbol: alert.symbol, exchange: alert.exchange, segment: alert.segment,
    growwSymbol: alert.growwSymbol, price, tradeTime };
}
function storage(raw = null) {
  let value = raw;
  let writes = 0;
  return {
    getItem(key) { assert.equal(key, scenarioAlertsStorageKey); return value; },
    setItem(key, next) { assert.equal(key, scenarioAlertsStorageKey); value = next; writes++; },
    value: () => value, writes: () => writes,
  };
}

test("captures both displayed horizons immutably, including snapshot, ATR, bounds and deadlines", () => {
  const data = analysis();
  const scenarios = calculateShortTermScenarios(data, now);
  const alerts = createScenarioAlerts(data, scenarios, now + 1000);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((alert) => [alert.minutes, alert.lowerPrice, alert.upperPrice, alert.endsAt]),
    scenarios.rows.map((row) => [row.minutes, row.lowerPrice, row.upperPrice, row.endsAt]));
  assert.equal(alerts[0].snapshotAt, data.fetchedAt);
  assert.equal(alerts[0].createdAt, new Date(now + 1000).toISOString());
  data.quote.price = 200; data.technical.atr = 10;
  scenarios.rows[0].upperPrice = 999;
  assert.equal(alerts[0].referencePrice, 100);
  assert.equal(alerts[0].atr, 2);
  assert.equal(alerts[0].upperPrice, 102);
  assert.equal(alerts[0].completion, null);
});

test("only available horizons are saved, and stale, mismatched or non-15-minute sources fail explicitly", () => {
  const data = analysis();
  const scenarios = calculateShortTermScenarios(data, now);
  scenarios.rows[1] = { minutes: 30, endsAt: scenarios.rows[1].endsAt, available: false, reason: "Unavailable" };
  assert.deepEqual(createScenarioAlerts(data, scenarios, now).map((alert) => alert.minutes), [15]);
  assert.throws(() => createScenarioAlerts(data, scenarios, now + 61_000), /fresh 15-minute/);
  assert.throws(() => createScenarioAlerts({ ...data, interval: "1hour" }, scenarios, now), /fresh 15-minute/);
  assert.throws(() => createScenarioAlerts(data, { ...scenarios, referencePrice: 101 }, now), /matching/);
  assert.throws(() => createScenarioAlerts(data, { available: false, reason: "Missing history" }, now), /fresh 15-minute/);
});

test("directional price hits are inclusive and complete each horizon independently", () => {
  const alerts = saved();
  const time = now + 1000;
  assert.equal(completeScenarioAlerts(alerts, time, observation(alerts[0], alerts[0].lowerPrice)), alerts);
  const first = completeScenarioAlerts(alerts, time, observation(alerts[0], alerts[0].upperPrice));
  assert.equal(first[0].completion.reason, "PRICE");
  assert.equal(first[0].completion.boundary, "UPPER");
  assert.equal(first[0].completion.price, 102);
  assert.equal(first[1].completion, null);
  const both = completeScenarioAlerts(first, time + 1000, observation(alerts[1], alerts[1].upperPrice, time + 1000));
  assert.equal(both[1].completion.reason, "PRICE");
  assert.equal(both[0], first[0]);
});

test("bearish alerts use only the lower bound, while neutral alerts accept either boundary", () => {
  const bearish = saved("BEARISH");
  assert.equal(completeScenarioAlerts(bearish, now + 1000, observation(bearish[0], bearish[0].upperPrice)), bearish);
  assert.equal(completeScenarioAlerts(bearish, now + 1000, observation(bearish[0], bearish[0].lowerPrice))[0].completion.boundary, "LOWER");
  for (const boundary of ["lowerPrice", "upperPrice"]) {
    const neutral = saved("NEUTRAL");
    assert.equal(completeScenarioAlerts(neutral, now + 1000, observation(neutral[0], neutral[0][boundary]))[0].completion.reason, "PRICE");
  }
});

test("deadlines win ties and late observations; prior price completions never fire again", () => {
  const alerts = saved();
  const deadline = Date.parse(alerts[0].endsAt);
  const priceFirst = completeScenarioAlerts(alerts, deadline - 1, observation(alerts[0], alerts[0].upperPrice, deadline - 1));
  const later = completeScenarioAlerts(priceFirst, Date.parse(alerts[1].endsAt));
  assert.equal(later[0], priceFirst[0]);
  assert.equal(later[1].completion.reason, "TIME");
  assert.equal(completeScenarioAlerts(later, Date.parse(alerts[1].endsAt) + 1000), later);
  const tied = completeScenarioAlerts(alerts, deadline, observation(alerts[0], 103, deadline - 1));
  assert.equal(tied[0].completion.reason, "TIME");
  const overdue = completeScenarioAlerts(alerts, Date.parse(alerts[1].endsAt) + 60_000);
  assert.ok(overdue.every((alert) => alert.completion.reason === "TIME"));
});

test("price monitoring ignores other symbols/exchanges/segments, pre-save ticks and stale or future ticks", () => {
  const alerts = saved();
  const tick = observation(alerts[0], 110);
  for (const changed of [
    { symbol: "TCS" }, { exchange: "BSE" }, { segment: "FNO", growwSymbol: "NSE-TEST-FUT" },
    { tradeTime: now - 1 }, { tradeTime: now + 10_000 },
  ]) assert.equal(completeScenarioAlerts(alerts, now + 1000, { ...tick, ...changed }), alerts);
  assert.equal(completeScenarioAlerts(alerts, now + 62_000, tick), alerts);
});

test("F&O alerts retain exact contract identity rather than watching the underlying or another contract", () => {
  const data = analysis();
  data.segment = "FNO";
  data.instrument = { tradingSymbol: data.symbol, growwSymbol: "NSE-TEST-23Nov26-FUT", exchange: "NSE",
    underlying: "RELIANCE", instrumentType: "FUT", expiry: "2026-11-23", strikePrice: null, lotSize: 50, tickSize: 0.1 };
  const alerts = saved("BULLISH", data);
  assert.equal(alerts[0].growwSymbol, data.instrument.growwSymbol);
  assert.equal(completeScenarioAlerts(alerts, now + 1000, {
    ...observation(alerts[0], 110), growwSymbol: "NSE-TEST-30Nov26-FUT",
  }), alerts);
  assert.equal(completeScenarioAlerts(alerts, now + 1000, observation(alerts[0], 110))[0].completion.reason, "PRICE");
});

test("repeat saves do not reset exact snapshots, but a different displayed deadline is a new alert", () => {
  const existing = saved();
  const candidates = saved();
  assert.equal(mergeScenarioAlerts(existing, candidates), existing);
  const next = mergeScenarioAlerts(existing, [{ ...candidates[0], endsAt: new Date(now + 899_000).toISOString() }]);
  assert.equal(next.length, 3);
  assert.equal(next[0], existing[0]);
  assert.equal(next[2].endsAt, new Date(now + 899_000).toISOString());
});

test("local storage round-trips pending/completed alerts and persists completion before returning it", () => {
  const store = storage();
  const pending = updateStoredScenarioAlerts(store, () => saved());
  assert.equal(store.writes(), 1);
  const unchanged = updateStoredScenarioAlerts(store, (previous) => completeScenarioAlerts(previous, now));
  assert.deepEqual(unchanged, pending);
  assert.equal(store.writes(), 1);
  const completed = updateStoredScenarioAlerts(store, (previous) => completeScenarioAlerts(previous, now + 1_800_000));
  assert.deepEqual(JSON.parse(store.value()).alerts, completed);
  assert.ok(completed.every((alert) => alert.completion.reason === "TIME"));
  const reloaded = updateStoredScenarioAlerts(store, (previous) => completeScenarioAlerts(previous, now + 1_900_000));
  assert.deepEqual(reloaded, completed);
  assert.equal(store.writes(), 2);
});

test("corrupt, unsupported or inconsistent storage is rejected without overwriting it", () => {
  for (const raw of [
    "{bad", JSON.stringify({ version: 2, alerts: [] }),
    JSON.stringify({ version: 1, alerts: [{ ...saved()[0], lowerPrice: 200 }] }),
  ]) {
    const store = storage(raw);
    assert.throws(() => updateStoredScenarioAlerts(store, () => []), /not overwritten/);
    assert.equal(store.value(), raw);
    assert.equal(store.writes(), 0);
  }
});

test("blocked reads and quota failures propagate rather than reporting a successful save", () => {
  assert.throws(() => updateStoredScenarioAlerts({
    getItem() { throw new Error("Storage blocked"); }, setItem() { assert.fail("Unexpected write"); },
  }, () => saved()), /Storage blocked/);
  assert.throws(() => updateStoredScenarioAlerts({
    getItem() { return null; }, setItem() { throw new Error("Quota exceeded"); },
  }, () => saved()), /Quota exceeded/);
});
