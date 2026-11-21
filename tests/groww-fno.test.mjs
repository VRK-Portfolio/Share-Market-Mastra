import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET as search } from "../src/app/api/groww/instruments/route.ts";
import { GET as analyze } from "../src/app/api/groww/analysis/route.ts";
import { GET as guide } from "../src/app/api/groww/fno-guide/route.ts";
import { GET as optionUnderlying } from "../src/app/api/groww/option-underlying/route.ts";
import { POST as recommend } from "../src/app/api/groww/recommendation/route.ts";
import { parseInstrumentCsv } from "../src/lib/groww/instruments.ts";
import { growwFnoCandleHistorySchema, growwFnoQuoteSchema } from "../src/lib/groww/market-schemas.ts";
import { recommendationForMode } from "../src/lib/market/recommendation.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { historicalRequests } from "../src/lib/groww/historical-requests.ts";
import { stockAnalysisAgent } from "../src/mastra/agents/stock-analysis-agent.ts";
import { nearbyOptionContracts, optionIndexTrend, optionSideGuidance, optionStrikeMoneyness } from "../src/lib/market/option-guide.ts";

const envKeys = ["GROWW_SESSION_SECRET", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"];
const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const token = "test-fno-secret-token";
let clock = Date.now();
beforeEach((t) => {
  t.mock.method(historicalRequests, "run", async (_token, _signal, request) => request());
  clock += 3_600_001;
  t.mock.method(Date, "now", () => clock);
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-fno-key";
  delete process.env.GOOGLE_API_KEY;
});
afterEach(() => {
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

const header = "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment,name";
const future = 'NSE,NIFTY99NOVFUT,NSE-NIFTY-23Nov99-FUT,NIFTY,FUT,2099-11-23,-0.01,65,0.1,FNO,"Nifty, future"';
const call = "NSE,NIFTY99NOV25000CE,NSE-NIFTY-23Nov99-25000-CE,NIFTY,CE,2099-11-23,25000,65,0.05,FNO,";
const put = "NSE,NIFTY99NOV25000PE,NSE-NIFTY-23Nov99-25000-PE,NIFTY,PE,2099-11-23,25000,65,0.05,FNO,";
const bse = "BSE,SENSEX99NOVFUT,BSE-SENSEX-23Nov99-FUT,SENSEX,FUT,2099-11-23,,20,0.05,FNO,";
const expired = "NSE,NIFTY00NOVFUT,NSE-NIFTY-23Nov00-FUT,NIFTY,FUT,2000-11-23,-0.01,65,0.1,FNO,";
const csv = [header, future, call, put, bse, expired].join("\r\n");
const indexRow = "NSE,NIFTY,NSE-NIFTY,NIFTY,IDX,,,,,CASH,NIFTY 50";

test("option analytics underlying requires authentication and valid exact query before any upstream call", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected request"); });
  assert.equal((await optionUnderlying(new Request("http://localhost/api/groww/option-underlying?symbol=NIFTY"))).status, 401);
  assert.equal((await optionUnderlying(get("option-underlying?symbol=bad%20symbol"))).status, 400);
  assert.equal((await optionUnderlying(get("option-underlying?symbol=NIFTY&exchange=INVALID"))).status, 400);
  assert.equal(calls, 0);
});

test("option analytics resolves the selected index option to exact CASH spot without historical/model calls", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    requests.push(url);
    return url.hostname === "growwapi-assets.groww.in" ? new Response([header, call, indexRow].join("\n")) : Response.json(quote);
  });
  const response = await optionUnderlying(get("option-underlying?symbol=NIFTY99NOV25000CE&exchange=NSE"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.contract.tradingSymbol, "NIFTY99NOV25000CE");
  assert.equal(body.underlying.tradingSymbol, "NIFTY");
  assert.equal(body.underlying.instrumentType, "IDX");
  assert.equal(body.quote.price, 151);
  assert.equal(body.quote.lastTradeTime, quote.payload.last_trade_time);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("segment"), "CASH");
  assert.equal(requests[1].searchParams.get("trading_symbol"), "NIFTY");
});

