import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/market-movers/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { marketMoversResponseSchema, marketMoversUniverse, rankMarketMovers } from "../src/lib/market/market-movers.ts";

const now = Date.parse("2026-11-16T11:30:00+05:30");
const originalSecret = process.env.GROWW_SESSION_SECRET;
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

function stock(symbol, changePercent, lastTradeTime = now) {
  return { symbol, quote: {
    price: 100 + changePercent, change: changePercent, changePercent, previousClose: 100,
    open: 100, high: 110, low: 90, volume: null, lastTradeTime,
  } };
}
function request(cookie = sessionCookie("test-movers-token")) {
  return new Request("http://localhost/api/groww/market-movers", {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
  });
}
function quoteBody(symbol) {
  const change = marketMoversUniverse.indexOf(symbol) - 3;
  return {
    status: "SUCCESS", payload: {
      last_price: 100 + change, day_change: change, day_change_perc: change,
      ohlc: { open: 100, high: 110, low: 90, close: 100 }, last_trade_time: now,
    },
  };
}

test("ranks all positive and negative day changes separately, with deterministic ties and unchanged counts", () => {
  const result = rankMarketMovers([
    stock("TCS", 2), stock("SBIN", -3), stock("INFY", 2), stock("ITC", 0),
    stock("LT", -1), stock("RELIANCE", 4), stock("HDFCBANK", 1), stock("ICICIBANK", 3),
  ], now);
  assert.deepEqual(result.gainers.map(({ symbol }) => symbol), ["RELIANCE", "ICICIBANK", "INFY", "TCS", "HDFCBANK"]);
  assert.deepEqual(result.losers.map(({ symbol }) => symbol), ["SBIN", "LT"]);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.warnings, []);
});

test("excludes previous-date, missing, future and invalid quotes rather than showing yesterday's movers", () => {
  const missing = stock("INFY", 1); missing.quote.changePercent = null;
  const invalid = stock("LT", 1); invalid.quote.previousClose = 0;
  const result = rankMarketMovers([
    stock("TCS", 1, now - 86_400_000), stock("SBIN", -1, null),
    stock("ITC", 2, now + 6000), missing, invalid,
  ], now);
  assert.deepEqual(result.gainers, []);
  assert.deepEqual(result.losers, []);
  assert.equal(result.warnings.length, 5);
  const midnight = Date.parse("2026-11-17T00:01:00+05:30");
  assert.equal(rankMarketMovers([stock("TCS", 1, midnight - 120_000)], midnight).warnings.length, 1);
  assert.equal(rankMarketMovers([stock("TCS", 1, midnight - 30_000)], midnight).gainers.length, 1);
});

test("authenticated movers fetch only quotes, preserve prices/day changes and bound concurrency", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  let active = 0;
  let peak = 0;
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    assert.equal(url.origin, "https://api.groww.in");
    assert.equal(url.pathname, "/v1/live-data/quote");
    assert.equal(url.searchParams.get("exchange"), "NSE");
    assert.equal(url.searchParams.get("segment"), "CASH");
    assert.equal(options.headers.Authorization, "Bearer test-movers-token");
    return Response.json(quoteBody(url.searchParams.get("trading_symbol")));
  });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = marketMoversResponseSchema.parse(await response.json());
  assert.equal(data.date, "2026-11-16");
  assert.deepEqual(data.gainers.map(({ symbol }) => symbol), ["ITC", "LT", "SBIN", "TCS"]);
  assert.deepEqual(data.losers.map(({ symbol }) => symbol), ["RELIANCE", "HDFCBANK", "ICICIBANK"]);
  assert.equal(data.gainers[0].price, 104);
  assert.equal(data.gainers[0].change, 4);
  assert.equal(data.unchanged, 1);
  assert.deepEqual(data.warnings, []);
  assert.equal(upstream.mock.callCount(), marketMoversUniverse.length);
  assert.ok(peak <= 2);
});

test("missing sessions cause no upstream requests", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  assert.equal((await GET(request(""))).status, 401);
  assert.equal(upstream.mock.callCount(), 0);
});

test("partial failures are explicit and a complete upstream failure is not an empty success", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const upstream = t.mock.method(globalThis, "fetch", async (url) =>
    url.searchParams.get("trading_symbol") === "RELIANCE"
      ? Response.json({ error: "Unavailable" }, { status: 404 })
      : Response.json(quoteBody(url.searchParams.get("trading_symbol"))));
  const response = await GET(request());
  assert.equal(response.status, 200);
  const data = marketMoversResponseSchema.parse(await response.json());
  assert.equal(data.warnings.length, 1);
  assert.equal(data.warnings[0].symbol, "RELIANCE");
  assert.match(data.warnings[0].error, /404/);
  upstream.mock.mockImplementation(async () => Response.json({}, { status: 404 }));
  const failed = await GET(request());
  assert.equal(failed.status, 502);
  assert.ok((await failed.json()).error);
});

test("old-session quotes yield empty lists with exclusions, never yesterday's gainers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now + 86_400_000 });
  t.mock.method(globalThis, "fetch", async (url) => Response.json(quoteBody(url.searchParams.get("trading_symbol"))));
  const response = await GET(request());
  assert.equal(response.status, 200);
  const data = marketMoversResponseSchema.parse(await response.json());
  assert.deepEqual(data.gainers, []);
  assert.deepEqual(data.losers, []);
  assert.equal(data.warnings.length, marketMoversUniverse.length);
});

test("authentication, permissions and rate limits stop loading and retain upstream status", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 401 }));
  for (const status of [401, 403, 429]) {
    upstream.mock.mockImplementation(async () => Response.json({}, { status, headers: { "Retry-After": "30" } }));
    const calls = upstream.mock.callCount();
    const response = await GET(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.has("set-cookie"), status === 401);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "30");
    assert.ok(upstream.mock.callCount() - calls <= 2);
  }
});
