import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET as holdings } from "../src/app/api/groww/holdings/route.ts";
import { GET as positions } from "../src/app/api/groww/positions/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { POST as resolvePortfolioInstruments } from "../src/app/api/groww/portfolio-instruments/route.ts";
import { freshLivePrice, portfolioLiveMark, portfolioLiveTotals } from "../src/lib/market/live-prices.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
const token = "test-portfolio-access-token";
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

const holding = { isin: "TESTISIN123", trading_symbol: "TESTEQ", quantity: 12, average_price: 123.45 };
const position = {
  trading_symbol: "TESTEQ",
  exchange: "NSE",
  product: "MIS",
  quantity: -3,
  net_price: 120.5,
  realised_pnl: -25.75,
};

test("live portfolio valuation uses signed units, not leverage or lot multipliers, and keeps zero-cost percentage unavailable", () => {
  const now = Date.parse("2026-11-17T06:30:00Z");
  const selection = { symbol: "TESTEQ", exchange: "NSE", segment: "CASH" };
  const tick = { ...selection, type: "tick", price: 110, tradeTime: now, receivedAt: new Date(now).toISOString(), observedAt: now };
  assert.deepEqual(portfolioLiveMark(selection, 10, 100, tick, now), {
    price: 110, entryValue: 1000, value: 1100, pnl: 100, percent: 10,
  });
  assert.equal(portfolioLiveMark(selection, -10, 100, tick, now).pnl, -100);
  assert.equal(portfolioLiveMark(selection, -10, 100, { ...tick, price: 90 }, now).pnl, 100);
  assert.equal(portfolioLiveMark(selection, 10, 110, tick, now).pnl, 0);
  assert.equal(portfolioLiveMark(selection, 2, 0, tick, now).percent, null);
  assert.equal(portfolioLiveMark(selection, 0, 0, tick, now), null);
  assert.equal(portfolioLiveMark(selection, 1, -1, tick, now), null);
  assert.equal(portfolioLiveMark(selection, Number.MAX_VALUE, 100, tick, now), null);
  for (const mismatch of [{ symbol: "OTHER" }, { exchange: "BSE" }, { segment: "FNO" }]) {
    assert.equal(portfolioLiveMark(selection, 10, 100, { ...tick, ...mismatch }, now), null);
  }
  const future = { ...selection, segment: "FNO" };
  assert.equal(portfolioLiveMark(future, -65, 100, { ...tick, ...future, price: 90 }, now).pnl, 650);
});

test("live P&L expires at the exact 60-second threshold and rejects delayed, future, invalid and missing quotes", () => {
  const now = Date.parse("2026-11-17T06:30:00Z");
  const selection = { symbol: "TESTEQ", exchange: "NSE", segment: "CASH" };
  const tick = { ...selection, type: "tick", price: 110, tradeTime: now - 30_000, receivedAt: new Date(now).toISOString(), observedAt: now };
  assert.equal(freshLivePrice(tick, now + 30_000), true);
  assert.equal(portfolioLiveMark(selection, 10, 100, tick, now + 30_001), null);
  for (const invalid of [undefined, { ...tick, price: 0 }, { ...tick, tradeTime: now - 60_001 },
    { ...tick, tradeTime: now + 5001 }, { ...tick, receivedAt: "invalid" }, { ...tick, observedAt: NaN }]) {
    assert.equal(portfolioLiveMark(selection, 10, 100, invalid, now), null);
  }
});

test("overall live P&L combines signed long and short results with a weighted entry basis", () => {
  const now = Date.parse("2026-11-17T06:30:00Z");
  const selection = { symbol: "TESTEQ", exchange: "NSE", segment: "CASH" };
  const tick = { ...selection, type: "tick", price: 110, tradeTime: now, receivedAt: new Date(now).toISOString(), observedAt: now };
  const long = portfolioLiveMark(selection, 10, 100, tick, now);
  const short = portfolioLiveMark(selection, -5, 120, tick, now);
  assert.deepEqual(portfolioLiveTotals([long, short]), {
    count: 2, pricedCount: 2, pnl: 150, percent: 150 / 1600 * 100,
  });
  assert.equal(portfolioLiveTotals([portfolioLiveMark(selection, -10, 100, tick, now)]).pnl, -100);
  assert.deepEqual(portfolioLiveTotals([]), { count: 0, pricedCount: 0, pnl: 0, percent: null });
  assert.equal(portfolioLiveTotals([portfolioLiveMark(selection, 1, 0, tick, now)]).percent, null);
});

