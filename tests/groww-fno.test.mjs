import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET as search } from "../src/app/api/groww/instruments/route.ts";
import { GET as analyze } from "../src/app/api/groww/analysis/route.ts";
import { POST as recommend } from "../src/app/api/groww/recommendation/route.ts";
import { parseInstrumentCsv } from "../src/lib/groww/instruments.ts";
import { growwFnoCandleHistorySchema, growwFnoQuoteSchema } from "../src/lib/groww/market-schemas.ts";
import { recommendationForMode } from "../src/lib/market/recommendation.ts";
import { calculateIndicators } from "../src/lib/market/indicators.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { stockAnalysisAgent } from "../src/mastra/agents/stock-analysis-agent.ts";

const envKeys = ["GROWW_SESSION_SECRET", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"];
const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const token = "test-fno-secret-token";
let clock = Date.now();
beforeEach((t) => {
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
  indicatorAssessments: ["VWAP", "RSI", "ATR", "EMA20", "EMA50", "MACD", "SUPERTREND"].map((indicator) => ({
    indicator, signal: "NEUTRAL", explanation: "Actual contract indicator values require confirmation from other signals.",
  })),
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
  const parsed = growwFnoCandleHistorySchema.parse(candles);
  assert.equal(parsed.omittedCandles, 1);
  assert.equal(parsed.candles[0].openInterest, null);
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
  assert.equal(input.candles[0].openInterest, 10000);
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