test("option analytics resolves exact stock-option underlyings and known index aliases, not substring matches", async t => {
  const stockCall = call.replaceAll("NIFTY", "RELIANCE");
  const aliasCall = put.replaceAll("NIFTY", "MIDCPNIFTY");
  const requests = [];
  const stock = "NSE,RELIANCE,NSE-RELIANCE,RELIANCE,EQ,,,,,CASH,Reliance";
  const similar = "NSE,RELIANCEPART,NSE-RELIANCEPART,RELIANCEPART,EQ,,,,,CASH,Similar name";
  const aliasIndex = "NSE,NIFTYMIDSELECT,NSE-NIFTYMIDSELECT,NIFTYMIDSELECT,IDX,,,,,CASH,Nifty Midcap Select";
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response([header, stockCall, aliasCall, stock, similar, aliasIndex].join("\n"));
    requests.push(url.searchParams.get("trading_symbol"));
    return Response.json(quote);
  });
  const stockBody = await (await optionUnderlying(get("option-underlying?symbol=RELIANCE99NOV25000CE"))).json();
  assert.equal(stockBody.underlying.instrumentType, "EQ");
  assert.equal(stockBody.underlying.tradingSymbol, "RELIANCE");
  const indexBody = await (await optionUnderlying(get("option-underlying?symbol=MIDCPNIFTY99NOV25000PE"))).json();
  assert.equal(indexBody.underlying.tradingSymbol, "NIFTYMIDSELECT");
  assert.deepEqual(requests, ["RELIANCE", "NIFTYMIDSELECT"]);
});

test("option analytics rejects missing, expired, future, unmapped and ambiguous contracts without guessing a spot", async t => {
  const unknown = call.replaceAll("NIFTY", "UNKNOWN");
  const ambiguous = indexRow.replace("NSE-NIFTY,", "NSE-NIFTY-OTHER,");
  let quotes = 0;
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response([csv.replaceAll("\r\n", "\n"), unknown, indexRow, ambiguous].join("\n"));
    quotes++;
    return Response.json(quote);
  });
  for (const symbol of ["NIFTY99NOVFUT", "NIFTY00NOVFUT", "MISSINGCE", "UNKNOWN99NOV25000CE", "NIFTY99NOV25000CE"]) {
    assert.equal((await optionUnderlying(get(`option-underlying?symbol=${symbol}`))).status, 404, symbol);
  }
  assert.equal(quotes, 0);
});

test("option analytics propagates expired authentication and rejects malformed underlying quotes", async t => {
  let status = 401;
  t.mock.method(globalThis, "fetch", async input => {
    if (new URL(input).hostname === "growwapi-assets.groww.in") return new Response([header, call, indexRow].join("\n"));
    return Response.json(status === 200 ? { status: "SUCCESS", payload: { last_price: 0 } } : { error: "Expired" }, { status });
  });
  assert.equal((await optionUnderlying(get("option-underlying?symbol=NIFTY99NOV25000CE"))).status, 401);
  status = 200;
  assert.equal((await optionUnderlying(get("option-underlying?symbol=NIFTY99NOV25000CE"))).status, 502);
});

