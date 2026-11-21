import assert from "node:assert/strict";
import { test } from "node:test";
import { blackScholes, optionImpliedVolatility, calculateOptionAnalytics } from "../src/lib/market/option-analytics.ts";
import { calculateOptionVerdict } from "../src/lib/market/option-verdict.ts";
import { calculateTechnicalVerdict } from "../src/lib/market/technical-verdict.ts";

const near = (actual, expected, tolerance = 0.00001) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
const pricing = { type: "CE", spot: 100, strike: 100, years: 1, volatility: 0.2, rate: 0.05, dividend: 0 };
const now = Date.parse("2026-11-17T11:00:00+05:30");
const instrument = {
  exchange: "NSE", tradingSymbol: "NIFTY26NOV100CE", growwSymbol: "NSE-NIFTY-23Nov26-100-CE",
  underlying: "NIFTY", instrumentType: "CE", expiry: "2026-11-23", strikePrice: 100, lotSize: 65, tickSize: 0.05,
};
function inputs(overrides = {}) {
  const years = (Date.parse("2026-11-23T15:30:00+05:30") - now) / (365 * 86400_000);
  const premium = blackScholes({ ...pricing, years, rate: 0.06 }).price;
  return { instrument, now, premium, premiumTime: now, spot: 100, spotTime: now,
    ratePercent: 6, dividendPercent: 0, ivPercent: null, entryPremium: premium, lots: 1, ...overrides };
}

test("BSM matches independent standard call/put price and Greek reference values with explicit day/percentage units", () => {
  const call = blackScholes(pricing);
  near(call.price, 10.45058357);
  near(call.delta, 0.63683065);
  near(call.gamma, 0.01876202);
  near(call.theta, -0.01757268);
  near(call.vega, 0.37524035);
  near(call.rho, 0.53232482);
  near(call.itmProbability, 0.55961769);
  const put = blackScholes({ ...pricing, type: "PE" });
  near(put.price, 5.57352602);
  near(put.delta, -0.36316935);
  near(put.theta, -0.00454214);
  near(put.rho, -0.41890461);
  near(put.gamma, call.gamma);
  near(put.vega, call.vega);
});

test("all five Greeks agree with finite differences for CE and PE with nonzero dividend yield", () => {
  for (const type of ["CE", "PE"]) {
    const input = { ...pricing, type, spot: 105, years: 0.75, volatility: 0.27, rate: 0.04, dividend: 0.018 };
    const value = blackScholes(input);
    const derivative = (key, step) => (blackScholes({ ...input, [key]: input[key] + step }).price
      - blackScholes({ ...input, [key]: input[key] - step }).price) / (2 * step);
    near(value.delta, derivative("spot", 0.01), 0.00003);
    near(value.gamma, (blackScholes({ ...input, spot: 105.02 }).price - 2 * value.price
      + blackScholes({ ...input, spot: 104.98 }).price) / 0.02 ** 2, 0.00003);
    near(value.theta, -derivative("years", 0.00001) / 365, 0.00003);
    near(value.vega, derivative("volatility", 0.00001) / 100, 0.00003);
    near(value.rho, derivative("rate", 0.00001) / 100, 0.00003);
  }
});

test("IV solver recovers CE/PE volatility across moneyness, dividends and time, and rejects unidentifiable premiums", () => {
  for (const type of ["CE", "PE"]) for (const spot of [85, 100, 120]) {
    const input = { ...pricing, type, spot, dividend: 0.025, years: 0.3, volatility: 0.34 };
    near(optionImpliedVolatility(input, blackScholes(input).price), 0.34, 0.000001);
  }
  for (const premium of [0, -1, NaN, 1, 100, 200]) assert.throws(() => optionImpliedVolatility(pricing, premium));
  assert.throws(() => blackScholes({ ...pricing, years: 0 }));
  assert.throws(() => blackScholes({ ...pricing, spot: Infinity }));
});

