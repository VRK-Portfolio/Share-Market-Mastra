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
import { fillPaperOrder, newPaperAccount, paperSnapshotSchema, PaperTradingError } from "../src/lib/market/paper-trading.ts";
import { paperTradeHistory } from "../src/lib/market/paper-history.ts";
import { paperSignalChecks } from "../src/lib/paper/strict-signals.ts";
import { paperRiskMarket } from "../src/lib/paper/risk-market.ts";

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
  t.mock.method(paperSignalChecks, "approve", async () => {});
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
  "NSE,TEST99NOVFUT,NSE-TEST-23Nov99-FUT,TEST,FUT,2099-11-23,,10,0.05,FNO",
  "NSE,TEST99NOV100CE,NSE-TEST-23Nov99-100-CE,TEST,CE,2099-11-23,100,10,0.05,FNO",
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
      assert.equal(url.searchParams.get("segment"), settings.segment ?? "CASH");
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
  const side = changes.side ?? "BUY";
  const product = changes.product ?? "MIS";
  const existing = snapshot.account.positions.find(position => position.symbol === (changes.symbol ?? "ADANIPORTS") &&
    position.product === product && position.exchange === (changes.exchange ?? "NSE"));
  const closing = existing && Math.sign(existing.quantity) !== (side === "BUY" ? 1 : -1);
  return {
    type: "TRADE", accountId: snapshot.accountId, expectedRevision: snapshot.revision,
    operationId: randomUUID(), symbol: "ADANIPORTS", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10,
    ...(!closing ? { protection: side === "BUY" ? { targetPrice: 200, stopPrice: 99 } : { targetPrice: 50, stopPrice: 110 } } : {}),
    ...changes,
  };
}
async function load(accessToken = token) {
  const response = await GET(request(null, accessToken));
  assert.equal(response.status, 200);
  return paperSnapshotSchema.parse(await response.json());
}

test("market entries allow optional protection and exceeded risk guidelines without fetching strategy or account-risk approval", async t => {
  market(t);
  const approval = t.mock.method(paperSignalChecks, "approve", async () => { throw new PaperTradingError("Strict depth is unavailable."); });
  const risk = t.mock.method(paperRiskMarket, "load", async () => { throw new Error("Unrelated account marks are unavailable."); });
  let state = await load();
  for (const changes of [{ protection: undefined }, { quantity: 300 },
    { quantity: 100, protection: { targetPrice: 200, stopPrice: 90 } }, { quantity: 10 }]) {
    const response = await POST(request(trade(state, changes)));
    assert.equal(response.status, 200);
    state = paperSnapshotSchema.parse(await response.json());
    if (!changes.protection && changes.quantity === undefined) assert.equal(state.account.orders.length, 0);
  }
  assert.equal(state.account.fills.length, 4);
  assert.equal(approval.mock.callCount(), 0);
  assert.equal(risk.mock.callCount(), 0);
  assert.equal((await POST(request(trade(state, { approved: true })))).status, 400);
});

test("unprotected LIMIT and GTT entries fill without strategy approval while preserving fees and reservations", async t => {
  market(t);
  const approval = t.mock.method(paperSignalChecks, "approve", async () => { throw new PaperTradingError("Strict entry no longer agrees."); });
  const risk = t.mock.method(paperRiskMarket, "load", async () => { throw new Error("Account marks unavailable"); });
  let state = await load();
  for (const kind of ["LIMIT", "GTT"]) {
    const orderId = randomUUID();
    const placedResponse = await POST(request({
      type: "PLACE", accountId: state.accountId, expectedRevision: state.revision, operationId: orderId,
      order: { symbol: "ADANIPORTS", exchange: "NSE", product: kind === "GTT" ? "CNC" : "MIS",
        side: "BUY", quantity: 10, kind, limitPrice: 100,
        ...(kind === "GTT" ? { triggerPrice: 100, triggerDirection: "UP" } : {}) },
    }));
    assert.equal(placedResponse.status, 200);
    const placed = await placedResponse.json();
    assert.ok(placed.account.orders.at(-1).reservedCash > 0);
    const processed = await POST(request({
      type: "PROCESS", accountId: placed.accountId, expectedRevision: placed.revision, operationId: randomUUID(),
      symbol: "ADANIPORTS", exchange: "NSE", quoteProof: signExecutionQuote(token, {
        symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 100, tradeTime: now,
      }),
    }));
    assert.equal(processed.status, 200);
    state = paperSnapshotSchema.parse(await processed.json());
    const filledOrder = state.account.orders.find(order => order.id === orderId);
    assert.equal(filledOrder.status, "FILLED");
    assert.equal(filledOrder.reservedCash, 0);
    assert.ok(state.account.fills.at(-1).fees > 0);
    assert.equal(state.account.orders.filter(order => order.kind === "BRACKET").length, 0);
  }
  assert.equal(state.account.fills.length, 2);
  assert.equal(approval.mock.callCount(), 0);
  assert.equal(risk.mock.callCount(), 0);
});

