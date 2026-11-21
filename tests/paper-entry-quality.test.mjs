import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/paper/entry-quality/route.ts";
import { historicalRequests } from "../src/lib/groww/historical-requests.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { assessPaperEntry, paperEntryContext, paperEntryQualitySchema } from "../src/lib/market/paper-entry-quality.ts";
import { regularMarketSession } from "../src/lib/market/market-session.ts";
import { fillPaperOrder, newPaperAccount } from "../src/lib/market/paper-trading.ts";
import { paperStore } from "../src/lib/paper/store.ts";

const now = Date.parse("2026-11-17T11:07:00+05:30");
const selection = { symbol: "TESTEQ", exchange: "NSE", segment: "CASH", product: "MIS" };
const quote = (price = 101.1, at = now) => ({ ...selection, price, tradeTime: at });
const opened = (side = "BUY", price = 101.1) => fillPaperOrder(newPaperAccount(), quote(price), side, 10, now);
const originalSecret = process.env.GROWW_SESSION_SECRET;
let token;
beforeEach(t => {
  token = randomUUID();
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  t.mock.method(historicalRequests, "run", async (_token, _signal, request) => request());
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

function history(interval, falling = false) {
  const times = [];
  const today = regularMarketSession(now).opensAt;
  const days = interval === "15minute" ? 14 : 90;
  for (let date = today - days * 86_400_000; date <= today; date += 86_400_000) {
    if (regularMarketSession(date).phase === "weekend") continue;
    for (let slot = 0; slot < (interval === "15minute" ? 25 : 1); slot++) {
      const start = date + slot * 900_000;
      const close = interval === "15minute" ? start + 900_000 : regularMarketSession(start).closesAt;
      if (close <= now) times.push(start / 1000);
    }
  }
  const candles = times.map((time, index) => {
    const distance = index - times.length + 1;
    const rising = 100 + distance * 0.03 + Math.sin(distance) * 0.6;
    const close = falling ? 200 - rising : rising;
    return { time, open: close, close, high: close + 0.5, low: close - 0.5, volume: 1000 };
  });
  return { candles, omittedCandles: 0 };
}
const histories = () => ({ intraday: history("15minute"), daily: history("1day") });

test("entry quality uses both pre-entry timeframes and exposes the numerical historical evidence", () => {
  const [entry] = opened().fills;
  const result = assessPaperEntry(entry, histories());
  assert.ok(paperEntryQualitySchema.safeParse(result).success);
  assert.equal(result.verdict, "FAVOURABLE");
  for (const frame of [result.intraday, result.daily]) {
    assert.equal(frame.verdict, "FAVOURABLE");
    assert.ok(frame.count >= 50);
    assert.equal(frame.candles.length, 5);
    assert.ok(frame.metrics.ema20 > frame.metrics.ema50);
    assert.ok(frame.lastClosedAt <= entry.at);
  }
  assert.equal(result.entryPrice, 10110);
  assert.equal(result.intraday.lastClosedAt, Date.parse("2026-11-17T11:00:00+05:30"));
  assert.equal(result.daily.lastClosedAt, Date.parse("2026-11-16T15:30:00+05:30"));
  const short = assessPaperEntry(opened("SELL", 98.9).fills[0], {
    intraday: history("15minute", true), daily: history("1day", true),
  });
  assert.equal(short.verdict, "FAVOURABLE");
  assert.equal(assessPaperEntry(opened("BUY", 99).fills[0], histories()).verdict, "MIXED");
});

test("forming entry candles, entry-day daily candles and later price moves cannot influence the assessment", () => {
  const [entry] = opened().fills;
  const data = histories();
  const baseline = assessPaperEntry(entry, data);
  const future = { open: 100, close: 1, high: 99999, low: 0.01, volume: 999999 };
  data.intraday.candles.push(
    { ...future, time: Date.parse("2026-11-17T11:00:00+05:30") / 1000 },
    { ...future, time: Date.parse("2026-11-17T11:15:00+05:30") / 1000 },
  );
  data.daily.candles.push({ ...future, time: regularMarketSession(now).opensAt / 1000 });
  const result = assessPaperEntry(entry, data);
  assert.deepEqual(result.intraday, baseline.intraday);
  assert.deepEqual(result.daily, baseline.daily);
  assert.equal(result.verdict, baseline.verdict);
});

test("risk warnings identify an opposing trend, chasing and nearby historical barriers for longs and shorts", () => {
  const long = assessPaperEntry(opened("BUY", 99).fills[0], {
    intraday: history("15minute", true), daily: history("1day", true),
  });
  assert.equal(long.verdict, "RISKY");
  assert.match(long.intraday.reasons.join(" "), /against the EMA/);
  const short = assessPaperEntry(opened("SELL", 101.1).fills[0], histories());
  assert.equal(short.verdict, "RISKY");
  assert.match(short.daily.reasons.join(" "), /against the EMA/);
  const chased = assessPaperEntry(opened("BUY", 110).fills[0], histories());
  assert.equal(chased.verdict, "RISKY");
  assert.match(chased.intraday.reasons.join(" "), /over 2 ATR/);
  const barrier = assessPaperEntry(opened("BUY", 100.6).fills[0], histories());
  assert.equal(barrier.verdict, "RISKY");
  assert.match(barrier.intraday.reasons.join(" "), /resistance reference/);
});

test("incomplete or stale pre-entry history never yields a complete good/bad claim", () => {
  const entry = opened().fills[0];
  for (const damage of [
    frame => { frame.candles = frame.candles.slice(-10); },
    frame => { frame.omittedCandles = 1; },
    frame => { frame.candles.pop(); },
    frame => { frame.candles.splice(-3, 1); },
    frame => { frame.candles.at(-1).close = 0; },
  ]) {
    const data = histories();
    damage(data.intraday);
    const result = assessPaperEntry(entry, data);
    assert.equal(result.verdict, "UNAVAILABLE");
    assert.equal(result.intraday.verdict, "UNAVAILABLE");
    assert.equal(result.intraday.metrics, null);
    assert.equal(result.daily.verdict, "FAVOURABLE");
  }
});

test("usable intraday evidence is shown as partial rather than hidden by a short daily contract history", () => {
  const data = histories();
  data.daily.candles = data.daily.candles.slice(-12);
  const result = assessPaperEntry(opened().fills[0], data);
  assert.equal(result.verdict, "UNAVAILABLE");
  assert.equal(result.coverage, "INTRADAY_ONLY");
  assert.equal(result.primaryInterval, "15minute");
  assert.equal(result.headline, "Intraday-only entry view: Favourable (partial)");
  assert.match(result.summary, /not a full two-timeframe verdict/);
  assert.match(result.summary, /Daily: Only 12\/50/);
  assert.equal(result.daily.requiredCount, 50);
  assert.equal(result.daily.count, 12);
  assert.equal(result.intraday.verdict, "FAVOURABLE");
});

test("holding period chooses the main timeframe without presenting secondary evidence as a confirmed entry", () => {
  const data = histories();
  data.intraday.candles = data.intraday.candles.slice(-8);
  const delivery = fillPaperOrder(newPaperAccount(), { ...quote(), product: "CNC" }, "BUY", 10, now).fills[0];
  const dailyOnly = assessPaperEntry(delivery, data);
  assert.equal(dailyOnly.primaryInterval, "1day");
  assert.equal(dailyOnly.coverage, "DAILY_ONLY");
  assert.equal(dailyOnly.headline, "Daily-only entry view: Favourable (partial)");
  const intradayMissing = assessPaperEntry(opened().fills[0], data);
  assert.equal(intradayMissing.headline, "Daily context only: Favourable (partial)");
  assert.match(intradayMissing.summary, /Intraday entry timing remains unverified/);
  data.daily.candles = data.daily.candles.slice(-6);
  const none = assessPaperEntry(opened().fills[0], data);
  assert.equal(none.coverage, "NONE");
  assert.equal(none.headline, "Entry quality unavailable");
  assert.match(none.summary, /Intraday: Only 8\/50/);
  assert.match(none.summary, /Daily: Only 6\/50/);
});

test("the first fill stays the assessment anchor through additions/partial exits, including same-timestamp re-entry", () => {
  let account = opened();
  const first = account.fills[0];
  account = fillPaperOrder(account, quote(103), "BUY", 5, now);
  account = fillPaperOrder(account, quote(104), "SELL", 4, now);
  let context = paperEntryContext(account, account.positions[0]);
  assert.equal(context.entry.id, first.id);
  assert.equal(context.entry.price, 10110);
  assert.equal(context.additions, 1);
  account = fillPaperOrder(account, quote(104), "SELL", 11, now);
  account = fillPaperOrder(account, quote(98), "BUY", 2, now);
  context = paperEntryContext(account, account.positions[0]);
  assert.equal(context.entry.id, account.fills.at(-1).id);
  assert.equal(context.entry.price, 9800);
  assert.equal(context.additions, 0);
});

function request(entry, authenticated = true, changes = {}) {
  const query = new URLSearchParams({
    ...selection, entryId: entry.id, ...changes,
  });
  return new Request(`http://localhost/api/groww/paper/entry-quality?${query}`, {
    headers: authenticated ? { cookie: sessionCookie(token).split(";")[0] } : {},
  });
}
function mockAccount(t, account, failure, editCandles) {
  const owner = createHash("sha256").update("groww-paper:v1:entry-test-owner").digest("hex");
  const store = t.mock.method(paperStore, "load", async id => {
    assert.equal(id, owner);
    return { _id: owner, revision: 1, account, operations: [] };
  });
  const save = t.mock.method(paperStore, "save", async () => { throw new Error("Assessment must not mutate paper trades."); });
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (url.pathname === "/v1/user/detail") {
      return Response.json({ status: "SUCCESS", payload: { vendor_user_id: "entry-test-owner" } });
    }
    assert.equal(url.pathname, "/v1/historical/candles");
    if (failure) return Response.json({ error: "Historical limit reached." }, { status: 429, headers: { "Retry-After": "45" } });
    const interval = url.searchParams.get("candle_interval");
    const frame = history(interval);
    const candles = frame.candles.map(bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume, null]);
    editCandles?.(candles, interval);
    return Response.json({ status: "SUCCESS", payload: { candles } });
  });
  return { store, upstream, save };
}

