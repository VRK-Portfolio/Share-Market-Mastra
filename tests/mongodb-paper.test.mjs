import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { Collection, MongoClient, MongoServerError } from "mongodb";
import { GET, POST } from "../src/app/api/groww/paper/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";
import { closePaperDatabase } from "../src/lib/paper/database.ts";
import { paperAccountIdentity } from "../src/lib/paper/identity.ts";
import { commandAlreadyApplied, paperStore } from "../src/lib/paper/store.ts";
import { signExecutionQuote } from "../src/lib/paper/execution-quote.ts";
import { fillPaperOrder, newPaperAccount, paperSnapshotSchema } from "../src/lib/market/paper-trading.ts";
import { paperTradeHistory } from "../src/lib/market/paper-history.ts";

const originalEnv = Object.fromEntries(["MONGODB_URI", "MONGODB_DB", "GROWW_SESSION_SECRET"].map((key) => [key, process.env[key]]));
let documents;
let token;
let now;
beforeEach((t) => {
  documents = new Map();
  token = randomUUID();
  now = Date.parse("2026-11-17T11:30:00+05:30");
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DB = "stock_terminal_paper_test";
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "error", () => {});
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(Collection.prototype, "updateOne", async function (filter, update) {
    if (!documents.has(filter._id)) documents.set(filter._id, structuredClone({ _id: filter._id, ...update.$setOnInsert }));
    return { acknowledged: true, matchedCount: 1 };
  });
  t.mock.method(Collection.prototype, "findOne", async function (filter) {
    return structuredClone(documents.get(filter._id) ?? null);
  });
  t.mock.method(Collection.prototype, "replaceOne", async function (filter, next) {
    if (documents.get(filter._id)?.revision !== filter.revision) return { acknowledged: true, matchedCount: 0 };
    documents.set(filter._id, structuredClone(next));
    return { acknowledged: true, matchedCount: 1 };
  });
});
afterEach(async () => {
  await closePaperDatabase();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function request(command, accessToken = token, headers = {}) {
  return new Request("http://localhost/api/groww/paper", {
    method: command ? "POST" : "GET",
    headers: { ...(accessToken ? { cookie: sessionCookie(accessToken).split(";")[0] } : {}), ...headers },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
}
const hashOwner = (id) => createHash("sha256").update(`groww-paper:v1:${id}`).digest("hex");
const csv = [
  "exchange,trading_symbol,groww_symbol,underlying_symbol,instrument_type,expiry_date,strike_price,lot_size,tick_size,segment",
  "NSE,ADANIPORTS,NSE-ADANIPORTS,,EQ,,,1,0.01,CASH",
].join("\n");
function market(t, settings = {}) {
  return t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "growwapi-assets.groww.in") return new Response(csv);
    if (url.pathname === "/v1/user/detail") {
      if (settings.authStatus) return Response.json({ error: "Test provider denial" }, { status: settings.authStatus });
      return Response.json({ status: "SUCCESS", payload: settings.missingOwner ? {} : {
        vendor_user_id: settings.owner ?? "stable-test-user",
      } });
    }
    if (url.pathname === "/v1/live-data/quote") {
      assert.equal(init.method, "GET");
      assert.equal(url.searchParams.get("segment"), "CASH");
      return Response.json({ status: "SUCCESS", payload: {
        last_price: settings.price ?? 100, day_change: 0, day_change_perc: 0,
        ohlc: { open: 100, high: 200, low: 90, close: 100 }, volume: 1000,
        last_trade_time: settings.stale ? now - 60_001 : now,
      } });
    }
    throw new Error("No broker order or other upstream endpoint is allowed.");
  });
}
function trade(snapshot, changes = {}) {
  return {
    type: "TRADE", accountId: snapshot.accountId, expectedRevision: snapshot.revision,
    operationId: randomUUID(), symbol: "ADANIPORTS", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10,
    ...changes,
  };
}
async function load(accessToken = token) {
  const response = await GET(request(null, accessToken));
  assert.equal(response.status, 200);
  return paperSnapshotSchema.parse(await response.json());
}

test("database accounts are private per verified stable user, survive new tokens and never derive ownership from client parameters", async (t) => {
  const settings = { owner: "owner-a" };
  market(t, settings);
  const a = await load();
  assert.equal(a.accountId, hashOwner("owner-a"));
  const renewed = await load(randomUUID());
  assert.equal(renewed.accountId, a.accountId);
  const cmd = trade(a);
  assert.equal((await POST(request(cmd))).status, 200);
  settings.owner = "owner-b";
  const otherToken = randomUUID();
  const b = await load(otherToken);
  assert.notEqual(a.accountId, b.accountId);
  assert.equal(b.account.fills.length, 0);
  assert.equal((await POST(request({ ...cmd, operationId: randomUUID() }, otherToken))).status, 409);
  assert.equal((await load()).account.fills.length, 1);
  assert.equal(documents.size, 2);
});

test("server fetches execution prices and persists fills, basis and realized cash atomically", async (t) => {
  const settings = { price: 125 };
  const upstream = market(t, settings);
  const initial = await load();
  const buy = trade(initial);
  const response = await POST(request(buy));
  assert.equal(response.status, 200);
  const filled = await response.json();
  assert.equal(filled.account.cash, 9_975_000);
  assert.equal(filled.account.positions[0].margin, 25_000);
  assert.equal(paperTradeHistory(filled.account).successRate, null);
  assert.equal(filled.account.fills[0].price, 12_500);
  assert.equal(filled.account.fills[0].id, buy.operationId);
  settings.price = 130;
  const exit = await POST(request(trade(filled, { side: "SELL" })));
  assert.equal(exit.status, 200);
  const closed = await load();
  assert.deepEqual(closed.account.positions, []);
  assert.equal(closed.account.realized, 5000);
  assert.equal(closed.account.cash, 10_005_000);
  assert.equal(closed.revision, 2);
  const history = paperTradeHistory(closed.account);
  assert.equal(history.successRate, 100);
  assert.equal(history.completed[0].quantity, 10);
  assert.equal(history.completed[0].entryValue, 125_000);
  assert.equal(history.completed[0].exitValue, 130_000);
  assert.equal(history.rows[1].entryPrice, 12_500);
  assert.ok(upstream.mock.calls.every((call) => !String(call.arguments[0]).includes("/order/")));
});

test("pending-order reservations and signed automatic fills are atomic and idempotent across clients", async (t) => {
  market(t);
  const initial = await load();
  const placedResponse = await POST(request({
    type: "PLACE", accountId: initial.accountId, expectedRevision: initial.revision, operationId: randomUUID(),
    order: { symbol: "ADANIPORTS", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10, kind: "LIMIT",
      limitPrice: 100, protection: { targetPrice: 110, stopPrice: 90 } },
  }));
  assert.equal(placedResponse.status, 200);
  const placed = await placedResponse.json();
  assert.equal(placed.account.cash, 9_980_000);
  const command = {
    type: "PROCESS", accountId: initial.accountId, expectedRevision: placed.revision, operationId: randomUUID(),
    symbol: "ADANIPORTS", exchange: "NSE", quoteProof: signExecutionQuote(token, {
      symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 99, tradeTime: now,
    }),
  };
  const results = await Promise.all([POST(request(command)), POST(request({ ...command, operationId: randomUUID() }))]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  const filled = await load();
  assert.equal(filled.account.fills.length, 1);
  assert.equal(filled.account.orders.filter((item) => item.kind === "BRACKET").length, 1);
  assert.equal(filled.account.cash, 9_980_200);
  assert.equal((await POST(request(command))).status, 200);
});

test("cancellation releases only the owner's reservation, and market fills can attach OCO protection", async (t) => {
  market(t);
  const initial = await load();
  const placed = await (await POST(request({
    type: "PLACE", accountId: initial.accountId, expectedRevision: 0, operationId: randomUUID(),
    order: { symbol: "ADANIPORTS", exchange: "NSE", product: "CNC", side: "BUY", quantity: 10, kind: "GTT",
      limitPrice: 100, triggerPrice: 105, triggerDirection: "UP" },
  }))).json();
  assert.equal((await POST(request({
    type: "CANCEL", accountId: placed.accountId, expectedRevision: placed.revision, operationId: randomUUID(),
    orderId: placed.account.orders[0].id,
  }))).status, 200);
  const cancelled = await load();
  assert.equal(cancelled.account.cash, 10_000_000);
  const entered = await POST(request(trade(cancelled, { protection: { targetPrice: 110, stopPrice: 90 } })));
  assert.equal(entered.status, 200);
  const held = await entered.json();
  assert.equal(held.account.orders.filter((item) => item.kind === "BRACKET" && item.status === "PENDING").length, 1);
});
test("duplicate operations are idempotent and concurrent competing revisions cannot double-spend", async (t) => {
  market(t);
  const initial = await load();
  const command = trade(initial, { quantity: 5000 });
  const duplicate = await Promise.all([POST(request(command)), POST(request(command))]);
  assert.deepEqual(duplicate.map((response) => response.status), [200, 200]);
  const filled = await load();
  assert.equal(filled.account.cash, 0);
  assert.equal(filled.account.fills.length, 1);
  const reused = await POST(request({ ...command, quantity: 1 }));
  assert.equal(reused.status, 409);
  const reset = { type: "RESET", confirmed: true, accountId: filled.accountId, expectedRevision: 1, operationId: randomUUID() };
  assert.equal((await POST(request(reset))).status, 200);
  const clean = await load();
  const race = await Promise.all([POST(request(trade(clean, { quantity: 5000 }))), POST(request(trade(clean, { quantity: 5000 })))]);
  assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await load()).account.fills.length, 1);
});