test("overall live P&L never presents missing, stale or overflowed valuations as a complete total", () => {
  const now = Date.parse("2026-11-17T06:30:00Z");
  const selection = { symbol: "TESTEQ", exchange: "NSE", segment: "CASH" };
  const tick = { ...selection, type: "tick", price: 110, tradeTime: now, receivedAt: new Date(now).toISOString(), observedAt: now };
  const mark = portfolioLiveMark(selection, 10, 100, tick, now);
  for (const missing of [null, portfolioLiveMark(selection, 1, 100, tick, now + 60_001)]) {
    assert.deepEqual(portfolioLiveTotals([mark, missing]), { count: 2, pricedCount: 1, pnl: null, percent: null });
  }
  const huge = portfolioLiveMark(selection, 1, 0, { ...tick, price: Number.MAX_VALUE }, now);
  assert.equal(portfolioLiveTotals([huge, huge]).pnl, null);
});

test("portfolio price mapping authenticates and validates batches, resolves holdings by ISIN and never guesses ambiguous positions", async t => {
  const header = "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment,exchange_token,isin";
  const catalog = [
    header,
    "NSE,RELIANCE,NSE-RELIANCE,,EQ,,,1,0.05,CASH,2885,INEREL",
    "BSE,RELIANCE,BSE-RELIANCE,,EQ,,,1,0.05,CASH,500325,INEREL",
    "BSE,BSEONLY,BSE-BSEONLY,,EQ,,,1,0.05,CASH,12345,INEBSE",
    "NSE,NIFTY99NOVFUT,NSE-NIFTY99NOVFUT,NIFTY,FUT,2099-11-23,,65,0.1,FNO,456,",
    "NSE,NIFTY00NOVFUT,NSE-NIFTY00NOVFUT,NIFTY,FUT,2000-11-23,,65,0.1,FNO,789,",
    "NSE,AMBIG,NSE-AMBIG,,EQ,,,1,0.05,CASH,1122,INEAMB",
    "NSE,AMBIG,NSE-AMBIG-FUT,NIFTY,FUT,2099-11-23,,65,0.1,FNO,3344,",
  ].join("\n");
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(catalog));
  const lookup = (body, cookie = sessionCookie(token), origin) => new Request("http://localhost/api/groww/portfolio-instruments", {
    method: "POST", headers: { "content-type": "application/json",
      ...(cookie ? { cookie: cookie.split(";")[0] } : {}), ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  assert.equal((await resolvePortfolioInstruments(lookup([{ symbol: "RELIANCE" }], ""))).status, 401);
  assert.equal((await resolvePortfolioInstruments(lookup([{ symbol: "RELIANCE" }], undefined, "https://other.example"))).status, 403);
  for (const bad of ["invalid-json", [], Array(51).fill({ symbol: "RELIANCE" }), [{ symbol: "" }]]) {
    assert.equal((await resolvePortfolioInstruments(lookup(bad))).status, 400);
  }
  assert.equal(upstream.mock.callCount(), 0);
  const response = await resolvePortfolioInstruments(lookup([
    { symbol: "RELIANCE", isin: "INEREL" }, { symbol: "OLDLABEL", isin: "INEBSE" },
    { symbol: "NIFTY99NOVFUT", exchange: "NSE" }, { symbol: "AMBIG", exchange: "NSE" },
    { symbol: "UNKNOWN", exchange: "NSE" }, { symbol: "NIFTY00NOVFUT", exchange: "NSE", segment: "FNO" },
    { symbol: "RELIANCE", exchange: "MCX" }, { symbol: "RELIANCE", isin: "WRONG" },
  ]));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data[0].instrument, { symbol: "RELIANCE", exchange: "NSE", segment: "CASH" });
  assert.deepEqual(data[1].instrument, { symbol: "BSEONLY", exchange: "BSE", segment: "CASH" });
  assert.deepEqual(data[2].instrument, { symbol: "NIFTY99NOVFUT", exchange: "NSE", segment: "FNO" });
  assert.match(data[3].error, /ambiguous/);
  for (const result of data.slice(3)) { assert.equal(result.instrument, null); assert.ok(result.error); }
  assert.equal(JSON.stringify(data).includes("exchangeToken"), false);
  assert.equal(upstream.mock.callCount(), 1);
});

test("portfolio mapping catalog failures remain explicit rather than returning an empty successful valuation", async t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 7_200_001);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Synthetic catalog failure"); });
  t.mock.method(console, "error", () => {});
  const response = await resolvePortfolioInstruments(new Request("http://localhost/api/groww/portfolio-instruments", {
    method: "POST", headers: { cookie: sessionCookie(token).split(";")[0], "content-type": "application/json" },
    body: JSON.stringify([{ symbol: "RELIANCE", isin: "INEREL" }]),
  }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /instrument catalog/i);
});

