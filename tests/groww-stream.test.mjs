import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "../src/app/api/groww/stream/route.ts";
import { getFeedInstrument } from "../src/lib/groww/instruments.ts";
import { startGrowwFeed } from "../src/lib/groww/stream.ts";
import { applyLiveTick, LiveEventDecoder } from "../src/lib/groww/live-schemas.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
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
const instrument = { symbol: "RELIANCE", exchange: "NSE", segment: "CASH", exchangeToken: "2885", instrumentType: "EQ" };
const header = "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment,exchange_token";
const catalog = [
  header, "NSE,RELIANCE,NSE-RELIANCE,,EQ,,,1,0.05,CASH,2885",
  "NSE,NIFTY,NSE-NIFTY,,IDX,,,1,0.05,CASH,123",
  "NSE,NIFTY99NOVFUT,NSE-NIFTY-23Nov99-FUT,NIFTY,FUT,2099-11-23,-0.01,65,0.1,FNO,456",
  "NSE,NIFTY00NOVFUT,NSE-NIFTY-23Nov00-FUT,NIFTY,FUT,2000-11-23,-0.01,65,0.1,FNO,789",
].join("\n");
function request(query = "symbol=RELIANCE&exchange=NSE&segment=CASH", authenticated = true, origin) {
  return new Request(`http://localhost/api/groww/stream?${query}`, {
    headers: { ...(authenticated ? { cookie: sessionCookie("fake-stream-test-token").split(";")[0] } : {}), ...(origin ? { origin } : {}) },
  });
}
function mockWorker(t) {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough();
  worker.stdin = new PassThrough();
  worker.exitCode = null;
  worker.kill = t.mock.fn(() => {
    worker.exitCode = 0;
    queueMicrotask(() => worker.emit("close", 0));
    return true;
  });
  const spawn = t.mock.method(childProcess, "spawn", () => worker);
  return { worker, spawn };
}

test("catalog resolves actual cash, index and futures tokens and excludes unknown/expired contracts", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(catalog));
  assert.deepEqual(await getFeedInstrument("RELIANCE", "NSE", "CASH", new AbortController().signal), instrument);
  assert.equal((await getFeedInstrument("NIFTY", "NSE", "CASH", new AbortController().signal)).instrumentType, "IDX");
  assert.equal((await getFeedInstrument("NIFTY99NOVFUT", "NSE", "FNO", new AbortController().signal)).exchangeToken, "456");
  assert.equal(await getFeedInstrument("NIFTY00NOVFUT", "NSE", "FNO", new AbortController().signal), null);
  assert.equal(await getFeedInstrument("UNKNOWN", "NSE", "CASH", new AbortController().signal), null);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(upstream.mock.calls[0].arguments[1].headers, undefined);
});

test("unauthenticated, cross-origin and malformed selections never start a worker", async (t) => {
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected worker"); });
  assert.equal((await GET(request(undefined, false))).status, 401);
  assert.equal((await GET(request(undefined, true, "https://other.example"))).status, 403);
  assert.equal((await GET(request("symbol=BAD!&segment=CASH"))).status, 400);
  assert.equal(spawn.mock.callCount(), 0);
});

test("SSE waits for authentication, frames partial worker output and keeps tokens out of args/env/events; cancellation kills its child", async (t) => {
  const { worker, spawn } = mockWorker(t);
  const controller = new AbortController();
  const pending = startGrowwFeed("fake-private-test-token", instrument, controller.signal);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const [python, args, options] = spawn.mock.calls[0].arguments;
  assert.ok(python.includes("python"));
  assert.ok(!JSON.stringify([args, options.env]).includes("fake-private-test-token"));
  assert.equal(options.env.GOOGLE_API_KEY, undefined);
  assert.ok(worker.stdin.read().toString().includes("fake-private-test-token"));
  worker.stdout.write('{"type":"con');
  worker.stdout.write('nected"}\n');
  const stream = await pending;
  const reader = stream.getReader();
  const decoder = new LiveEventDecoder();
  const first = decoder.push(new TextDecoder().decode((await reader.read()).value));
  assert.equal(first[0].type, "connected");
  worker.stdout.write(JSON.stringify({ type: "tick", price: 123.45, tradeTime: clock }) + "\n");
  const tick = decoder.push(new TextDecoder().decode((await reader.read()).value))[0];
  assert.equal(tick.price, 123.45);
  assert.equal(tick.symbol, instrument.symbol);
  assert.ok(!JSON.stringify(tick).includes("fake-private-test-token"));
  await reader.cancel();
  assert.equal(worker.kill.mock.calls[0].arguments[0], "SIGTERM");
});

