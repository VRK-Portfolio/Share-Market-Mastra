import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fillPaperOrder, newPaperAccount, paperAccountSchema, paperPositionMark, paperPositionPnl, paperProductSummary,
  paperQuoteError, paperRequiredMargin, readPaperAccount,
} from "../src/lib/market/paper-trading.ts";
import {
  cancelPaperOrder, nextPaperProcessing, placePaperOrder, processPaperOrders, protectPaperPosition,
} from "../src/lib/market/paper-orders.ts";
import { paperTradeHistory } from "../src/lib/market/paper-history.ts";

const now = Date.parse("2026-11-17T10:30:00+05:30");
const quote = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", product: "MIS", price: 100, tradeTime: now };
const fill = (account, side, quantity, changes = {}, time = now) =>
  fillPaperOrder(account, { ...quote, ...changes }, side, quantity, time);
const limit = { symbol: "ADANIPORTS", exchange: "NSE", product: "MIS", side: "BUY", quantity: 10, kind: "LIMIT", limitPrice: 100 };
const process = (account, price, at = now) => processPaperOrders(account, { ...quote, price, tradeTime: at }, at);

test("pending limits reserve cash, fill only at the limit or better, and release unused reservation", () => {
  const pending = placePaperOrder(newPaperAccount(), limit, now);
  assert.equal(pending.cash, 9_980_000);
  assert.equal(pending.orders[0].reservedCash, 20_000);
  assert.equal(process(pending, 101).fills.length, 0);
  assert.equal(process(pending, 100).fills[0].price, 10_000);
  const filled = process(pending, 99);
  assert.equal(filled.cash, 9_980_200);
  assert.equal(filled.positions[0].margin, 19_800);
  assert.equal(filled.orders[0].status, "FILLED");
  assert.equal(filled.orders[0].reservedCash, 0);
  assert.equal(filled.fills[0].price, 9900);
  assert.equal(filled.fills[0].id, pending.orders[0].id);
  assert.equal(process(filled, 98).fills.length, 1);
  assert.throws(() => placePaperOrder(pending, { ...limit, quantity: 5000 }, now), /reserve/);
});

test("cancellation and expiry return pending cash without losing existing ledger data", () => {
  const pending = placePaperOrder(fill(newPaperAccount(), "BUY", 1), limit, now);
  const cancelled = cancelPaperOrder(pending, pending.orders[0].id, now);
  assert.equal(cancelled.cash, 9_998_000);
  assert.equal(cancelled.orders[0].status, "CANCELLED");
  assert.equal(cancelled.fills.length, 1);
  assert.throws(() => cancelPaperOrder(cancelled, pending.orders[0].id, now), /no longer active/);
  const expired = processPaperOrders(pending, null, Date.parse("2026-11-17T15:20:00+05:30"));
  assert.equal(expired.orders[0].status, "EXPIRED");
  assert.equal(expired.cash, 9_998_000);
});

test("CNC GTT persists overnight, activates its limit once triggered, and cannot bypass that limit", () => {
  const pending = placePaperOrder(newPaperAccount(), { ...limit, product: "CNC", kind: "GTT",
    triggerPrice: 105, triggerDirection: "UP" }, now);
  const tomorrow = now + 86_400_000;
  assert.equal(processPaperOrders(pending, null, tomorrow).orders[0].status, "PENDING");
  const triggered = process(pending, 106, tomorrow);
  assert.equal(triggered.orders[0].status, "TRIGGERED");
  assert.equal(triggered.fills.length, 0);
  const filled = process(triggered, 99, tomorrow);
  assert.equal(filled.orders[0].status, "FILLED");
  assert.equal(filled.positions[0].product, "CNC");
  assert.throws(() => placePaperOrder(newPaperAccount(), { ...limit, kind: "GTT", triggerPrice: 105, triggerDirection: "UP" }, now), /only for CNC/);
});

