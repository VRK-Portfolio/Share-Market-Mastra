import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMarketDepth, calculatePriceActionConfluence } from "../src/lib/market/price-action-confluence.ts";
import { calculateTechnicalVerdict } from "../src/lib/market/technical-verdict.ts";
import { newsSentimentSchema } from "../src/lib/market/news-sentiment.ts";

const now = Date.parse("2026-11-17T10:00:00+05:30");
function fixture(bearish = false) {
  const candles = [];
  for (let date = Date.parse("2026-11-10T09:15:00+05:30"); date < now; date += 86_400_000) {
    if ([0, 6].includes(new Date(date).getUTCDay())) continue;
    for (let slot = 0; slot < 25; slot++) {
      const time = date + slot * 900_000;
      if (time >= now) break;
      candles.push({ time: time / 1000, open: 100, close: 100, high: 101, low: 99, volume: 100 });
    }
  }
  Object.assign(candles.at(-3), { open: 100, close: 100.5, high: 101, low: 99 });
  Object.assign(candles.at(-2), { open: 100.5, close: 100.4, high: 101, low: 99.5 });
  Object.assign(candles.at(-1), { open: 100.4, close: 102, high: 102.3, low: 100.3, volume: 200 });
  if (bearish) for (const bar of candles) {
    const { open, high, low, close } = bar;
    Object.assign(bar, { open: 200 - open, close: 200 - close, high: 200 - low, low: 200 - high });
  }
  return {
    symbol: "ADANIPORTS", exchange: "NSE", segment: "CASH", interval: "15minute", fetchedAt: new Date(now).toISOString(),
    quote: { price: bearish ? 98 : 102, previousClose: 100, open: 100, high: 103, low: 97,
      volume: 1000, change: null, changePercent: null, lastTradeTime: now },
    candles, technical: { vwap: null, rsi: null, atr: null, ema20: null, ema50: null,
      macd: null, supertrend: null, overlays: { vwap: [], ema20: [], supertrend: [] } },
  };
}
const run = (data, benchmark = null, at = now, mode = "MIS") =>
  calculatePriceActionConfluence(data, mode, benchmark, at);
function depth(data, opposing = false) {
  const mid = data.quote.price;
  return { ...data, quote: { ...data.quote, depthFetchedAt: new Date(now).toISOString(), depth: {
    buy: Array.from({ length: 5 }, (_, i) => ({ price: mid - 0.01 * (i + 1), quantity: opposing ? 100 : 200 })),
    sell: Array.from({ length: 5 }, (_, i) => ({ price: mid + 0.01 * (i + 1), quantity: opposing ? 200 : 100 })),
  } } };
}
const benchmark = (price = 101) => ({
  symbol: "TESTSECTOR", name: "Test sector", exchange: "NSE", price, previousClose: 100,
  lastTradeTime: now, fetchedAt: new Date(now).toISOString(),
});

test("news integrates as a fresh opposing veto, never an independent entry or override of raw price/volume requirements", () => {
  const news = (bias) => newsSentimentSchema.parse({
    symbol: "ADANIPORTS", exchange: "NSE", companyName: "Adani Ports", provider: "GNews", model: "test-model",
    fetchedAt: new Date(now).toISOString(), bias,
    articles: [1, 2].map((id) => ({
      id: `h${id}`, title: `Company development ${id}`, url: `https://publisher.example/${id}`, source: "Test",
      publishedAt: new Date(now).toISOString(), relevant: true,
      tone: bias === "BULLISH" ? "POSITIVE" : "NEGATIVE", explanation: "Company-specific development.",
    })),
  });
  for (const bearish of [false, true]) {
    const data = fixture(bearish);
    const aligned = news(bearish ? "BEARISH" : "BULLISH");
    const opposing = news(bearish ? "BULLISH" : "BEARISH");
    assert.equal(calculatePriceActionConfluence(data, "MIS", null, now, aligned).action, bearish ? "CONDITIONAL SELL" : "CONDITIONAL BUY");
    const blocked = calculatePriceActionConfluence(data, "MIS", null, now, opposing);
    assert.equal(blocked.action, "WAIT");
    assert.match(blocked.reasons.at(-1), /news sentiment opposes/);
    data.candles.at(-1).volume = 100;
    assert.equal(calculatePriceActionConfluence(data, "MIS", null, now, aligned).action, "WAIT");
  }
  const data = fixture();
  const old = news("BEARISH");
  old.fetchedAt = new Date(now - 900_001).toISOString();
  const unconfirmed = calculatePriceActionConfluence(data, "MIS", null, now, old);
  assert.equal(unconfirmed.action, "CONDITIONAL BUY");
  assert.ok(unconfirmed.missing.some((reason) => /15 minutes/.test(reason)));
});

