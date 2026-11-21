import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET as constituents } from "../src/app/api/groww/nifty100/route.ts";
import { parseNifty100Csv } from "../src/lib/groww/nifty100.ts";
import { nifty100Source } from "../src/lib/groww/nifty100-schemas.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { closedSessionCandles } from "../src/lib/market/closed-candles.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";
import { liveStockScreen, loadStockScreen, prepareStockScreen, requiredScreenerClose, screenerHistoryReady,
  StockScanError, stockAnalysisLinkSchema, stockScreenVerdict } from "../src/lib/market/stock-screener.ts";

const now = Date.parse("2026-11-17T11:00:00+05:30");
let clock = now;
const originalSecret = process.env.GROWW_SESSION_SECRET;
beforeEach(t => {
  clock += 3_600_001;
  t.mock.method(Date, "now", () => clock);
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});
const csvHeader = "Company Name,Industry,Symbol,Series,ISIN Code";
const csvRows = Array.from({ length: 100 }, (_, i) =>
  `${JSON.stringify(`Company ${i}, India`)},Financial Services,STOCK${i},EQ,INE${String(i).padStart(6, "0")}A01`);
const csv = [csvHeader, ...csvRows].join("\r\n");
function request(authenticated = true) {
  return new Request("http://localhost/api/groww/nifty100", {
    headers: authenticated ? { cookie: sessionCookie("test-screener-token").split(";")[0] } : {},
  });
}

test("official constituents require exactly 100 unique equities, valid symbols and complete issuer metadata", () => {
  const parsed = parseNifty100Csv(`\uFEFF${csv}`, new Date(now).toISOString());
  assert.equal(parsed.stocks.length, 100);
  assert.equal(parsed.stocks.find(stock => stock.symbol === "STOCK0").name, "Company 0, India");
  for (const content of [
    [csvHeader, ...csvRows.slice(1)].join("\n"),
    [csv, csvRows[0]].join("\n"),
    [csvHeader, csvRows[0], ...csvRows.slice(0, 99)].join("\n"),
    csv.replace("STOCK0,EQ", "INVALID/SYMBOL,EQ"),
    csv.replace("STOCK0,EQ", "STOCK0,BE"),
    csv.replace("INE000000A01", "missing"),
    "<html>Access denied</html>",
  ]) assert.throws(() => parseNifty100Csv(content, new Date(now).toISOString()));
});

test("constituent API requires authentication and shares fresh official downloads without forwarding broker credentials", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return new Response(csv); });
  assert.equal((await constituents(request(false))).status, 401);
  assert.equal(calls.length, 0);
  const responses = await Promise.all([constituents(request()), constituents(request())]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal((await responses[0].json()).stocks.length, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, nifty100Source);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(responses[0].headers.get("cache-control"), "no-store");
  assert.equal((await constituents(request())).status, 200);
  assert.equal(calls.length, 1);
});

test("expired official-list cache cannot hide HTTP or partial CSV failure, and a valid retry recovers", async t => {
  t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("denied", { status: 403 }));
  assert.equal((await constituents(request())).status, 502);
  upstream.mock.mockImplementation(async () => new Response([csvHeader, csvRows[0]].join("\n")));
  const partial = await constituents(request());
  assert.equal(partial.status, 502);
  assert.match((await partial.json()).error, /no partial, stale or substitute/i);
  upstream.mock.mockImplementation(async () => new Response(csv));
  assert.equal((await constituents(request())).status, 200);
});

function analysis(interval = "15minute") {
  const candles = [];
  if (interval === "15minute") {
    for (let date = Date.parse("2026-11-10T09:15:00+05:30"); date < now; date += 86_400_000) {
      if ([0, 6].includes(new Date(date).getUTCDay())) continue;
      for (let slot = 0; slot < 25 && date + slot * 900_000 < now; slot++) {
        const i = candles.length, close = 100 + i * 0.06 + Math.sin(i * 0.7) * 0.4;
        candles.push({ time: (date + slot * 900_000) / 1000, open: close, close, high: close + 0.2, low: close - 0.2, volume: 100 });
      }
    }
  } else {
    for (let date = Date.parse("2026-08-03T09:15:00+05:30"); date < now; date += 86_400_000) {
      if ([0, 6].includes(new Date(date).getUTCDay())) continue;
      const i = candles.length, close = 100 + i * 0.06 + Math.sin(i * 0.7) * 0.4;
      candles.push({ time: date / 1000, open: close, close, high: close + 0.2, low: close - 0.2, volume: 100 });
    }
  }
  const price = candles.at(-1).close;
  return { symbol: "STOCK0", segment: "CASH", exchange: "NSE", interval, fetchedAt: new Date(now).toISOString(),
    quote: { price, lastTradeTime: now, previousClose: 100, open: 100, high: 120, low: 80, change: 1, changePercent: 1, volume: 1000 },
    candles, technical: calculateIndicators(candles) };
}

