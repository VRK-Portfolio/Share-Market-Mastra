import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { POST, GET } from "../src/app/api/groww/orders/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { orderPreviewSchema, orderResultSchema } from "../src/lib/groww/order-schemas.ts";
import { claimOrder, loadPreview, loadResult } from "../src/lib/groww/order-store.ts";

const originalEnv = { secret: process.env.GROWW_SESSION_SECRET };
const originalCwd = process.cwd();
const token = "fake-orders-test-token-private";
let directory;
let now = Date.now();
beforeEach(async (t) => {
  now += 3_600_001;
  t.mock.method(Date, "now", () => now);
  directory = await mkdtemp(join(tmpdir(), "groww-order-tests-"));
  process.chdir(directory);
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  t.mock.method(console, "error", () => {});
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(directory, { recursive: true });
  for (const [key, value] of [["GROWW_SESSION_SECRET", originalEnv.secret]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const header = "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment";
const csv = [
  header, "NSE,RELIANCE,NSE-RELIANCE,,EQ,,,1,0.05,CASH",
  "NSE,NIFTY,NSE-NIFTY,,IDX,,,1,0.05,CASH",
  "NSE,NIFTY99NOVFUT,NSE-NIFTY-23Nov99-FUT,NIFTY,FUT,2099-11-23,-0.01,65,0.1,FNO",
  "NSE,NIFTY99NOV25000CE,NSE-NIFTY-23Nov99-25000-CE,NIFTY,CE,2099-11-23,25000,65,0.05,FNO",
  "NSE,NIFTY00NOVFUT,NSE-NIFTY-23Nov00-FUT,NIFTY,FUT,2000-11-23,-0.01,65,0.1,FNO",
].join("\n");
const selection = { symbol: "RELIANCE", exchange: "NSE", segment: "CASH", product: "MIS", side: "BUY",
  orderType: "LIMIT", quantity: 2, limitPrice: 100.05, execution: "LIVE" };
function request(body, accessToken = token, headers = {}) {
  return new Request("http://localhost/api/groww/orders", {
    method: "POST", headers: { "Content-Type": "application/json", ...(accessToken ? { cookie: sessionCookie(accessToken).split(";")[0] } : {}), ...headers },
    body: JSON.stringify(body),
  });
}
function status(reference, accessToken = token) {
  return new Request(`http://localhost/api/groww/orders?reference=${reference}`, { headers: { cookie: sessionCookie(accessToken).split(";")[0] } });
}
function market(t, overrides = {}) {
  return t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response(csv);
    if (url.pathname === "/v1/live-data/quote") return Response.json({ status: "SUCCESS", payload: {
      last_price: 100, day_change: 0, day_change_perc: 0, ohlc: { open: 100, high: 110, low: 90, close: 100 },
      last_trade_time: overrides.stale ? now - 120_000 : now, volume: 1000,
    } });
    if (url.pathname === "/v1/user/detail") {
      if (overrides.account) return overrides.account();
      return Response.json({ status: "SUCCESS", payload: {} });
    }
    if (url.pathname === "/v1/holdings/user") return Response.json({ status: "SUCCESS", payload: { holdings: [
      { isin: "FAKEISIN", trading_symbol: "RELIANCE", quantity: overrides.holdings ?? 10, average_price: 90 },
    ] } });
    if (url.pathname === "/v1/positions/user") return Response.json({ status: "SUCCESS", payload: { positions: [
      { trading_symbol: "NIFTY99NOV25000CE", segment: "FNO", exchange: "NSE", product: "NRML",
        quantity: overrides.positions ?? 65, net_price: 100, realised_pnl: 0 },
    ] } });
    if (url.pathname === "/v1/order/create") {
      if (overrides.create) return overrides.create(options);
      const order = JSON.parse(options.body);
      return Response.json({ status: "SUCCESS", payload: { groww_order_id: "FAKEGROWWORDER", order_status: "ACKED", order_reference_id: order.order_reference_id } });
    }
    if (url.pathname.startsWith("/v1/order/status/reference/")) return Response.json({ status: "SUCCESS", payload: {
      groww_order_id: "FAKEGROWWORDER", order_status: "EXECUTED", order_reference_id: url.pathname.split("/").at(-1),
    } });
    throw new Error("Unexpected endpoint");
  });
}
async function preview(order = selection) {
  const response = await POST(request(order));
  assert.equal(response.status, 200, await response.clone().text());
  return orderPreviewSchema.parse(await response.json());
}
function creates(upstream) { return upstream.mock.calls.filter((call) => String(call.arguments[0]).includes("/v1/order/create")); }

test("preview validates actual quotes without placing orders and only confirmed instructions are sent to Groww", async (t) => {
  const upstream = market(t);
  const review = await preview();
  assert.equal(creates(upstream).length, 0);
  assert.equal(review.estimatedValue, 200.1);
  assert.ok(!JSON.stringify(review).includes(token));
  const response = await POST(request({ reference: review.reference, confirmed: true }));
  assert.equal(response.status, 200);
  const result = orderResultSchema.parse(await response.json());
  assert.equal(result.state, "BROKER_REPORTED");
  assert.equal(result.brokerStatus, "ACKED");
  const { arguments: [url, options] } = creates(upstream)[0];
  assert.equal(url, "https://api.groww.in/v1/order/create");
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  assert.equal(options.headers["X-API-VERSION"], "1.0");
  assert.deepEqual(JSON.parse(options.body), { trading_symbol: "RELIANCE", quantity: 2, validity: "DAY", exchange: "NSE",
    segment: "CASH", product: "MIS", order_type: "LIMIT", transaction_type: "BUY", order_reference_id: review.reference, price: 100.05 });
  assert.equal((await POST(request({ reference: review.reference, confirmed: true }))).status, 200);
  assert.equal(creates(upstream).length, 1);
  assert.equal((await GET(status(review.reference))).status, 200);
  assert.equal((await loadResult(review.reference)).brokerStatus, "EXECUTED");
});

test("session, origin, invalid quantities/products and missing confirmation cannot place orders", async (t) => {
  const upstream = market(t);
  assert.equal((await POST(request(selection, null))).status, 401);
  assert.equal((await POST(request(selection, token, { origin: "https://evil.example" }))).status, 403);
  for (const bad of [
    { ...selection, quantity: 0 }, { ...selection, quantity: 1.2 }, { ...selection, limitPrice: null },
    { ...selection, orderType: "MARKET" }, { ...selection, product: "NRML" }, { ...selection, quantity: 1_000_001 },
    { reference: "a".repeat(20), confirmed: false }, { ...selection, confirmed: true },
  ]) assert.equal((await POST(request(bad))).status, 400);
  const review = await preview();
  assert.equal((await POST(request({ reference: review.reference, confirmed: true }, "other-private-test-token"))).status, 404);
  assert.equal(await loadPreview("other-private-test-token", review.reference), null);
  assert.equal(creates(upstream).length, 0);
});

test("paper MARKET simulates quote fills and LIMIT remains recorded/pending, never calling the real order endpoint", async (t) => {
  const upstream = market(t);
  for (const orderType of ["MARKET", "LIMIT"]) {
    const review = await preview({ ...selection, execution: "PAPER", orderType, limitPrice: orderType === "MARKET" ? null : 100.05 });
    const result = await (await POST(request({ reference: review.reference, confirmed: true }))).json();
    assert.equal(result.execution, "PAPER");
    assert.equal(result.state, orderType === "MARKET" ? "PAPER_FILLED" : "PAPER_PENDING");
    assert.equal(result.simulatedPrice, orderType === "MARKET" ? 100 : undefined);
    assert.match(result.message, /No real order was sent/);
    assert.equal((await GET(status(review.reference))).status, 200);
  }
  assert.equal(creates(upstream).length, 0);
});

test("F&O enforces active contract, product, lot/tick and option exit-only inventory; indices cannot be traded", async (t) => {
  const upstream = market(t);
  const future = { ...selection, symbol: "NIFTY99NOVFUT", segment: "FNO", product: "NRML", quantity: 65, limitPrice: 100.1, side: "SELL" };
  assert.equal((await POST(request({ ...future, quantity: 1 }))).status, 400);
  assert.equal((await POST(request({ ...future, limitPrice: 100.05 }))).status, 400);
  assert.equal((await POST(request({ ...future, product: "CNC" }))).status, 400);
  assert.equal((await POST(request({ ...future, symbol: "NIFTY00NOVFUT" }))).status, 400);
  assert.equal((await POST(request({ ...selection, symbol: "NIFTY" }))).status, 400);
  const review = await preview(future);
  assert.equal((await POST(request({ reference: review.reference, confirmed: true }))).status, 200);
  const option = { ...future, symbol: "NIFTY99NOV25000CE", limitPrice: 100.05 };
  assert.equal((await POST(request({ ...option, quantity: 130 }))).status, 400);
  assert.equal((await POST(request({ ...option, execution: "PAPER" }))).status, 400);
  const exit = await preview(option);
  assert.equal((await POST(request({ reference: exit.reference, confirmed: true }))).status, 200);
  assert.equal(creates(upstream).length, 2);
});

test("delivery SELL requires holdings and rechecks inventory at confirmation before any mutation", async (t) => {
  const upstream = market(t);
  const review = await preview({ ...selection, product: "CNC", side: "SELL", quantity: 10 });
  market(t, { holdings: 0 });
  const response = await POST(request({ reference: review.reference, confirmed: true }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).state, "NOT_SUBMITTED");
  assert.equal(creates(upstream).length, 0);
});

test("concurrent confirmations use a durable exclusive claim; timeouts/invalid JSON have unknown outcomes and are never retried", async (t) => {
  const upstream = market(t, { create: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error(`private ${token}`); } });
  const review = await preview();
  const responses = await Promise.all([POST(request({ reference: review.reference, confirmed: true })), POST(request({ reference: review.reference, confirmed: true }))]);
  assert.ok(responses.some((response) => response.status === 502));
  for (const response of responses) {
    const body = await response.json();
    assert.equal(body.state, "UNKNOWN");
    assert.ok(!JSON.stringify(body).includes(token));
  }
  await POST(request({ reference: review.reference, confirmed: true }));
  assert.equal(creates(upstream).length, 1);
  const bad = market(t, { create: () => new Response("invalid-json") });
  const second = await preview();
  assert.equal((await POST(request({ reference: second.reference, confirmed: true }))).status, 502);
  await POST(request({ reference: second.reference, confirmed: true }));
  assert.equal(creates(bad).length, 1);
});

test("expired review, stale MARKET quotes and previously claimed intents do not send real orders", async (t) => {
  const upstream = market(t);
  const review = await preview();
  now += 120_001;
  assert.equal((await POST(request({ reference: review.reference, confirmed: true }))).status, 400);
  const claimed = await preview();
  assert.equal(await claimOrder(claimed.reference), true);
  assert.equal((await POST(request({ reference: claimed.reference, confirmed: true }))).status, 409);
  const stale = market(t, { stale: true });
  assert.equal((await POST(request({ ...selection, orderType: "MARKET", limitPrice: null }))).status, 400);
  assert.equal(creates(upstream).length + creates(stale).length, 0);
});

test("malformed/semantic failures, wrong references and unsafe broker IDs remain unknown, with no retries or secret exposure", async (t) => {
  for (const body of [
    { status: "FAILURE", error: { message: token } },
    { status: "SUCCESS", payload: { groww_order_id: "FAKE", order_status: "ACKED", order_reference_id: "b".repeat(20) } },
    { status: "SUCCESS", payload: { groww_order_id: token, order_status: "ACKED" } },
  ]) {
    const upstream = market(t, { create: () => Response.json(body) });
    const review = await preview();
    const response = await POST(request({ reference: review.reference, confirmed: true }));
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.state, "UNKNOWN");
    assert.ok(!JSON.stringify(result).includes(token));
    await POST(request({ reference: review.reference, confirmed: true }));
    assert.equal(creates(upstream).length, 1);
  }
});

