import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fillPaperOrder, newPaperAccount, paperAccountSchema, PaperTradingError } from "../src/lib/market/paper-trading.ts";
import { placePaperOrder, processPaperOrders } from "../src/lib/market/paper-orders.ts";
import { assertPaperEntryRisk, paperExitSuggestion, paperRiskReport, paperSuggestedQuantity } from "../src/lib/market/paper-risk.ts";
import { paperCharges, paperExecutionPrice, paperPlannedRisk } from "../src/lib/market/paper-costs.ts";

const now = Date.parse("2026-11-17T10:30:00+05:30");
const selection = { symbol: "TESTEQ", exchange: "NSE", product: "MIS", segment: "CASH" };
const protection = { targetPrice: 110, stopPrice: 99 };
const quote = (price = 100, changes = {}) => ({ ...selection, price, tradeTime: now, ...changes });
const tick = (price = 100, changes = {}) => ({ ...quote(price), type: "tick", observedAt: now, receivedAt: new Date(now).toISOString(), ...changes });
const fill = (account, side, quantity, changes = {}, options = {}) =>
  fillPaperOrder(account, quote(100, changes), side, quantity, now, randomUUID(), "MARKET", { costAware: true, protection, ...options });
const prices = { "NSE:TESTEQ": tick() };
const riskEntry = { ...selection, side: "BUY", quantity: 10, price: 100.05, stop: 99 };

test("exit suggestions follow long/short target and stop boundaries without changing positions or orders", () => {
  for (const side of ["BUY", "SELL"]) {
    const account = fill(newPaperAccount(), side, 10, {}, {
      protection: side === "BUY" ? { targetPrice: 110, stopPrice: 90 } : { targetPrice: 90, stopPrice: 110 },
    });
    const snapshot = structuredClone(account);
    for (const price of [89, 90, 100, 110, 111]) {
      const suggestion = paperExitSuggestion(account.positions[0], account.orders, tick(price), now);
      assert.equal(suggestion.action, price === 100 ? "HOLD" : "EXIT");
      if (price !== 100) {
        const target = side === "BUY" ? price >= 110 : price <= 90;
        assert.match(suggestion.title, target ? /target reached/ : /stop-loss reached/);
      }
      assert.equal(suggestion.targetPrice, side === "BUY" ? 11000 : 9000);
      assert.equal(suggestion.stopPrice, side === "BUY" ? 9000 : 11000);
    }
    assert.deepEqual(account, snapshot);
  }
});

test("exit suggestions withhold live guidance for missing, stale, mismatched and out-of-session prices", () => {
  const account = fill(newPaperAccount(), "BUY", 10);
  const position = account.positions[0];
  for (const price of [
    undefined, tick(120, { observedAt: now - 60_001 }), tick(120, { symbol: "OTHER" }),
    tick(120, { exchange: "BSE" }), tick(120, { segment: "FNO" }),
    tick(120, { tradeTime: now - 86_400_000 }),
    tick(120, { tradeTime: now + 60_000, receivedAt: new Date(now + 60_000).toISOString() }),
  ]) {
    const suggestion = paperExitSuggestion(position, account.orders, price, now);
    assert.equal(suggestion.action, "WAIT");
    assert.match(suggestion.title, /Refresh live price/);
  }
  for (const at of ["2026-11-17T09:00:00+05:30", "2026-11-17T15:30:00+05:30", "2026-11-21T11:00:00+05:30"]) {
    const time = Date.parse(at);
    const suggestion = paperExitSuggestion(position, account.orders,
      tick(120, { observedAt: time, tradeTime: time, receivedAt: new Date(time).toISOString() }), time);
    assert.equal(suggestion.action, "WAIT");
    assert.equal(suggestion.title, "Market closed");
  }
});

test("exit suggestions never treat incomplete, cancelled, expired or other-position protection as a hold plan", () => {
  const account = fill(newPaperAccount(), "BUY", 10);
  const position = account.positions[0];
  const bracket = account.orders[0];
  for (const orders of [
    [], [{ ...bracket, quantity: 5 }], [{ ...bracket, side: "BUY" }], [{ ...bracket, intent: "OPEN" }],
    [{ ...bracket, status: "CANCELLED" }], [{ ...bracket, expiresAt: now }],
    [{ ...bracket, symbol: "OTHER" }], [{ ...bracket, exchange: "BSE" }],
    [{ ...bracket, product: "CNC" }], [{ ...bracket, segment: "FNO" }],
  ]) {
    const suggestion = paperExitSuggestion(position, orders, tick(), now);
    assert.equal(suggestion.action, "REVIEW");
    assert.equal(suggestion.title, "Set an exit plan");
  }
});