test("protective exits run before unrelated entry approval and never depend on entry strategy availability", async t => {
  const settings = { price: 100 };
  market(t, settings);
  const initial = await load();
  const entered = await (await POST(request(trade(initial, { protection: { targetPrice: 110, stopPrice: 99 } })))).json();
  const queued = await (await POST(request({
    type: "PLACE", accountId: entered.accountId, expectedRevision: entered.revision, operationId: randomUUID(),
    order: { symbol: "ADANIPORTS", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10, kind: "LIMIT",
      limitPrice: 120, protection: { targetPrice: 130, stopPrice: 119 } },
  }))).json();
  const approval = t.mock.method(paperSignalChecks, "approve", async () => { throw new Error("Must not delay a protective exit"); });
  settings.price = 110;
  const response = await POST(request({
    type: "PROCESS", accountId: queued.accountId, expectedRevision: queued.revision, operationId: randomUUID(),
    symbol: "ADANIPORTS", exchange: "NSE", quoteProof: signExecutionQuote(token, {
      symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 110, tradeTime: now,
    }),
  }));
  assert.equal(response.status, 200);
  const next = await response.json();
  assert.equal(next.account.positions.length, 0);
  assert.equal(next.account.fills.at(-1).reason, "TARGET");
  assert.equal(next.account.orders.find(order => order.kind === "LIMIT").status, "PENDING");
  assert.equal(approval.mock.callCount(), 0);
});

test("daily loss and legacy halt dates do not block entries, exits or confirmed resets", async t => {
  const settings = { price: 98 };
  market(t, settings);
  const initial = await load();
  documents.get(initial.accountId).account = fillPaperOrder(initial.account, {
    symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", product: "MIS", price: 100, tradeTime: now,
  }, "BUY", 1000, now, randomUUID(), "MARKET", { protection: { targetPrice: 200, stopPrice: 1 } });
  documents.get(initial.accountId).account.riskHaltDate = "2026-11-17";
  const response = await POST(request({
    type: "PROCESS", accountId: initial.accountId, expectedRevision: 0, operationId: randomUUID(),
    symbol: "ADANIPORTS", exchange: "NSE", quoteProof: signExecutionQuote(token, {
      symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 98, tradeTime: now,
    }),
  }));
  assert.equal(response.status, 200);
  const observed = await response.json();
  const entered = await POST(request(trade(observed, { quantity: 1, protection: undefined })));
  assert.equal(entered.status, 200);
  const increased = await entered.json();
  assert.equal(increased.account.positions[0].quantity, 1001);
  const exit = await POST(request(trade(increased, { side: "SELL", quantity: 1001 })));
  assert.equal(exit.status, 200);
  const closed = await exit.json();
  assert.equal(closed.account.positions.length, 0);
  assert.equal((await POST(request({
    type: "RESET", confirmed: true, accountId: closed.accountId, expectedRevision: closed.revision, operationId: randomUUID(),
  }))).status, 200);
  assert.deepEqual((await load()).account, newPaperAccount());
});

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
  assert.equal(filled.account.cash, 9_972_617);
  assert.equal(filled.account.fills[0].costModel, "INDIA_FLAT20_V2");
  assert.equal(filled.account.fills[0].charges.brokerage, 2000);
  assert.equal(filled.account.fills[0].charges.total, filled.account.fills[0].fees);
  assert.equal(filled.account.positions[0].margin, 25_014);
  assert.equal(paperTradeHistory(filled.account).successRate, null);
  assert.equal(filled.account.fills[0].price, 12_507);
  assert.equal(filled.account.fills[0].id, buy.operationId);
  settings.price = 130;
  const exit = await POST(request(trade(filled, { side: "SELL" })));
  assert.equal(exit.status, 200);
  const closed = await load();
  assert.deepEqual(closed.account.positions, []);
  assert.equal(closed.account.realized, 126);
  assert.equal(closed.account.cash, 10_000_126);
  assert.equal(closed.revision, 2);
  const history = paperTradeHistory(closed.account);
  assert.equal(history.successRate, 100);
  assert.equal(history.completed[0].quantity, 10);
  assert.equal(history.completed[0].entryValue, 125_070);
  assert.equal(history.completed[0].exitValue, 129_930);
  assert.equal(history.rows[1].entryPrice, 12_507);
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
  assert.equal(placed.account.cash, 9_977_633);
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
  assert.equal(filled.account.cash, 9_977_823);
  assert.equal((await POST(request(command))).status, 200);
});