test("reset is per-user and retains operation receipts; old revision cannot resurrect reset balances or trades", async (t) => {
  market(t);
  const initial = await load();
  const command = trade(initial);
  const filled = await (await POST(request(command))).json();
  const reset = { type: "RESET", confirmed: true, accountId: filled.accountId, expectedRevision: filled.revision, operationId: randomUUID() };
  assert.equal((await POST(request(reset))).status, 200);
  assert.equal((await POST(request(reset))).status, 200);
  assert.equal((await POST(request(command))).status, 200);
  const final = await load();
  assert.equal(final.revision, 2);
  assert.deepEqual(final.account, newPaperAccount());
  assert.equal((await POST(request(trade(initial)))).status, 409);
});

test("missing/tampered authentication, cross-origin requests, client prices, balances and FNO are rejected before writes", async (t) => {
  const upstream = market(t);
  assert.equal((await GET(request(null, null))).status, 401);
  assert.equal((await POST(request({ type: "RESET" }, token, { origin: "https://other.example" }))).status, 403);
  const initial = await load();
  for (const extra of [{ price: 1 }, { margin: 1 }, { leverage: 100 }, { account: newPaperAccount() }, { segment: "FNO" }, { quantity: 0 }, { product: "NRML" }]) {
    assert.equal((await POST(request(trade(initial, extra)))).status, 400);
  }
  assert.equal((await load()).revision, 0);
  assert.equal(upstream.mock.calls.filter((call) => new URL(call.arguments[0]).pathname === "/v1/live-data/quote").length, 0);
});