test("startup auth errors preserve safe HTTP statuses and 401 clears the cookie while 403 retains it", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(catalog));
  for (const code of [401, 403]) {
    const { worker } = mockWorker(t);
    const pending = GET(request());
    setTimeout(() => worker.stdout.write(JSON.stringify({ type: "error", code }) + "\n"), 10);
    const response = await pending;
    assert.equal(response.status, code);
    assert.equal(!!response.headers.get("set-cookie"), code === 401);
    assert.ok(!(await response.text()).includes("fake-stream-test-token"));
  }
});

test("request abort closes an established SSE stream and kills only its own worker", async (t) => {
  const { worker } = mockWorker(t);
  const controller = new AbortController();
  const pending = startGrowwFeed("fake-token", instrument, controller.signal);
  worker.stdout.write('{"type":"connected"}\n');
  const reader = (await pending).getReader();
  await reader.read();
  controller.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(worker.kill.mock.callCount(), 1);
});

test("safe worker diagnostics identify the failing stage without exposing credentials or raw provider errors", async (t) => {
  const { worker } = mockWorker(t);
  const log = t.mock.method(console, "error", () => {});
  const pending = startGrowwFeed("fake-private-token", instrument, new AbortController().signal);
  worker.stdout.write(JSON.stringify({ type: "error", code: 502, stage: "socket-token", failureType: "invalid-response",
    upstreamCode: "GA005", providerBody: "fake-private-token", stack: "private-provider-stack" }) + "\n");
  await assert.rejects(pending, (error) => {
    assert.deepEqual(error.diagnostic, { stage: "socket-token", failureType: "invalid-response", upstreamCode: "GA005" });
    assert.match(error.message, /socket-token creation/);
    return true;
  });
  assert.ok(!JSON.stringify(log.mock.calls).includes("fake-private-token"));
  assert.ok(!JSON.stringify(log.mock.calls).includes("private-provider-stack"));
});

test("initial HTTP errors expose diagnostics but strip an upstream code containing the session token", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(catalog));
  t.mock.method(console, "error", () => {});
  const { worker } = mockWorker(t);
  const pending = GET(request());
  setTimeout(() => worker.stdout.write(JSON.stringify({ type: "error", code: 502, stage: "connection",
    failureType: "connection-failed", upstreamCode: "fake-stream-test-token" }) + "\n"), 10);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.equal(body.stage, "connection");
  assert.equal(body.failureType, "connection-failed");
  assert.equal(body.upstreamCode, undefined);
  assert.ok(!JSON.stringify(body).includes("fake-stream-test-token"));
});

test("established SSE errors preserve safe decoding diagnostics and close the feed", async (t) => {
  t.mock.method(console, "error", () => {});
  const { worker } = mockWorker(t);
  const pending = startGrowwFeed("fake-token", instrument, new AbortController().signal);
  worker.stdout.write('{"type":"connected"}\n');
  const reader = (await pending).getReader();
  await reader.read();
  worker.stdout.write(JSON.stringify({ type: "error", code: 502, stage: "decoding", failureType: "invalid-tick" }) + "\n");
  const error = new LiveEventDecoder().push(new TextDecoder().decode((await reader.read()).value))[0];
  assert.equal(error.stage, "decoding");
  assert.equal(error.failureType, "invalid-tick");
  assert.match(error.error, /price tick/);
  assert.equal((await reader.read()).done, true);
  assert.equal(worker.kill.mock.callCount(), 1);
});