test("target/stop protection exits once at actual gap prices and resizes after a partial exit", () => {
  const held = fill(newPaperAccount(), "BUY", 10);
  const protectedAccount = protectPaperPosition(held, quote, { targetPrice: 110, stopPrice: 90 }, now);
  assert.equal(process(protectedAccount, 105).fills.length, 1);
  assert.equal(process(protectedAccount, 110).fills[1].reason, "TARGET");
  const stopped = process(protectedAccount, 85);
  assert.equal(stopped.orders[0].status, "FILLED");
  assert.equal(stopped.fills[1].price, 8500);
  assert.equal(stopped.realized, -15_000);
  assert.equal(process(stopped, 115).fills.length, 2);
  const partial = fill(protectedAccount, "SELL", 1);
  assert.equal(partial.orders[0].status, "PENDING");
  assert.equal(partial.orders[0].quantity, 9);
  assert.equal(process(partial, 120).positions.length, 0);
  const short = protectPaperPosition(fill(newPaperAccount(), "SELL", 4), quote, { targetPrice: 90, stopPrice: 110 }, now);
  assert.equal(process(short, 89).realized, 4400);
});

test("entry limits attach linked exits after filling and reject unaffordable short gaps with reservation released", () => {
  const pending = placePaperOrder(newPaperAccount(), { ...limit, protection: { targetPrice: 110, stopPrice: 90 } }, now);
  const filled = process(pending, 99);
  assert.equal(filled.orders.length, 2);
  assert.equal(filled.orders[1].kind, "BRACKET");
  assert.equal(process(filled, 111).realized, 12_000);
  const short = placePaperOrder(newPaperAccount(), { ...limit, side: "SELL", quantity: 5000 }, now);
  const rejected = process(short, 110);
  assert.equal(rejected.orders[0].status, "REJECTED");
  assert.match(rejected.orders[0].reason, /Insufficient virtual cash/);
  assert.equal(rejected.cash, 10_000_000);
  assert.equal(rejected.fills.length, 0);
});

test("15:20 cutoff closes MIS with fresh prices, blocks new entries and retains CNC", () => {
  const cutoff = Date.parse("2026-11-17T15:20:00+05:30");
  assert.equal(fill(newPaperAccount(), "BUY", 1, { tradeTime: cutoff - 1 }, cutoff - 1).positions[0].quantity, 1);
  let account = fill(newPaperAccount(), "BUY", 10);
  account = fill(account, "BUY", 2, { product: "CNC" });
  assert.throws(() => fill(account, "BUY", 1, { tradeTime: cutoff }, cutoff), /15:20/);
  assert.throws(() => placePaperOrder(account, limit, cutoff), /15:20/);
  const closed = process(account, 105, cutoff);
  assert.equal(closed.realized, 5000);
  assert.equal(closed.positions.length, 1);
  assert.equal(closed.positions[0].product, "CNC");
  assert.throws(() => processPaperOrders(account, { ...quote, tradeTime: cutoff - 60_001 }, cutoff), /60 seconds/);
});

test("CNC day limits expire at 15:30 while GTT reservations remain active", () => {
  const pending = placePaperOrder(newPaperAccount(), { ...limit, product: "CNC" }, now);
  const gtt = placePaperOrder(pending, { ...limit, product: "CNC", kind: "GTT", triggerPrice: 105, triggerDirection: "UP" }, now);
  const close = Date.parse("2026-11-17T15:30:00+05:30");
  assert.equal(processPaperOrders(gtt, null, close - 1).orders[0].status, "PENDING");
  const expired = processPaperOrders(gtt, null, close);
  assert.equal(expired.orders[0].status, "EXPIRED");
  assert.equal(expired.orders[1].status, "PENDING");
  assert.equal(expired.cash, 9_900_000);
});

test("pending exits remain available with negative cash, but new entry reservations do not", () => {
  let account = fill(newPaperAccount(), "SELL", 900);
  account = fill(account, "BUY", 10, { symbol: "RELIANCE", product: "CNC" });
  account = fill(account, "BUY", 900, { price: 250 });
  assert.ok(account.cash < 0);
  const exit = placePaperOrder(account, { ...limit, symbol: "RELIANCE", product: "CNC", side: "SELL" }, now);
  assert.equal(exit.orders[0].reservedCash, 0);
  assert.throws(() => placePaperOrder(account, limit, now), /Insufficient virtual cash/);
});