test("both scan timeframes use the existing analysis API, exclude forming bars and recalculate real indicators", async t => {
  clock = now;
  for (const [mode, interval] of [["MIS", "15minute"], ["CNC", "1day"]]) {
    const data = analysis(interval);
    const expected = closedSessionCandles(data.candles, interval, now);
    const forming = { ...data.candles.at(-1), time: now / 1000, close: 90000, high: 90001, low: 1 };
    const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), `/api/groww/analysis?symbol=STOCK0&exchange=NSE&segment=CASH&interval=${interval}`);
      assert.equal(options.cache, "no-store");
      return Response.json({ ...data, candles: [...data.candles, forming], technical: { ...data.technical, rsi: 99 } });
    });
    const prepared = await loadStockScreen("STOCK0", mode, new AbortController().signal);
    assert.deepEqual(prepared.candles, expected);
    assert.deepEqual(prepared.technical, calculateIndicators(expected));
    assert.notEqual(prepared.technical.rsi, 99);
    assert.ok(prepared.candles.length >= 50);
    upstream.mock.restore();
  }
});

test("daily completion follows exchange session close, while future, weekend and misaligned intraday bars never count", () => {
  const data = analysis("1day");
  const today = data.candles.at(-1);
  assert.equal(closedSessionCandles([today], "1day", now).length, 0);
  assert.equal(closedSessionCandles([today], "1day", Date.parse("2026-11-17T15:30:00+05:30")).length, 1);
  const bar = analysis().candles.at(-1);
  assert.deepEqual(closedSessionCandles([
    bar, { ...bar, time: now / 1000 }, { ...bar, time: bar.time + 60 },
    { ...bar, time: Date.parse("2026-11-21T09:15:00+05:30") / 1000 },
  ], "15minute", now), [bar]);
});

test("wrong stocks, exchanges, segments, timeframes and malformed analyses fail explicitly instead of showing a verdict", async t => {
  clock = now;
  const data = analysis();
  for (const change of [{ symbol: "OTHER" }, { exchange: "BSE" }, { segment: "FNO" }, { interval: "1day" }, { quote: {} }]) {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ ...data, ...change }));
    await assert.rejects(loadStockScreen("STOCK0", "MIS", new AbortController().signal), /different|invalid/);
    upstream.mock.restore();
  }
});

test("authentication, permissions and rate-limit errors retain their status and cooldown for the scan controller", async t => {
  for (const [status, seconds] of [[401, 0], [403, 0], [429, 120]]) {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Synthetic refusal" }, {
      status, headers: status === 429 ? { "retry-after": "120" } : {},
    }));
    await assert.rejects(loadStockScreen("STOCK0", "MIS", new AbortController().signal),
      error => error instanceof StockScanError && error.status === status && error.retryAfterSeconds === seconds);
    upstream.mock.restore();
  }
});