test("nearby strikes use actual irregular values, deterministic lower ties and CE/PE moneyness", () => {
  const template = parseInstrumentCsv(csv)[1];
  const contracts = [150, 100, 103, 90, 120, 110, 108, 200, 80].map(strike => ({
    ...template, strikePrice: strike, tradingSymbol: `TEST${strike}CE`, growwSymbol: `NSE-TEST-${strike}-CE`,
  }));
  const result = nearbyOptionContracts(contracts, 104);
  assert.equal(result.nearestStrike, 103);
  assert.deepEqual(result.strikes, [80, 90, 100, 103, 108, 110, 120, 150, 200]);
  assert.deepEqual(result.contracts.map(item => item.strikePrice), [80, 90, 100, 103, 108, 110, 120]);
  assert.equal(nearbyOptionContracts(contracts, 105.5).nearestStrike, 103);
  assert.equal(nearbyOptionContracts([], 100).nearestStrike, null);
  const aroundChosen = nearbyOptionContracts(contracts, 104, 200);
  assert.equal(aroundChosen.nearestStrike, 103);
  assert.ok(aroundChosen.contracts.some(item => item.strikePrice === 200));
  assert.deepEqual(aroundChosen.strikes, result.strikes);
  assert.equal(optionStrikeMoneyness("CE", 103, 104), "ITM");
  assert.equal(optionStrikeMoneyness("PE", 103, 104), "OTM");
  assert.equal(optionStrikeMoneyness("CE", 108, 104), "OTM");
  assert.equal(optionStrikeMoneyness("PE", 108, 104), "ITM");
  assert.equal(optionStrikeMoneyness("CE", 104, 104), "ATM");
  assert.equal(optionStrikeMoneyness("PE", 104, 104), "ATM");
});

function indexAnalysis(bearish = false) {
  const now = Date.parse("2026-11-17T11:00:00+05:30");
  const candles = [];
  for (let start = Date.parse("2026-11-10T09:15:00+05:30"); start < now; start += 86400_000) {
    if ([0, 6].includes(new Date(start).getUTCDay())) continue;
    for (let slot = 0; slot < 25 && start + slot * 900_000 < now; slot++) {
      const i = candles.length;
      const value = 100 + i * 0.06 + Math.sin(i * 0.7) * 0.4;
      const close = bearish ? 200 - value : value;
      candles.push({ time: (start + slot * 900_000) / 1000, open: close, close, high: close + 0.2, low: close - 0.2, volume: null });
    }
  }
  return { symbol: "NIFTY", exchange: "NSE", segment: "CASH", interval: "15minute", fetchedAt: new Date(now).toISOString(), candles,
    quote: { price: candles.at(-1).close, lastTradeTime: now, previousClose: 100, open: 100, high: 120, low: 80,
      change: null, changePercent: null, volume: null } };
}

test("index guidance confirms CE or PE with closed price evidence, not option type or fabricated index VWAP", () => {
  for (const bearish of [false, true]) {
    const analysis = indexAnalysis(bearish);
    const now = Date.parse(analysis.fetchedAt);
    const trend = optionIndexTrend(analysis, now);
    assert.equal(trend.bias, bearish ? "BEARISH" : "BULLISH");
    assert.equal(trend.reasons.length, 4);
    const spot = { ...analysis.quote, symbol: "NIFTY", name: "Nifty 50", exchange: "NSE", fetchedAt: analysis.fetchedAt };
    const side = bearish ? "PE" : "CE";
    assert.equal(optionSideGuidance(spot, trend, side, now).action, "CONDITIONAL BUY");
    assert.equal(optionSideGuidance(spot, trend, side, now).preferred, side);
    assert.equal(optionSideGuidance(spot, trend, bearish ? "CE" : "PE", now).action, "WAIT");
    const forming = { ...analysis.candles.at(-1), time: now / 1000, close: 1, low: 1, high: 90000 };
    assert.deepEqual(optionIndexTrend({ ...analysis, candles: [...analysis.candles, forming] }, now), trend);
    assert.equal(optionIndexTrend({ ...analysis, candles: analysis.candles.slice(-49) }, now).bias, "NEUTRAL");
    assert.equal(optionIndexTrend({ ...analysis, omittedCandles: 1 }, now).bias, "NEUTRAL");
    assert.equal(optionIndexTrend({ ...analysis, fetchedAt: undefined }, now).bias, "NEUTRAL");
  }
});