test("gross long-option POP uses expiry breakeven, not delta or ITM probability, and distinguishes CE/PE", () => {
  const call = calculateOptionAnalytics(inputs());
  near(call.ivPercent, 20, 0.00001);
  assert.ok(call.pop < call.itmProbability);
  assert.notEqual(call.pop, call.delta);
  near(call.breakeven, 100 + inputs().entryPremium);
  assert.equal(call.units, 65);
  const lowerEntry = calculateOptionAnalytics(inputs({ entryPremium: 0.2 }));
  assert.ok(lowerEntry.pop > call.pop);
  const put = calculateOptionAnalytics(inputs({
    instrument: { ...instrument, instrumentType: "PE", tradingSymbol: "NIFTY26NOV100PE" },
    ivPercent: 20, entryPremium: 1,
  }));
  assert.equal(put.breakeven, 99);
  assert.ok(put.delta < 0 && put.pop < put.itmProbability && put.pop > 0);
  const impossible = calculateOptionAnalytics(inputs({
    instrument: { ...instrument, instrumentType: "PE" }, ivPercent: 20, entryPremium: 100,
  }));
  assert.equal(impossible.breakeven, null);
  assert.equal(impossible.pop, 0);
  const breakEvenCall = calculateOptionAnalytics(inputs({ ivPercent: 20, entryPremium: 2 }));
  near(breakEvenCall.scenarios.find(item => item.move === 0.02).grossPnl, 0);
  near(breakEvenCall.scenarios.find(item => item.move === 0).grossPnl, -130);
});

test("live spot/premium changes recompute IV, Greeks and POP while explicit entry and IV remain independent assumptions", () => {
  const original = calculateOptionAnalytics(inputs({ entryPremium: 1 }));
  const nextPremium = blackScholes({ ...pricing, years: original.years, spot: 101, rate: 0.06, volatility: 0.3 }).price;
  const updated = calculateOptionAnalytics(inputs({ spot: 101, premium: nextPremium, entryPremium: 1 }));
  near(updated.ivPercent, 30, 0.00001);
  assert.notEqual(updated.delta, original.delta);
  assert.notEqual(updated.pop, original.pop);
  assert.equal(updated.breakeven, original.breakeven);
  const manual = calculateOptionAnalytics(inputs({ premium: nextPremium, ivPercent: 25, entryPremium: 1, lots: 3 }));
  assert.equal(manual.ivPercent, 25);
  assert.equal(manual.units, 195);
  assert.equal(manual.maxLoss, 195);
  assert.notEqual(manual.price, nextPremium);
});

test("expiry POP matches a known normal-CDF reference for both sides at the same gross breakeven", () => {
  const time = Date.parse("2026-11-17T15:30:00+05:30");
  for (const [type, strike, expected] of [["CE", 90, 0.55961769], ["PE", 110, 0.44038231]]) {
    const result = calculateOptionAnalytics(inputs({
      instrument: { ...instrument, instrumentType: type, strikePrice: strike, expiry: "2027-11-17" },
      now: time, premiumTime: time, spotTime: time, ivPercent: 20, ratePercent: 5, entryPremium: 10,
      premium: blackScholes({ ...pricing, type, strike }).price,
    }));
    near(result.years, 1);
    assert.equal(result.breakeven, 100);
    near(result.pop, expected);
  }
});

test("expiry uses 15:30 IST ACT/365 and all stale/missing/asynchronous or invalid inputs are explicitly rejected", () => {
  const expectedDays = 6 + 4.5 / 24;
  near(calculateOptionAnalytics(inputs()).days, expectedDays);
  for (const overrides of [
    { premiumTime: null }, { spotTime: null }, { spotTime: now - 60_001 }, { premiumTime: now - 60_001 },
    { spotTime: now + 5001 }, { spotTime: now - 30_001 }, { premiumTime: now - 86400_000 },
    { spot: 0 }, { premium: 0 }, { entryPremium: 0 }, { lots: 0 }, { lots: 1.5 },
    { ivPercent: 20, premium: 1000 },
    { ivPercent: 20, premium: 1, spot: 120 },
    { ratePercent: NaN }, { dividendPercent: -1 }, { ivPercent: 0 }, { ivPercent: 501 },
    { instrument: { ...instrument, instrumentType: "FUT", strikePrice: null } },
    { instrument: { ...instrument, expiry: "invalid" } },
  ]) assert.throws(() => calculateOptionAnalytics(inputs(overrides)), JSON.stringify(overrides));
  const expiry = Date.parse("2026-11-23T15:30:00+05:30");
  assert.throws(() => calculateOptionAnalytics(inputs({ now: expiry, premiumTime: expiry, spotTime: expiry })), /expired/);
  const justBefore = calculateOptionAnalytics(inputs({ now: expiry - 1000, premiumTime: expiry - 1000, spotTime: expiry - 1000, ivPercent: 20 }));
  assert.ok(justBefore.days > 0 && justBefore.days < 0.00002);
  assert.doesNotThrow(() => calculateOptionAnalytics(inputs({ premiumTime: now - 60_000, spotTime: now - 30_000 })));
});