test("independent closed-price ORB verdicts support both sides without needing or changing lagging indicators", () => {
  for (const bearish of [false, true]) {
    const data = fixture(bearish);
    const before = calculateTechnicalVerdict(data, "MIS", now);
    const verdict = run(data);
    assert.equal(verdict.action, bearish ? "CONDITIONAL SELL" : "CONDITIONAL BUY");
    assert.deepEqual(verdict.openingRange, { high: 101, low: 99 });
    assert.equal(verdict.volume.ratio, 2);
    assert.equal(verdict.boundary.price, bearish ? 99 : 101);
    assert.equal(verdict.confirmedAt, now);
    assert.equal(before.decision, "HOLD");
    assert.deepEqual(calculateTechnicalVerdict(data, "MIS", now), before);
    assert.ok(verdict.missing.some((reason) => /Market-wide/.test(reason)));
    assert.ok(verdict.missing.some((reason) => /Executed order flow/.test(reason)));
  }
});

test("30-minute opening range and price setups never use unfinished candles or pre-09:45 data", () => {
  const data = fixture();
  for (const time of ["09:44:59", "09:45:00", "09:59:59"]) {
    const at = Date.parse(`2026-11-17T${time}+05:30`);
    const forming = { ...data, fetchedAt: new Date(at).toISOString(), quote: { ...data.quote, lastTradeTime: at } };
    const verdict = run(forming, null, at);
    assert.equal(verdict.action, "WAIT");
    if (time !== "09:44:59") assert.deepEqual(verdict.openingRange, { high: 101, low: 99 });
  }
  const future = { ...data.candles.at(-1), time: now / 1000, close: 10000, high: 10001, low: 1 };
  assert.deepEqual(run({ ...data, candles: [...data.candles, future] }), run(data));
});

test("breakout volume compares the same completed time slot in five prior sessions and does not fill missing volume", () => {
  for (const volume of [150, 149, 0, null]) {
    const data = fixture();
    data.candles.at(-1).volume = volume;
    assert.equal(run(data).action, volume === 150 ? "CONDITIONAL BUY" : "WAIT");
  }
  const missing = fixture();
  const slot = missing.candles.at(-1).time - missing.candles.at(-3).time;
  const previousSameSlot = missing.candles.filter((bar) => bar.time < missing.candles.at(-3).time &&
    (bar.time - missing.candles[0].time) % 86400 === slot).at(-1);
  previousSameSlot.volume = null;
  assert.equal(run(missing).action, "WAIT");
  assert.match(run(missing).volume.reason, /missing/);
  const insufficient = fixture();
  insufficient.candles = insufficient.candles.slice(25);
  assert.equal(run(insufficient).volume.samples, 4);
  assert.equal(run(insufficient).action, "WAIT");
});

test("rejection wicks and engulfing only qualify at previously observed structural bands", () => {
  const near = fixture();
  Object.assign(near.candles.at(-1), { open: 100.6, close: 100.5, high: 100.7, low: 99.05 });
  near.quote.price = 100.5;
  assert.equal(run(near).action, "CONDITIONAL BUY");
  assert.ok(run(near).patterns.includes("Bullish rejection wick"));
  const far = fixture();
  Object.assign(far.candles.at(-1), { open: 100.7, close: 100.6, high: 100.8, low: 99.6 });
  far.quote.price = 100.6;
  assert.ok(run(far).patterns.includes("Bullish rejection wick"));
  assert.equal(run(far).action, "WAIT");
  const engulf = fixture();
  Object.assign(engulf.candles.at(-1), { open: 100.3, close: 100.8, high: 100.9, low: 99.05 });
  engulf.quote.price = 100.8;
  assert.ok(run(engulf).patterns.includes("Bullish body engulfing"));
  assert.equal(run(engulf).action, "CONDITIONAL BUY");
});