test("automation requests are emitted only for relevant fresh triggers, expiry or square-off", () => {
  const account = placePaperOrder(newPaperAccount(), limit, now);
  const tick = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 101, tradeTime: now,
    receivedAt: new Date(now).toISOString(), observedAt: now, paperQuoteProof: "signed-test-proof" };
  assert.equal(nextPaperProcessing(account, { "NSE:ADANIPORTS": tick }, now), null);
  assert.equal(nextPaperProcessing(account, { "NSE:ADANIPORTS": { ...tick, price: 99 } }, now).type, "PROCESS");
  assert.equal(nextPaperProcessing(account, { "NSE:ADANIPORTS": { ...tick, price: 99 } }, now + 60_001), null);
  assert.deepEqual(nextPaperProcessing(account, {}, Date.parse("2026-11-17T15:20:00+05:30")), {
    type: "PROCESS", symbol: "ADANIPORTS", exchange: "NSE",
  });
  const legacy = newPaperAccount();
  delete legacy.orders;
  assert.deepEqual(paperAccountSchema.parse(legacy).orders, []);
});

test("long additions and partial/full exits conserve cash, basis and realized P&L in paise", () => {
  let account = fill(newPaperAccount(), "BUY", 3);
  account = fill(account, "BUY", 2, { price: 110 });
  assert.equal(account.cash, 9_989_600);
  assert.equal(account.positions[0].basis, 52_000);
  assert.equal(account.positions[0].quantity, 5);
  assert.equal(paperPositionPnl(account.positions[0], 120), 8000);
  account = fill(account, "SELL", 2, { price: 120 });
  assert.equal(account.realized, 3200);
  assert.equal(account.positions[0].basis, 31_200);
  account = fill(account, "SELL", 3, { price: 90 });
  assert.equal(account.realized, -1000);
  assert.equal(account.cash, 9_999_000);
  assert.deepEqual(account.positions, []);
  assert.equal(account.fills.length, 4);
});

test("short entries reserve 20% margin, partial covers release collateral and realize full directional P&L", () => {
  let account = fill(newPaperAccount(), "SELL", 10);
  assert.equal(account.cash, 9_980_000);
  assert.equal(account.positions[0].margin, 20_000);
  assert.equal(account.positions[0].quantity, -10);
  assert.equal(paperPositionPnl(account.positions[0], 90), 10_000);
  account = fill(account, "BUY", 4, { price: 90 });
  assert.equal(account.realized, 4000);
  assert.equal(account.cash, 9_992_000);
  assert.equal(account.positions[0].margin, 12_000);
  account = fill(account, "BUY", 6, { price: 110 });
  assert.equal(account.cash, 9_998_000);
  assert.equal(account.realized, -2000);
  assert.deepEqual(account.positions, []);
});

test("live position marks compare long and short quantities against their saved entry values independently", () => {
  const account = fill(fill(newPaperAccount(), "BUY", 10), "SELL", 4, { symbol: "RELIANCE", price: 200 });
  const tick = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 110, tradeTime: now,
    receivedAt: new Date(now).toISOString(), observedAt: now };
  assert.deepEqual(paperPositionMark(account.positions[0], tick, now), {
    price: 110, value: 110_000, pnl: 10_000, pnlPercent: 10,
  });
  assert.deepEqual(paperPositionMark(account.positions[1], { ...tick, symbol: "RELIANCE", price: 180 }, now), {
    price: 180, value: 72_000, pnl: 8000, pnlPercent: 10,
  });
  assert.equal(paperPositionMark(account.positions[1], { ...tick, symbol: "RELIANCE", price: 220 }, now).pnl, -8000);
  assert.equal(paperPositionMark(account.positions[0], { ...tick, price: 90 }, now).pnl, -10_000);
});

