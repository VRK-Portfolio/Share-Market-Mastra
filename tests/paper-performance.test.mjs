import assert from "node:assert/strict";
import { test } from "node:test";
import { fillPaperOrder, newPaperAccount, paperAccountSchema } from "../src/lib/market/paper-trading.ts";
import { paperTradeHistory } from "../src/lib/market/paper-history.ts";
import { paperPerformance } from "../src/lib/market/paper-performance.ts";

const now = Date.parse("2026-11-17T10:30:00+05:30");
function fill(account, side, quantity, price, modeled = true) {
  const next = fillPaperOrder(account, {
    symbol: "RELIANCE", exchange: "NSE", segment: "CASH", product: "MIS", price, tradeTime: now,
  }, side, quantity, now);
  if (!modeled) return next;
  const last = next.fills.at(-1);
  const fees = Math.ceil(last.price * quantity * 0.001);
  return paperAccountSchema.parse({
    ...next, cash: next.cash - fees, realized: next.realized - fees,
    fills: [...next.fills.slice(0, -1), { ...last, fees, realized: last.realized - fees, costModel: "ESTIMATED_V1" }],
  });
}

test("fee replay preserves gross basis through partial closes and adds while cycles remain net", () => {
  let account = fill(newPaperAccount(), "BUY", 10, 100);
  assert.equal(paperTradeHistory(account).partialRealized, -100);
  account = fill(account, "SELL", 4, 110);
  assert.equal(paperTradeHistory(account).partialRealized, 3856);
  account = fill(account, "BUY", 2, 120);
  const snapshot = structuredClone(account);
  const open = paperTradeHistory(account);
  assert.equal(open.rows[1].entryPrice, 10000);
  assert.equal(open.partialRealized, 3832);
  assert.equal(open.completed.length, 0);
  assert.deepEqual(account, snapshot);
  account = fill(account, "SELL", 8, 90);
  const history = paperTradeHistory(account);
  assert.equal(history.rows.at(-1).entryPrice, 10500);
  assert.equal(history.completed[0].entryValue, 124000);
  assert.equal(history.completed[0].exitValue, 116000);
  assert.equal(history.completed[0].fees, 240);
  assert.equal(history.realized, -8240);
  assert.equal(history.realized, account.realized);
  assert.equal(paperPerformance(account).expectancy, -8240);
});

test("short-cover replay adds exit fees back before releasing basis", () => {
  let account = fill(newPaperAccount(), "SELL", 3, 200);
  account = fill(account, "BUY", 1, 190);
  account = fill(account, "BUY", 2, 195);
  const history = paperTradeHistory(account);
  assert.deepEqual(history.rows.slice(1).map((row) => row.entryPrice), [20000, 20000]);
  assert.equal(history.completed[0].fees, 118);
  assert.equal(history.realized, 1882);
  assert.equal(history.completed[0].costModel, "ESTIMATED_V1");
});

test("outcome reasons distinguish fee-erased gains, fee-only losses and normal fee impact", () => {
  for (const [exitPrice, net, expected] of [
    [100.1, -11, "Fees of Rs0.21 exceeded the price gain."],
    [100.21, 0, "Fees of Rs0.21 used up the price gain."],
    [100, -20, "Fees of Rs0.20 caused the net loss."],
    [110, 979, "Fees reduced the gain by Rs0.21."],
    [90, -1019, "Fees added to the loss by Rs0.19."],
  ]) {
    const account = fill(fill(newPaperAccount(), "BUY", 1, 100), "SELL", 1, exitPrice);
    const [trade] = paperTradeHistory(account).completed;
    assert.equal(trade.realized, net);
    assert.ok(trade.outcomeReason.endsWith(expected), trade.outcomeReason);
  }
});