test("index side guidance expires without polling and blocks mixed, missing, stale, pre-open and cutoff evidence", () => {
  const analysis = indexAnalysis();
  const now = Date.parse(analysis.fetchedAt);
  const trend = optionIndexTrend(analysis, now);
  const spot = { symbol: "NIFTY", name: "Nifty 50", exchange: "NSE", ...analysis.quote, fetchedAt: analysis.fetchedAt };
  for (const time of [null, now - 60_001, now + 5001, now - 86_400_000]) {
    assert.equal(optionSideGuidance({ ...spot, lastTradeTime: time }, trend, "CE", now).action, "WAIT");
  }
  assert.equal(optionSideGuidance(spot, trend, "CE", now + 60_001).action, "WAIT");
  assert.equal(optionSideGuidance(spot, { ...trend, bias: "NEUTRAL" }, "CE", now).action, "WAIT");
  assert.equal(optionSideGuidance(spot, { ...trend, closedThrough: now - 1_800_001 }, "CE", now).action, "WAIT");
  assert.equal(optionSideGuidance(spot, { ...trend, error: "No index candles." }, "CE", now).action, "WAIT");
  for (const at of ["2026-11-17T09:01:00+05:30", "2026-11-17T15:20:00+05:30", "2026-11-21T11:00:00+05:30"]) {
    const time = Date.parse(at);
    assert.equal(optionSideGuidance({ ...spot, lastTradeTime: time, fetchedAt: new Date(time).toISOString() },
      { ...trend, closedThrough: time }, "CE", time).action, "WAIT");
  }
});

test("guided index selection uses the full exact chain, actual index identity and verified aliases", async (t) => {
  const calls = Array.from({ length: 81 }, (_, i) => call.replaceAll("25000", String(23000 + i * 50)));
  const catalog = [header, indexRow, ...calls, put, future, bse,
    call.replaceAll("NIFTY", "BANKNIFTY"),
    "NSE,NIFTYMIDSELECT,NSE-NIFTYMIDSELECT,MIDCPNIFTY,IDX,,,,,CASH,Nifty Midcap Select",
    call.replaceAll("NIFTY", "MIDCPNIFTY")].join("\n");
  const requests = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === "growwapi-assets.groww.in") return new Response(catalog);
    return Response.json(url.pathname === "/v1/live-data/quote"
      ? { ...quote, payload: { ...quote.payload, last_price: 25024, last_trade_time: clock } } : history());
  });
  const list = await guide(get("fno-guide?exchange=NSE"));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).indices.map(item => item.underlying), ["NIFTY", "MIDCPNIFTY"]);
  const response = await guide(get("fno-guide?exchange=NSE&underlying=NIFTY&type=CE"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.spot.symbol, "NIFTY");
  assert.equal(data.spot.price, 25024);
  assert.equal(data.nearestStrike, 25000);
  assert.equal(data.contracts.length, 7);
  assert.equal(data.strikes.length, 81);
  assert.ok(data.contracts.every(item => item.underlying === "NIFTY" && item.instrumentType === "CE" && item.expiry === "2099-11-23"));
  assert.equal(requests.find(url => url.pathname === "/v1/historical/candles").searchParams.get("groww_symbol"), "NSE-NIFTY");
  assert.equal(requests.find(url => url.pathname === "/v1/live-data/quote").searchParams.get("segment"), "CASH");
  assert.equal(requests.find(url => url.pathname === "/v1/live-data/quote").searchParams.get("trading_symbol"), "NIFTY");
  const pe = await (await guide(get("fno-guide?exchange=NSE&underlying=NIFTY&type=PE"))).json();
  assert.equal(pe.contracts.length, 1);
  assert.equal(pe.contracts[0].instrumentType, "PE");
  const chosen = await (await guide(get("fno-guide?exchange=NSE&underlying=NIFTY&type=CE&strike=23000"))).json();
  assert.equal(chosen.nearestStrike, 25000);
  assert.equal(chosen.strikes.length, 81);
  assert.deepEqual(chosen.contracts.map(item => item.strikePrice), [23000, 23050, 23100, 23150, 23200, 23250, 23300]);
  const quoteCount = requests.filter(url => url.pathname === "/v1/live-data/quote").length;
  assert.equal((await guide(get("fno-guide?underlying=NIFTY&type=CE&strike=25001"))).status, 404);
  assert.equal((await guide(get("fno-guide?underlying=NIFTY&type=PE&strike=23000"))).status, 404);
  assert.equal(requests.filter(url => url.pathname === "/v1/live-data/quote").length, quoteCount);
  assert.equal((await guide(get("fno-guide?exchange=BSE&underlying=NIFTY&type=CE"))).status, 404);
  assert.equal((await guide(get("fno-guide?exchange=NSE&underlying=NIFTY&expiry=2099-12-01"))).status, 404);
});