test("missing Python setup and malformed IPC fail explicitly rather than reporting connected", async (t) => {
  const missing = mockWorker(t);
  const missingPending = startGrowwFeed("fake-token", instrument, new AbortController().signal);
  missing.worker.emit("error", new Error("Missing Python"));
  await assert.rejects(missingPending, { status: 503 });
  const { worker } = mockWorker(t);
  const pending = startGrowwFeed("fake-token", instrument, new AbortController().signal);
  worker.stdout.write('{"type":"tick","price":"invalid","tradeTime":1}\n');
  await assert.rejects(pending, { status: 502 });
  assert.equal(worker.kill.mock.callCount(), 1);
});

test("SSE decoding handles partial frames and heartbeats and rejects invalid/oversized events", () => {
  const decoder = new LiveEventDecoder();
  const message = JSON.stringify({ type: "tick", symbol: "RELIANCE", exchange: "NSE", segment: "CASH", price: 123, tradeTime: clock, receivedAt: new Date().toISOString() });
  assert.deepEqual(decoder.push(": keepalive\n\ndata: " + message.slice(0, 30)), []);
  assert.equal(decoder.push(message.slice(30) + "\n\n")[0].price, 123);
  assert.throws(() => decoder.push("data: {bad}\n\n"), /invalid live price/);
  assert.throws(() => new LiveEventDecoder().push("x".repeat(65_537)), /allowed size/);
});

test("startup timeout terminates its worker and a dropped connected worker sends an explicit feed error", async (t) => {
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => originalTimeout(callback, delay === 25_000 ? 5 : delay, ...args));
  const timeout = mockWorker(t);
  await assert.rejects(startGrowwFeed("fake-token", instrument, new AbortController().signal), { status: 504 });
  assert.equal(timeout.worker.kill.mock.callCount(), 1);
  const { worker } = mockWorker(t);
  const pending = startGrowwFeed("fake-token", instrument, new AbortController().signal);
  worker.stdout.write('{"type":"connected"}\n');
  const reader = (await pending).getReader();
  await reader.read();
  worker.exitCode = 1;
  worker.emit("close", 1);
  const error = new LiveEventDecoder().push(new TextDecoder().decode((await reader.read()).value))[0];
  assert.equal(error.type, "error");
  assert.equal(error.code, 502);
  assert.equal((await reader.read()).done, true);
});

test("live LTP changes only quote price and derived change; snapshots, stale ticks and other symbols are preserved", () => {
  const analysis = { symbol: "RELIANCE", exchange: "NSE", segment: "CASH", fetchedAt: new Date().toISOString(), candles: [], technical: {}, quote: { price: 100, previousClose: 100, change: 0, changePercent: 0, high: 110, volume: 1000, lastTradeTime: clock - 1000 } };
  const tick = { ...instrument, type: "tick", price: 105, tradeTime: clock, receivedAt: new Date().toISOString() };
  const live = applyLiveTick(analysis, tick);
  assert.equal(live.quote.price, 105);
  assert.equal(live.quote.changePercent, 5);
  assert.equal(live.quote.high, 110);
  assert.equal(live.quote.volume, 1000);
  assert.equal(live.candles, analysis.candles);
  assert.equal(live.technical, analysis.technical);
  assert.equal(live.fetchedAt, analysis.fetchedAt);
  assert.equal(applyLiveTick(live, { ...tick, price: 99, tradeTime: clock - 1 }), live);
  assert.equal(applyLiveTick(live, { ...tick, symbol: "TCS" }), live);
  assert.equal(applyLiveTick({ ...analysis, quote: { ...analysis.quote, previousClose: 0 } }, tick).quote.changePercent, null);
});
