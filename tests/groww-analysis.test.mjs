import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/analysis/route.ts";
import { growwCandlesSchema, growwQuoteSchema, marketAnalysisSchema } from "../src/lib/groww/market-schemas.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
const token = "test-market-access-token";
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

const quote = {
  status: "SUCCESS",
  payload: {
    last_price: 150.75, day_change: -1.25, day_change_perc: -0.82,
    ohlc: { open: 151, high: 153, low: 150, close: 152 },
    volume: 45678, last_trade_time: Date.parse("2026-11-10T15:29:00+05:30"),
  },
};

function history(count = 80) {
  return { status: "SUCCESS", payload: { candles: Array.from({ length: count }, (_, index) => {
    const time = Math.floor(Date.parse("2026-11-09T09:15:00+05:30") / 1000) + index * 900;
    const close = 140 + index * 0.1 + Math.sin(index);
    return [time, close - 0.2, close + 0.5, close - 0.5, close, 100 + index, null];
  }) } };
}

function request(query = "symbol=TESTEQ&exchange=NSE&interval=15minute", cookie = sessionCookie(token)) {
  return new Request(`http://localhost/api/groww/analysis?${query}`, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
  });
}

function mockMarket(t, candles = history()) {
  return t.mock.method(globalThis, "fetch", async (url) =>
    Response.json(url.pathname === "/v1/live-data/quote" ? quote : candles));
}

test("analysis uses the session and official quote/current historical APIs and calculates real indicators", async (t) => {
  const candles = history();
  const upstream = mockMarket(t, candles);
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.ok(marketAnalysisSchema.safeParse(result).success);
  assert.equal(result.symbol, "TESTEQ");
  assert.equal(result.exchange, "NSE");
  assert.equal(result.interval, "15minute");
  assert.equal(result.quote.price, 150.75);
  assert.equal(result.quote.previousClose, 152);
  assert.equal(result.quote.lastTradeTime, quote.payload.last_trade_time);
  assert.equal(result.candles.length, 80);
  assert.equal(result.omittedCandles, 0);
  const expected = calculateIndicators(growwCandlesSchema.parse(candles));
  assert.deepEqual(result.technical, {
    ...expected,
    supertrend: { value: expected.supertrend.value, direction: expected.supertrend.direction },
  });
  assert.ok(result.technical.ema50 !== null);
  const calls = upstream.mock.calls.map(({ arguments: args }) => args);
  assert.equal(calls.length, 2);
  const [quoteUrl] = calls.find(([url]) => url.pathname === "/v1/live-data/quote");
  assert.equal(quoteUrl.searchParams.get("trading_symbol"), "TESTEQ");
  const [historyUrl] = calls.find(([url]) => url.pathname === "/v1/historical/candles");
  assert.equal(historyUrl.searchParams.get("groww_symbol"), "NSE-TESTEQ");
  assert.equal(historyUrl.searchParams.get("candle_interval"), "15minute");
  for (const [url, options] of calls) {
    assert.equal(url.origin, "https://api.groww.in");
    assert.equal(url.searchParams.get("segment"), "CASH");
    assert.equal(url.searchParams.get("exchange"), "NSE");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers["X-API-VERSION"], "1.0");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.href.includes(token));
  }
});

test("normalizes exact symbols and encodes ampersands without inventing instrument names", async (t) => {
  const upstream = mockMarket(t);
  const response = await GET(request("symbol=%20m%26m%20&exchange=BSE&interval=1day"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).symbol, "M&M");
  const urls = upstream.mock.calls.map(({ arguments: [url] }) => url);
  assert.equal(urls[0].searchParams.get("trading_symbol"), "M&M");
  assert.equal(urls[1].searchParams.get("groww_symbol"), "BSE-M&M");
  assert.equal(urls[1].searchParams.get("exchange"), "BSE");
});

