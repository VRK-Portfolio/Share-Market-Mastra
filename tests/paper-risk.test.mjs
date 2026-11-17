import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fillPaperOrder, newPaperAccount, paperAccountSchema, PaperTradingError } from "../src/lib/market/paper-trading.ts";
import { placePaperOrder, processPaperOrders } from "../src/lib/market/paper-orders.ts";
import { assertPaperEntryRisk, paperRiskReport, paperSuggestedQuantity } from "../src/lib/market/paper-risk.ts";

const now = Date.parse("2026-11-17T10:30:00+05:30");
const selection = { symbol: "TESTEQ", exchange: "NSE", product: "MIS", segment: "CASH" };
const protection = { targetPrice: 110, stopPrice: 99 };
const quote = (price = 100, changes = {}) => ({ ...selection, price, tradeTime: now, ...changes });
const tick = (price = 100, changes = {}) => ({ ...quote(price), type: "tick", observedAt: now, receivedAt: new Date(now).toISOString(), ...changes });
const fill = (account, side, quantity, changes = {}, options = {}) =>
  fillPaperOrder(account, quote(100, changes), side, quantity, now, randomUUID(), "MARKET", { costAware: true, protection, ...options });
const prices = { "NSE:TESTEQ": tick() };
const riskEntry = { symbol: "TESTEQ", side: "BUY", quantity: 10, price: 100.05, stop: 99 };

test("future fills apply adverse slippage and net fees without changing legacy cost-free history", () => {
  const legacy = fillPaperOrder(newPaperAccount(), quote(), "BUY", 10, now);
  assert.equal(legacy.fills[0].price, 10_000);
  assert.equal(legacy.fills[0].fees, 0);
  assert.equal(legacy.fills[0].costModel, undefined);
  const opened = fill(newPaperAccount(), "BUY", 10);
  assert.equal(opened.fills[0].price, 10_005);
  assert.equal(opened.fills[0].fees, 101);
  assert.equal(opened.realized, -101);
  assert.equal(opened.fills[0].costModel, "ESTIMATED_V1");
  assert.equal(opened.positions[0].basis, 100_050);
  const closed = fill(opened, "SELL", 10, { price: 110 }, { protection: undefined });
  assert.equal(closed.fills[1].price, 10_994);
  assert.equal(closed.fills[1].fees, 110);
  assert.equal(closed.realized, 9679);
  assert.equal(closed.cash, closed.initialBalance + closed.realized);
  assert.ok(paperAccountSchema.safeParse(closed).success);
  assert.throws(() => fill(newPaperAccount(), "BUY", 10, {}, { protection: undefined }), /require a stop/);
});

test("protection is retained and resized on additions and partial exits, then cancelled when flat", () => {
  const opened = fill(newPaperAccount(), "BUY", 10);
  const id = opened.orders[0].id;
  const added = fill(opened, "BUY", 5, { price: 101 });
  assert.equal(added.orders.filter(order => order.kind === "BRACKET").length, 1);
  assert.equal(added.orders[0].id, id);
  assert.equal(added.orders[0].quantity, 15);
  const partial = fill(added, "SELL", 5, {}, { protection: undefined });
  assert.equal(partial.orders[0].quantity, 10);
  assert.equal(partial.orders[0].status, "PENDING");
  const closed = fill(partial, "SELL", 10, {}, { protection: undefined });
  assert.equal(closed.orders[0].status, "CANCELLED");
});

test("equity-risk sizing rejects outsized stop losses, stock concentration and incomplete valuations", () => {
  const initial = newPaperAccount();
  const valid = fill(initial, "BUY", 10);
  assert.doesNotThrow(() => assertPaperEntryRisk(initial, valid, riskEntry, prices, now));
  const wideStop = fill(initial, "BUY", 100, {}, { protection: { ...protection, stopPrice: 90 } });
  assert.throws(() => assertPaperEntryRisk(initial, wideStop, { ...riskEntry, quantity: 100, stop: 90 }, prices, now), /0.5%/);
  const concentrated = fill(initial, "BUY", 201);
  assert.throws(() => assertPaperEntryRisk(initial, concentrated, { ...riskEntry, quantity: 201 }, prices, now), /20%/);
  assert.equal(paperRiskReport(valid, {}, now).equity, null);
  assert.throws(() => assertPaperEntryRisk(valid, fill(valid, "BUY", 1), { ...riskEntry, quantity: 1 }, {}, now), /Fresh prices/);
  assert.ok(paperSuggestedQuantity(initial.initialBalance, 100.05, 99, "BUY") > 0);
  assert.equal(paperSuggestedQuantity(initial.initialBalance, 100, 101, "BUY"), 0);
});