test("position marks reject missing, wrong-stock, wrong-exchange and expired prices without extending age on receipt", () => {
  const position = fill(newPaperAccount(), "BUY", 10).positions[0];
  const tick = { symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", price: 110, tradeTime: now - 59_000,
    receivedAt: new Date(now).toISOString(), observedAt: now };
  assert.notEqual(paperPositionMark(position, tick, now + 1000), null);
  assert.equal(paperPositionMark(position, tick, now + 1001), null);
  assert.equal(paperPositionMark(position, undefined, now), null);
  for (const changes of [
    { symbol: "RELIANCE" }, { exchange: "BSE" }, { segment: "FNO" },
    { receivedAt: "invalid" }, { tradeTime: now + 5001 }, { price: NaN }, { price: 0 },
  ]) assert.equal(paperPositionMark(position, { ...tick, ...changes }, now), null);
});

test("partial basis rounding preserves every paise when a fractional average is closed in pieces", () => {
  let account = fill(newPaperAccount(), "BUY", 1, { price: 1 });
  account = fill(account, "BUY", 2, { price: 1.01 });
  account = fill(account, "SELL", 1, { price: 1.02 });
  account = fill(account, "SELL", 1, { price: 1.02 });
  account = fill(account, "SELL", 1, { price: 1.02 });
  assert.equal(account.realized, 4);
  assert.equal(account.cash, 10_000_004);
});

test("delivery allows holding exits only, and neither product allows reversing through zero", () => {
  assert.throws(() => fill(newPaperAccount(), "SELL", 1, { product: "CNC" }), /paper holdings/);
  const delivery = fill(newPaperAccount(), "BUY", 2, { product: "CNC" });
  assert.throws(() => fill(delivery, "SELL", 3, { product: "CNC" }), /open quantity/);
  assert.equal(fill(delivery, "SELL", 2, { product: "CNC", price: 105 }).realized, 1000);
  assert.throws(() => fill(fill(newPaperAccount(), "SELL", 1), "BUY", 2), /open quantity/);
});

test("MIS, CNC and exchange identities remain separate and cannot cross-close holdings", () => {
  let account = fill(newPaperAccount(), "BUY", 2, { product: "CNC" });
  account = fill(account, "SELL", 1);
  account = fill(account, "SELL", 1, { exchange: "BSE" });
  assert.equal(account.positions.length, 3);
  assert.throws(() => fill(account, "SELL", 1, { product: "CNC", exchange: "BSE" }), /paper holdings/);
});

test("opening orders cannot exceed cash, but a losing short can always be closed even into negative cash", () => {
  assert.throws(() => fill(newPaperAccount(), "BUY", 5001), /Insufficient virtual cash/);
  assert.throws(() => fill(newPaperAccount(), "SELL", 5001), /Insufficient virtual cash/);
  let account = fill(newPaperAccount(), "SELL", 1000);
  account = fill(account, "BUY", 1000, { price: 250 });
  assert.equal(account.cash, -5_000_000);
  assert.equal(account.realized, -15_000_000);
  assert.throws(() => fill(account, "BUY", 1), /Insufficient virtual cash/);
});

test("freshness, same-day session and CASH restrictions are enforced at execution", () => {
  assert.equal(paperQuoteError(quote, now), null);
  assert.equal(paperQuoteError({ ...quote, tradeTime: now - 60_000 }, now), null);
  for (const changes of [
    { tradeTime: now - 60_001 }, { tradeTime: now + 5001 }, { tradeTime: null },
    { tradeTime: NaN }, { price: 0 }, { price: Infinity }, { price: 0.001 }, { segment: "FNO" },
  ]) assert.throws(() => fill(newPaperAccount(), "BUY", 1, changes));
  for (const time of ["2026-11-17T09:14:59+05:30", "2026-11-17T15:30:00+05:30", "2026-11-21T10:30:00+05:30"]) {
    const at = Date.parse(time);
    assert.throws(() => fill(newPaperAccount(), "BUY", 1, { tradeTime: at }, at), /regular weekday session/);
  }
});

