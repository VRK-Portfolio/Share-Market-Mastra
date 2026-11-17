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