test("history lookbacks respect Groww limits and provide enough history for the selected interval", async (t) => {
  const upstream = mockMarket(t);
  const now = Date.parse("2026-11-11T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  for (const [interval, days, maxDays] of [["15minute", 14, 90], ["1hour", 45, 180], ["1day", 179, 180]]) {
    assert.equal((await GET(request(`symbol=TESTEQ&interval=${interval}`))).status, 200);
    const url = upstream.mock.calls.at(-1).arguments[0];
    assert.equal(url.pathname, "/v1/historical/candles");
    assert.equal(url.searchParams.get("candle_interval"), interval);
    const start = Number(url.searchParams.get("start_time"));
    const end = Number(url.searchParams.get("end_time"));
    assert.equal(end, now / 1000);
    assert.equal(end - start, days * 86400);
    assert.ok(end - start <= maxDays * 86400);
  }
});

test("missing and tampered sessions are rejected before contacting Groww", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  for (const cookie of ["", "groww-session=invalid"]) {
    const response = await GET(request(undefined, cookie));
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("invalid query inputs are rejected rather than returning sample stocks", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  for (const query of [
    "", "symbol=", "symbol=..", "symbol=A/B", "symbol=TEST&exchange=MCX",
    "symbol=TEST&interval=5minute", `symbol=${"A".repeat(51)}`,
  ]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("empty or short actual history stays unavailable instead of creating fake candles/indicators", async (t) => {
  const upstream = mockMarket(t, history(0));
  let response = await GET(request());
  let result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.quote.price, 150.75);
  assert.deepEqual(result.candles, []);
  for (const key of ["vwap", "rsi", "atr", "ema20", "ema50", "macd", "supertrend"]) {
    assert.equal(result.technical[key], null, key);
  }
  upstream.mock.mockImplementation(async (url) => Response.json(url.pathname === "/v1/live-data/quote" ? quote : history(5)));
  response = await GET(request());
  result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.candles.length, 5);
  assert.equal(result.technical.ema50, null);
  assert.equal(result.technical.macd, null);
});

test("KALYANKJIL analysis omits reported null-open candles and calculates indicators from unchanged complete rows", async (t) => {
  const upstreamHistory = history(230);
  const missing = [21, 48, 75, 102, 129, 156, 183, 190, 217];
  for (const index of missing) upstreamHistory.payload.candles[index][1] = null;
  mockMarket(t, upstreamHistory);
  const response = await GET(request("symbol=KALYANKJIL&exchange=NSE&interval=15minute"));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.symbol, "KALYANKJIL");
  assert.equal(result.omittedCandles, missing.length);
  assert.equal(result.candles.length, 230 - missing.length);
  const complete = upstreamHistory.payload.candles.filter((_, index) => !missing.includes(index))
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
  assert.deepEqual(result.candles, complete);
  const expected = calculateIndicators(complete);
  assert.deepEqual(result.technical, {
    ...expected,
    supertrend: { value: expected.supertrend.value, direction: expected.supertrend.direction },
  });
  assert.equal(marketAnalysisSchema.parse(result).omittedCandles, missing.length);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("missing OHLC candles, including all-null rows, leave the quote available without fabricated chart data", async (t) => {
  const upstreamHistory = history(5);
  for (let index = 0; index < 4; index++) upstreamHistory.payload.candles[index][index + 1] = null;
  upstreamHistory.payload.candles[4].splice(1, 5, null, null, null, null, null);
  mockMarket(t, upstreamHistory);
  const response = await GET(request());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.quote.price, quote.payload.last_price);
  assert.equal(result.omittedCandles, 5);
  assert.deepEqual(result.candles, []);
  for (const key of ["vwap", "rsi", "atr", "ema20", "ema50", "macd", "supertrend"]) {
    assert.equal(result.technical[key], null);
  }
});

test("quote parsing handles documented object and unquoted-key string OHLC, with missing metrics explicitly null", () => {
  for (const ohlc of [quote.payload.ohlc, "{open: 151,high: 153,low: 150,close: 152}", JSON.stringify(quote.payload.ohlc)]) {
    const parsed = growwQuoteSchema.parse({ ...quote, payload: { ...quote.payload, ohlc, volume: undefined, last_trade_time: null } });
    assert.equal(parsed.open, 151);
    assert.equal(parsed.previousClose, 152);
    assert.equal(parsed.volume, null);
    assert.equal(parsed.lastTradeTime, null);
  }
});

test("historical timestamps are interpreted as IST when zone-less and sorted before indicator calculations", () => {
  const parsed = growwCandlesSchema.parse({
    status: "SUCCESS",
    payload: { candles: [
      ["2026-11-10T09:30:00", 100, 102, 99, 101, 200, null],
      ["2026-11-10 09:15:00", 99, 101, 98, 100, 100],
      ["2026-11-10T04:15:00Z", 101, 103, 100, 102, 300],
    ] },
  });
  assert.equal(parsed[0].time, Date.parse("2026-11-10T09:15:00+05:30") / 1000);
  assert.equal(parsed[1].time, Date.parse("2026-11-10T09:30:00+05:30") / 1000);
  assert.equal(parsed[2].time, Date.parse("2026-11-10T09:45:00+05:30") / 1000);
});

test("invalid candle dates, duplicate times, invalid ranges, missing or negative volumes are rejected", () => {
  for (const candles of [
    [["2026-02-30T09:15:00", 100, 102, 99, 101, 100]],
    [["2026-13-01T09:15:00", 100, 102, 99, 101, 100]],
    [["invalid", 100, 102, 99, 101, 100]],
    [[123, 100, 102, 99, 101, 100], [123, 100, 102, 99, 101, 200]],
    [[123, 100, 99, 98, 101, 100]],
    [[123, 100, 102, 99, 101]],
    [[123, 100, 102, 99, 101, -1]],
    [[123, 100, 102, 99, 101, null]],
    [[123, null, "invalid", 99, 101, 100]],
    [[123, null, 102, 99, 101, -1]],
    [[123, null, 102, 99, 101]],
    [[123, null, 102, 99, 101, 100], [123, 100, 102, 99, 101, 200]],
  ]) {
    assert.equal(growwCandlesSchema.safeParse({ status: "SUCCESS", payload: { candles } }).success, false);
  }
});

test("upstream auth, invalid symbols, subscription and rate-limit failures are surfaced without sample fallbacks", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch");
  for (const status of [401, 403, 404, 429, 500]) {
    upstream.mock.mockImplementation(async () => new Response("Upstream error", { status }));
    const response = await GET(request());
    assert.equal(response.status, status);
    assert.ok((await response.json()).error);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), status === 401);
  }
});

