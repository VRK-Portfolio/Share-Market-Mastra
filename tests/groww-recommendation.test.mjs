import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { MastraTimeoutError } from "@mastra/core/loop";
import { POST } from "../src/app/api/groww/recommendation/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { recommendationForMode, recommendationResponseSchema, stockAnalysisModel } from "../src/lib/market/recommendation.ts";
import { stockAnalysisAgent } from "../src/mastra/agents/stock-analysis-agent.ts";

const envNames = ["GROWW_SESSION_SECRET", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"];
const originalEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const token = "test-groww-token-never-send-to-gemini";
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
  delete process.env.GOOGLE_API_KEY;
});
afterEach(() => {
  for (const key of envNames) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const selection = { symbol: "KALYANKJIL", exchange: "NSE", interval: "15minute", mode: "MIS" };
const plan = {
  decision: "BUY", confidencePercent: 65, summary: "Conditional breakout entry; intraday only.",
  entryPrice: 150, targetPrices: [160, 170], stopLoss: 145,
  supportLevels: [145], resistanceLevels: [160],
  rationale: ["Positive price momentum in the supplied candles."],
  indicatorAssessments: ["VWAP", "RSI", "ATR", "EMA20", "EMA50", "MACD", "SUPERTREND"].map((indicator) => ({
    indicator, signal: "NEUTRAL", explanation: "Supplied indicator needs confirmation from the other signals.",
  })),
  risks: ["News and fundamentals are not available."],
  invalidation: "A break below support invalidates this setup.",
  gtt: null,
};
const quote = {
  status: "SUCCESS", payload: {
    last_price: 151, day_change: 1, day_change_perc: 0.67,
    ohlc: { open: 150, high: 153, low: 149, close: 150 },
    volume: 1000, last_trade_time: Date.parse("2026-11-12T10:30:00+05:30"),
  },
};
function history() {
  const candles = Array.from({ length: 150 }, (_, index) => [
    1794378300 + index * 900, 150 + index / 10, 152 + index / 10,
    149 + index / 10, 151 + index / 10, 100 + index, null,
  ]);
  for (const index of [21, 48, 75]) candles[index][1] = null;
  return { status: "SUCCESS", payload: { candles } };
}
function request(body = selection, headers = {}, signal) {
  return new Request("http://localhost/api/groww/recommendation", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: sessionCookie(token).split(";")[0], ...headers },
    body: JSON.stringify(body), signal,
  });
}
function mockMarket(t) {
  return t.mock.method(globalThis, "fetch", async (url) =>
    Response.json(url.pathname === "/v1/live-data/quote" ? quote : history()));
}

test("Gemini receives server-fetched public stock data, bounded candles and indicators, never client prices or credentials", async (t) => {
  const upstream = mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate", async () => ({ object: plan }));
  const req = request({ ...selection, analysis: { price: 9999, accessToken: token }, holdings: ["private"] });
  const response = await POST(req);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.ok(recommendationResponseSchema.safeParse(body).success);
  assert.equal(body.symbol, "KALYANKJIL");
  assert.equal(body.mode, "MIS");
  assert.equal(body.model, stockAnalysisModel);
  assert.equal(body.referencePrice, 151);
  assert.equal(body.riskRewardRatio, 2);
  assert.equal(body.candleCount, 147);
  assert.equal(body.candleSampleCount, 120);
  assert.equal(body.omittedCandles, 3);
  assert.equal(body.lastTradeTime, quote.payload.last_trade_time);
  assert.equal(agent.mock.callCount(), 1);
  const [prompt, options] = agent.mock.calls[0].arguments;
  const input = JSON.parse(prompt);
  assert.equal(input.quote.price, 151);
  assert.equal(input.symbol, "KALYANKJIL");
  assert.equal(input.candles.length, 120);
  assert.equal(input.coverage.candleCount, 147);
  assert.equal(input.coverage.omittedCandles, 3);
  assert.ok(input.technical.ema50 !== null);
  assert.deepEqual(body.indicatorSnapshot, input.technical);
  assert.match(input.task, /indicator-based/);
  assert.equal(input.technical.overlays, undefined);
  for (const forbidden of [token, "test-google-key", "accessToken", "holdings", "9999", "private"]) {
    assert.ok(!prompt.includes(forbidden), forbidden);
  }
  assert.equal(options.structuredOutput.errorStrategy, "strict");
  assert.equal(options.maxSteps, 1);
  assert.equal(options.modelSettings.maxRetries, 0);
  assert.equal(options.modelSettings.timeout.totalMs, 45000);
  assert.equal(options.abortSignal, req.signal);
  assert.equal(upstream.mock.callCount(), 2);
});

test("indicator evidence must include all seven indicators once and accurately label missing values", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate");
  for (const indicatorAssessments of [
    plan.indicatorAssessments.slice(0, 6),
    plan.indicatorAssessments.map(() => plan.indicatorAssessments[0]),
    plan.indicatorAssessments.map((item) => ({ ...item, signal: "UNAVAILABLE" })),
  ]) {
    agent.mock.mockImplementation(async () => ({ object: { ...plan, indicatorAssessments } }));
    assert.equal((await POST(request())).status, 502);
  }
  upstream.mock.mockImplementation(async (url) => Response.json(url.pathname === "/v1/live-data/quote"
    ? quote : { status: "SUCCESS", payload: { candles: [] } }));
  agent.mock.mockImplementation(async () => ({ object: {
    ...plan, decision: "HOLD", entryPrice: null, stopLoss: null, targetPrices: [],
    indicatorAssessments: plan.indicatorAssessments.map((item) => ({ ...item, signal: "UNAVAILABLE", explanation: "Insufficient candles; indicator is unavailable." })),
  } }));
  const response = await POST(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Object.values(body.indicatorSnapshot).every((value) => value === null));
  assert.equal(body.decision, "HOLD");
});