test("Groww auth errors never expose credentials; only 401 clears the cookie", async (t) => {
  for (const statusCode of [401, 403]) {
    market(t, { create: () => Response.json({ status: "FAILURE", error: { message: token } }, { status: statusCode }),
      account: () => Response.json({ status: "FAILURE", error: {} }, { status: 401 }) });
    const review = await preview();
    const response = await POST(request({ reference: review.reference, confirmed: true }));
    assert.equal(response.status, statusCode);
    assert.equal(response.headers.has("set-cookie"), statusCode === 401);
    assert.ok(!(await response.text()).includes(token));
  }
});

test("order-endpoint 401 retains a token that still authenticates with Groww and surfaces safe order diagnostics without retrying", async (t) => {
  const upstream = market(t, { create: () => Response.json({
    status: "FAILURE", error: { code: "GA005", message: `Order access denied for ${token}` },
  }, { status: 401 }) });
  const review = await preview();
  const response = await POST(request({ reference: review.reference, confirmed: true }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.has("set-cookie"), false);
  const body = await response.json();
  assert.equal(body.state, "NOT_SUBMITTED");
  assert.equal(body.sessionExpired, false);
  assert.equal(body.upstreamStatus, 401);
  assert.equal(body.upstreamCode, "GA005");
  assert.equal(body.stage, "order submission");
  assert.match(body.message, /account token is valid/);
  assert.match(body.message, /Order access denied/);
  assert.ok(!JSON.stringify(body).includes(token));
  assert.equal(upstream.mock.calls.filter((call) => String(call.arguments[0]).includes("/v1/user/detail")).length, 1);
  await POST(request({ reference: review.reference, confirmed: true }));
  assert.equal(creates(upstream).length, 1);
});

test("unverifiable account authentication retains the cookie instead of claiming that the app session expired", async (t) => {
  for (const account of [
    () => Response.json({ status: "FAILURE", error: {} }, { status: 503 }),
    () => new Response("invalid json"),
    () => { throw new DOMException("Test verification timeout", "TimeoutError"); },
    () => Response.json({ status: "FAILURE", error: {} }),
  ]) {
    const upstream = market(t, { create: () => Response.json({ error: "Order authentication rejected" }, { status: 401 }), account });
    const review = await preview();
    const response = await POST(request({ reference: review.reference, confirmed: true }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.has("set-cookie"), false);
    const body = await response.json();
    assert.equal(body.sessionExpired, false);
    assert.match(body.message, /authentication could not be verified/);
    assert.equal(creates(upstream).length, 1);
  }
});

test("401 during review or order status revalidates the token and does not disconnect a valid session", async (t) => {
  const upstream = market(t);
  const reviewed = await preview();
  await POST(request({ reference: reviewed.reference, confirmed: true }));
  upstream.mock.mockImplementation(async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/live-data/quote" || url.pathname.startsWith("/v1/order/status/reference/")) {
      return Response.json({ status: "FAILURE", error: { code: "GA005", message: "Endpoint access denied." } }, { status: 401 });
    }
    if (url.pathname === "/v1/user/detail") return Response.json({ status: "SUCCESS", payload: {} });
    throw new Error("Unexpected request");
  });
  for (const response of [await POST(request(selection)), await GET(status(reviewed.reference))]) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal((await response.json()).sessionExpired, false);
  }
  assert.equal(creates(upstream).length, 1);
});