function request(resource, query = "", cookie = sessionCookie(token)) {
  return new Request(`http://localhost/api/groww/${resource}${query}`, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
  });
}

for (const [resource, GET, item] of [["holdings", holdings, holding], ["positions", positions, position]]) {
  test(`${resource} uses the encrypted session and official endpoint/headers without caching`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
      status: "SUCCESS", payload: { [resource]: [item] },
    }));
    const response = await GET(request(resource));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "SUCCESS", payload: { [resource]: [item] } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const [url, options] = upstream.mock.calls[0].arguments;
    assert.equal(url.href, `https://api.groww.in/v1/${resource}/user`);
    assert.deepEqual(options.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-API-VERSION": "1.0",
    });
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
  });

  test(`${resource} rejects missing or tampered sessions without calling Groww`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
    for (const cookie of ["", "groww-session=invalid"]) {
      const response = await GET(request(resource, "", cookie));
      assert.equal(response.status, 401);
      assert.ok((await response.json()).error);
      assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
    }
    assert.equal(upstream.mock.callCount(), 0);
  });

  test(`${resource} accepts a genuine empty list, not a missing or malformed list`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
      status: "SUCCESS", payload: { [resource]: [] },
    }));
    const empty = await GET(request(resource));
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).payload[resource], []);
    t.mock.method(console, "error", () => {});
    for (const data of [
      { status: "SUCCESS", payload: {} },
      { status: "SUCCESS", payload: { [resource]: null } },
      { status: "SUCCESS", payload: { [resource]: [{}] } },
      { status: "SUCCESS", payload: { [resource]: [{ ...item, quantity: "12" }] } },
      { status: "FAILURE", payload: { [resource]: [] } },
    ]) {
      upstream.mock.mockImplementation(async () => Response.json(data));
      const invalid = await GET(request(resource));
      assert.equal(invalid.status, 502);
      assert.ok((await invalid.json()).error);
    }
  });

  test(`${resource} clears expired sessions even when Groww sends a non-JSON 401`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
    const response = await GET(request(resource));
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
    assert.ok((await response.json()).error);
  });

  test(`${resource} preserves permission, rate-limit and server failures without pretending the list is empty`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch");
    for (const status of [403, 429, 500, 503]) {
      upstream.mock.mockImplementation(async () => new Response("Unavailable", { status }));
      const response = await GET(request(resource));
      assert.equal(response.status, status);
      assert.ok((await response.json()).error);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  test(`${resource} returns explicit gateway errors without logging credentials or portfolio data`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const upstream = t.mock.method(globalThis, "fetch");
    for (const implementation of [
      async () => { throw new TypeError(token); },
      async () => { throw new DOMException("Timed out", "TimeoutError"); },
      async () => new Response("<html>Unavailable</html>"),
    ]) {
      upstream.mock.mockImplementation(implementation);
      const response = await GET(request(resource));
      assert.equal(response.status, 502);
      assert.ok((await response.json()).error);
    }
    assert.equal(log.mock.callCount(), 3);
    assert.ok(!JSON.stringify(log.mock.calls).includes(token));
    assert.ok(!JSON.stringify(log.mock.calls).includes(item.trading_symbol));
  });
}

test("positions forwards the optional CASH/FNO segment filter", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
    status: "SUCCESS", payload: { positions: [{ ...position, segment: "CASH" }] },
  }));
  for (const segment of ["CASH", "FNO"]) {
    const response = await positions(request("positions", `?segment=${segment}`));
    assert.equal(response.status, 200);
    assert.equal(upstream.mock.calls.at(-1).arguments[0].href, `https://api.groww.in/v1/positions/user?segment=${segment}`);
  }
});

test("positions rejects invalid segment filters before calling Groww", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  for (const segment of ["", "MCX", "cash", "CASH%26extra=value"]) {
    const response = await positions(request("positions", `?segment=${segment}`));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("portfolio reports missing server configuration explicitly", async (t) => {
  const cookie = sessionCookie(token);
  delete process.env.GROWW_SESSION_SECRET;
  t.mock.method(console, "error", () => {});
  const response = await holdings(request("holdings", "", cookie));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GROWW_SESSION_SECRET/);
});

test("positions preserves short and closed positions and zero prices/P&L", async (t) => {
  const rows = [position, { ...position, product: "CNC", quantity: 0, net_price: 0, realised_pnl: 0 }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "SUCCESS", payload: { positions: rows } }));
  const response = await positions(request("positions"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).payload.positions, rows);
});