test("overdue MIS cannot be increased or automatically closed; fresh manual cover is allowed", () => {
  const account = fill(newPaperAccount(), "SELL", 2);
  const tomorrow = now + 86_400_000;
  assert.throws(() => fill(account, "SELL", 1, { tradeTime: tomorrow }, tomorrow), /overdue/);
  const closed = fill(account, "BUY", 2, { tradeTime: tomorrow, price: 99 }, tomorrow);
  assert.equal(closed.realized, 200);
  assert.equal(account.positions[0].quantity, -2);
});

test("invalid quantities, unsafe values and duplicate fill IDs fail without mutating the account", () => {
  const account = newPaperAccount();
  for (const quantity of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => fill(account, "BUY", quantity));
  }
  const first = fill(account, "BUY", 1);
  assert.throws(() => fillPaperOrder(first, quote, "BUY", 1, now, first.fills[0].id));
  assert.deepEqual(account, newPaperAccount());
});

test("browser persistence round-trips positions and history; malformed or inconsistent records never silently reset", () => {
  const account = fill(newPaperAccount(), "BUY", 2);
  assert.deepEqual(readPaperAccount({ getItem: () => JSON.stringify(account) }), account);
  assert.deepEqual(readPaperAccount({ getItem: () => null }), newPaperAccount());
  assert.throws(() => readPaperAccount({ getItem: () => "not json" }));
  assert.throws(() => readPaperAccount({ getItem: () => JSON.stringify({ ...account, cash: 0 }) }), /damaged/);
  assert.equal(paperAccountSchema.safeParse({ ...account, positions: [...account.positions, ...account.positions] }).success, false);
});

test("MIS funds five times the CNC quantity without discounting entry prices or multiplying P&L twice", () => {
  const mis = fill(newPaperAccount(), "BUY", 5000);
  assert.equal(mis.cash, 0);
  assert.equal(mis.positions[0].basis, 50_000_000);
  assert.equal(mis.positions[0].margin, 10_000_000);
  assert.equal(mis.fills[0].price, 10_000);
  assert.equal(paperPositionPnl(mis.positions[0], 101), 500_000);
  const cnc = fill(newPaperAccount(), "BUY", 1000, { product: "CNC" });
  assert.equal(cnc.cash, 0);
  assert.equal(cnc.positions[0].margin, cnc.positions[0].basis);
  assert.throws(() => fill(newPaperAccount(), "BUY", 1001, { product: "CNC" }), /Insufficient/);
  assert.equal(fill(mis, "SELL", 5000, { price: 101 }).cash, 10_500_000);
});

test("partial leveraged exits conserve every paise without leaving an uncollateralized fractional remainder", () => {
  for (const side of ["BUY", "SELL"]) {
    let account = fill(newPaperAccount(), side, 5, { price: 0.01 });
    assert.equal(account.positions[0].margin, 1);
    for (let count = 0; count < 4; count++) {
      account = fill(account, side === "BUY" ? "SELL" : "BUY", 1, { price: 0.01 });
      assert.equal(account.positions[0].margin, 1);
      assert.equal(account.cash + account.positions[0].margin, account.initialBalance);
    }
    account = fill(account, side === "BUY" ? "SELL" : "BUY", 1, { price: 0.01 });
    assert.equal(account.cash, account.initialBalance);
    assert.equal(account.positions.length, 0);
  }
  assert.equal(paperRequiredMargin("MIS", 6), 2);
  assert.equal(paperRequiredMargin("CNC", 6), 6);
});

