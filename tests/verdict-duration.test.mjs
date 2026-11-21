import assert from "node:assert/strict";
import { test } from "node:test";
import { observeVerdict, verdictObservationSchema, verdictDurationLabel, verdictTimingContext } from "../src/lib/market/verdict-duration.ts";

const now = Date.parse("2026-11-18T14:00:00+05:30");
const context = "NSE:FNO:NIFTY:CE:MIS:15minute";

test("unchanged BUY/SELL/HOLD observations accumulate time, while a known transition starts a new timer", () => {
  for (const decision of ["BUY", "SELL", "HOLD"]) {
    const first = observeVerdict(null, context, decision, now, false);
    const tick = observeVerdict(first, context, decision, now + 1000, true);
    const next = observeVerdict(tick, context, decision, now + 4000, true);
    assert.equal(next.firstObservedAt, now);
    assert.equal(next.observedMs, 4000);
    assert.equal(next.lastGap, null);
    assert.equal(first.observedMs, 0);
    const changed = observeVerdict(next, context, decision === "HOLD" ? "BUY" : "HOLD", now + 4500, true);
    assert.equal(changed.firstObservedAt, now + 4500);
    assert.equal(changed.observedMs, 0);
    assert.equal(changed.lastGap, null);
  }
});

test("same-state reload restores observed time but excludes the unmonitored gap and never assumes continuity", () => {
  const first = observeVerdict(null, context, "HOLD", now, false);
  const saved = observeVerdict(first, context, "HOLD", now + 2000, true);
  const restored = verdictObservationSchema.parse(JSON.parse(JSON.stringify(saved)));
  const resumed = observeVerdict(restored, context, "HOLD", now + 62_000, false);
  assert.equal(resumed.firstObservedAt, now);
  assert.equal(resumed.observedMs, 2000);
  assert.deepEqual(resumed.lastGap, { from: now + 2000, to: now + 62_000, previousDecision: "HOLD" });
  const live = observeVerdict(resumed, context, "HOLD", now + 63_000, true);
  assert.equal(live.observedMs, 3000);
  assert.deepEqual(live.lastGap, resumed.lastGap);
});

test("a verdict changed while away starts at its first new observation and retains the uncertain transition", () => {
  const saved = observeVerdict(null, context, "BUY", now, false);
  const resumed = observeVerdict(saved, context, "SELL", now + 60_000, false);
  assert.equal(resumed.firstObservedAt, now + 60_000);
  assert.equal(resumed.observedMs, 0);
  assert.equal(resumed.lastGap.previousDecision, "BUY");
  assert.equal(resumed.lastGap.from, now);
  const next = observeVerdict(resumed, context, "SELL", now + 61_000, true);
  assert.equal(next.observedMs, 1000);
  assert.equal(next.lastGap.previousDecision, "BUY");
  const observedTransition = observeVerdict(next, context, "HOLD", now + 62_000, true);
  assert.equal(observedTransition.observedMs, 0);
  assert.equal(observedTransition.lastGap, null);
});

test("paused observations and throttled clocks exclude gaps, including the exact heartbeat boundary", () => {
  const saved = observeVerdict(null, context, "BUY", now, false);
  const boundary = observeVerdict(saved, context, "BUY", now + 5000, true);
  assert.equal(boundary.observedMs, 5000);
  const throttled = observeVerdict(saved, context, "BUY", now + 5001, true);
  assert.equal(throttled.observedMs, 0);
  assert.equal(throttled.lastGap.to, now + 5001);
  const paused = observeVerdict(saved, context, "BUY", now + 2000, false);
  assert.equal(paused.observedMs, 0);
  assert.equal(paused.lastGap.to, now + 2000);
});

test("different instruments, exchanges, segments, products and intervals never share an elapsed timer", () => {
  const data = { symbol: "NIFTYCE", exchange: "NSE", segment: "FNO", interval: "15minute", instrument: { growwSymbol: "NSE-NIFTY-CE" } };
  const key = verdictTimingContext(data, "MIS");
  const previous = observeVerdict(null, key, "HOLD", now, false);
  const contexts = [
    verdictTimingContext({ ...data, symbol: "NIFTYPE" }, "MIS"),
    verdictTimingContext({ ...data, exchange: "BSE" }, "MIS"),
    verdictTimingContext({ ...data, segment: "CASH" }, "MIS"),
    verdictTimingContext({ ...data, instrument: { growwSymbol: "NSE-OTHER-CE" } }, "MIS"),
    verdictTimingContext(data, "NRML"),
    verdictTimingContext({ ...data, interval: "1hour" }, "MIS"),
  ];
  for (const changed of contexts) {
    const next = observeVerdict(previous, changed, "HOLD", now + 3000, true);
    assert.equal(next.firstObservedAt, now + 3000);
    assert.equal(next.observedMs, 0);
    assert.equal(next.lastGap, null);
  }
});

test("malformed history, impossible timelines and a backwards device clock are rejected explicitly", () => {
  const valid = observeVerdict(null, context, "BUY", now, false);
  for (const invalid of [
    { ...valid, version: 2 }, { ...valid, decision: "WAIT" }, { ...valid, observedMs: 1 },
    { ...valid, observedMs: -1 }, { ...valid, firstObservedAt: now + 1 },
    { ...valid, lastGap: { from: now + 1, to: now, previousDecision: "BUY" } },
    { ...valid, lastGap: { from: now, to: now + 1, previousDecision: "BUY" } },
  ]) assert.equal(verdictObservationSchema.safeParse(invalid).success, false);
  assert.throws(() => observeVerdict(valid, context, "BUY", now - 1, false), /clock moved backwards/);
  assert.throws(() => observeVerdict(null, context, "HOLD", NaN, false));
});

test("duration labels retain seconds and scale to minutes, hours and days", () => {
  assert.equal(verdictDurationLabel(0), "0s");
  assert.equal(verdictDurationLabel(62_999), "1m 2s");
  assert.equal(verdictDurationLabel(3_661_000), "1h 1m 1s");
  assert.equal(verdictDurationLabel(90_061_000), "1d 1h 1m 1s");
  assert.throws(() => verdictDurationLabel(-1));
  assert.throws(() => verdictDurationLabel(Infinity));
});