test("cancellation releases only the owner's reservation, and market fills can attach OCO protection", async (t) => {
  market(t);
  const initial = await load();
  const placed = await (await POST(request({
    type: "PLACE", accountId: initial.accountId, expectedRevision: 0, operationId: randomUUID(),
    order: { symbol: "ADANIPORTS", exchange: "NSE", product: "CNC", side: "BUY", quantity: 10, kind: "GTT",
      limitPrice: 100, triggerPrice: 105, triggerDirection: "UP", protection: { targetPrice: 110, stopPrice: 90 } },
  }))).json();
  assert.equal((await POST(request({
    type: "CANCEL", accountId: placed.accountId, expectedRevision: placed.revision, operationId: randomUUID(),
    orderId: placed.account.orders[0].id,
  }))).status, 200);
  const cancelled = await load();
  assert.equal(cancelled.account.cash, 10_000_000);
  assert.equal(cancelled.account.fills.length, 0);
  const entered = await POST(request(trade(cancelled, { protection: { targetPrice: 110, stopPrice: 90 } })));
  assert.equal(entered.status, 200);
  const held = await entered.json();
  assert.equal(held.account.orders.filter((item) => item.kind === "BRACKET" && item.status === "PENDING").length, 1);
});
test("duplicate operations are idempotent and concurrent competing revisions cannot double-spend", async (t) => {
  market(t);
  const initial = await load();
  const command = trade(initial, { quantity: 100 });
  const duplicate = await Promise.all([POST(request(command)), POST(request(command))]);
  assert.deepEqual(duplicate.map((response) => response.status), [200, 200]);
  const filled = await load();
  assert.equal(filled.account.cash, 9_797_472);
  assert.equal(filled.account.fills.length, 1);
  const reused = await POST(request({ ...command, quantity: 1 }));
  assert.equal(reused.status, 409);
  const reset = { type: "RESET", confirmed: true, accountId: filled.accountId, expectedRevision: 1, operationId: randomUUID() };
  now = Date.parse("2026-11-17T16:00:00+05:30");
  assert.equal((await POST(request(reset))).status, 200);
  const clean = await load();
  now = Date.parse("2026-11-18T10:30:00+05:30");
  const race = await Promise.all([POST(request(trade(clean, { quantity: 100 }))), POST(request(trade(clean, { quantity: 100 })))]);
  assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await load()).account.fills.length, 1);
});

test("reset is per-user and retains operation receipts; old revision cannot resurrect reset balances or trades", async (t) => {
  market(t);
  const initial = await load();
  const command = trade(initial);
  const filled = await (await POST(request(command))).json();
  const reset = { type: "RESET", confirmed: true, accountId: filled.accountId, expectedRevision: filled.revision, operationId: randomUUID() };
  now = Date.parse("2026-11-17T16:00:00+05:30");
  assert.equal((await POST(request(reset))).status, 200);
  assert.equal((await POST(request(reset))).status, 200);
  assert.equal((await POST(request(command))).status, 200);
  const final = await load();
  assert.equal(final.revision, 2);
  assert.deepEqual(final.account, newPaperAccount());
  assert.equal((await POST(request(trade(initial)))).status, 409);
});