test("legacy positions preserve full collateral and basis when new MIS entries add 20% margin", () => {
  const legacy = fill(newPaperAccount(), "BUY", 2);
  legacy.version = 1;
  legacy.cash = legacy.initialBalance - legacy.positions[0].basis;
  delete legacy.positions[0].margin;
  const migrated = readPaperAccount({ getItem: () => JSON.stringify(legacy) });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.cash, legacy.cash);
  assert.equal(migrated.positions[0].margin, 20_000);
  const mixed = fill(migrated, "BUY", 3);
  assert.equal(mixed.positions[0].basis, 50_000);
  assert.equal(mixed.positions[0].margin, 26_000);
  assert.equal(fill(mixed, "SELL", 5, { price: 110 }).cash, 10_005_000);
  const partial = fill(mixed, "SELL", 2);
  assert.equal(partial.positions[0].margin, 15_600);
  assert.equal(fill(partial, "SELL", 3).cash, 10_000_000);
  assert.equal(paperAccountSchema.safeParse({ ...migrated, positions: [{ ...migrated.positions[0], margin: 20_001 }] }).success, false);
});

test("mixed legacy collateral never exceeds the remaining basis after a fractional partial exit", () => {
  const legacy = fill(fill(newPaperAccount(), "BUY", 4, { price: 0.01 }), "BUY", 1, { price: 0.02 });
  legacy.cash = legacy.initialBalance - legacy.positions[0].basis;
  delete legacy.positions[0].margin;
  const migrated = paperAccountSchema.parse(legacy);
  const mixed = fill(migrated, "BUY", 1, { price: 0.02 });
  assert.equal(mixed.positions[0].basis, 8);
  assert.equal(mixed.positions[0].margin, 7);
  const partial = fill(mixed, "SELL", 5, { price: 0.02 });
  assert.equal(partial.positions[0].basis, 1);
  assert.equal(partial.positions[0].margin, 1);
  assert.equal(fill(partial, "SELL", 1, { price: 0.02 }).cash, 10_000_004);
});

test("MIS and CNC share the stock price but retain independent basis, collateral and product P&L", () => {
  let account = fill(newPaperAccount(), "SELL", 10);
  account = fill(account, "BUY", 20, { product: "CNC", price: 105 });
  const tick = { symbol: quote.symbol, exchange: "NSE", segment: "CASH", price: 110, tradeTime: now,
    receivedAt: new Date(now).toISOString(), observedAt: now };
  const prices = { "NSE:ADANIPORTS": tick };
  const mis = paperProductSummary(account, "MIS", prices, now);
  const cnc = paperProductSummary(account, "CNC", prices, now);
  assert.equal(mis.pnl, -10_000);
  assert.equal(cnc.pnl, 10_000);
  assert.equal(mis.margin, 20_000);
  assert.equal(cnc.margin, 210_000);
  account = fill(account, "BUY", 1, { symbol: "RELIANCE" });
  assert.equal(paperProductSummary(account, "MIS", prices, now).pnl, null);
  assert.equal(paperProductSummary(account, "CNC", prices, now).pnl, 10_000);
  account = fill(account, "SELL", 1, { symbol: "RELIANCE", price: 102 });
  assert.equal(paperProductSummary(account, "MIS", prices, now).realized, 200);
});

test("success counts one combined final result, not a profitable partial exit, even with later additions", () => {
  let account = fill(newPaperAccount(), "BUY", 10);
  account = fill(account, "SELL", 4, { price: 110 });
  let history = paperTradeHistory(account);
  assert.equal(history.successRate, null);
  assert.equal(history.completed.length, 0);
  assert.equal(history.partialRealized, 4000);
  account = fill(account, "BUY", 2, { price: 120 });
  account = fill(account, "SELL", 8, { price: 90 });
  history = paperTradeHistory(account);
  assert.equal(history.completed.length, 1);
  assert.equal(history.losses, 1);
  assert.equal(history.wins, 0);
  assert.equal(history.successRate, 0);
  assert.equal(history.completed[0].quantity, 12);
  assert.equal(history.completed[0].entryValue, 124_000);
  assert.equal(history.completed[0].exitValue, 116_000);
  assert.equal(history.realized, -8000);
  assert.equal(history.rows.at(-1).entryPrice, 10_500);
  assert.equal(history.partialRealized, 0);
});