test("legacy, modeled and mixed cycles retain original charges and separate performance cohorts", () => {
  let account = fill(newPaperAccount(), "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 110, false);
  account = fill(account, "BUY", 1, 100);
  account = fill(account, "SELL", 1, 110);
  account = fill(account, "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 110);
  const snapshot = structuredClone(account);
  const performance = paperPerformance(account);
  assert.equal(performance.cohorts.legacy.netRealized, 1000);
  assert.equal(performance.cohorts.modeled.netRealized, 979);
  assert.equal(performance.cohorts.mixed.netRealized, 989);
  assert.equal(performance.cohorts.legacy.sampleSize, 1);
  assert.equal(performance.cohorts.modeled.sampleSize, 1);
  assert.equal(performance.cohorts.mixed.sampleSize, 1);
  assert.equal(performance.netRealized, 2968);
  assert.equal(performance.fees, 32);
  assert.equal(performance.legacyFills, 3);
  assert.equal(performance.modeledFills, 3);
  assert.deepEqual(account, snapshot);
  // Persisted records from before the optional fees field remain readable.
  const old = { ...account, fills: account.fills.map((item) => {
    if (item.costModel) return item;
    const legacy = { ...item };
    delete legacy.fees;
    return legacy;
  }) };
  assert.deepEqual(paperPerformance(old), performance);
});

test("V2 fills persist itemized charges, reconcile net P&L and stay separate from V1 and legacy history", () => {
  const quote = { symbol: "RELIANCE", exchange: "NSE", segment: "CASH", product: "MIS", price: 100, tradeTime: now };
  const open = fillPaperOrder(newPaperAccount(), quote, "BUY", 1000, now, undefined, "LIMIT", { costAware: true, limitPrice: 100 });
  const saved = structuredClone(open);
  const closed = fillPaperOrder(open, quote, "SELL", 1000, now, undefined, "LIMIT", { costAware: true, limitPrice: 100 });
  assert.equal(open.fills[0].fees, 3034);
  assert.equal(closed.fills[1].fees, 5234);
  assert.equal(closed.realized, -8268);
  assert.equal(closed.cash, 9_991_732);
  assert.deepEqual(open, saved);
  const restored = paperAccountSchema.parse(JSON.parse(JSON.stringify(closed)));
  assert.deepEqual(restored, closed);
  const history = paperTradeHistory(restored);
  assert.equal(history.completed[0].costModel, "INDIA_FLAT20_V2");
  assert.equal(history.completed[0].realized, -8268);
  const result = paperPerformance(restored);
  assert.equal(result.itemizedFills, 2);
  assert.equal(result.legacyFills, 0);
  assert.equal(result.modeledFills, 0);
  assert.equal(result.cohorts.itemized.netRealized, -8268);
  assert.equal(result.itemizedCharges.brokerage, 4000);
  assert.equal(result.itemizedCharges.stt, 2500);
  assert.equal(result.itemizedCharges.total, result.fees);
  const partial = fillPaperOrder(open, quote, "SELL", 500, now, undefined, "LIMIT", { costAware: true, limitPrice: 100 });
  const final = fillPaperOrder(partial, quote, "SELL", 500, now, undefined, "LIMIT", { costAware: true, limitPrice: 100 });
  assert.equal(paperPerformance(final).itemizedCharges.brokerage, 6000);
  assert.equal(paperTradeHistory(final).completed.length, 1);
  const old = fill(newPaperAccount(), "BUY", 10, 100);
  const mixed = fillPaperOrder(old, { ...quote, price: 110 }, "SELL", 10, now, undefined, "LIMIT", { costAware: true, limitPrice: 110 });
  assert.equal(paperPerformance(mixed).cohorts.mixed.sampleSize, 1);
  assert.equal(paperPerformance(mixed).cohorts.itemized.sampleSize, 0);
  assert.equal(mixed.fills[0].fees, 100);
  for (const charges of [undefined, { ...closed.fills[1].charges, gst: 0 }]) {
    assert.equal(paperAccountSchema.safeParse({ ...closed, fills: [closed.fills[0], { ...closed.fills[1], charges }] }).success, false);
  }
});

test("a high win score can coexist with negative expectancy and a low profit factor", () => {
  let account = newPaperAccount();
  for (const exit of [101, 101, 101, 90]) {
    account = fill(account, "BUY", 1, 100, false);
    account = fill(account, "SELL", 1, exit, false);
  }
  const performance = paperPerformance(account);
  assert.equal(performance.score, 75);
  assert.equal(performance.sampleSize, 4);
  assert.equal(performance.insufficientEvidence, true);
  assert.equal(performance.expectancy, -175);
  assert.equal(performance.averageWinner, 100);
  assert.equal(performance.averageLoser, -1000);
  assert.equal(performance.profitFactor, 0.3);
  assert.equal(performance.maxDrawdown, 1000);
  assert.equal(performance.maxDrawdownPercent, 1000 / 10000300 * 100);
});

test("realized-equity drawdown includes entry fees, partial exits and open cycles, not only closed trades", () => {
  let account = fill(newPaperAccount(), "BUY", 2, 100);
  account = fill(account, "SELL", 1, 110);
  account = fill(account, "SELL", 1, 90);
  account = fill(account, "BUY", 1, 100);
  const performance = paperPerformance(account);
  // -20 entry fee, +989 partial profit, -1009 last exit, -10 fee on the still-open cycle.
  assert.equal(performance.maxDrawdown, 1019);
  assert.equal(performance.maxDrawdownPercent, 1019 / 10000969 * 100);
  assert.equal(performance.realizedEquity, 9999950);
  assert.equal(performance.partialRealized, -10);
  assert.equal(performance.netRealized, -40);
  assert.equal(performance.sampleSize, 1);
});

test("empty, break-even and no-loss samples do not invent expectancy or an infinite profit factor", () => {
  const empty = paperPerformance(newPaperAccount());
  assert.equal(empty.score, null);
  assert.equal(empty.expectancy, null);
  assert.equal(empty.profitFactor, null);
  let account = fill(newPaperAccount(), "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 100, false);
  assert.equal(paperPerformance(account).breakEven, 1);
  assert.equal(paperPerformance(account).profitFactor, null);
  account = fill(account, "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 110, false);
  const result = paperPerformance(account);
  assert.equal(result.score, 50);
  assert.equal(result.expectancy, 500);
  assert.equal(result.profitFactor, null);
});

test("fee and ledger mismatches cannot produce a performance-shaped fallback", () => {
  let account = fill(newPaperAccount(), "BUY", 2, 100);
  account = fill(account, "SELL", 1, 110);
  assert.throws(() => paperPerformance({ ...account, realized: account.realized + 1 }), /cannot be reconciled/);
  assert.throws(() => paperPerformance({
    ...account, fills: account.fills.map((item, index) => index ? { ...item, fees: item.fees + 1 } : item),
  }), /cannot be reconciled/);
});

test("daily P&L groups net fill results by IST date including entry fees and partial exits", () => {
  let account = fill(newPaperAccount(), "BUY", 2, 100);
  account = fill(account, "SELL", 1, 110);
  account = fill(account, "SELL", 1, 90);
  account = fill(account, "BUY", 1, 100);
  account = paperAccountSchema.parse({
    ...account,
    fills: account.fills.map((item, index) => ({
      ...item, at: Date.parse([
        "2026-11-17T10:30:00+05:30", "2026-11-18T10:30:00+05:30",
        "2026-11-18T11:30:00+05:30", "2026-11-19T10:30:00+05:30",
      ][index]),
    })),
  });
  const snapshot = structuredClone(account);
  const history = paperTradeHistory(account);
  assert.deepEqual(history.daily, [
    { date: "2026-11-19", profit: 0, loss: 10, netRealized: -10, fees: 10, fills: 1 },
    { date: "2026-11-18", profit: 989, loss: 1009, netRealized: -20, fees: 20, fills: 2 },
    { date: "2026-11-17", profit: 0, loss: 20, netRealized: -20, fees: 20, fills: 1 },
  ]);
  assert.equal(history.daily.reduce((sum, day) => sum + day.netRealized, 0), account.realized);
  assert.equal(history.daily.reduce((sum, day) => sum + day.fees, 0), 50);
  assert.equal(history.realized + history.partialRealized, account.realized);
  assert.deepEqual(account, snapshot);
});

test("daily results use IST boundaries rather than UTC or server-local dates and retain zero-result days", () => {
  let account = fill(newPaperAccount(), "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 100, false);
  account = paperAccountSchema.parse({
    ...account, fills: account.fills.map((item, index) => ({
      ...item, at: Date.parse(index ? "2026-11-17T18:30:00Z" : "2026-11-17T18:29:59Z"),
    })),
  });
  assert.deepEqual(paperTradeHistory(account).daily, [
    { date: "2026-11-18", profit: 0, loss: 0, netRealized: 0, fees: 0, fills: 1 },
    { date: "2026-11-17", profit: 0, loss: 0, netRealized: 0, fees: 0, fills: 1 },
  ]);
  assert.deepEqual(paperTradeHistory(newPaperAccount()).daily, []);
  assert.throws(() => paperTradeHistory({ ...account, realized: 1 }), /cannot be reconciled/);
});

test("daily P&L isolates CASH and F&O and reconciles combined segment results", () => {
  let account = fill(newPaperAccount(), "BUY", 1, 100, false);
  account = fill(account, "SELL", 1, 110, false);
  const instrument = { exchange: "NSE", tradingSymbol: "TEST26NOVFUT", growwSymbol: "NSE-TEST26NOVFUT",
    underlying: "TEST", instrumentType: "FUT", expiry: "2026-11-26", strikePrice: null, lotSize: 10, tickSize: 0.05 };
  const quote = { symbol: instrument.tradingSymbol, exchange: "NSE", product: "NRML", segment: "FNO",
    instrument, price: 100, tradeTime: now };
  account = fillPaperOrder(account, quote, "SELL", 10, now);
  account = fillPaperOrder(account, { ...quote, price: 110 }, "BUY", 10, now);
  assert.deepEqual(paperTradeHistory(account, "CASH").daily, [
    { date: "2026-11-17", profit: 1000, loss: 0, netRealized: 1000, fees: 0, fills: 2 },
  ]);
  assert.deepEqual(paperTradeHistory(account, "FNO").daily, [
    { date: "2026-11-17", profit: 0, loss: 10000, netRealized: -10000, fees: 0, fills: 2 },
  ]);
  assert.deepEqual(paperTradeHistory(account).daily, [
    { date: "2026-11-17", profit: 1000, loss: 10000, netRealized: -9000, fees: 0, fills: 4 },
  ]);
});