test("historical entry endpoint authenticates before loading data and rejects client prices/timestamps", async t => {
  const account = opened();
  const mocks = mockAccount(t, account);
  assert.equal((await GET(request(account.fills[0], false))).status, 401);
  assert.equal((await GET(request(account.fills[0], true, { price: "1", entryAt: "1" }))).status, 400);
  assert.equal(mocks.upstream.mock.callCount(), 0);
  assert.equal(mocks.store.mock.callCount(), 0);
});

test("endpoint scopes history to the owner's persisted opening fill, not today's price or the client average", async t => {
  const account = opened();
  const mocks = mockAccount(t, account);
  const response = await GET(request(account.fills[0]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = paperEntryQualitySchema.parse(await response.json());
  assert.equal(result.entryId, account.fills[0].id);
  assert.equal(result.entryAt, now);
  assert.equal(result.verdict, "FAVOURABLE");
  const calls = mocks.upstream.mock.calls.filter(call => call.arguments[0].pathname === "/v1/historical/candles");
  assert.equal(calls.length, 2);
  for (const { arguments: [url] } of calls) {
    const days = url.searchParams.get("candle_interval") === "15minute" ? 14 : 90;
    assert.equal(url.searchParams.get("groww_symbol"), "NSE-TESTEQ");
    assert.equal(url.searchParams.get("segment"), "CASH");
    assert.equal(Number(url.searchParams.get("end_time")), Math.floor(now / 1000));
    assert.equal(Number(url.searchParams.get("start_time")), Math.floor(now / 1000) - days * 86400);
  }
  assert.equal(mocks.save.mock.callCount(), 0);
});

test("unfinished candles with null OHLC never count as missing pre-entry history", async t => {
  const account = opened();
  mockAccount(t, account, false, (candles, interval) => {
    const start = interval === "15minute" ? Date.parse("2026-11-17T11:00:00+05:30") : regularMarketSession(now).opensAt;
    candles.push([start / 1000, null, null, null, null, 0, null]);
  });
  const response = await GET(request(account.fills[0]));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.verdict, "FAVOURABLE");
  assert.equal(result.coverage, "FULL");
  assert.equal(result.intraday.lastClosedAt, Date.parse("2026-11-17T11:00:00+05:30"));
  assert.equal(result.daily.lastClosedAt, Date.parse("2026-11-16T15:30:00+05:30"));
});

test("missing OHLC in completed pre-entry candles still prevents a confirmed verdict and identifies the cause", async t => {
  const account = opened();
  mockAccount(t, account, false, candles => { candles.at(-1)[2] = null; });
  const response = await GET(request(account.fills[0]));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.coverage, "NONE");
  assert.equal(result.verdict, "UNAVAILABLE");
  assert.match(result.summary, /Intraday: Groww omitted OHLC data for 1 completed pre-entry candle/);
  assert.match(result.summary, /Daily: Groww omitted OHLC data for 1 completed pre-entry candle/);
});