test("pending entries consume both risk and stock limits, and reserve estimated fees", () => {
  const request = { ...selection, segment: undefined, side: "BUY", quantity: 100, kind: "LIMIT", limitPrice: 100, protection };
  delete request.segment;
  const initial = newPaperAccount();
  const one = placePaperOrder(initial, request, now, randomUUID(), { costAware: true });
  assert.equal(one.orders[0].reservedCash, 201_000);
  const two = placePaperOrder(one, request, now, randomUUID(), { costAware: true });
  assert.doesNotThrow(() => assertPaperEntryRisk(one, two, { ...riskEntry, quantity: 100, price: 100 }, {}, now));
  const excess = placePaperOrder(two, { ...request, quantity: 1 }, now, randomUUID(), { costAware: true });
  assert.throws(() => assertPaperEntryRisk(two, excess, { ...riskEntry, quantity: 1, price: 100 }, {}, now), /20%/);
  assert.throws(() => placePaperOrder(initial, { ...request, protection: undefined }, now, randomUUID(), { costAware: true }), /require a stop/);
});

test("combined open-risk cap includes separate stocks and rejects the fifth otherwise affordable entry", () => {
  let account = newPaperAccount();
  const marks = {};
  for (let index = 0; index < 5; index++) {
    const symbol = `TEST${index}`;
    marks[`NSE:${symbol}`] = tick(100, { symbol });
    const next = fill(account, "BUY", 155, { symbol }, { protection: { targetPrice: 110, stopPrice: 97.5 } });
    const entry = { ...riskEntry, symbol, quantity: 155, stop: 97.5 };
    if (index < 4) assert.doesNotThrow(() => assertPaperEntryRisk(account, next, entry, marks, now));
    else assert.throws(() => assertPaperEntryRisk(account, next, entry, marks, now), /Combined open risk/);
    account = next;
  }
});

test("risk totals that overflow safe paise arithmetic block entries instead of becoming an unavailable allowance", () => {
  const initial = newPaperAccount();
  const pending = placePaperOrder(initial, {
    symbol: "TESTEQ", exchange: "NSE", product: "MIS", side: "BUY", quantity: 1,
    kind: "LIMIT", limitPrice: 100, protection,
  }, now);
  const huge = { ...pending.orders[0], quantity: 1_000_000, limitPrice: 9_000_000_000,
    protection: { targetPrice: 10_000_000_000, stopPrice: 100 } };
  const account = { ...initial, orders: [huge, { ...huge, id: randomUUID() }] };
  const report = paperRiskReport(account, {}, now);
  assert.equal(report.openRisk, null);
  assert.ok(report.blockers.some(blocker => blocker.includes("represented safely")));
  assert.throws(() => assertPaperEntryRisk(account, account, riskEntry, {}, now), /represented safely/);
});

test("daily losses do not replenish with profits; a recorded halt survives recovery and never blocks exits", () => {
  const opened = fill(newPaperAccount(), "BUY", 200, {}, { protection: { targetPrice: 110, stopPrice: 90 } });
  const lost = fill(opened, "SELL", 200, { price: 90 }, { protection: undefined });
  assert.equal(paperRiskReport(lost, {}, now).dailyLocked, true);
  const halted = { ...opened, riskHaltDate: "2026-11-17" };
  assert.equal(paperRiskReport(halted, { "NSE:TESTEQ": tick(105) }, now).dailyLocked, true);
  assert.doesNotThrow(() => fill(halted, "SELL", 200, {}, { protection: undefined }));
  const legacy = fillPaperOrder(newPaperAccount(), quote(), "BUY", 1, now);
  assert.equal(paperRiskReport(legacy, prices, now).unprotected, 1);
  assert.doesNotThrow(() => fill(legacy, "SELL", 1, {}, { protection: undefined }));
});

test("automatic fills respect limits, revalidate entry risk and defer entries when processing exits", () => {
  const request = { symbol: "TESTEQ", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10, kind: "LIMIT", limitPrice: 100, protection };
  const pending = placePaperOrder(newPaperAccount(), request, now, randomUUID(), { costAware: true });
  const filled = processPaperOrders(pending, quote(), now, { costAware: true, approveEntry() {} });
  assert.equal(filled.fills[0].price, 10_000);
  assert.equal(filled.orders.filter(order => order.kind === "BRACKET" && order.status === "PENDING").length, 1);
  const rejected = processPaperOrders(pending, quote(), now, { costAware: true,
    approveEntry() { throw new PaperTradingError("Strict evidence unavailable."); } });
  assert.equal(rejected.orders[0].status, "REJECTED");
  assert.equal(rejected.fills.length, 0);
  assert.equal(rejected.cash, rejected.initialBalance);
  const deferred = processPaperOrders(pending, quote(), now, { costAware: true, deferEntries: true,
    approveEntry() { throw new Error("Must not check entries while prioritizing exits"); } });
  assert.equal(deferred.orders[0].status, "PENDING");
  assert.equal(deferred.fills.length, 0);
});
