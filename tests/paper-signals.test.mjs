import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { historicalRequests } from "../src/lib/groww/historical-requests.ts";
import { calculateEntryTiming } from "../src/lib/market/entry-timing.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";
import { PaperTradingError } from "../src/lib/market/paper-trading.ts";
import { calculateTechnicalVerdict } from "../src/lib/market/technical-verdict.ts";
import { paperSignalChecks } from "../src/lib/paper/strict-signals.ts";

const now = Date.parse("2026-11-17T10:00:00+05:30");
const selection = { symbol: "TESTEQ", exchange: "NSE", product: "MIS" };
const approve = (side = "BUY", product = "MIS", at = now) =>
  paperSignalChecks.approve("synthetic-token", { ...selection, product }, side, new AbortController().signal, at);

function fixture(bearish = false, daily = false) {
  const candles = [];
  const start = Date.parse(`${daily ? "2026-07-20" : "2026-11-10"}T09:15:00+05:30`);
  for (let date = start; date < now - (daily ? 86_400_000 : 0); date += 86_400_000) {
    if ([0, 6].includes(new Date(date).getUTCDay())) continue;
    for (let slot = 0; slot < (daily ? 1 : 25) && date + slot * 900_000 < now; slot++) {
      const i = candles.length;
      const close = 100 + i * 0.02 + Math.sin(i) * 0.4;
      candles.push({ time: (date + slot * 900_000) / 1000, open: close - 0.1,
        close, high: close + 0.2, low: close - 0.3, volume: 100 });
    }
  }
  const price = candles.at(-4).close;
  Object.assign(candles.at(-3), { open: price, close: price + 0.1, high: price + 0.3, low: price - 0.2 });
  Object.assign(candles.at(-2), { open: price + 0.1, close: price - 0.1, high: price + 0.3, low: price - 0.2 });
  Object.assign(candles.at(-1), { open: price - 0.1, close: price + 1.5,
    high: price + 1.6, low: price - 0.15, volume: 200 });
  if (bearish) for (const bar of candles) {
    const { open, high, low, close } = bar;
    Object.assign(bar, { open: 200 - open, close: 200 - close, high: 200 - low, low: 200 - high });
  }
  const mid = candles.at(-1).close;
  return { candles, payload: {
    last_price: mid, day_change: 1, day_change_perc: 1,
    ohlc: { open: mid, high: mid + 2, low: mid - 2, close: mid },
    last_trade_time: now, volume: 1000,
    depth: {
      buy: Array.from({ length: 5 }, (_, i) => ({ price: mid - 0.01 * (i + 1), quantity: 100 })),
      sell: Array.from({ length: 5 }, (_, i) => ({ price: mid + 0.01 * (i + 1), quantity: 100 })),
    },
  } };
}

function upstream(t, data = fixture(), { depthAge = 0, at = now, segment = "CASH" } = {}) {
  let clock = at - depthAge;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(historicalRequests, "run", async (_token, _signal, request) => request());
  return t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://growwapi-assets.groww.in/")) return new Response([
      "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment",
      "NSE,TEST99NOVFUT,NSE-TEST-23Nov99-FUT,TEST,FUT,2099-11-23,,10,0.05,FNO",
      "NSE,TEST99NOV100CE,NSE-TEST-23Nov99-100-CE,TEST,CE,2099-11-23,100,10,0.05,FNO",
    ].join("\n"));
    assert.equal(url.origin, "https://api.groww.in");
    assert.equal(options.method, "GET");
    if (url.pathname === "/v1/live-data/quote") return Response.json({ status: "SUCCESS", payload: data.payload });
    assert.equal(url.pathname, "/v1/historical/candles");
    assert.equal(url.searchParams.get("segment"), segment);
    if (segment === "FNO") assert.ok(url.searchParams.get("groww_symbol").startsWith("NSE-TEST-23Nov99-"));
    await setImmediate();
    clock = at;
    return Response.json({ status: "SUCCESS", payload: { candles: data.candles.map((bar) =>
      [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]) } });
  });

}

const denied = (pattern) => (error) => {
  assert.ok(error instanceof PaperTradingError);
  assert.match(error.message, pattern);
  return true;
};

test("F&O approval uses authoritative contract candle symbols, not CASH data or the unsupported CASH ORB", async t => {
  const calls = upstream(t, fixture(), { segment: "FNO" });
  await paperSignalChecks.approve("synthetic-token", {
    symbol: "TEST99NOVFUT", exchange: "NSE", product: "MIS", segment: "FNO",
  }, "BUY", new AbortController().signal, now);
  assert.ok(calls.mock.calls.some(call => call.arguments[0] instanceof URL &&
    call.arguments[0].searchParams.get("groww_symbol") === "NSE-TEST-23Nov99-FUT"));
});

test("option bearish signals cannot approve uncovered paper SELL entries", async t => {
  upstream(t, fixture(true), { segment: "FNO" });
  await assert.rejects(paperSignalChecks.approve("synthetic-token", {
    symbol: "TEST99NOV100CE", exchange: "NSE", product: "MIS", segment: "FNO",
  }, "SELL", new AbortController().signal, now), denied(/Technical rules/));
});

test("strict approval is mockable at the shared object boundary", async (t) => {
  const check = t.mock.method(paperSignalChecks, "approve", async () => {});
  await approve();
  assert.equal(check.mock.callCount(), 1);
});

for (const side of ["BUY", "SELL"]) {
  test(`MIS ${side} requires actual matching technical rules, timing, depth and ORB/volume`, async (t) => {
    const calls = upstream(t, fixture(side === "SELL"));
    await approve(side);
    assert.equal(calls.mock.callCount(), 2);
    assert.equal(calls.mock.calls[1].arguments[0].searchParams.get("candle_interval"), "15minute");
  });
}