test("closed/replaced position checks stop before history calls and provider failures stay explicit", async t => {
  const account = opened();
  const mocks = mockAccount(t, account, true);
  assert.equal((await GET(request(account.fills[0], true, { entryId: randomUUID() }))).status, 409);
  assert.equal((await GET(request(account.fills[0], true, { symbol: "OTHER" }))).status, 409);
  assert.equal(mocks.upstream.mock.callCount(), 1);
  const response = await GET(request(account.fills[0]));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "45");
  assert.match((await response.json()).error, /rate limit/i);
});

test("F&O entry assessment loads the saved exact contract history without substituting its underlying", async t => {
  const instrument = { exchange: "NSE", tradingSymbol: "TEST99NOV100PE", growwSymbol: "NSE-TEST-23Nov99-100-PE",
    underlying: "TEST", instrumentType: "PE", expiry: "2099-11-23", strikePrice: 100, lotSize: 10, tickSize: 0.05 };
  const account = fillPaperOrder(newPaperAccount(), { ...quote(), symbol: instrument.tradingSymbol,
    segment: "FNO", product: "NRML", instrument }, "BUY", 10, now);
  const mocks = mockAccount(t, account);
  const response = await GET(request(account.fills[0], true, {
    symbol: instrument.tradingSymbol, segment: "FNO", product: "NRML",
  }));
  assert.equal(response.status, 200);
  const result = paperEntryQualitySchema.parse(await response.json());
  assert.equal(result.symbol, instrument.tradingSymbol);
  assert.equal(result.segment, "FNO");
  const calls = mocks.upstream.mock.calls.filter(call => call.arguments[0].pathname === "/v1/historical/candles");
  assert.equal(calls.length, 2);
  for (const { arguments: [url] } of calls) {
    assert.equal(url.searchParams.get("groww_symbol"), instrument.growwSymbol);
    assert.equal(url.searchParams.get("segment"), "FNO");
  }
});