test("short covers, break-even trades and re-entry use distinct completed cycles in persisted fill order", () => {
  let account = fill(newPaperAccount(), "BUY", 2);
  account = fill(account, "SELL", 2, { price: 110 });
  account = fill(account, "SELL", 3, { symbol: "RELIANCE", price: 200 });
  account = fill(account, "BUY", 1, { symbol: "RELIANCE", price: 190 });
  account = fill(account, "BUY", 1);
  account = fill(account, "SELL", 1);
  account = fill(account, "BUY", 2, { symbol: "RELIANCE", price: 195 });
  account = fill(account, "BUY", 1);
  const history = paperTradeHistory(account);
  assert.equal(history.completed.length, 3);
  assert.equal(history.wins, 2);
  assert.equal(history.breakEven, 1);
  assert.equal(history.losses, 0);
  assert.equal(history.successRate, 2 / 3 * 100);
  assert.equal(history.completed.at(-1).entrySide, "SELL");
  assert.equal(history.completed.at(-1).entryValue, 60_000);
  assert.equal(history.completed.at(-1).exitValue, 58_000);
  assert.equal(history.rows[3].role, "EXIT");
  assert.equal(history.rows[3].entryPrice, 20_000);
  assert.equal(history.rows.at(-1).role, "ENTRY");
  assert.deepEqual(paperTradeHistory(paperAccountSchema.parse(JSON.parse(JSON.stringify(account)))), history);
  const pending = placePaperOrder(account, { ...limit, symbol: "RELIANCE" }, now);
  assert.equal(paperTradeHistory(cancelPaperOrder(pending, pending.orders[0].id, now)).successRate, history.successRate);
});

test("exchange and product cycles stay independent and open-position partial P&L is excluded from completed P&L", () => {
  let account = fill(newPaperAccount(), "BUY", 1);
  account = fill(account, "BUY", 2, { product: "CNC", price: 200 });
  account = fill(account, "SELL", 3, { exchange: "BSE", price: 300 });
  account = fill(account, "SELL", 1, { price: 110 });
  account = fill(account, "SELL", 1, { product: "CNC", price: 190 });
  account = fill(account, "BUY", 3, { exchange: "BSE", price: 310 });
  const history = paperTradeHistory(account);
  assert.equal(history.completed.length, 2);
  assert.equal(history.wins, 1);
  assert.equal(history.losses, 1);
  assert.equal(history.successRate, 50);
  assert.equal(history.realized, -2000);
  assert.equal(history.partialRealized, -1000);
  assert.equal(history.realized + history.partialRealized, account.realized);
  assert.equal(history.rows[4].entryPrice, 20_000);
});

test("entry cost history preserves ledger paise rounding instead of estimating P&L from rounded displayed averages", () => {
  let account = fill(newPaperAccount(), "BUY", 1, { price: 1 });
  account = fill(account, "BUY", 2, { price: 1.01 });
  for (let count = 0; count < 3; count++) account = fill(account, "SELL", 1, { price: 1.02 });
  const history = paperTradeHistory(account);
  assert.deepEqual(history.rows.filter((row) => row.role === "EXIT").map((row) => row.entryPrice), [101, 101, 100]);
  assert.equal(history.realized, 4);
  assert.equal(history.completed[0].entryValue, 302);
  assert.equal(history.completed[0].exitValue, 306);
  assert.equal(history.successRate, 100);
});

test("empty/reset history has no score, and unreconciled fills never produce a success-shaped fallback", () => {
  assert.equal(paperTradeHistory(newPaperAccount()).successRate, null);
  const open = fill(newPaperAccount(), "BUY", 2);
  assert.equal(paperTradeHistory(open).breakEven, 0);
  assert.throws(() => paperTradeHistory({ ...open, fills: [] }), /cannot be reconciled/);
  const closed = fill(open, "SELL", 2, { price: 110 });
  assert.throws(() => paperTradeHistory({ ...closed, realized: 0 }), /cannot be reconciled/);
  assert.throws(() => paperTradeHistory({ ...closed, fills: [closed.fills[1]] }), /cannot be reconciled/);
});