test("near-spot guide lists and resolves exact stock underlyings alongside indices without guessing ambiguous stocks", async t => {
  const stockCalls = [100, 150, 175, 200].map(strike => call.replaceAll("NIFTY", "RELIANCE").replaceAll("25000", String(strike)));
  const duplicate = call.replaceAll("NIFTY", "DUPLICATE");
  const stock = "NSE,RELIANCE,NSE-RELIANCE,RELIANCE,EQ,,,,,CASH,Reliance Industries";
  const similar = "NSE,RELIANCEPART,NSE-RELIANCEPART,RELIANCEPART,EQ,,,,,CASH,Similar name";
  const ambiguous = [
    "NSE,DUPLICATE,NSE-DUPLICATE-A,DUPLICATE,EQ,,,,,CASH,Duplicate A",
    "NSE,DUPLICATE,NSE-DUPLICATE-B,DUPLICATE,EQ,,,,,CASH,Duplicate B",
  ];
  const requests = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") {
      return new Response([header, indexRow, call, ...stockCalls, stock, similar, duplicate, ...ambiguous].join("\n"));
    }
    requests.push(url);
    return Response.json(url.pathname === "/v1/live-data/quote" ? quote : history());
  });
  const list = await (await guide(get("fno-guide?exchange=NSE"))).json();
  assert.deepEqual(list.indices.map(item => [item.underlying, item.index.instrumentType]), [["NIFTY", "IDX"], ["RELIANCE", "EQ"]]);
  const response = await guide(get("fno-guide?underlying=RELIANCE&type=CE&strike=175"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.index.tradingSymbol, "RELIANCE");
  assert.equal(data.index.instrumentType, "EQ");
  assert.equal(data.spot.symbol, "RELIANCE");
  assert.equal(data.nearestStrike, 150);
  assert.deepEqual(data.strikes, [100, 150, 175, 200]);
  assert.ok(data.contracts.some(item => item.strikePrice === 175));
  assert.equal(requests.find(url => url.pathname === "/v1/live-data/quote").searchParams.get("trading_symbol"), "RELIANCE");
  assert.equal(requests.find(url => url.pathname === "/v1/historical/candles").searchParams.get("groww_symbol"), "NSE-RELIANCE");
  const count = requests.length;
  assert.equal((await guide(get("fno-guide?underlying=DUPLICATE"))).status, 404);
  assert.equal((await guide(get("fno-guide?underlying=RELIANCEPART"))).status, 404);
  assert.equal(requests.length, count);
});

test("option guide keeps spot selection explicitly indicative when candles fail, but propagates expired authentication", async (t) => {
  let status = 403;
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response([header, indexRow, call].join("\n"));
    if (url.pathname === "/v1/live-data/quote") return Response.json(quote);
    return Response.json({ error: "Unavailable" }, { status });
  });
  const response = await guide(get("fno-guide?underlying=NIFTY"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.spot.price, 151);
  assert.equal(data.trend.bias, "NEUTRAL");
  assert.match(data.trend.error, /could not be loaded or validated/);
  status = 401;
  assert.equal((await guide(get("fno-guide?underlying=NIFTY"))).status, 401);
});