function verdictFixture({ type = "CE", volatility = 0.2, atr = 14, rate = 0.06, strike = 25000,
  expiry = "2026-11-23", time = now, bearish = false, neutral = false } = {}) {
  const contract = { ...instrument, instrumentType: type, strikePrice: strike, expiry,
    tradingSymbol: `NIFTYFIXTURE${type}`, growwSymbol: `NSE-NIFTY-FIXTURE-${type}` };
  const price = blackScholes({ type, spot: 25000, strike, years: (Date.parse(`${expiry}T15:30:00+05:30`) - time) / (365 * 86400_000),
    volatility, rate, dividend: 0 }).price;
  const data = {
    symbol: contract.tradingSymbol, exchange: "NSE", segment: "FNO", instrument: contract, interval: "15minute",
    fetchedAt: new Date(time).toISOString(),
    quote: { price, lastTradeTime: time, previousClose: price, open: price, high: price + 10, low: price - 10,
      volume: 10000, change: 0, changePercent: 0 },
    candles: Array.from({ length: 60 }, (_, i) => ({
      time: (time - (59 - i) * 900_000) / 1000, open: price, high: price + 10, low: price - 10, close: price, volume: 100,
    })),
    technical: {
      vwap: price * (bearish ? 1.01 : 0.99), ema20: price * (bearish ? 1.02 : 0.98), ema50: price * (bearish ? 1.04 : 0.96),
      rsi: neutral ? 50 : bearish ? 40 : 60, atr,
      macd: bearish ? { value: -5, signal: -3, histogram: -2 } : { value: 5, signal: 3, histogram: 2 },
      supertrend: { value: price * (bearish ? 1.03 : 0.97), direction: bearish ? "bearish" : "bullish" },
      overlays: { vwap: [], ema20: [], supertrend: [] },
    },
  };
  const input = { instrument: contract, premium: price, premiumTime: time, now: time, spot: 25000, spotTime: time,
    ratePercent: rate * 100, dividendPercent: 0, ivPercent: null, entryPremium: price, lots: 1 };
  return { data, input };
}

test("option-aware verdict can confirm BUY for CE/PE, without mutating technical analysis or replacing its plan", () => {
  for (const type of ["CE", "PE"]) {
    const { data, input } = verdictFixture({ type });
    const original = structuredClone(data);
    const technical = calculateTechnicalVerdict(data, "MIS", now);
    const verdict = calculateOptionVerdict(data, "MIS", input, now);
    assert.equal(technical.decision, "BUY");
    assert.equal(verdict.decision, "BUY", verdict.summary);
    assert.equal(verdict.stopLoss, technical.stopLoss);
    assert.equal(verdict.target, technical.targetPrices[0]);
    assert.equal(verdict.exitOnly, false);
    assert.ok(verdict.checks.every(check => check.status === "PASS"));
    const favorable = verdict.scenarios.find(item => item.id === "favorable");
    const adverse = verdict.scenarios.find(item => item.id === "adverse");
    assert.ok(type === "CE" ? favorable.spot > input.spot : favorable.spot < input.spot);
    assert.ok(favorable.premium > adverse.premium);
    assert.deepEqual(data, original);
    assert.deepEqual(calculateTechnicalVerdict(data, "MIS", now), technical);
  }
});

test("live IV/premium sensitivity changes option-aware BUY to HOLD while technical direction stays BUY", () => {
  const normal = verdictFixture();
  const highVol = verdictFixture({ volatility: 0.5 });
  assert.equal(calculateOptionVerdict(normal.data, "MIS", normal.input, now).decision, "BUY");
  const verdict = calculateOptionVerdict(highVol.data, "MIS", highVol.input, now);
  assert.equal(verdict.technicalDecision, "BUY");
  assert.equal(verdict.decision, "HOLD");
  assert.equal(verdict.checks.find(check => check.label.startsWith("Vega:"))?.status, "FAIL");
  assert.equal(verdict.checks.find(check => check.label.startsWith("Theta:"))?.status, "PASS");
});

test("holding horizon changes decay/risk checks and too-distant targets fail despite a technical BUY", () => {
  const { data, input } = verdictFixture();
  const mis = calculateOptionVerdict(data, "MIS", input, now);
  const overnight = calculateOptionVerdict(data, "NRML", input, now);
  assert.equal(mis.decision, "BUY");
  assert.equal(mis.horizonAt, Date.parse("2026-11-17T15:30:00+05:30"));
  assert.equal(overnight.horizonAt, now + 86400_000);
  assert.equal(overnight.technicalDecision, "BUY");
  assert.equal(overnight.decision, "HOLD");
  assert.equal(overnight.checks.find(check => check.label.startsWith("Theta:"))?.status, "FAIL");
  const distant = verdictFixture({ atr: 50 });
  const rejected = calculateOptionVerdict(distant.data, "MIS", distant.input, now);
  assert.equal(rejected.technicalDecision, "BUY");
  assert.equal(rejected.decision, "HOLD");
  assert.equal(rejected.checks.find(check => check.label.startsWith("Delta / gamma:"))?.status, "FAIL");
});