test("network, timeout, malformed JSON and unsuccessful payloads fail explicitly without leaking tokens", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch");
  for (const implementation of [
    async () => { throw new Error(token); },
    async () => { throw new DOMException("Timed out", "TimeoutError"); },
    async () => new Response("<html>Error</html>"),
    async () => Response.json({ status: "FAILURE" }),
    async () => Response.json({ status: "SUCCESS", payload: {} }),
  ]) {
    upstream.mock.mockImplementation(implementation);
    const response = await GET(request());
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.ok(body.error);
    assert.equal(body.candles, undefined);
  }
  assert.ok(!JSON.stringify(log.mock.calls).includes(token));
});

test("quote 403 exposes Groww's error code and reason without discarding the account session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => url.pathname === "/v1/live-data/quote"
    ? Response.json({
      status: "FAILURE",
      error: { code: "GA005", message: "Your Trading API subscription has expired.", metadata: { accessToken: token } },
    }, { status: 403 })
    : Response.json(history()));
  const response = await GET(request());
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.upstreamCode, "GA005");
  assert.equal(body.upstreamMessage, "Your Trading API subscription has expired.");
  assert.match(body.error, /GA005/);
  assert.match(body.error, /Trading API subscription has expired/);
  assert.match(body.error, /successful account connection does not confirm market-data access/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.metadata, undefined);
  assert.ok(!JSON.stringify(body).includes(token));
});

