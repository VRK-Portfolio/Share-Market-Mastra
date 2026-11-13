import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateTradeCosts, defaultFeeAssumptions, feeNames } from "../src/lib/market/trade-calculator.ts";

const plan = {
  symbol: "RELIANCE", exchange: "NSE", segment: "CASH", mode: "CNC", decision: "BUY",
  entryPrice: 100, referencePrice: 100, targetPrices: [110, 120], stopLoss: 95,
  snapshotAt: "2026-11-13T06:30:00.000Z",
};
const input = { sizing: "QUANTITY", quantity: 10, entryPrice: 100, targetPrice: 110, stopLoss: 95, entryTriggerPrice: 100 };
function fno(type = "FUT", decision = "BUY") {
  return {
    ...plan, segment: "FNO", mode: "NRML", decision,
    instrument: { tradingSymbol: plan.symbol, growwSymbol: "NSE-RELIANCE-23Nov99-FUT", exchange: "NSE",
      underlying: "RELIANCE", instrumentType: type, expiry: "2099-11-23",
      lotSize: 50, tickSize: 0.1, strikePrice: type === "FUT" ? null : 100 },
  };
}
const estimate = (selection = plan, values = input, fees = defaultFeeAssumptions(selection)) => calculateTradeCosts(selection, values, fees);

test("NSE fee defaults use current 2026 transaction/IPFT split and STT, not outdated Groww derivative tables", () => {
  assert.equal(defaultFeeAssumptions(plan).exchangePercent, 0.0030699);
  assert.equal(defaultFeeAssumptions(plan).ipftPercent, 0.0000001);
  assert.equal(defaultFeeAssumptions(fno()).exchangePercent, 0.0018299);
  assert.equal(defaultFeeAssumptions(fno()).sttSellPercent, 0.05);
  assert.equal(defaultFeeAssumptions(fno("CE")).exchangePercent, 0.0355299);
  assert.equal(defaultFeeAssumptions(fno("CE")).sttSellPercent, 0.15);
});

test("delivery costs separate statutory taxes, GST base, DP and net target/stop outcomes", () => {
  const result = estimate();
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 10);
  assert.equal(result.entryValue, 1000);
  assert.deepEqual(result.entryFees, { brokerage: 5, stt: 1, exchange: 0.03, ipft: 0, sebi: 0,
    stampDuty: 0.15, dp: 0, gst: 0.91, total: 7.09 });
  assert.equal(result.entryExposureWithFees, 1007.09);
  assert.equal(result.entryCashFlow, -1007.09);
  assert.equal(result.target.exitFees.dp, 20);
  assert.equal(result.target.exitFees.gst, 4.51);
  assert.equal(result.target.totalFees, 37.63);
  assert.equal(result.target.grossPnl, 100);
  assert.equal(result.target.netPnl, 62.37);
  assert.equal(result.stop.netPnl, -87.63);
  assert.equal(result.netRewardRisk, 62.37 / 87.63);
  assert.equal(result.approximateBreakEven, 103.77);
  assert.deepEqual(result.gtt, { quantity: 10, entryTrigger: 100, entryLimit: 100, targetTrigger: 110, stopTrigger: 95 });
});

test("intraday has buy-only stamp, sell-only STT, no DP and no GTT; short P/L is directional", () => {
  const selection = { ...plan, mode: "MIS" };
  const long = estimate(selection);
  assert.equal(long.entryFees.total, 5.97);
  assert.equal(long.entryFees.stt, 0);
  assert.equal(long.entryFees.stampDuty, 0.03);
  assert.equal(long.target.exitFees.stampDuty, 0);
  assert.equal(long.target.exitFees.dp, 0);
  assert.equal(long.gtt, null);
  const short = estimate({ ...selection, decision: "SELL" }, { ...input, targetPrice: 95, stopLoss: 110 });
  assert.equal(short.ok, true);
  assert.equal(short.target.grossPnl, 50);
  assert.equal(short.stop.grossPnl, -100);
  assert.equal(short.entryFees.stampDuty, 0);
  assert.equal(short.target.exitFees.stampDuty, 0.03);
  assert.ok(short.approximateBreakEven < input.entryPrice);
});