test("inside bars alone wait; a closed mother-range break at a structural level can qualify", () => {
  const data = fixture();
  Object.assign(data.candles.at(-1), { open: 100, close: 100.2, high: 100.8, low: 99.7 });
  data.quote.price = 100.2;
  assert.equal(run(data).action, "WAIT");
  assert.ok(run(data).patterns.some((pattern) => pattern.startsWith("Inside bar:")));
  data.candles.push({ time: now / 1000, open: 100.2, close: 102, high: 102.3, low: 100.1, volume: 200 });
  const at = now + 900_000;
  data.fetchedAt = new Date(at).toISOString();
  data.quote = { ...data.quote, price: 102, lastTradeTime: at };
  assert.equal(run(data, null, at).action, "CONDITIONAL BUY");
  assert.ok(run(data, null, at).patterns.some((pattern) => pattern.startsWith("Inside-bar upside break")));
});

test("five-level REST depth is sorted and summed, and cannot be refreshed by a new LTP timestamp", () => {
  const data = depth(fixture());
  data.quote.depth.buy.reverse();
  const book = assessMarketDepth(data.quote, now);
  assert.equal(book.available, true);
  assert.equal(book.bidQuantity, 1000);
  assert.equal(book.askQuantity, 500);
  assert.equal(book.pressure, "BULLISH");
  assert.ok(book.bids[0].price > book.bids[1].price);
  assert.equal(assessMarketDepth(data.quote, now + 15_000).available, true);
  assert.equal(assessMarketDepth({ ...data.quote, lastTradeTime: now + 15_001 }, now + 15_001).available, false);
  data.quote.depth.buy.pop();
  assert.equal(assessMarketDepth(data.quote, now).available, false);
});

test("known opposing benchmark/depth or a wide spread blocks a setup; unavailable context stays explicitly conditional", () => {
  assert.equal(run(depth(fixture()), benchmark()).action, "CONDITIONAL BUY");
  assert.equal(run(depth(fixture()), benchmark(99)).action, "WAIT");
  assert.equal(run(depth(fixture(), true), benchmark()).action, "WAIT");
  const wide = depth(fixture());
  wide.quote.depth.buy.forEach((level) => { level.price -= 1; });
  wide.quote.depth.sell.forEach((level) => { level.price += 1; });
  assert.equal(run(wide).action, "WAIT");
  const locked = depth(fixture());
  locked.quote.depth.sell[0].price = locked.quote.depth.buy[0].price;
  assert.equal(run(locked).depth.available, false);
  assert.equal(run(locked).action, "CONDITIONAL BUY");
  const staleBenchmark = { ...benchmark(99), lastTradeTime: now - 60_001 };
  assert.equal(run(fixture(), staleBenchmark).action, "CONDITIONAL BUY");
  assert.equal(run(fixture(), staleBenchmark).sector.available, false);
});

test("missing opening bars, stale quotes/history, failed breakouts and unsupported modes never authorize confluence entries", () => {
  const data = fixture();
  assert.equal(run({ ...data, candles: data.candles.filter((_, index) => index !== data.candles.length - 2) }).action, "WAIT");
  assert.equal(run({ ...data, omittedCandles: 1 }).action, "WAIT");
  assert.equal(run({ ...data, quote: { ...data.quote, lastTradeTime: now - 60_001 } }).action, "WAIT");
  assert.equal(run({ ...data, quote: { ...data.quote, price: 100.9 } }).action, "WAIT");
  assert.equal(run(data, null, now, "CNC").action, "WAIT");
  assert.equal(run({ ...data, segment: "FNO" }).action, "WAIT");
  assert.equal(run({ ...data, interval: "1hour" }).action, "WAIT");
  const at = now + 900_001;
  assert.equal(run({ ...data, fetchedAt: new Date(at).toISOString(), quote: { ...data.quote, lastTradeTime: at } }, null, at).action, "WAIT");
});