test("stale server quotes and insufficient funds cannot mutate MongoDB balances", async (t) => {
  const settings = { stale: true };
  market(t, settings);
  const initial = await load();
  assert.equal((await POST(request(trade(initial)))).status, 400);
  settings.stale = false;
  assert.equal((await POST(request(trade(initial, { quantity: 5001 })))).status, 400);
  assert.equal((await POST(request(trade(initial, { symbol: "UNKNOWN" })))).status, 400);
  assert.equal((await load()).revision, 0);
});

test("a server-signed live price fills despite stale REST data and remains idempotent after proof expiry", async (t) => {
  const upstream = market(t, { stale: true, price: 99 });
  const initial = await load();
  const quoteProof = signExecutionQuote(token, {
    symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 125, tradeTime: now,
  });
  const command = trade(initial, { quoteProof });
  const response = await POST(request(command));
  assert.equal(response.status, 200);
  const filled = await response.json();
  assert.equal(filled.account.fills[0].price, 12_500);
  assert.equal(filled.account.fills[0].quoteTime, now);
  assert.equal(filled.account.cash, 9_975_000);
  assert.equal(upstream.mock.calls.filter((call) => new URL(call.arguments[0]).pathname === "/v1/live-data/quote").length, 0);
  now += 60_001;
  assert.equal((await POST(request(command))).status, 200);
  assert.equal((await load()).account.fills.length, 1);
});

test("stored version-1 positions retain collateral and cash until new leveraged mutations persist version 2", async (t) => {
  const settings = { price: 100 };
  market(t, settings);
  const initial = await load();
  const legacy = fillPaperOrder(initial.account, {
    symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", product: "MIS", price: 100, tradeTime: now,
  }, "BUY", 10, now);
  legacy.version = 1;
  legacy.cash = 9_900_000;
  delete legacy.positions[0].margin;
  documents.get(initial.accountId).account = legacy;
  const loaded = await load();
  assert.equal(loaded.account.cash, 9_900_000);
  assert.equal(loaded.account.positions[0].margin, 100_000);
  const response = await POST(request(trade(loaded)));
  assert.equal(response.status, 200);
  const added = await response.json();
  assert.equal(added.account.cash, 9_880_000);
  assert.equal(added.account.positions[0].basis, 200_000);
  assert.equal(added.account.positions[0].margin, 120_000);
  assert.equal(documents.get(initial.accountId).account.version, 2);
  settings.price = 110;
  const closed = await (await POST(request(trade(added, { side: "SELL", quantity: 20 })))).json();
  assert.equal(closed.account.cash, 10_020_000);
  assert.equal(closed.account.realized, 20_000);
});