test("exit suggestions prioritize due MIS square-off, but never invent an intraday cutoff for CNC", () => {
  const opened = fill(newPaperAccount(), "BUY", 10);
  const cutoff = Date.parse("2026-11-17T15:20:00+05:30");
  for (const time of [cutoff - 1, cutoff, now + 86_400_000]) {
    const currentTick = tick(100, { observedAt: time, tradeTime: time, receivedAt: new Date(time).toISOString() });
    const suggestion = paperExitSuggestion(opened.positions[0], opened.orders, currentTick, time);
    assert.equal(suggestion.action, time === cutoff - 1 ? "HOLD" : "EXIT");
    if (time !== cutoff - 1) assert.match(suggestion.reason, /square-off is due/);
  }
  const delivery = fill(newPaperAccount(), "BUY", 10, { product: "CNC" });
  const currentTick = tick(100, { observedAt: cutoff, tradeTime: cutoff, receivedAt: new Date(cutoff).toISOString() });
  assert.equal(paperExitSuggestion(delivery.positions[0], delivery.orders, currentTick, cutoff).action, "HOLD");
});

test("itemized paper taxes follow side, delivery, futures notional and option premium with flat brokerage", () => {
  const future = { exchange: "NSE", tradingSymbol: "TEST99NOVFUT", growwSymbol: "NSE-TEST-23Nov99-FUT",
    underlying: "TEST", instrumentType: "FUT", expiry: "2099-11-23", strikePrice: null, lotSize: 10, tickSize: 0.05 };
  const fno = { symbol: future.tradingSymbol, exchange: "NSE", product: "NRML", segment: "FNO", instrument: future };
  const option = { ...fno, instrument: { ...future, tradingSymbol: "TEST99NOV100PE", instrumentType: "PE", strikePrice: 100 },
    symbol: "TEST99NOV100PE" };
  assert.deepEqual(paperCharges(10_000_000, selection, "BUY"), {
    brokerage: 2000, stt: 0, exchange: 307, ipft: 0, sebi: 10, stampDuty: 300, dp: 0, gst: 417, total: 3034,
  });
  for (const [identity, side, total, stt, stamp, dp] of [
    [selection, "SELL", 5234, 2500, 0, 0],
    [{ ...selection, product: "CNC" }, "BUY", 14234, 10000, 1500, 0],
    [{ ...selection, product: "CNC" }, "SELL", 15094, 10000, 0, 2000],
    [fno, "BUY", 2788, 0, 200, 0], [fno, "SELL", 7588, 5000, 0, 0],
    [option, "BUY", 6864, 0, 300, 0], [option, "SELL", 21564, 15000, 0, 0],
  ]) {
    const fees = paperCharges(10_000_000, identity, side);
    assert.equal(fees.brokerage, 2000);
    assert.equal(fees.total, total);
    assert.equal(fees.stt, stt);
    assert.equal(fees.stampDuty, stamp);
    assert.equal(fees.dp, dp);
  }
  const bse = paperCharges(10_000_000, { ...selection, exchange: "BSE" }, "BUY");
  assert.equal(bse.exchange, 375);
  assert.equal(bse.ipft, 1);
  assert.equal(bse.total, 3115);
  const small = paperCharges(9900, { ...selection, product: "CNC" }, "SELL");
  assert.equal(small.brokerage, 2000);
  assert.equal(small.dp, 350);
});

test("flat per-order fees require nonlinear sizing, including whole derivative lots", () => {
  const budget = 10000;
  const quantity = paperSuggestedQuantity(selection, 10_000_000, 100, 95, "BUY", 0.01, budget);
  assert.ok(quantity > 5);
  assert.ok(paperPlannedRisk(selection, quantity, 100, 95, "BUY") <= budget);
  assert.ok(paperPlannedRisk(selection, quantity + 1, 100, 95, "BUY") > budget);
  assert.equal(paperSuggestedQuantity(selection, 10_000_000, 100, 95, "BUY", 0.01, 4000), 0);
  const instrument = { exchange: "NSE", tradingSymbol: "TEST99NOVFUT", growwSymbol: "NSE-TEST-23Nov99-FUT",
    underlying: "TEST", instrumentType: "FUT", expiry: "2099-11-23", strikePrice: null, lotSize: 10, tickSize: 0.05 };
  const fno = { ...selection, symbol: instrument.tradingSymbol, segment: "FNO", instrument };
  const units = paperSuggestedQuantity(fno, 10_000_000, 100, 99, "BUY", 0.05, 20000);
  assert.ok(units > 0 && units % 10 === 0);
  assert.ok(paperPlannedRisk(fno, units, 100, 99, "BUY", 0.05) <= 20000);
  assert.ok(paperPlannedRisk(fno, units + 10, 100, 99, "BUY", 0.05) > 20000);
});

