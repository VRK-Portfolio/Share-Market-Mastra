import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/top-picks/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { historicalRequests } from "../src/lib/groww/historical-requests.ts";
import { rankTopPicks, screenTopPicks, topPicksResponseSchema, topPicksUniverse } from "../src/lib/market/top-picks.ts";

const now = Date.parse("2026-11-16T11:30:00+05:30");
const originalSecret = process.env.GROWW_SESSION_SECRET;
beforeEach((t) => {
  t.mock.method(historicalRequests, "run", async (_token, _signal, request) => request());
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

function analysis(symbol, volume = 1000, bearish = false, interval = "15minute") {
  return {
    symbol, exchange: "NSE", segment: "CASH", interval, fetchedAt: new Date(now).toISOString(),
    quote: { price: 100, volume, lastTradeTime: now, change: 1, changePercent: 1,
      open: 98, high: 102, low: 97, previousClose: 99 },
    candles: Array.from({ length: 60 }, (_, index) => ({
      time: (now - (59 - index) * (interval === "1day" ? 86_400_000 : 900_000)) / 1000,
      open: 98, high: 102, low: 97, close: 100, volume: 100,
    })),
    technical: {
      vwap: bearish ? 102 : 98, rsi: bearish ? 40 : 60, atr: 2,
      ema20: bearish ? 103 : 97, ema50: bearish ? 105 : 95,
      macd: bearish ? { value: -5, signal: -3, histogram: -2 } : { value: 5, signal: 3, histogram: 2 },
      supertrend: { value: bearish ? 104 : 96, direction: bearish ? "bearish" : "bullish" },
      overlays: { vwap: [], ema20: [], supertrend: [] },
    },
  };
}

test("ranks at most three actionable setups by traded value with deterministic ties and real risk levels", () => {
  const data = [analysis("TCS", 100), analysis("SBIN", 300, true), analysis("RELIANCE", 200),
    analysis("INFY", 300), analysis("ITC", 50)];
  const picks = rankTopPicks(data, "MIS", now);
  assert.deepEqual(picks.map((pick) => pick.symbol), ["INFY", "SBIN", "RELIANCE"]);
  assert.equal(picks[1].decision, "SELL");
  assert.equal(picks[1].stopLoss, 103);
  assert.deepEqual(picks[1].targetPrices, [94, 91]);
  assert.equal(picks[0].entryPrice, 100);
  assert.equal(picks[0].stopLoss, 97);
  assert.deepEqual(picks[0].targetPrices, [106, 109]);
});

test("carry-forward picks require daily candles and BUY, excluding intraday shorts and exit-only CNC", () => {
  const daily = analysis("TCS", 1000, false, "1day");
  daily.technical.vwap = null;
  const picks = rankTopPicks([daily, analysis("SBIN", 9000, true, "1day"), analysis("INFY")], "CNC", now);
  assert.deepEqual(picks.map((pick) => [pick.symbol, pick.mode, pick.interval, pick.decision]), [["TCS", "CNC", "1day", "BUY"]]);
  assert.deepEqual(rankTopPicks([daily], "MIS", now), []);
});

test("does not force picks from stale, illiquid, incomplete or conflicting data or other segments/exchanges", () => {
  const stale = analysis("TCS"); stale.quote.lastTradeTime = now - 61_000;
  const incomplete = analysis("INFY"); incomplete.candles = [];
  const conflict = analysis("ITC"); conflict.technical.rsi = 50;
  const bse = { ...analysis("SBIN"), exchange: "BSE" };
  const fno = { ...analysis("RELIANCE"), segment: "FNO" };
  assert.deepEqual(rankTopPicks([stale, incomplete, conflict, bse, fno,
    analysis("LT", null), analysis("ICICIBANK", 0)], "MIS", now), []);
  const oldDaily = analysis("TCS", 1000, false, "1day");
  oldDaily.quote.lastTradeTime = now - 4 * 86_400_000;
  assert.deepEqual(rankTopPicks([oldDaily], "CNC", now), []);
});

test("screen diagnostics explain mixed signals, stale data, missing history and unrankable volume without promoting them", () => {
  const conflict = analysis("ITC"); conflict.technical.rsi = 50;
  const stale = analysis("TCS"); stale.quote.lastTradeTime = now - 61_000;
  const incomplete = analysis("INFY"); incomplete.candles = [];
  const screened = screenTopPicks([conflict, stale, incomplete, analysis("LT", null)], "MIS", now);
  assert.deepEqual(screened.picks, []);
  assert.equal(screened.screenedStocks.length, 4);
  assert.ok(screened.screenedStocks.every((stock) => !stock.qualified));
  const bySymbol = Object.fromEntries(screened.screenedStocks.map((stock) => [stock.symbol, stock]));
  assert.equal(bySymbol.ITC.dataReady, true);
  assert.equal(bySymbol.ITC.directionalSignals.find((item) => item.indicator === "RSI").signal, "NEUTRAL");
  assert.ok(bySymbol.ITC.reasons.some((reason) => /BUY is not confirmed: RSI NEUTRAL/.test(reason)));
  assert.equal(bySymbol.TCS.dataReady, false);
  assert.ok(bySymbol.TCS.reasons.some((reason) => /timestamps.*stale/.test(reason)));
  assert.ok(bySymbol.INFY.reasons.some((reason) => /50 complete candles/.test(reason)));
  assert.equal(bySymbol.LT.decision, "BUY");
  assert.ok(bySymbol.LT.reasons.some((reason) => /positive reported quote volume/.test(reason)));
});

test("diagnostics retain qualified stocks outside the top three and explain exit-only CNC without changing picks", () => {
  const data = [analysis("TCS", 100), analysis("SBIN", 300), analysis("INFY", 200), analysis("ITC", 50)];
  const screened = screenTopPicks(data, "MIS", now);
  assert.deepEqual(screened.picks, rankTopPicks(data, "MIS", now));
  assert.equal(screened.picks.length, 3);
  assert.equal(screened.screenedStocks.length, 4);
  assert.ok(screened.screenedStocks.every((stock) => stock.qualified));
  const daily = screenTopPicks([analysis("SBIN", 300, true, "1day")], "CNC", now);
  assert.deepEqual(daily.picks, []);
  assert.equal(daily.screenedStocks[0].qualified, false);
  assert.match(daily.screenedStocks[0].summary, /EXIT OR AVOID/);
});

function request(cookie = sessionCookie("test-picks-token")) {
  return new Request("http://localhost/api/groww/top-picks", { headers: cookie ? { Cookie: cookie.split(";")[0] } : {} });
}
function mockData(url) {
  if (url.pathname === "/v1/live-data/quote") return {
    status: "SUCCESS", payload: { last_price: 100, day_change: 1, day_change_perc: 1,
      ohlc: { open: 98, high: 102, low: 97, close: 99 }, volume: 1000, last_trade_time: now },
  };
  return { status: "SUCCESS", payload: { candles: analysis("TCS", 1000, false,
    url.searchParams.get("candle_interval")).candles.map((candle) =>
    [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]) } };
}

test("authenticated scanner uses official APIs for both timeframes without inventing qualifying picks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  let active = 0;
  let peak = 0;
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    assert.equal(url.origin, "https://api.groww.in");
    assert.equal(url.searchParams.get("segment"), "CASH");
    assert.equal(options.headers.Authorization, "Bearer test-picks-token");
    return Response.json(mockData(url));
  });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = topPicksResponseSchema.parse(await response.json());
  assert.equal(data.date, "2026-11-16");
  assert.equal(data.screened, topPicksUniverse.length);
  assert.deepEqual(data.intraday, []);
  assert.deepEqual(data.carryForward, []);
  assert.deepEqual(data.warnings, []);
  assert.equal(data.screenedStocks.length, topPicksUniverse.length * 2);
  assert.ok(data.screenedStocks.every((stock) => !stock.qualified &&
    stock.reasons.some((reason) => /required indicator is unavailable/.test(reason)) &&
    stock.directionalSignals.some((item) => item.signal === "UNAVAILABLE")));
  assert.ok(peak <= 4);
  const historyCalls = upstream.mock.calls.filter(({ arguments: [url] }) => url.pathname === "/v1/historical/candles");
  assert.equal(historyCalls.length, topPicksUniverse.length * 2);
  for (const symbol of topPicksUniverse) assert.deepEqual(historyCalls
    .filter(({ arguments: [url] }) => url.searchParams.get("groww_symbol") === `NSE-${symbol}`)
    .map(({ arguments: [url] }) => url.searchParams.get("candle_interval")).sort(), ["15minute", "1day"]);
});

