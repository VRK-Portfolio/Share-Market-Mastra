import { regularMarketSession } from "./market-session.ts";
import type { Candle } from "./types.ts";

export function closedSessionCandles<T extends Pick<Candle, "time">>(candles: T[], interval: "15minute" | "1day", cutoff: number) {
  if (!Number.isFinite(cutoff) || candles.some(bar => !Number.isFinite(bar.time) || bar.time <= 0 ||
    bar.time * 1000 > 8_640_000_000_000_000 - 86_400_000)) throw new Error("Valid candle and snapshot timestamps are required.");
  return candles.filter(bar => {
    const start = bar.time * 1000;
    const session = regularMarketSession(start);
    if (interval === "1day") return session.phase !== "weekend" && session.closesAt <= cutoff;
    return session.phase === "open" && (start - session.opensAt) % 900_000 === 0 &&
      start + 900_000 <= Math.min(cutoff, session.closesAt);
  });
}
