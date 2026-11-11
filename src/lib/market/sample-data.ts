import type { Candle, Interval, Quote } from "./types";

const sessionDates: number[] = [];
const date = new Date("2026-11-10T03:45:00Z");
while (sessionDates.length < 100) {
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
    sessionDates.unshift(date.getTime() / 1000);
  }
  date.setUTCDate(date.getUTCDate() - 1);
}

function createCandles(interval: Interval): Candle[] {
  const barsPerDay = interval === "15minute" ? 25 : interval === "1hour" ? 7 : 1;
  const count = interval === "1hour" ? 98 : 100;
  const step = interval === "15minute" ? 900 : interval === "1hour" ? 3600 : 86400;
  const days = count / barsPerDay;
  const rawClose = (index: number) => index * 0.65 + Math.sin(index / 4) * 7 + Math.sin(index / 11) * 12;
  const offset = 2840.50 - rawClose(count - 1);
  return Array.from({ length: count }, (_, index) => {
    const close = Number((offset + rawClose(index)).toFixed(2));
    const open = Number((offset + rawClose(index - 1)).toFixed(2));
    const day = sessionDates[sessionDates.length - days + Math.floor(index / barsPerDay)];
    return {
      time: day + (index % barsPerDay) * step,
      open,
      high: Number((Math.max(open, close) + 1.4 + (index % 5) * 0.25).toFixed(2)),
      low: Number((Math.min(open, close) - 1.2 - (index % 3) * 0.3).toFixed(2)),
      close,
      volume: 42000 + (index * 7919) % 85000,
    };
  });
}

export const sampleCandles: Record<Interval, Candle[]> = {
  "15minute": createCandles("15minute"),
  "1hour": createCandles("1hour"),
  "1day": createCandles("1day"),
};

const dayCandles = sampleCandles["15minute"].slice(-25);
const previousClose = sampleCandles["15minute"].at(-26)!.close;
const price = dayCandles.at(-1)!.close;
const change = Number((price - previousClose).toFixed(2));

export const sampleQuote: Quote = {
  price,
  change,
  changePercent: Number((change / previousClose * 100).toFixed(2)),
  open: dayCandles[0].open,
  high: Math.max(...dayCandles.map((candle) => candle.high)),
  low: Math.min(...dayCandles.map((candle) => candle.low)),
  previousClose,
  volume: dayCandles.reduce((sum, candle) => sum + candle.volume, 0),
  lastTradeTime: dayCandles.at(-1)!.time * 1000,
};