test("low-value equity brokerage respects the 2.5% small-order cap and DP threshold is not double counted", () => {
  const result = estimate(plan, { ...input, quantity: 1, entryPrice: 50, targetPrice: 55, stopLoss: 45, entryTriggerPrice: 50 });
  assert.equal(result.entryFees.brokerage, 1.25);
  assert.equal(result.target.exitFees.dp, 3.5);
  assert.equal(result.target.netPnl < 0, true);
  assert.ok(result.warnings.some((warning) => warning.includes("does not cover")));
  const threshold = estimate(plan, { ...input, quantity: 1, entryPrice: 90, targetPrice: 100, stopLoss: 80, entryTriggerPrice: 90 });
  assert.equal(threshold.target.exitFees.dp, 20);
  const cap = estimate(plan, { ...input, quantity: 500 });
  assert.equal(cap.entryFees.brokerage, 20);
});

test("budget sizing includes entry fees, returns the maximum whole affordable quantity and does not exceed budget", () => {
  for (const budget of [100, 1000, 1007.08, 1007.09, 100_000]) {
    const result = estimate(plan, { ...input, sizing: "BUDGET", budget });
    if (!result.ok) {
      assert.ok(budget < 1007.09 && budget < estimate(plan, { ...input, quantity: 1 }).entryExposureWithFees);
      continue;
    }
    assert.ok(result.entryExposureWithFees <= budget);
    assert.ok(result.remainingBudget >= 0);
    const next = estimate(plan, { ...input, quantity: result.quantity + 1 });
    assert.ok(next.entryExposureWithFees > budget);
  }
  assert.equal(estimate(plan, { ...input, sizing: "BUDGET", budget: 1000 }).quantity, 9);
  assert.equal(estimate(plan, { ...input, sizing: "BUDGET", budget: 1007.09 }).quantity, 10);
  assert.equal(estimate(plan, { ...input, sizing: "BUDGET", budget: 1007.08 }).quantity, 9);
  assert.equal(estimate(plan, { ...input, sizing: "BUDGET", budget: 1007.089 }).quantity, 9);
});

test("F&O uses verified units/lots and premium/notional turnover, never reports futures notional as a cash debit", () => {
  const future = estimate(fno(), { ...input, quantity: 50, targetPrice: 105 });
  assert.equal(future.ok, true);
  assert.equal(future.lots, 1);
  assert.equal(future.entryValue, 5000);
  assert.equal(future.entryCashFlow, null);
  assert.equal(future.entryFees.total, 23.82);
  assert.equal(future.target.exitFees.stt, 3);
  assert.equal(future.target.netPnl, 199.45);
  assert.equal(future.gtt, null);
  const options = estimate(fno("CE"), { ...input, quantity: 50 });
  assert.equal(options.entryFees.brokerage, 20);
  assert.equal(options.entryFees.total, 25.86);
  assert.equal(options.target.exitFees.stt, 8);
  assert.equal(options.target.exitFees.dp, 0);
  assert.equal(options.target.netPnl, 440.23);
  assert.equal(options.gtt, null);
  for (const budget of [5023.81, 5023.82, 10_047.64]) {
    const result = estimate(fno(), { ...input, sizing: "BUDGET", budget });
    if (!result.ok) { assert.equal(budget, 5023.81); continue; }
    assert.equal(result.quantity % 50, 0);
    assert.ok(result.entryExposureWithFees <= budget);
    const next = estimate(fno(), { ...input, quantity: result.quantity + 50 });
    assert.ok(next.entryExposureWithFees > budget);
  }
});

test("F&O prices validate actual tick size and hidden unsupported GTT triggers do not invalidate cost-only scenarios", () => {
  const selection = fno();
  assert.equal(estimate(selection, { ...input, quantity: 50, entryPrice: 100.05 }).ok, false);
  assert.equal(estimate(selection, { ...input, quantity: 50, targetPrice: 110.05 }).ok, false);
  assert.equal(estimate(selection, { ...input, quantity: 50, entryTriggerPrice: 100.06 }).ok, true);
  assert.equal(estimate(selection, { ...input, quantity: 51 }).ok, false);
});