test("future fills apply adverse slippage and net fees without changing legacy cost-free history", () => {
  const legacy = fillPaperOrder(newPaperAccount(), quote(), "BUY", 10, now);
  assert.equal(legacy.fills[0].price, 10_000);
  assert.equal(legacy.fills[0].fees, 0);
  assert.equal(legacy.fills[0].costModel, undefined);
  const opened = fill(newPaperAccount(), "BUY", 10);
  assert.equal(opened.fills[0].price, 10_005);
  assert.equal(opened.fills[0].fees, 2367);
  assert.equal(opened.realized, -2367);
  assert.equal(opened.fills[0].charges.brokerage, 2000);
  assert.equal(opened.fills[0].costModel, "INDIA_FLAT20_V2");
  assert.equal(opened.positions[0].basis, 100_050);
  const closed = fill(opened, "SELL", 10, { price: 110 }, { protection: undefined });
  assert.equal(closed.fills[1].price, 10_994);
  assert.equal(closed.fills[1].fees, 2364);
  assert.equal(closed.realized, 5159);
  assert.equal(closed.cash, closed.initialBalance + closed.realized);
  assert.ok(paperAccountSchema.safeParse(closed).success);
  const unprotected = fill(newPaperAccount(), "BUY", 10, {}, { protection: undefined });
  assert.equal(unprotected.positions[0].quantity, 10);
  assert.equal(unprotected.orders.length, 0);
  assert.ok(unprotected.fills[0].fees > 0);
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

test("optional strict-policy diagnostic flags trade risk, concentration and incomplete valuations", () => {
  const initial = newPaperAccount();
  const valid = fill(initial, "BUY", 10);
  assert.doesNotThrow(() => assertPaperEntryRisk(initial, valid, riskEntry, prices, now));
  const wideStop = fill(initial, "BUY", 100, {}, { protection: { ...protection, stopPrice: 90 } });
  assert.throws(() => assertPaperEntryRisk(initial, wideStop, { ...riskEntry, quantity: 100, stop: 90 }, prices, now), /0.5%/);
  const concentrated = fill(initial, "BUY", 201);
  assert.throws(() => assertPaperEntryRisk(initial, concentrated, { ...riskEntry, quantity: 201 }, prices, now), /20%/);
  assert.equal(paperRiskReport(valid, {}, now).equity, null);
  assert.throws(() => assertPaperEntryRisk(valid, fill(valid, "BUY", 1), { ...riskEntry, quantity: 1 }, {}, now), /Fresh prices/);
  assert.ok(paperSuggestedQuantity(selection, initial.initialBalance, 100.05, 99, "BUY") > 0);
  assert.equal(paperSuggestedQuantity(selection, initial.initialBalance, 100, 101, "BUY"), 0);
});

test("pending entries consume both risk and stock limits, and reserve estimated fees", () => {
  const request = { ...selection, segment: undefined, side: "BUY", quantity: 100, kind: "LIMIT", limitPrice: 100, protection };
  delete request.segment;
  const initial = newPaperAccount();
  const one = placePaperOrder(initial, request, now, randomUUID(), { costAware: true });
  assert.equal(one.orders[0].reservedCash, 202_428);
  const two = placePaperOrder(one, request, now, randomUUID(), { costAware: true });
  assert.doesNotThrow(() => assertPaperEntryRisk(one, two, { ...riskEntry, quantity: 100, price: 100 }, {}, now));
  const excess = placePaperOrder(two, { ...request, quantity: 1 }, now, randomUUID(), { costAware: true });
  assert.throws(() => assertPaperEntryRisk(two, excess, { ...riskEntry, quantity: 1, price: 100 }, {}, now), /20%/);
  const unprotected = placePaperOrder(initial, { ...request, protection: undefined }, now, randomUUID(), { costAware: true });
  assert.equal(unprotected.orders[0].protection, undefined);
  assert.ok(unprotected.orders[0].reservedCash > 0);
});

test("optional strict-policy diagnostic flags a fifth entry beyond the combined guideline", () => {
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

test("risk breakdown separates position and pending risk and leaves unavailable budgets unknown", () => {
  const opened = fill(newPaperAccount(), "BUY", 155, {}, { protection: { ...protection, stopPrice: 97.5 } });
  const pending = placePaperOrder(opened, {
    symbol: "PENDING", exchange: "NSE", product: "MIS", side: "BUY", quantity: 150,
    kind: "LIMIT", limitPrice: 100, protection: { ...protection, stopPrice: 97.5 },
  }, now, randomUUID(), { costAware: true });
  const report = paperRiskReport(pending, prices, now);
  assert.equal(report.positionRisk, paperRiskReport(opened, prices, now).openRisk);
  assert.equal(report.pendingRisk, paperPlannedRisk(selection, 150, 100, 97.5, "BUY"));
  assert.equal(report.openRisk, report.positionRisk + report.pendingRisk);
  assert.equal(report.openRiskLimit, Math.floor(report.equity * 0.02));
  assert.equal(report.remainingOpenRisk, report.openRiskLimit - report.openRisk);
  const unavailable = paperRiskReport(pending, {}, now);
  assert.equal(unavailable.positionRisk, null);
  assert.equal(unavailable.openRiskLimit, null);
  assert.equal(unavailable.remainingOpenRisk, null);
  const unprotected = paperRiskReport({ ...opened, orders: [] }, prices, now);
  assert.equal(unprotected.remainingOpenRisk, null);
});

test("risk sizing respects remaining position/pending budget for both market and limit entry directions", () => {
  let account = newPaperAccount();
  const marks = {};
  for (let index = 0; index < 4; index++) {
    const symbol = `EXISTING${index}`;
    marks[`NSE:${symbol}`] = tick(100, { symbol });
    account = fill(account, "BUY", 155, { symbol }, { protection: { ...protection, stopPrice: 97.5 } });
  }
  account = placePaperOrder(account, {
    symbol: "PENDING", exchange: "NSE", product: "MIS", side: "BUY", quantity: 30,
    kind: "LIMIT", limitPrice: 100, protection: { ...protection, stopPrice: 97.5 },
  }, now, randomUUID(), { costAware: true });
  const report = paperRiskReport(account, marks, now);
  for (const side of ["BUY", "SELL"]) {
    const exit = side === "BUY" ? { targetPrice: 110, stopPrice: 95 } : { targetPrice: 90, stopPrice: 105 };
    for (const kind of ["MARKET", "LIMIT"]) {
      const entry = kind === "MARKET" ? paperExecutionPrice(100, side) : 100;
      const quantity = paperSuggestedQuantity(selection, report.equity, entry, exit.stopPrice, side, 0.01, report.remainingOpenRisk);
      assert.ok(quantity > 0);
      assert.ok(quantity < paperSuggestedQuantity(selection, report.equity, entry, exit.stopPrice, side));
      assert.ok(paperPlannedRisk(selection, quantity, entry, exit.stopPrice, side) <= report.remainingOpenRisk);
      const next = kind === "MARKET"
        ? fill(account, side, quantity, {}, { protection: exit })
        : placePaperOrder(account, { ...selection, side, quantity, kind, limitPrice: 100, protection: exit }, now,
          randomUUID(), { costAware: true });
      assert.doesNotThrow(() => assertPaperEntryRisk(account, next, {
        ...riskEntry, side, quantity, price: entry, stop: exit.stopPrice,
      }, { ...marks, ...prices }, now));
      const after = paperRiskReport(next, { ...marks, ...prices }, now);
      assert.ok(after.openRisk <= after.openRiskLimit);
    }
  }
});

test("an exhausted combined budget suggests no new entry without preventing a reducing fill", () => {
  let account = newPaperAccount();
  const marks = {};
  for (let index = 0; index < 5; index++) {
    const symbol = `TEST${index}`;
    marks[`NSE:${symbol}`] = tick(100, { symbol });
    account = fill(account, "BUY", 155, { symbol }, { protection: { ...protection, stopPrice: 97.5 } });
  }
  const report = paperRiskReport(account, marks, now);
  assert.ok(report.openRisk > report.openRiskLimit);
  assert.equal(report.remainingOpenRisk, 0);
  for (const unavailable of [0, -1, NaN, Infinity]) {
    assert.equal(paperSuggestedQuantity(selection, report.equity, 100, 95, "BUY", 0.01, unavailable), 0);
  }
  assert.doesNotThrow(() => fill(account, "SELL", 155, { symbol: "TEST0" }, { protection: undefined }));
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
  assert.equal(report.remainingOpenRisk, null);
  assert.ok(report.blockers.some(blocker => blocker.includes("represented safely")));
  assert.throws(() => assertPaperEntryRisk(account, account, riskEntry, {}, now), /represented safely/);
});

test("daily loss guidance does not replenish with profits and ignores legacy halt dates after recovery", () => {
  const opened = fill(newPaperAccount(), "BUY", 200, {}, { protection: { targetPrice: 110, stopPrice: 90 } });
  const lost = fill(opened, "SELL", 200, { price: 90 }, { protection: undefined });
  assert.equal(paperRiskReport(lost, {}, now).dailyLocked, true);
  const halted = { ...opened, riskHaltDate: "2026-11-17" };
  assert.equal(paperRiskReport(halted, { "NSE:TESTEQ": tick(105) }, now).dailyLocked, false);
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