test("screener BUY expires locally, session/data failures cannot retain levels, and carry-forward SELL is exit-only", () => {
  const data = analysis();
  data.quote.price += 0.5;
  assert.equal(stockScreenVerdict(data, "MIS", now).decision, "BUY");
  for (const [snapshot, at] of [
    [data, now + 60_001], [{ ...data, omittedCandles: 1 }, now],
    [data, Date.parse("2026-11-17T15:20:00+05:30")],
    [{ ...data, quote: { ...data.quote, lastTradeTime: null } }, now],
  ]) {
    const verdict = stockScreenVerdict(snapshot, "MIS", at);
    assert.equal(verdict.decision, "HOLD");
    assert.equal(verdict.entryPrice, null);
    assert.equal(verdict.stopLoss, null);
    assert.deepEqual(verdict.targetPrices, []);
  }
  const daily = analysis("1day");
  daily.candles = closedSessionCandles(daily.candles, "1day", now);
  daily.quote.price = 100;
  daily.technical = { ...daily.technical, rsi: 40, ema20: 103, ema50: 105, atr: 2,
    macd: { value: -5, signal: -3, histogram: -2 }, supertrend: { value: 104, direction: "bearish" } };
  const sell = stockScreenVerdict(daily, "CNC", now);
  assert.equal(sell.decision, "SELL");
  assert.equal(sell.exitOnly, true);
  assert.equal(sell.entryPrice, null);
  assert.equal(sell.stopLoss, null);
  assert.deepEqual(sell.targetPrices, []);
  const cutoff = Date.parse("2026-11-17T15:20:00+05:30");
  const atCutoff = { ...data, fetchedAt: new Date(cutoff).toISOString(),
    quote: { ...data.quote, lastTradeTime: cutoff },
    candles: [...data.candles.slice(0, -1), { ...data.candles.at(-1), time: (cutoff - 20 * 60_000) / 1000 }] };
  const blocked = stockScreenVerdict(atCutoff, "MIS", cutoff);
  assert.equal(blocked.decision, "HOLD");
  assert.ok(blocked.reasons.some(reason => /before 15:20/.test(reason)));
});

test("full-analysis deep links accept exact cash symbols and both modes, but not injected or derivative modes", () => {
  assert.deepEqual(stockAnalysisLinkSchema.parse({ symbol: "m&m", mode: "CNC" }), { symbol: "M&M", mode: "CNC" });
  assert.deepEqual(stockAnalysisLinkSchema.parse({ symbol: "RELIANCE" }), { symbol: "RELIANCE", mode: "MIS" });
  for (const selection of [{ symbol: "NSE:ABC" }, { symbol: ["ABC"] }, { symbol: "ABC", mode: "NRML" }]) {
    assert.equal(stockAnalysisLinkSchema.safeParse(selection).success, false);
  }
});

test("cached baselines reject malformed, mismatched and future snapshots and recompute closed-candle indicators", () => {
  const raw = analysis();
  const prepared = prepareStockScreen({ ...raw, technical: { ...raw.technical, rsi: 99 } }, "STOCK0", "MIS", now);
  assert.deepEqual(prepared.technical, calculateIndicators(prepared.candles));
  assert.notEqual(prepared.technical.rsi, 99);
  for (const change of [{ symbol: "OTHER" }, { interval: "1day" }, { segment: "FNO" },
    { fetchedAt: new Date(now + 5001).toISOString() }, { quote: { ...raw.quote, lastTradeTime: now + 5001 } },
    { candles: [raw.candles[0], ...raw.candles] },
    { candles: [raw.candles[1], raw.candles[0], ...raw.candles.slice(2)] }, { candles: [{}] }]) {
    assert.throws(() => prepareStockScreen({ ...raw, ...change }, "STOCK0", "MIS", now));
  }
});

test("history expiry follows completed IST bars, session close and the preceding weekday over weekends", () => {
  const at = text => Date.parse(`${text}+05:30`);
  for (const [mode, time, expected] of [
    ["MIS", "2026-11-17T09:29:59", "2026-11-16T15:30:00"],
    ["MIS", "2026-11-17T09:30:00", "2026-11-17T09:30:00"],
    ["MIS", "2026-11-17T11:14:59", "2026-11-17T11:00:00"],
    ["MIS", "2026-11-17T11:15:00", "2026-11-17T11:15:00"],
    ["MIS", "2026-11-21T11:00:00", "2026-11-20T15:30:00"],
    ["MIS", "2026-11-23T09:15:00", "2026-11-20T15:30:00"],
    ["CNC", "2026-11-23T15:29:59", "2026-11-20T15:30:00"],
    ["CNC", "2026-11-23T15:30:00", "2026-11-23T15:30:00"],
  ]) assert.equal(requiredScreenerClose(mode, at(time)), at(expected), `${mode} ${time}`);
  const data = prepareStockScreen(analysis(), "STOCK0", "MIS", now);
  assert.equal(screenerHistoryReady(data, "MIS", now), true);
  assert.equal(screenerHistoryReady(data, "MIS", now + 899_999), true);
  assert.equal(screenerHistoryReady(data, "MIS", now + 900_000), false);
  assert.equal(screenerHistoryReady({ ...data, candles: data.candles.slice(0, -1) }, "MIS", now), false);
  assert.equal(screenerHistoryReady({ ...data, omittedCandles: 1 }, "MIS", now), false);
  const daily = prepareStockScreen(analysis("1day"), "STOCK0", "CNC", now);
  assert.equal(screenerHistoryReady(daily, "CNC", now + 900_000), true);
});