test("CNC/options SELL remains exit-only: quantities are owned units, no speculative budget, new trade plan or invented P/L", () => {
  for (const selection of [{ ...plan, decision: "SELL" }, fno("CE", "SELL"), fno("PE", "SELL")]) {
    const exitInput = { ...input, quantity: selection.instrument?.lotSize ?? 10, targetPrice: null, stopLoss: null };
    const result = estimate(selection, exitInput);
    assert.equal(result.ok, true);
    assert.equal(result.exitOnly, true);
    assert.ok(result.entryCashFlow > 0);
    assert.equal(result.target, null);
    assert.equal(result.stop, null);
    assert.equal(result.gtt, null);
    assert.equal(result.approximateBreakEven, null);
    assert.equal(estimate(selection, { ...exitInput, sizing: "BUDGET", budget: 100_000 }).ok, false);
    assert.equal(estimate(selection, { ...exitInput, targetPrice: 95 }).ok, false);
  }
});

test("manual fee overrides apply to the correct taxable base; absent BSE IPFT is an error, not a zero assumption", () => {
  const fees = { ...defaultFeeAssumptions(plan), brokerageOverride: 0, exchangePercent: 0, ipftPercent: 0,
    sebiPercent: 0, sttBuyPercent: 0, sttSellPercent: 0, stampBuyPercent: 0, dpNormal: 0, dpSmall: 0 };
  const result = estimate(plan, input, fees);
  assert.equal(result.entryFees.total, 0);
  assert.equal(result.target.netPnl, 100);
  assert.equal(result.stop.netPnl, -50);
  const bse = { ...plan, exchange: "BSE" };
  assert.equal(defaultFeeAssumptions(bse).ipftPercent, null);
  const unverified = estimate(bse);
  assert.equal(unverified.ok, false);
  assert.match(unverified.error, /verified IPFT/);
  const confirmed = estimate(bse, input, { ...defaultFeeAssumptions(bse), ipftPercent: 0 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entryFees.ipft, 0);
});

test("invalid quantities, prices, direction, rates and contracts surface errors instead of estimates", () => {
  for (const changes of [
    { quantity: 0 }, { quantity: 1.5 }, { quantity: 1_000_001 }, { entryPrice: 0 }, { entryPrice: Infinity },
    { targetPrice: 90 }, { stopLoss: 110 }, { sizing: "BUDGET", budget: 0 }, { entryTriggerPrice: 120 },
  ]) {
    const result = estimate(plan, { ...input, ...changes });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.entryValue, undefined);
  }
  assert.equal(estimate(plan, input, { ...defaultFeeAssumptions(plan), gstPercent: -1 }).ok, false);
  assert.equal(estimate({ ...fno(), instrument: undefined }).ok, false);
  assert.equal(defaultFeeAssumptions({ ...fno(), instrument: undefined }), null);
  assert.equal(estimate({ ...plan, mode: "NRML" }).ok, false);
});

test("HOLD cost illustrations never create GTT, and blank target/stop do not fabricate P/L", () => {
  const selection = { ...plan, decision: "HOLD", entryPrice: null, targetPrices: [], stopLoss: null };
  const result = estimate(selection, { ...input, targetPrice: null, stopLoss: null });
  assert.equal(result.ok, true);
  assert.equal(result.target, null);
  assert.equal(result.stop, null);
  assert.equal(result.gtt, null);
  assert.ok(result.warnings.some((warning) => warning.includes("HOLD")));
});

test("fee totals and scenario net P/L reconcile exactly at paise precision without leaking any order execution behavior", () => {
  for (const selection of [plan, { ...plan, mode: "MIS" }, fno(), fno("CE")]) {
    const result = estimate(selection, { ...input, quantity: selection.instrument?.lotSize ?? 123 });
    for (const fees of [result.entryFees, result.target.exitFees, result.stop.exitFees]) {
      assert.equal(Math.round(feeNames.reduce((sum, key) => sum + fees[key], 0) * 100), Math.round(fees.total * 100));
    }
    assert.equal(Math.round((result.target.grossPnl - result.target.totalFees) * 100), Math.round(result.target.netPnl * 100));
    assert.equal(Math.round((result.stop.grossPnl - result.stop.totalFees) * 100), Math.round(result.stop.netPnl * 100));
  }
});