test("delivery BUY includes validated advisory GTT, while HOLD and delivery SELL avoid new trade plans", async (t) => {
  mockMarket(t);
  const gtt = {
    entryTriggerPrice: 150, targetTriggerPrice: 160, stopLossTriggerPrice: 145,
    note: "Confirm eligibility, limit prices, quantity, validity and exit protection with the broker.",
  };
  const agent = t.mock.method(stockAnalysisAgent, "generate", async () => ({ object: { ...plan, gtt } }));
  let response = await POST(request({ ...selection, mode: "CNC" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).gtt, gtt);
  for (const decision of ["HOLD", "SELL"]) {
    agent.mock.mockImplementation(async () => ({
      object: { ...plan, decision, entryPrice: null, targetPrices: [], stopLoss: null, gtt: null },
    }));
    response = await POST(request({ ...selection, mode: "CNC" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.decision, decision);
    assert.equal(body.riskRewardRatio, null);
    assert.equal(body.gtt, null);
  }
});

test("an unavailable zero reference quote can produce HOLD without fabricated price levels", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => Response.json(url.pathname === "/v1/live-data/quote"
    ? { ...quote, payload: { ...quote.payload, last_price: 0 } } : history()));
  t.mock.method(stockAnalysisAgent, "generate", async () => ({
    object: { ...plan, decision: "HOLD", entryPrice: null, targetPrices: [], stopLoss: null, gtt: null },
  }));
  const response = await POST(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.referencePrice, 0);
  assert.equal(body.decision, "HOLD");
  assert.equal(body.riskRewardRatio, null);
});

test("malformed model output, invalid directional targets, inappropriate GTT and missing trade levels are rejected", async (t) => {
  t.mock.method(console, "error", () => {});
  mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate");
  for (const object of [
    undefined, { decision: "BUY" }, { ...plan, stopLoss: 155 },
    { ...plan, targetPrices: [160, 155] }, { ...plan, entryPrice: null },
    { ...plan, decision: "HOLD" }, { ...plan, confidencePercent: 101 },
    { ...plan, gtt: { entryTriggerPrice: 150, targetTriggerPrice: 160, stopLossTriggerPrice: 145, note: "Invalid for MIS" } },
  ]) {
    agent.mock.mockImplementation(async () => ({ object }));
    const response = await POST(request());
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /invalid trade plan/);
  }
  assert.ok(recommendationForMode("MIS").safeParse({
    ...plan, decision: "SELL", stopLoss: 155, targetPrices: [140, 130],
  }).success);
  assert.equal(recommendationForMode("CNC").safeParse({
    ...plan, decision: "SELL", stopLoss: 155, targetPrices: [140, 130],
  }).success, false);
  assert.equal(recommendationForMode("CNC").safeParse({
    ...plan, gtt: { entryTriggerPrice: 150, targetTriggerPrice: 159, stopLossTriggerPrice: 145, note: "Mismatched target" },
  }).success, false);
});

test("missing/tampered sessions, cross-origin and invalid selections never call Groww or Gemini", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate");
  for (const [req, status] of [
    [request(selection, { cookie: "" }), 401],
    [request(selection, { cookie: "groww-session=tampered" }), 401],
    [request(selection, { origin: "https://other.example" }), 403],
    [request({ ...selection, mode: "INVALID" }), 400],
    [request({ ...selection, symbol: "A/B" }), 400],
  ]) assert.equal((await POST(req)).status, status);
  const invalidJson = new Request("http://localhost/api/groww/recommendation", {
    method: "POST", headers: { cookie: sessionCookie(token).split(";")[0] }, body: "{",
  });
  assert.equal((await POST(invalidJson)).status, 400);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(agent.mock.callCount(), 0);
});

test("missing Google credentials reports 503; both supported Google environment names work", async (t) => {
  t.mock.method(console, "error", () => {});
  const upstream = mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate", async () => ({ object: plan }));
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let response = await POST(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(agent.mock.callCount(), 0);
  process.env.GOOGLE_API_KEY = "test-alternative-google-key";
  assert.equal((await POST(request())).status, 200);
});

test("Groww authorization failures propagate and only 401 clears the session; Gemini is not called", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch");
  const agent = t.mock.method(stockAnalysisAgent, "generate");
  for (const status of [401, 403, 429]) {
    upstream.mock.mockImplementation(async () => Response.json({
      status: "FAILURE", error: { code: "GA005", message: "Market data unavailable" },
    }, { status }));
    const response = await POST(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.has("set-cookie"), status === 401);
  }
  assert.equal(agent.mock.callCount(), 0);
});

test("provider errors and native Mastra timeouts fail safely without logging keys or replacing market data", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  mockMarket(t);
  const agent = t.mock.method(stockAnalysisAgent, "generate");
  for (const [error, status] of [
    [new Error(`secret provider body ${token} test-google-key`), 502],
    [new MastraTimeoutError({ timeoutType: "total", timeoutMs: 45000 }), 504],
  ]) {
    agent.mock.mockImplementation(async () => { throw error; });
    const response = await POST(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.has("set-cookie"), false);
    const body = await response.json();
    assert.ok(body.error);
    assert.equal(body.decision, undefined);
    assert.ok(!JSON.stringify(body).includes(token));
    assert.ok(!JSON.stringify(body).includes("test-google-key"));
  }
  assert.ok(!JSON.stringify(log.mock.calls).includes(token));
  assert.ok(!JSON.stringify(log.mock.calls).includes("test-google-key"));
});
