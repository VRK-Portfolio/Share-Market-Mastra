import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fillPaperOrder, newPaperAccount, paperAccountSchema, paperPositionMark, paperRequiredMargin } from "../src/lib/market/paper-trading.ts";
import { nextPaperProcessing, placePaperOrder, processPaperOrders } from "../src/lib/market/paper-orders.ts";
import { paperTradeHistory } from "../src/lib/market/paper-history.ts";
import { assertPaperEntryRisk, paperRiskReport } from "../src/lib/market/paper-risk.ts";
import { paperPriceKey } from "../src/lib/market/paper-instruments.ts";

const now = Date.parse("2026-11-17T11:30:00+05:30");
const instrument = { exchange: "NSE", tradingSymbol: "TEST99NOVFUT", growwSymbol: "NSE-TEST-23Nov99-FUT",
  underlying: "TEST", instrumentType: "FUT", expiry: "2099-11-23", strikePrice: null, lotSize: 10, tickSize: 0.05 };
const quote = (changes = {}) => ({ symbol: instrument.tradingSymbol, exchange: "NSE", product: "MIS", segment: "FNO",
  instrument, price: 100, tradeTime: now, ...changes });
const tick = q => ({ ...q, receivedAt: new Date(now).toISOString(), observedAt: now, paperQuoteProof: "synthetic-proof" });
const fill = (account, side = "BUY", quantity = 10, changes = {}, protection = { targetPrice: 110, stopPrice: 99 }) =>
  fillPaperOrder(account, quote(changes), side, quantity, now, randomUUID(), "MARKET", { costAware: true, protection });

test("futures longs and shorts fund full notional in MIS/NRML and P&L multiplies contract units only once", () => {
  for (const product of ["MIS", "NRML"]) for (const side of ["BUY", "SELL"]) {
    const opened = fill(newPaperAccount(), side, 10, { product },
      side === "BUY" ? { targetPrice: 110, stopPrice: 99 } : { targetPrice: 90, stopPrice: 101 });
    const position = opened.positions[0];
    assert.equal(position.margin, position.basis);
    assert.equal(paperRequiredMargin(product, 100000, "FNO"), 100000);
    assert.equal(paperPositionMark(position, tick(quote({ price: 105 })), now).pnl,
      (side === "BUY" ? 1 : -1) * (105000 - position.basis));
    const closed = fill(opened, side === "BUY" ? "SELL" : "BUY", 10, { product, price: 105 }, undefined);
    assert.equal(closed.cash, closed.initialBalance + closed.realized);
    assert.equal(paperTradeHistory(closed).completed.length, 1);
    assert.equal(closed.positions.length, 0);
    assert.ok(paperAccountSchema.safeParse(closed).success);
  }
});

test("options reserve full premium, reject uncovered SELL, support partial lots and retain linked protection", () => {
  for (const instrumentType of ["CE", "PE"]) {
    const option = { ...instrument, instrumentType, strikePrice: 100, tradingSymbol: `TEST99NOV100${instrumentType}` };
    const changes = { symbol: option.tradingSymbol, instrument: option, product: "NRML" };
    assert.throws(() => fill(newPaperAccount(), "SELL", 10, changes), /exit-only/);
    const opened = fill(newPaperAccount(), "BUY", 20, changes);
    assert.equal(opened.positions[0].margin, 200100);
    const partial = fill(opened, "SELL", 10, { ...changes, price: 105 }, undefined);
    assert.equal(partial.positions[0].quantity, 10);
    assert.equal(partial.orders[0].quantity, 10);
    assert.equal(paperTradeHistory(partial, "FNO").completed.length, 0);
    const closed = fill(partial, "SELL", 10, { ...changes, price: 110 }, undefined);
    assert.equal(paperTradeHistory(closed, "FNO").completed[0].realized, closed.realized);
    assert.throws(() => fill(opened, "SELL", 30, changes, undefined), /Close no more/);
  }
});

test("contract lots, ticks, expiry and product validation cannot be bypassed with legacy execution options", () => {
  assert.throws(() => fill(newPaperAccount(), "BUY", 1), /whole-lot/);
  assert.throws(() => fill(newPaperAccount(), "BUY", 10, {}, { targetPrice: 110.01, stopPrice: 99 }), /tick size/);
  assert.throws(() => fill(newPaperAccount(), "BUY", 10, { product: "CNC" }), /matching product/);
  assert.throws(() => fill(newPaperAccount(), "BUY", 10, { instrument: { ...instrument, expiry: "2020-01-01" } }), /expired/);
  assert.throws(() => fillPaperOrder(newPaperAccount(), quote(), "BUY", 1, now), /whole-lot/);
});

