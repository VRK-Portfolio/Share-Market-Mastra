import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "../src/app/api/groww/sentiment/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { fetchCompanyNews, selectCompanyHeadlines } from "../src/lib/market/company-news.ts";
import {
  assessNewsSentiment, combineHeadlineClassifications, headlineBalance, newsSentimentSchema,
} from "../src/lib/market/news-sentiment.ts";
import { newsSentimentAgent } from "../src/mastra/agents/news-sentiment-agent.ts";

const now = Date.parse("2026-11-17T11:00:00+05:30");
const selection = { symbol: "ADANIPORTS", exchange: "NSE" };
const token = "private-groww-token-not-for-news";
const newsKey = "test-gnews-key-not-for-model";
const names = ["GROWW_SESSION_SECRET", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GNEWS_API_KEY"];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.GNEWS_API_KEY = newsKey;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
  delete process.env.GOOGLE_API_KEY;
});
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
const rawArticle = (index, time = now) => ({
  title: `Adani Ports test development ${index}`, url: `https://publisher.example/article/${index}`,
  publishedAt: new Date(time).toISOString(), source: { name: "Test publisher" },
  content: "Article content must not be sent to the model.", description: null,
});
function snapshot(tone = "POSITIVE", at = now) {
  const articles = combineHeadlineClassifications(selectCompanyHeadlines({
    articles: [rawArticle(1, at), rawArticle(2, at)],
  }, at), { headlines: [1, 2].map((id) => ({ id: `h${id}`, relevant: true, tone, explanation: "Headline-only test classification." })) });
  return newsSentimentSchema.parse({
    ...selection, companyName: "Adani Ports", fetchedAt: new Date(at).toISOString(),
    provider: "GNews", model: "test-model", articles, bias: headlineBalance(articles).bias,
  });
}
function request(body = selection, headers = {}) {
  return new Request("http://localhost/api/groww/sentiment", {
    method: "POST", headers: { "Content-Type": "application/json", cookie: sessionCookie(token).split(";")[0], ...headers },
    body: JSON.stringify(body),
  });
}
const catalog = [
  "exchange,segment,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,name",
  "NSE,CASH,ADANIPORTS,NSE-ADANIPORTS,,EQ,,,1,0.01,Adani Ports And Special Economic Zone Limited",
].join("\n");
function mockSources(t, options = {}) {
  return t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response(catalog);
    assert.equal(url.origin + url.pathname, "https://gnews.io/api/v4/search");
    assert.equal(url.searchParams.get("apikey"), newsKey);
    assert.equal(url.searchParams.get("lang"), "en");
    assert.equal(url.searchParams.get("country"), "in");
    assert.equal(url.searchParams.get("in"), "title");
    assert.equal(url.searchParams.get("max"), "10");
    assert.match(url.searchParams.get("q"), /"ADANIPORTS"/);
    assert.match(url.searchParams.get("q"), /"Adani Ports"/);
    assert.ok(!JSON.stringify(init.headers).includes(token));
    if (options.status) return Response.json({ error: `Do not echo ${newsKey} ${token}` }, { status: options.status });
    const at = Date.now();
    return Response.json(options.body ?? { articles: [rawArticle(1, at), rawArticle(2, at)] });
  });
}
const positiveOutput = { headlines: [1, 2].map((id) => ({
  id: `h${id}`, relevant: true, tone: "POSITIVE", explanation: "A positive company-specific development is described.",
})) };

test("headlines are date-filtered, newest-first, deduplicated and bounded without accepting unsafe links", () => {
  const articles = selectCompanyHeadlines({ articles: [
    rawArticle(1, now - 1000), { ...rawArticle(1), url: "https://publisher.example/duplicate" },
    { ...rawArticle(2), url: "javascript:alert(1)" }, rawArticle(3, now - 73 * 3_600_000),
    rawArticle(4, now + 60_000), { ...rawArticle(5), publishedAt: "not-a-date" },
    ...Array.from({ length: 10 }, (_, index) => rawArticle(20 + index, now - index * 1000)),
  ] }, now);
  assert.equal(articles.length, 8);
  assert.deepEqual(articles.map((item) => item.id), Array.from({ length: 8 }, (_, index) => `h${index + 1}`));
  assert.equal(new Set(articles.map((item) => item.title)).size, 8);
  assert.ok(articles.every((item) => !/Article content/.test(JSON.stringify(item))));
  const queryUrls = selectCompanyHeadlines({ articles: [
    { ...rawArticle(1), url: "https://publisher.example/story?id=1&utm_source=test" },
    { ...rawArticle(2), url: "https://publisher.example/story?id=2" },
    { ...rawArticle(3), url: "https://publisher.example/story?id=1" },
  ] }, now);
  assert.equal(queryUrls.length, 2);
});

test("classification must cover exact source IDs once; no model headlines, links or direction are trusted", () => {
  const articles = selectCompanyHeadlines({ articles: [rawArticle(1), rawArticle(2)] }, now);
  for (const headlines of [
    positiveOutput.headlines.slice(0, 1),
    [positiveOutput.headlines[0], positiveOutput.headlines[0]],
    [positiveOutput.headlines[0], { ...positiveOutput.headlines[1], id: "h8" }],
    positiveOutput.headlines.map((item) => ({ ...item, relevant: false })),
  ]) assert.throws(() => combineHeadlineClassifications(articles, { headlines }));
  const merged = combineHeadlineClassifications(articles, {
    headlines: positiveOutput.headlines.map((item) => ({ ...item, url: "https://invented.example", title: "Invented" })),
  });
  assert.equal(merged[0].url, articles[0].url);
  assert.equal(merged[0].title, articles[0].title);
  assert.equal(headlineBalance(merged).bias, "BULLISH");
});