function liveTick(data, price = data.quote.price + 0.5) {
  return { type: "tick", symbol: data.symbol, exchange: "NSE", segment: "CASH", price,
    tradeTime: now, receivedAt: new Date(now).toISOString(), observedAt: now };
}

test("live prices recalculate verdicts and risk levels without changing confirmed indicators, candles or snapshot age", () => {
  const data = prepareStockScreen(analysis(), "STOCK0", "MIS", now);
  const first = liveStockScreen(data, "MIS", liveTick(data), now);
  assert.equal(first.verdict.decision, "BUY");
  const raised = liveStockScreen(data, "MIS", liveTick(data, data.quote.price + 1.5), now);
  assert.equal(raised.verdict.decision, "BUY");
  assert.ok(raised.verdict.entryPrice > first.verdict.entryPrice);
  assert.ok(raised.verdict.stopLoss > first.verdict.stopLoss);
  assert.equal(raised.data.technical, data.technical);
  assert.equal(raised.data.candles, data.candles);
  assert.equal(raised.data.fetchedAt, data.fetchedAt);
  assert.equal(raised.verdict.riskPerUnit.toFixed(5), first.verdict.riskPerUnit.toFixed(5));
  const below = liveStockScreen(data, "MIS", liveTick(data, 100), now);
  assert.equal(below.verdict.decision, "HOLD");
  assert.equal(below.verdict.entryPrice, null);
});

test("missing, stale, wrong-identity and older ticks cannot approve entries in either mode, even with fresh cached quotes", () => {
  for (const [mode, interval] of [["MIS", "15minute"], ["CNC", "1day"]]) {
    const data = prepareStockScreen(analysis(interval), "STOCK0", mode, now);
    const tick = liveTick(data);
    for (const invalid of [undefined, { ...tick, symbol: "OTHER" }, { ...tick, exchange: "BSE" },
      { ...tick, segment: "FNO" }, { ...tick, tradeTime: now - 1 },
      { ...tick, tradeTime: now - 60_001 }, { ...tick, tradeTime: now + 10_000 }]) {
      const evaluated = liveStockScreen(data, mode, invalid, now);
      assert.equal(evaluated.live, false);
      assert.equal(evaluated.verdict.decision, "HOLD");
      assert.equal(evaluated.verdict.entryPrice, null);
      assert.deepEqual(evaluated.verdict.targetPrices, []);
      assert.equal(evaluated.data, data);
    }
    assert.equal(liveStockScreen(data, mode, tick, now + 60_001).verdict.decision, "HOLD");
  }
});

test("a fresh tick cannot cover a missing new closed candle or turn a refreshed timestamp into new history", () => {
  const data = prepareStockScreen(analysis(), "STOCK0", "MIS", now);
  const boundary = now + 900_000;
  const tick = { ...liveTick(data), tradeTime: boundary, receivedAt: new Date(boundary).toISOString(), observedAt: boundary };
  for (const snapshot of [data, { ...data, fetchedAt: new Date(boundary).toISOString() }]) {
    const evaluated = liveStockScreen(snapshot, "MIS", tick, boundary);
    assert.equal(evaluated.live, true);
    assert.equal(evaluated.historyReady, false);
    assert.equal(evaluated.verdict.decision, "HOLD");
    assert.equal(evaluated.verdict.stopLoss, null);
    assert.ok(evaluated.verdict.reasons.some(reason => /completed candle baseline/.test(reason)));
  }
});