test("option guide requires a session and rejects invalid sides before any catalog or broker requests", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected request"); });
  assert.equal((await guide(new Request("http://localhost/api/groww/fno-guide"))).status, 401);
  assert.equal((await guide(get("fno-guide?type=FUT"))).status, 400);
  for (const strike of ["0", "-1", "NaN", "Infinity"]) {
    assert.equal((await guide(get(`fno-guide?strike=${strike}`))).status, 400);
  }
  assert.equal(calls, 0);
});
const quote = {
  status: "SUCCESS", payload: {
    last_price: 151, day_change: 1, day_change_perc: 0.67, volume: 1000,
    last_trade_time: Date.parse("2026-11-12T10:30:00+05:30"),
    ohlc: { open: 150, high: 153, low: 149, close: 150 },
    open_interest: 50000, oi_day_change: -1200, implied_volatility: 18.5,
  },
};
function history() {
  return { status: "SUCCESS", payload: { candles: Array.from({ length: 80 }, (_, index) => {
    const close = 150 + index / 10 + Math.sin(index);
    return [1794378300 + index * 900, close - 0.2, close + 0.5, close - 0.5, close, 100 + index, 10000 + index];
  }) } };
}
function get(path) {
  return new Request(`http://localhost/api/groww/${path}`, { headers: { cookie: sessionCookie(token).split(";")[0] } });
}
function post(symbol, mode = "NRML", segment = "FNO") {
  return new Request("http://localhost/api/groww/recommendation", {
    method: "POST", headers: { cookie: sessionCookie(token).split(";")[0], "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, exchange: "NSE", interval: "15minute", segment, mode }),
  });
}
function market(t, catalog = csv, candles = history()) {
  return t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response(catalog);
    return Response.json(url.pathname === "/v1/live-data/quote" ? quote : candles);
  });
}
const plan = {
  decision: "SELL", confidencePercent: 55, summary: "Conditional futures short setup.",
  entryPrice: 151, targetPrices: [141, 131], stopLoss: 156,
  supportLevels: [141], resistanceLevels: [156], rationale: ["Contract price momentum."],
  risks: ["Margin and expiry risk; verify eligibility."], invalidation: "Above resistance.", gtt: null,
};

test("CSV preserves exact Groww symbols, quoted fields and futures strike sentinel; malformed metadata is rejected", () => {
  const instruments = parseInstrumentCsv(`\uFEFF${csv}`);
  assert.equal(instruments.length, 5);
  assert.equal(instruments[0].growwSymbol, "NSE-NIFTY-23Nov99-FUT");
  assert.equal(instruments[0].strikePrice, null);
  assert.equal(instruments[0].lotSize, 65);
  assert.equal(instruments[1].strikePrice, 25000);
  assert.throws(() => parseInstrumentCsv("exchange,segment\nNSE,FNO"));
  assert.throws(() => parseInstrumentCsv([header, call.replace(",25000,65,", ",-1,65,")].join("\n")));
  assert.throws(() => parseInstrumentCsv([header, future.replace(",65,0.1,", ",0,0.1,")].join("\n")));
});