test("missing, thin, mixed, stale, delayed or wrong-stock coverage cannot become fresh directional confirmation", () => {
  const news = snapshot();
  assert.equal(assessNewsSentiment(news, selection.symbol, "NSE", now).available, true);
  assert.equal(assessNewsSentiment(news, selection.symbol, "NSE", now + 900_001).available, false);
  const delayed = { ...snapshot("POSITIVE", now - 12 * 3_600_000), fetchedAt: new Date(now).toISOString() };
  assert.equal(assessNewsSentiment(delayed, selection.symbol, "NSE", now).available, false);
  assert.match(assessNewsSentiment(delayed, selection.symbol, "NSE", now).reason, /six hours/);
  assert.equal(assessNewsSentiment(news, "TCS", "NSE", now).available, false);
  assert.equal(assessNewsSentiment(news, selection.symbol, "BSE", now).available, false);
  assert.equal(assessNewsSentiment(null, selection.symbol, "NSE", now).available, false);
  assert.equal(headlineBalance([]).bias, "UNAVAILABLE");
  assert.equal(headlineBalance(news.articles.slice(0, 1)).bias, "UNAVAILABLE");
  assert.equal(headlineBalance([news.articles[0], { ...news.articles[1], tone: "NEGATIVE" }]).bias, "NEUTRAL");
  assert.equal(newsSentimentSchema.safeParse({ ...news, bias: "BEARISH" }).success, false);
  assert.equal(newsSentimentSchema.safeParse({ ...news, articles: [news.articles[0], news.articles[0]] }).success, false);
});

test("sentiment endpoint checks origin, session, input and configuration before external calls", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream call"); });
  const agent = t.mock.method(newsSentimentAgent, "generate", () => { throw new Error("Unexpected model call"); });
  assert.equal((await POST(request(selection, { origin: "https://other.example" }))).status, 403);
  assert.equal((await POST(new Request("http://localhost/api/groww/sentiment", { method: "POST" }))).status, 401);
  assert.equal((await POST(request({ ...selection, segment: "FNO" }))).status, 400);
  assert.equal((await POST(request({ ...selection, symbol: "../bad" }))).status, 400);
  delete process.env.GNEWS_API_KEY;
  assert.equal((await POST(request())).status, 503);
  process.env.GNEWS_API_KEY = newsKey;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  assert.equal((await POST(request())).status, 503);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(agent.mock.callCount(), 0);
});

test("server verifies company identity, sends only public headline metadata and recomputes sentiment", async (t) => {
  mockSources(t);
  const agent = t.mock.method(newsSentimentAgent, "generate", async () => ({ object: { ...positiveOutput, bias: "BEARISH" } }));
  const req = request();
  const response = await POST(req);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.ok(newsSentimentSchema.safeParse(result).success);
  assert.equal(result.bias, "BULLISH");
  assert.equal(result.articles.length, 2);
  const [prompt, options] = agent.mock.calls[0].arguments;
  assert.match(JSON.parse(prompt).companyName, /Special Economic Zone/);
  for (const value of [token, newsKey, "test-gemini-key", "Article content", "apikey", "holdings"]) assert.ok(!prompt.includes(value));
  assert.equal(options.structuredOutput.errorStrategy, "strict");
  assert.equal(options.maxSteps, 1);
  assert.equal(options.modelSettings.maxRetries, 0);
  assert.equal(agent.mock.callCount(), 1);
});

test("no coverage is explicitly unavailable with no model call; unknown equity symbols are rejected", async (t) => {
  mockSources(t, { body: { articles: [] } });
  const agent = t.mock.method(newsSentimentAgent, "generate", () => { throw new Error("No model call for empty coverage"); });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.bias, "UNAVAILABLE");
  assert.equal(result.model, null);
  assert.deepEqual(result.articles, []);
  assert.equal((await POST(request({ ...selection, symbol: "NOTANAPPROVEDEQUITY" }))).status, 404);
  assert.equal(agent.mock.callCount(), 0);
});

test("provider errors never echo keys or invalidate Groww sessions; bad model IDs never become a verdict", async (t) => {
  t.mock.method(console, "error", () => {});
  const provider = { status: 429 };
  const upstream = mockSources(t, provider);
  const agent = t.mock.method(newsSentimentAgent, "generate", async () => ({ object: { headlines: [positiveOutput.headlines[0]] } }));
  for (const status of [429, 401, 403]) {
    provider.status = status;
    const limited = await POST(request());
    assert.equal(limited.status, status === 429 ? 429 : 502);
    assert.equal(limited.headers.get("set-cookie"), null);
    const message = await limited.text();
    assert.ok(!message.includes(newsKey));
    assert.ok(!message.includes(token));
  }
  upstream.mock.mockImplementation(async () => Response.json({ articles: [rawArticle(1, Date.now()), rawArticle(2, Date.now())] }));
  const invalid = await POST(request());
  assert.equal(invalid.status, 502);
  assert.equal(agent.mock.callCount(), 1);
  upstream.mock.mockImplementation(async () => Response.json({ articles: [{ title: "Broken metadata" }] }));
  assert.equal((await POST(request())).status, 502);
});

test("bounded news requests explicitly reject oversized provider responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(" ".repeat(512_001)));
  await assert.rejects(() => fetchCompanyNews(selection.symbol, "Adani Ports", newsKey, AbortSignal.timeout(1000)), /size limit/);
});