test("rho adverse-rate stress can veto a technical BUY, and repricing includes nonlinear spot curvature", () => {
  const { data, input } = verdictFixture({ strike: 15000, expiry: "2027-11-17" });
  const verdict = calculateOptionVerdict(data, "MIS", input, now);
  assert.equal(verdict.technicalDecision, "BUY");
  assert.equal(verdict.decision, "HOLD");
  assert.equal(verdict.checks.find(check => check.label.startsWith("Rho:"))?.status, "FAIL");
  assert.equal(verdict.checks.find(check => check.label.startsWith("Theta:"))?.status, "PASS");
  assert.equal(verdict.checks.find(check => check.label.startsWith("Vega:"))?.status, "PASS");
  const normal = verdictFixture();
  const scenarios = calculateOptionVerdict(normal.data, "MIS", normal.input, now).scenarios;
  const price = id => scenarios.find(item => item.id === id).premium;
  assert.ok(price("favorable") + price("adverse") > 2 * price("decay"), "Convexity must not be reduced to a linear delta estimate.");
});

test("unavailable Greek data never creates BUY or blocks a fresh exit, and option risk never creates a short", () => {
  const bullish = verdictFixture();
  for (const input of [null, { ...bullish.input, spotTime: now - 61_000 },
    { ...bullish.input, instrument: { ...bullish.input.instrument, strikePrice: 24000 } }]) {
    const verdict = calculateOptionVerdict(bullish.data, "MIS", input, now);
    assert.equal(verdict.decision, "HOLD");
    assert.equal(verdict.exitOnly, false);
    assert.equal(verdict.dataReady, false);
    assert.ok(verdict.checks.some(check => check.status === "UNAVAILABLE"));
  }
  for (const type of ["CE", "PE"]) {
    const { data, input } = verdictFixture({ type, bearish: true });
    for (const model of [null, { ...input, spotTime: now - 61_000 }]) {
      const verdict = calculateOptionVerdict(data, "MIS", model, now);
      assert.equal(verdict.decision, "SELL");
      assert.equal(verdict.exitOnly, true);
      assert.equal(verdict.dataReady, true);
    }
    data.quote.lastTradeTime = now - 61_000;
    assert.equal(calculateOptionVerdict(data, "NRML", input, now).decision, "HOLD");
  }
  const mixed = verdictFixture({ neutral: true });
  assert.equal(calculateOptionVerdict(mixed.data, "MIS", mixed.input, now).decision, "HOLD");
});

test("historical entry/lots and expiry POP cannot manufacture BUY; inconsistent IV overrides show HOLD", () => {
  const { data, input } = verdictFixture();
  const baseline = calculateOptionVerdict(data, "MIS", input, now);
  assert.deepEqual(calculateOptionVerdict(data, "MIS", { ...input, entryPremium: 1, lots: 1000 }, now), baseline);
  const mismatch = calculateOptionVerdict(data, "MIS", { ...input, ivPercent: 40 }, now);
  assert.equal(mismatch.decision, "HOLD");
  assert.equal(mismatch.checks.find(check => check.label === "IV / market consistency")?.status, "FAIL");
});

test("MIS cutoff, expiry capping and terminal payoffs produce explicit finite HOLD rather than invalid Greeks", () => {
  const late = verdictFixture({ time: Date.parse("2026-11-17T15:20:00+05:30") });
  assert.equal(calculateOptionVerdict(late.data, "MIS", late.input, late.input.now).decision, "HOLD");
  for (const type of ["CE", "PE"]) {
    const nearExpiry = verdictFixture({ type, time: Date.parse("2026-11-17T15:00:00+05:30"), expiry: "2026-11-17", atr: 10 });
    const result = calculateOptionVerdict(nearExpiry.data, "NRML", nearExpiry.input, nearExpiry.input.now);
    assert.equal(result.horizonAt, Date.parse("2026-11-17T15:30:00+05:30"));
    for (const scenario of result.scenarios) {
      near(scenario.premium, Math.max(0, (type === "CE" ? 1 : -1) * (scenario.spot - 25000)));
    }
    assert.equal(result.decision, "HOLD");
  }
});