test("missing sessions are rejected without market-data calls", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  const response = await GET(request(""));
  assert.equal(response.status, 401);
  assert.equal(upstream.mock.callCount(), 0);
});

test("symbol failures are explicit partial warnings, not fabricated data", async (t) => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url) =>
    url.searchParams.get("trading_symbol") === "RELIANCE"
      ? Response.json({ error: "Unavailable" }, { status: 404 }) : Response.json(mockData(url)));
  const response = await GET(request());
  const data = topPicksResponseSchema.parse(await response.json());
  assert.equal(response.status, 200);
  assert.equal(data.screened, topPicksUniverse.length - 1);
  assert.equal(data.warnings.length, 1);
  assert.equal(data.warnings[0].symbol, "RELIANCE");
  assert.equal(data.screenedStocks.length, (topPicksUniverse.length - 1) * 2);
  assert.ok(data.screenedStocks.every((stock) => stock.symbol !== "RELIANCE"));
  assert.match(data.warnings[0].error, /404/);
});

test("all symbol failures return an error rather than successful empty picks", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Unavailable" }, { status: 404 }));
  const response = await GET(request());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.ok(body.error);
  assert.equal(body.warnings.length, topPicksUniverse.length);
  assert.equal(body.intraday, undefined);
});

test("authentication, permissions and rate-limit failures stop the scan and preserve upstream status", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Denied" }, { status: 401 }));
  for (const status of [401, 403, 429]) {
    upstream.mock.mockImplementation(async () => Response.json({ error: "Denied" }, { status }));
    const previousCalls = upstream.mock.callCount();
    const response = await GET(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.has("set-cookie"), status === 401);
    assert.ok(upstream.mock.callCount() - previousCalls <= 4);
  }
});
