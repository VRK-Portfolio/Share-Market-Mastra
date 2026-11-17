import type { FeedSelection, LiveTick } from "../groww/live-schemas.ts";

export type ObservedPrice = LiveTick & { observedAt: number };
export const livePriceKey = ({ exchange, segment, symbol }: FeedSelection) => `${exchange}:${segment}:${symbol}`;

export function freshLivePrice(tick: ObservedPrice | undefined, now = Date.now()): tick is ObservedPrice {
  if (!tick || !Number.isFinite(tick.price) || tick.price <= 0 ||
    !Number.isFinite(tick.observedAt) || !Number.isSafeInteger(tick.tradeTime)) return false;
  const ageAtReceipt = Date.parse(tick.receivedAt) - tick.tradeTime;
  return Number.isFinite(ageAtReceipt) && ageAtReceipt >= -5000 &&
    ageAtReceipt + Math.max(0, now - tick.observedAt) <= 60_000;
}

export function portfolioLiveMark(selection: FeedSelection, quantity: number, entryPrice: number,
  tick: ObservedPrice | undefined, now = Date.now()) {
  if (!Number.isFinite(quantity) || quantity === 0 || !Number.isFinite(entryPrice) || entryPrice < 0 ||
    !freshLivePrice(tick, now) || livePriceKey(tick) !== livePriceKey(selection)) return null;
  const entryValue = Math.abs(quantity) * entryPrice;
  const value = Math.abs(quantity) * tick.price;
  const pnl = quantity * (tick.price - entryPrice);
  const percent = entryValue > 0 ? pnl / entryValue * 100 : null;
  if (![entryValue, value, pnl].every(Number.isFinite) || percent !== null && !Number.isFinite(percent)) return null;
  return { price: tick.price, entryValue, value, pnl, percent };
}

export function portfolioLiveTotals(marks: readonly ReturnType<typeof portfolioLiveMark>[]) {
  const priced = marks.filter(mark => mark !== null);
  const pnl = priced.reduce((total, mark) => total + mark.pnl, 0);
  const entryValue = priced.reduce((total, mark) => total + mark.entryValue, 0);
  const complete = priced.length === marks.length && Number.isFinite(pnl) && Number.isFinite(entryValue);
  const percent = complete && entryValue > 0 ? pnl / entryValue * 100 : null;
  return {
    count: marks.length,
    pricedCount: priced.length,
    pnl: complete ? pnl : null,
    percent: percent !== null && Number.isFinite(percent) ? percent : null,
  };
}