test("contract search filters expiry, strike, type and exchange, excludes expired contracts and caches public CSV without sending tokens", async (t) => {
  const upstream = market(t);
  let response = await search(get("instruments?q=NIFTY&exchange=NSE"));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.total, 3);
  assert.ok(body.instruments.every((item) => item.expiry === "2099-11-23"));
  response = await search(get("instruments?q=NIFTY&type=CE&expiry=2099-11-23&strike=25000"));
  body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.instruments[0].instrumentType, "CE");
  response = await search(get("instruments?q=SENSEX&exchange=BSE&type=FUT"));
  assert.equal((await response.json()).total, 1);
  assert.equal(upstream.mock.callCount(), 1);
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.ok(!String(url).includes(token));
  assert.equal(options.headers, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("contract pagination returns every matching strike rather than silently truncating the list", async (t) => {
  const rows = Array.from({ length: 65 }, (_, index) => call.replaceAll("25000", String(25000 + index * 50)));
  market(t, [header, ...rows].join("\n"));
  const symbols = [];
  for (let page = 1; page <= 3; page++) {
    const response = await search(get(`instruments?q=NIFTY&type=CE&page=${page}`));
    const body = await response.json();
    assert.equal(body.total, 65);
    assert.equal(body.hasMore, page < 3);
    assert.equal(body.instruments.length, page < 3 ? 30 : 5);
    symbols.push(...body.instruments.map((item) => item.growwSymbol));
  }
  assert.equal(new Set(symbols).size, 65);
});

test("NIFTY exact-underlying and prefix matches appear before BANKNIFTY substring matches without losing pagination", async t => {
  const bank = Array.from({ length: 35 }, (_, index) =>
    call.replaceAll("NIFTY", "BANKNIFTY").replaceAll("25000", String(25000 + index * 50)));
  const next = call.replaceAll("NIFTY", "NIFTYNEXT50");
  const fin = call.replaceAll("NIFTY", "FINNIFTY");
  market(t, [header, ...bank, fin, next, future, call, put].join("\n"));
  const first = await (await search(get("instruments?q=nifty"))).json();
  assert.equal(first.total, 40);
  assert.equal(first.instruments.length, 30);
  assert.deepEqual(first.instruments.slice(0, 3).map(item => item.underlying), ["NIFTY", "NIFTY", "NIFTY"]);
  assert.equal(first.instruments[3].underlying, "NIFTYNEXT50");
  const second = await (await search(get("instruments?q=NIFTY&page=2"))).json();
  assert.equal(second.instruments.length, 10);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.instruments, ...second.instruments].map(item => item.growwSymbol)).size, 40);
  const filtered = await (await search(get("instruments?q=NIFTY&type=CE&expiry=2099-11-23&strike=25000"))).json();
  assert.equal(filtered.instruments[0].underlying, "NIFTY");
  assert.equal(filtered.total, 4);
  const exact = await (await search(get("instruments?q=BANKNIFTY99NOV25000CE"))).json();
  assert.equal(exact.total, 1);
  assert.equal(exact.instruments[0].tradingSymbol, "BANKNIFTY99NOV25000CE");
});

test("invalid filters and absent sessions reject before downloading the catalog", async (t) => {
  const upstream = market(t);
  for (const query of ["q=N", "q=NIFTY&type=BAD", "q=NIFTY&expiry=2026-02-30", "q=NIFTY&strike=-1", "q=NIFTY&page=0"]) {
    assert.equal((await search(get(`instruments?${query}`))).status, 400);
  }
  assert.equal((await search(new Request("http://localhost/api/groww/instruments?q=NIFTY"))).status, 401);
  assert.equal(upstream.mock.callCount(), 0);
});

