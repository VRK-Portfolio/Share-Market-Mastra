import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/instruments/route.ts";
import { cashInstrumentSearchResponseSchema } from "../src/lib/groww/instrument-schemas.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
const token = "stock-search-test-token";
let clock = Date.now();
beforeEach((t) => {
  clock += 3_600_001;
  t.mock.method(Date, "now", () => clock);
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});
const header = "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment,name";
function stock(symbol, name, exchange = "NSE", type = "EQ") {
  return `${exchange},${symbol},${exchange}-${symbol},,${type},,,1,0.05,CASH,${JSON.stringify(name)}`;
}
const csv = [
  header, stock("RELIANCE", "Reliance Industries"), stock("RELIANCEPP", "Rights security"),
  stock("AAA", "Reliance"), stock("ZZ", "Reliance Technologies"), stock("OTHER", "Company Reliance"),
  stock("M&M", "Mahindra & Mahindra"), stock("RELIANCE", "Reliance Industries", "BSE"),
  stock("RELIANCEINDEX", "Reliance Index", "NSE", "IDX"),
  "NSE,RELIANCE99FUT,NSE-RELIANCE-23Nov99-FUT,RELIANCE,FUT,2099-11-23,,50,0.05,FNO,",
].join("\n");
function request(query, authenticated = true) {
  return new Request(`http://localhost/api/groww/instruments?${query}`, {
    headers: authenticated ? { cookie: sessionCookie(token).split(";")[0] } : {},
  });
}
function catalog(t, content = csv) {
  return t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), "https://growwapi-assets.groww.in/instruments/instrument.csv");
    return new Response(content);
  });
}

test("cash search matches actual names and symbols, ranks exact/prefix results and excludes other exchanges, indices and derivatives", async (t) => {
  catalog(t);
  const response = await GET(request("segment=CASH&q=reliance"));
  assert.equal(response.status, 200);
  const body = cashInstrumentSearchResponseSchema.parse(await response.json());
  assert.equal(body.q, "RELIANCE");
  assert.equal(body.exchange, "NSE");
  assert.deepEqual(body.instruments.map((item) => item.tradingSymbol), ["RELIANCE", "AAA", "RELIANCEPP", "ZZ", "OTHER"]);
  assert.equal(body.instruments[0].name, "Reliance Industries");
  assert.equal(body.total, 5);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const byName = await GET(request("segment=CASH&q=mahindra"));
  assert.equal((await byName.json()).instruments[0].tradingSymbol, "M&M");
  const bse = await GET(request("segment=CASH&q=reliance&exchange=BSE"));
  assert.deepEqual((await bse.json()).instruments.map((item) => item.exchange), ["BSE"]);
});

test("cash search reuses the public catalog cache and never sends account credentials upstream", async (t) => {
  const upstream = catalog(t);
  await GET(request("segment=CASH&q=reliance"));
  await GET(request("segment=CASH&q=mahindra"));
  assert.equal(upstream.mock.callCount(), 1);
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.ok(!String(url).includes(token));
  assert.equal(options.headers, undefined);
});

test("cash pagination includes all matches, supports literal company punctuation and preserves missing names", async (t) => {
  catalog(t, [header, ...Array.from({ length: 65 }, (_, index) => stock(`SHARED${index}`, `Shared company ${index}`)),
    stock("OBRIEN", "O'Brien (India)"), stock("NONAME", "")].join("\n"));
  const symbols = [];
  for (let page = 1; page <= 3; page++) {
    const body = await (await GET(request(`segment=CASH&q=shared&page=${page}`))).json();
    assert.equal(body.total, 65);
    assert.equal(body.hasMore, page < 3);
    assert.equal(body.instruments.length, page < 3 ? 30 : 5);
    symbols.push(...body.instruments.map((item) => item.tradingSymbol));
  }
  assert.equal(new Set(symbols).size, 65);
  const punctuation = await GET(request(`segment=CASH&q=${encodeURIComponent("O'Brien (India)")}`));
  assert.equal((await punctuation.json()).instruments[0].tradingSymbol, "OBRIEN");
  const unnamed = await GET(request("segment=CASH&q=NONAME"));
  assert.equal((await unnamed.json()).instruments[0].name, null);
  const empty = await GET(request("segment=CASH&q=unknown"));
  assert.equal((await empty.json()).total, 0);
});

test("invalid cash search and unauthenticated requests never download the catalog; FNO remains the default", async (t) => {
  const upstream = catalog(t);
  for (const query of ["segment=CASH&q=A", "segment=CASH&q=AA&exchange=BAD", "segment=CASH&q=AA&page=0", "segment=BAD&q=AA"]) {
    assert.equal((await GET(request(query))).status, 400);
  }
  assert.equal((await GET(request("segment=CASH&q=reliance", false))).status, 401);
  assert.equal(upstream.mock.callCount(), 0);
  const fno = await GET(request("q=RELIANCE"));
  assert.equal((await fno.json()).instruments[0].instrumentType, "FUT");
});

test("catalog failures and malformed cash metadata return explicit errors, not sample or empty success results", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  assert.equal((await GET(request("segment=CASH&q=reliance"))).status, 502);
  upstream.mock.mockImplementation(async () => new Response([header, stock("INVALID/SYMBOL", "Invalid stock")].join("\n")));
  const malformed = await GET(request("segment=CASH&q=invalid"));
  assert.equal(malformed.status, 502);
  assert.match((await malformed.json()).error, /Retry/);
});

test("a catalog body taking 20 seconds succeeds within the 45-second shared download budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 45_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async (_, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode([header, stock("TCS", "TCS")].join("\n")));
        controller.close();
      }, 20_000);
    },
  })));
  const loading = GET(request("segment=CASH&q=TCS"));
  await setImmediate();
  t.mock.timers.tick(20_000);
  const response = await loading;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).instruments[0].tradingSymbol, "TCS");
});

test("catalog timeout, HTTP, network and validation diagnostics are explicit and never expire the session", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Timed out", "TimeoutError");
  });
  let response = await GET(request("segment=CASH&q=TCS"));
  assert.equal(response.status, 504);
  let body = await response.json();
  assert.equal(body.failureType, "timeout");
  assert.equal(body.stage, "catalog download");
  assert.equal(response.headers.get("set-cookie"), null);
  upstream.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  response = await GET(request("q=TCS"));
  body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.failureType, "http");
  assert.equal(body.upstreamStatus, 503);
  upstream.mock.mockImplementation(async () => { throw new TypeError("Internal network details must not be exposed"); });
  response = await GET(request("segment=CASH&q=TCS"));
  body = await response.json();
  assert.equal(body.failureType, "network");
  assert.ok(!JSON.stringify(body).includes("Internal network details"));
  upstream.mock.mockImplementation(async () => new Response("invalid CSV"));
  response = await GET(request("segment=CASH&q=TCS"));
  body = await response.json();
  assert.equal(body.failureType, "invalid-catalog");
  assert.equal(body.stage, "catalog validation");
  assert.equal(response.headers.get("set-cookie"), null);
});