test("missing/tampered authentication, cross-origin requests, client prices, balances and invalid products are rejected before writes", async (t) => {
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

test("F&O paper API uses verified contract metadata, full funding and shared cash without broker submission", async t => {
  const upstream = market(t, { segment: "FNO" });
  const initial = await load();
  const command = trade(initial, { segment: "FNO", symbol: "TEST99NOVFUT", product: "NRML",
    quantity: 10, protection: undefined });
  const response = await POST(request(command));
  assert.equal(response.status, 200);
  const opened = await response.json();
  const position = opened.account.positions[0];
  assert.equal(position.instrument.lotSize, 10);
  assert.equal(position.instrument.instrumentType, "FUT");
  assert.equal(position.margin, 100050);
  assert.equal(position.margin, position.basis);
  assert.equal(opened.account.cash, 9_897_586);
  assert.equal(opened.account.orders.length, 0);
  assert.equal((await POST(request(command))).status, 200);
  assert.equal((await load()).account.fills.length, 1);
  const close = trade(opened, { segment: "FNO", symbol: "TEST99NOVFUT", product: "NRML", side: "SELL", quantity: 10 });
  const closed = await POST(request(close));
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).account.positions.length, 0);
  assert.ok(upstream.mock.calls.filter(call => new URL(call.arguments[0]).pathname.includes("quote"))
    .every(call => new URL(call.arguments[0]).searchParams.get("segment") === "FNO"));
});

test("F&O rejects fractional lots, wrong ticks, option writing, edited metadata and cross-segment signed prices atomically", async t => {
  market(t, { segment: "FNO" });
  const initial = await load();
  const base = { segment: "FNO", symbol: "TEST99NOV100CE", product: "MIS", quantity: 10,
    protection: { targetPrice: 110, stopPrice: 99 } };
  for (const changes of [{ quantity: 1 }, { side: "SELL" }, { protection: { targetPrice: 110.01, stopPrice: 99 } },
    { instrument: { lotSize: 1 } }, { quoteProof: signExecutionQuote(token, {
      symbol: base.symbol, exchange: "NSE", segment: "CASH", price: 100, tradeTime: now,
    }) }]) {
    assert.equal((await POST(request(trade(initial, { ...base, ...changes })))).status, 400);
  }
  assert.equal((await load()).revision, 0);
  const response = await POST(request(trade(initial, { ...base, quoteProof: signExecutionQuote(token, {
    symbol: base.symbol, exchange: "NSE", segment: "FNO", price: 100, tradeTime: now,
  }) })));
  assert.equal(response.status, 200);
  const opened = await response.json();
  const sell = await POST(request(trade(opened, { ...base, side: "SELL", protection: undefined })));
  assert.equal(sell.status, 200);
  assert.equal((await sell.json()).account.positions.length, 0);
});

test("F&O pending limits and target exits process signed contract ticks against the same persisted account", async t => {
  market(t, { segment: "FNO" });
  let state = await load();
  const identity = { symbol: "TEST99NOV100CE", exchange: "NSE", segment: "FNO" };
  const placed = await POST(request({ type: "PLACE", accountId: state.accountId, expectedRevision: state.revision,
    operationId: randomUUID(), order: { ...identity, product: "NRML", side: "BUY", quantity: 10,
      kind: "LIMIT", limitPrice: 100, protection: { targetPrice: 110, stopPrice: 99 } } }));
  assert.equal(placed.status, 200);
  state = await placed.json();
  assert.equal(state.account.orders[0].reservedCash, 102405);
  for (const price of [100, 110]) {
    const processed = await POST(request({ type: "PROCESS", ...identity, accountId: state.accountId,
      expectedRevision: state.revision, operationId: randomUUID(), quoteProof: signExecutionQuote(token, {
        ...identity, price, tradeTime: now,
      }) }));
    assert.equal(processed.status, 200);
    state = await processed.json();
  }
  assert.equal(state.account.positions.length, 0);
  assert.equal(state.account.fills[0].reason, "LIMIT");
  assert.equal(state.account.fills[0].price, 10000);
  assert.equal(state.account.fills[1].reason, "TARGET");
  assert.equal(state.account.fills[1].segment, "FNO");
  assert.equal(state.account.cash, state.account.initialBalance + state.account.realized);
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
  assert.equal(filled.account.fills[0].price, 12_507);
  assert.equal(filled.account.fills[0].quoteTime, now);
  assert.equal(filled.account.cash, 9_972_617);
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
  }, "BUY", 10, now, randomUUID(), "MARKET", { protection: { targetPrice: 200, stopPrice: 90 } });
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
  assert.equal(added.account.cash, 9_877_623);
  assert.equal(added.account.positions[0].basis, 200_050);
  assert.equal(added.account.positions[0].margin, 120_010);
  assert.equal(documents.get(initial.accountId).account.version, 2);
  settings.price = 110;
  const closed = await (await POST(request(trade(added, { side: "SELL", quantity: 20 })))).json();
  assert.equal(closed.account.cash, 10_014_995);
  assert.equal(closed.account.realized, 14_995);
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
  const cmd = trade({ accountId: owner, revision: 0, account: loaded.account });
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