test("shared cash, history and live marks remain segment-isolated even for the same trading symbol", () => {
  const cashQuote = { ...quote(), segment: "CASH", instrument: undefined, product: "MIS" };
  let account = fillPaperOrder(newPaperAccount(), cashQuote, "BUY", 10, now);
  account = fill(account);
  assert.equal(account.positions.length, 2);
  assert.equal(paperPositionMark(account.positions[0], tick(quote()), now), null);
  assert.equal(paperPositionMark(account.positions[1], tick(cashQuote), now), null);
  assert.equal(paperRiskReport(account, { [paperPriceKey(quote())]: tick(quote()) }, now).equity, null);
  account = fill(account, "SELL", 10, { price: 105 }, undefined);
  assert.equal(account.positions.length, 1);
  assert.equal(paperTradeHistory(account, "FNO").completed.length, 1);
  assert.equal(paperTradeHistory(account, "CASH").rows.length, 1);
  assert.equal(paperTradeHistory(account, "CASH").completed.length, 0);
  assert.ok(paperAccountSchema.safeParse(account).success);
});

test("contract limits reserve full fees and notional, respect price limits and automatically attach protective exits", () => {
  const pending = placePaperOrder(newPaperAccount(), {
    symbol: instrument.tradingSymbol, exchange: "NSE", segment: "FNO", product: "NRML", side: "BUY",
    quantity: 10, kind: "LIMIT", limitPrice: 100, protection: { targetPrice: 110, stopPrice: 99 },
  }, now, randomUUID(), { costAware: true, instrument });
  assert.equal(pending.orders[0].reservedCash, 100100);
  const filled = processPaperOrders(pending, quote(), now, { costAware: true, tickSize: instrument.tickSize });
  assert.equal(filled.fills[0].price, 10000);
  assert.equal(filled.positions[0].margin, 100000);
  const closed = processPaperOrders(filled, quote({ price: 110 }), now, { costAware: true, tickSize: instrument.tickSize });
  assert.equal(closed.positions.length, 0);
  assert.equal(closed.fills[1].reason, "TARGET");
  assert.equal(closed.fills[1].segment, "FNO");
  const wrongSegment = processPaperOrders(filled, { ...quote({ price: 110 }), segment: "CASH", instrument: undefined }, now, { costAware: true });
  assert.equal(wrongSegment.positions.length, 1);
});

test("expiry-day NRML square-off uses observed contract prices and never fabricates settlement afterward", () => {
  const expiry = { ...instrument, expiry: "2026-11-17" };
  const opened = fill(newPaperAccount(), "BUY", 10, { product: "NRML", instrument: expiry });
  const cutoff = Date.parse("2026-11-17T15:20:00+05:30");
  const q = quote({ product: "NRML", instrument: expiry, tradeTime: cutoff });
  const command = nextPaperProcessing(opened, { [paperPriceKey(q)]: { ...tick(q), observedAt: cutoff, receivedAt: new Date(cutoff).toISOString() } }, cutoff);
  assert.equal(command.segment, "FNO");
  const closed = processPaperOrders(opened, q, cutoff, { costAware: true });
  assert.equal(closed.fills[1].reason, "SQUARE_OFF");
  assert.equal(closed.positions.length, 0);
  assert.throws(() => fillPaperOrder(newPaperAccount(), q, "BUY", 10, cutoff), /expiry day/);
});

test("risk concentration combines futures and option premium exposure for the same underlying", () => {
  const opened = fill(newPaperAccount(), "BUY", 100);
  const option = { ...instrument, instrumentType: "CE", strikePrice: 100, tradingSymbol: "TEST99NOV100CE" };
  const next = fill(opened, "BUY", 100, { symbol: option.tradingSymbol, instrument: option });
  const prices = { [paperPriceKey(quote())]: tick(quote()),
    [paperPriceKey(quote({ symbol: option.tradingSymbol }))]: tick(quote({ symbol: option.tradingSymbol })) };
  assert.throws(() => assertPaperEntryRisk(opened, next, { symbol: option.tradingSymbol,
    underlying: "TEST", side: "BUY", quantity: 100, price: 100.05, stop: 99, tickSize: 0.05 }, prices, now), /20%/);
});