test("502 validation errors identify quote and candle fields without exposing payload values", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch");
  for (const [stage, badPayload, field] of [
    ["quote", { ...quote, payload: { ...quote.payload, last_price: token } }, "payload.last_price"],
    ["candles", { status: "SUCCESS", payload: { candles: [[token, 100, 102, 99, 101, 100]] } }, "payload.candles.0.0"],
  ]) {
    upstream.mock.mockImplementation(async (url) => Response.json(
      url.pathname === "/v1/live-data/quote" ? stage === "quote" ? badPayload : quote
        : stage === "candles" ? badPayload : history(),
    ));
    const response = await GET(request("symbol=KALYANKJIL&exchange=NSE&interval=15minute"));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.failureType, "validation");
    assert.equal(body.stage, stage);
    assert.ok(body.validationErrors.some((issue) => issue.field === field));
    assert.ok(!JSON.stringify(body).includes(token));
  }
  assert.ok(!JSON.stringify(log.mock.calls).includes(token));
});

test("invalid JSON and HTTP-200 failure envelopes retain the failing upstream resource and safe reason", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch");
  for (const [type, implementation] of [
    ["invalid-json", async () => new Response(`<html>${token}</html>`)],
    ["upstream-failure", async () => Response.json({
      status: "FAILURE", error: { code: "GA006", message: `Cannot serve historical data ${token}` },
    })],
  ]) {
    upstream.mock.mockImplementation(async (url) => url.pathname === "/v1/live-data/quote"
      ? Response.json(quote) : implementation());
    const response = await GET(request());
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.failureType, type);
    assert.equal(body.stage, "historical candles");
    if (type === "upstream-failure") assert.equal(body.upstreamCode, "GA006");
    assert.ok(!JSON.stringify(body).includes(token));
  }
});

test("502 timeout failures are distinguishable from response validation", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("Timed out", "TimeoutError"); });
  const response = await GET(request());
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.failureType, "timeout");
  assert.match(body.error, /timed out/);
});

test("upstream diagnostics redact credentials and ignore metadata, headers and unrelated fields", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({
    status: "FAILURE",
    error: {
      code: "GA005",
      message: `Denied for ${token}; Authorization: Bearer another-credential\nTry again with ${token}`,
      metadata: { accessToken: token },
    },
    accessToken: token,
    headers: { Authorization: `Bearer ${token}` },
  }, { status: 403 }));
  const response = await GET(request());
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.upstreamCode, "GA005");
  assert.match(body.upstreamMessage, /\[redacted\]/);
  assert.ok(!JSON.stringify(body).includes(token));
  assert.ok(!JSON.stringify(body).includes("another-credential"));
  assert.equal(body.accessToken, undefined);
  assert.equal(body.headers, undefined);
  assert.equal(log.mock.callCount(), 0);
});

test("non-JSON and malformed error responses retain the original 403 without exposing response bodies", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch");
  for (const implementation of [
    async () => new Response(`<html>Access denied ${token}</html>`, { status: 403, headers: { "Content-Type": "text/html" } }),
    async () => new Response("{invalid", { status: 403, headers: { "Content-Type": "application/json" } }),
    async () => Response.json({ error: "Access denied" }, { status: 403 }),
  ]) {
    upstream.mock.mockImplementation(implementation);
    const response = await GET(request());
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.match(body.error, /Groww denied access/);
    assert.ok(!JSON.stringify(body).includes(token));
    assert.ok(!JSON.stringify(body).includes("<html>"));
  }
});

test("when one upstream request fails the remaining market request is aborted", async (t) => {
  const signals = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    signals.push(options.signal);
    if (url.pathname === "/v1/live-data/quote") return new Response("Not found", { status: 404 });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const response = await GET(request());
  assert.equal(response.status, 404);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("unconfigured sessions fail explicitly", async (t) => {
  const cookie = sessionCookie(token);
  delete process.env.GROWW_SESSION_SECRET;
  t.mock.method(console, "error", () => {});
  const response = await GET(request(undefined, cookie));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GROWW_SESSION_SECRET/);
});