test("delivery BUY uses previous completed daily candles, not today's forming bar", async (t) => {
  const data = fixture(false, true);
  data.candles.push({ time: Date.parse("2026-11-17T09:15:00+05:30") / 1000,
    open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const calls = upstream(t, data);
  await approve("BUY", "CNC");
  assert.equal(calls.mock.calls[1].arguments[0].searchParams.get("candle_interval"), "1day");
});

test("cutoff denies new MIS entries at 15:20, and timing agrees while CNC remains eligible", async (t) => {
  const calls = upstream(t);
  const at = Date.parse("2026-11-17T15:20:00+05:30");
  await assert.rejects(approve("BUY", "MIS", at), denied(/15:20/));
  assert.equal(calls.mock.callCount(), 0);
  const data = fixture();
  const analysis = { ...selection, segment: "CASH", interval: "15minute", candles: data.candles,
    quote: { price: data.payload.last_price, lastTradeTime: now }, fetchedAt: new Date(now).toISOString(),
    technical: calculateIndicators(data.candles) };
  const verdict = calculateTechnicalVerdict(analysis, "MIS", now);
  assert.equal(verdict.decision, "BUY");
  analysis.quote.lastTradeTime = at;
  assert.equal(calculateEntryTiming(analysis, verdict, at - 1).status, "CONDITIONS_MET");
  assert.equal(calculateEntryTiming(analysis, verdict, at).status, "WAIT");
  assert.match(calculateEntryTiming(analysis, verdict, at).reasons.join(" "), /15:20/);
  assert.equal(calculateEntryTiming({ ...analysis, interval: "1day" },
    { ...verdict, mode: "CNC" }, at).status, "CONDITIONS_MET");
});

test("CNC short entries and out-of-session entries cannot fetch or submit orders", async (t) => {
  const calls = upstream(t);
  await assert.rejects(approve("SELL", "CNC"), denied(/BUY entries only/));
  await assert.rejects(approve("BUY", "MIS", Date.parse("2026-11-17T09:14:00+05:30")), denied(/session required/));
  assert.equal(calls.mock.callCount(), 0);
});

test("a request crossing the intraday cutoff cannot approve using its earlier start time", async (t) => {
  const at = Date.parse("2026-11-17T15:20:00+05:30");
  const data = fixture();
  data.payload.last_trade_time = at;
  const calls = upstream(t, data, { at, depthAge: 2_000 });
  await assert.rejects(approve("BUY", "MIS", at - 1_000), denied(/15:20/));
  assert.equal(calls.mock.callCount(), 2);
});

test("forming, future and off-session candles cannot manufacture indicator history", async (t) => {
  const data = fixture();
  data.candles = data.candles.slice(-49);
  data.candles.push(...[
    now - 1_000, now, now + 900_000, Date.parse("2026-11-17T08:00:00+05:30"),
  ].map((time) => ({ time: time / 1000, open: 100, close: 100, high: 101, low: 99, volume: 100 })));
  upstream(t, data);
  await assert.rejects(approve(), denied(/50 CLOSED regular-session candles/));
});

test("unfinished bars cannot change an otherwise approved closed-candle entry", async (t) => {
  const data = fixture();
  data.candles.push({ time: now / 1000, open: 1, close: 1, high: 1, low: 1, volume: 100 });
  upstream(t, data);
  await approve();
});

test("missing OHLC and insufficient completed daily bars cannot be replaced with defaults", async (t) => {
  const data = fixture(false, true);
  data.candles = data.candles.slice(-49);
  data.candles.push({ time: Date.parse("2026-11-17T09:15:00+05:30") / 1000,
    open: 100, close: 101, high: 102, low: 99, volume: 200 });
  upstream(t, data);
  await assert.rejects(approve("BUY", "CNC"), denied(/50 CLOSED regular-session candles/));
  data.candles[0].open = null;
  await assert.rejects(approve("BUY", "CNC"), denied(/Missing OHLC candles/));
});

for (const problem of ["missing", "stale", "partial", "crossed", "spread", "opposing"]) {
  test(`strict entries deny ${problem} depth even with matching signals`, async (t) => {
    const data = fixture();
    if (problem === "missing") delete data.payload.depth;
    if (problem === "partial") data.payload.depth.buy.pop();
    if (problem === "crossed") data.payload.depth.buy[0].price = data.payload.depth.sell[0].price;
    if (problem === "spread") data.payload.depth.sell.forEach((level) => { level.price += 1; });
    if (problem === "opposing") data.payload.depth.sell.forEach((level) => { level.quantity *= 3; });
    upstream(t, data, { depthAge: problem === "stale" ? 15_001 : 0 });
    await assert.rejects(approve(), denied(problem === "spread" ? /spread exceeds/
      : problem === "opposing" ? /pressure opposes/ : /Required five-level depth evidence missing/));
  });
}

test("manual/conflicting side evidence cannot bypass authoritative approval", async (t) => {
  upstream(t);
  await assert.rejects(paperSignalChecks.approve("synthetic-token", {
    ...selection, approved: true, verdict: { decision: "SELL" }, technical: { rsi: 40 },
  }, "SELL", new AbortController().signal, now), denied(/Technical rules do not approve SELL/));
});

test("a technical BUY cannot bypass missing same-slot volume confirmation", async (t) => {
  const data = fixture();
  data.candles.at(-1).volume = null;
  upstream(t, data);
  await assert.rejects(approve(), denied(/same-slot volume evidence.*missing/s));
});

test("upstream failure is a clear PAPER denial rather than fallback approval", async (t) => {
  upstream(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(approve(), denied(/Authoritative quote, candle or depth evidence could not be loaded/));
});