test("live proofs reject edited prices, another token/instrument, stale or future trades without modifying the account", async (t) => {
  market(t);
  const initial = await load();
  const quote = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 125, tradeTime: now };
  const valid = signExecutionQuote(token, quote);
  const [payload, signature] = valid.split(".");
  const edited = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), price: 1 };
  const proofs = [
    `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`,
    signExecutionQuote("another-broker-token", quote),
    signExecutionQuote(token, { ...quote, symbol: "RELIANCE" }),
    signExecutionQuote(token, { ...quote, exchange: "BSE" }),
    signExecutionQuote(token, { ...quote, tradeTime: now - 60_001 }),
    signExecutionQuote(token, { ...quote, tradeTime: now + 5001 }),
    "malformed-proof",
  ];
  for (const quoteProof of proofs) {
    assert.equal((await POST(request(trade(initial, { quoteProof })))).status, 400);
  }
  assert.equal((await load()).revision, 0);
  assert.equal((await load()).account.fills.length, 0);
});

test("proof issuance cannot extend trade freshness and the 60-second boundary is enforced", async (t) => {
  market(t);
  let initial = await load();
  const quote = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 125, tradeTime: now };
  const quoteProof = signExecutionQuote(token, quote);
  now += 60_000;
  assert.equal((await POST(request(trade(initial, { quoteProof })))).status, 200);
  initial = await load();
  now++;
  const expired = await POST(request(trade(initial, { quoteProof })));
  assert.equal(expired.status, 400);
  assert.match((await expired.json()).error, /expired/);
  const reissued = signExecutionQuote(token, quote);
  assert.equal((await POST(request(trade(initial, { quoteProof: reissued })))).status, 400);
  assert.equal((await load()).account.fills.length, 1);
});

test("unverifiable identities and database outages fail explicitly without creating fallback browser/shared accounts", async (t) => {
  const settings = { missingOwner: true };
  market(t, settings);
  const invalid = await GET(request());
  assert.equal(invalid.status, 503);
  assert.equal(documents.size, 0);
  const dbFailure = t.mock.method(paperStore, "load", async () => { throw new Error("Private connection diagnostic"); });
  settings.missingOwner = false;
  const unavailable = await GET(request());
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("Private connection diagnostic"));
  assert.equal(dbFailure.mock.callCount(), 1);
  assert.equal(documents.size, 0);
});

test("store compare-and-swap filters, persisted data validation and duplicate-create race handling use isolated user IDs", async (t) => {
  const owner = hashOwner("store-owner");
  const loaded = await paperStore.load(owner);
  assert.equal(loaded.revision, 0);
  const cmd = trade({ accountId: owner, revision: 0 });
  const account = fillPaperOrder(loaded.account, {
    symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", product: "MIS", price: 100, tradeTime: now,
  }, "BUY", 10, now, cmd.operationId);
  const next = await paperStore.save(loaded, cmd, account);
  assert.equal(next.revision, 1);
  assert.equal(commandAlreadyApplied(next, cmd), true);
  await assert.rejects(() => paperStore.save(loaded, { ...cmd, operationId: randomUUID() }, account), /another client/);
  const update = t.mock.method(Collection.prototype, "updateOne", async () => { throw new MongoServerError({ code: 11000, message: "duplicate" }); });
  assert.equal((await paperStore.load(owner)).revision, 1);
  update.mock.restore();
  documents.set(owner, { ...next, account: { ...next.account, cash: 0 } });
  await assert.rejects(() => paperStore.load(owner));
});

test("a Groww auth denial remains 401 and never returns another user's data or connection diagnostics", async (t) => {
  market(t, { authStatus: 401 });
  const response = await GET(request());
  assert.equal(response.status, 401);
  assert.equal(documents.size, 0);
  assert.ok(!(await response.text()).includes(token));
});

test("verified user identity cache expires, does not depend on token renewal, and never accepts a missing provider identifier", async (t) => {
  const settings = { owner: "stable-owner" };
  const upstream = market(t, settings);
  const one = randomUUID();
  assert.equal(await paperAccountIdentity(one, AbortSignal.timeout(1000)), hashOwner(settings.owner));
  await paperAccountIdentity(one, AbortSignal.timeout(1000));
  assert.equal(upstream.mock.callCount(), 1);
  await paperAccountIdentity(randomUUID(), AbortSignal.timeout(1000));
  assert.equal(upstream.mock.callCount(), 2);
  now += 30_001;
  await paperAccountIdentity(one, AbortSignal.timeout(1000));
  assert.equal(upstream.mock.callCount(), 3);
});