test("futures and both option types use their own FNO quote and exact catalog Groww candle symbol, with real indicators and OI", async (t) => {
  const candles = history();
  const upstream = market(t, csv, candles);
  for (const symbol of ["NIFTY99NOVFUT", "NIFTY99NOV25000CE", "NIFTY99NOV25000PE"]) {
    const response = await analyze(get(`analysis?symbol=${symbol}&segment=FNO&exchange=NSE&interval=15minute`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.segment, "FNO");
    assert.equal(body.symbol, symbol);
    assert.equal(body.instrument.tradingSymbol, symbol);
    assert.equal(body.quote.openInterest, 50000);
    assert.equal(body.quote.oiDayChange, -1200);
    assert.equal(body.quote.impliedVolatility, 18.5);
    assert.equal(body.candles[0].openInterest, 10000);
    const expected = calculateIndicators(growwFnoCandleHistorySchema.parse(candles).candles);
    assert.deepEqual(body.technical, {
      ...expected, supertrend: { value: expected.supertrend.value, direction: expected.supertrend.direction },
    });
    const calls = upstream.mock.calls.slice(-2);
    for (const { arguments: [url] } of calls) assert.equal(url.searchParams.get("segment"), "FNO");
    assert.equal(calls[0].arguments[0].searchParams.get("trading_symbol"), symbol);
    assert.equal(calls[1].arguments[0].searchParams.get("groww_symbol"), body.instrument.growwSymbol);
    assert.notEqual(body.instrument.growwSymbol, `NSE-${symbol}`);
  }
});

test("unknown/expired FNO contracts never fall back to cash data or synthesized symbols", async (t) => {
  const upstream = market(t);
  for (const symbol of ["RELIANCE", "NIFTY00NOVFUT"]) {
    const response = await analyze(get(`analysis?symbol=${symbol}&segment=FNO`));
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal((await analyze(get("analysis?symbol=NIFTY&segment=INVALID"))).status, 400);
});

test("OI and IV remain explicitly unavailable when absent; malformed FNO OI is rejected and incomplete candles are omitted", () => {
  const parsedQuote = growwFnoQuoteSchema.parse({
    ...quote, payload: { ...quote.payload, open_interest: undefined, oi_day_change: null, implied_volatility: undefined },
  });
  assert.equal(parsedQuote.openInterest, null);
  assert.equal(parsedQuote.oiDayChange, null);
  assert.equal(parsedQuote.impliedVolatility, null);
  const candles = history();
  candles.payload.candles[0][1] = null;
  candles.payload.candles[1].splice(6);
  candles.payload.candles[1][5] = null;
  const parsed = growwFnoCandleHistorySchema.parse(candles);
  assert.equal(parsed.omittedCandles, 1);
  assert.equal(parsed.candles[0].openInterest, null);
  assert.equal(parsed.candles[0].volume, null);
  candles.payload.candles[2][6] = -1;
  assert.equal(growwFnoCandleHistorySchema.safeParse(candles).success, false);
});

test("Gemini futures NRML receives exact contract metadata, premiums/OI and validated short levels without GTT", async (t) => {
  market(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate", async () => ({ object: plan }));
  const response = await recommend(post("NIFTY99NOVFUT"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "NRML");
  assert.equal(body.segment, "FNO");
  assert.equal(body.decision, "SELL");
  assert.equal(body.riskRewardRatio, 2);
  assert.equal(body.gtt, null);
  const prompt = agent.mock.calls[0].arguments[0];
  const input = JSON.parse(prompt);
  assert.equal(input.instrument.growwSymbol, "NSE-NIFTY-23Nov99-FUT");
  assert.equal(input.instrument.lotSize, 65);
  assert.equal(input.instrument.expiry, "2099-11-23");
  assert.equal(input.quote.openInterest, 50000);
  assert.equal(input.candles, undefined);
  assert.equal(input.coverage.candleSampleCount, 0);
  assert.ok(input.technical.macd);
  assert.ok(input.ruleVerdict);
  assert.ok(!prompt.includes(token));
  assert.ok(!prompt.includes("test-google-fno-key"));
});

test("options SELL is exit/avoid, not uncovered writing; FNO GTT and CNC and cash NRML are rejected", async (t) => {
  market(t);
  const exit = { ...plan, entryPrice: null, stopLoss: null, targetPrices: [] };
  t.mock.method(stockAnalysisAgent, "generate", async () => ({ object: exit }));
  for (const symbol of ["NIFTY99NOV25000CE", "NIFTY99NOV25000PE"]) {
    const response = await recommend(post(symbol));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entryPrice, null);
  }
  assert.equal((await recommend(post("NIFTY99NOVFUT", "CNC"))).status, 400);
  assert.equal((await recommend(post("RELIANCE", "NRML", "CASH"))).status, 400);
  assert.equal(recommendationForMode("NRML", "CE").safeParse(plan).success, false);
  assert.equal(recommendationForMode("NRML", "FUT").safeParse({
    ...plan, decision: "BUY", entryPrice: 151, stopLoss: 146, targetPrices: [161],
    gtt: { entryTriggerPrice: 151, targetTriggerPrice: 161, stopLossTriggerPrice: 146, note: "Not allowed for FNO." },
  }).success, false);
});

test("catalog failures are explicit and retryable, with no stale list or fabricated market data", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  let response = await search(get("instruments?q=NIFTY"));
  assert.equal(response.status, 502);
  response = await analyze(get("analysis?symbol=NIFTY99NOVFUT&segment=FNO"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).stage, "instruments");
  upstream.mock.mockImplementation(async () => new Response(csv));
  response = await search(get("instruments?q=NIFTY"));
  assert.equal(response.status, 200);
});
