import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import type { MarketAnalysis } from "./types.ts";

type ScenarioRow = { minutes: 15 | 30; endsAt: string } & (
  { available: true; lowerPrice: number; upperPrice: number } |
  { available: false; reason: string }
);
export type ShortTermScenarios =
  | { available: false; reason: string }
  | { available: true; bias: "BULLISH" | "BEARISH" | "NEUTRAL"; referencePrice: number;
    atr: number; snapshotAt: string; rows: ScenarioRow[] };

export function calculateShortTermScenarios(analysis: MarketAnalysis | null, now = Date.now()): ShortTermScenarios {
  if (!analysis) return { available: false, reason: "A verified 15-minute market snapshot is required." };
  if (analysis.interval !== "15minute") return { available: false, reason: "Hourly/daily ATR cannot be substituted for 15-minute ATR." };
  const verdict = calculateTechnicalVerdict(analysis, "MIS", now);
  const atr = analysis.technical.atr;
  if (!verdict.dataReady || atr === null || atr <= 0 || !analysis.fetchedAt) {
    return { available: false, reason: verdict.reasons.join(" ") || "A positive 15-minute ATR and fresh quote/candles are required." };
  }
  const ist = new Date(now + 330 * 60_000);
  const minuteOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (ist.getUTCDay() === 0 || ist.getUTCDay() === 6 || minuteOfDay < 9 * 60 + 15 || minuteOfDay >= 15 * 60 + 30) {
    return { available: false, reason: "Short-term scenarios are only shown during the regular weekday NSE/BSE session (09:15-15:30 IST)." };
  }
  const close = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 15, 30) - 330 * 60_000;
  const bias = verdict.decision === "BUY" ? "BULLISH" : verdict.decision === "SELL" ? "BEARISH" : "NEUTRAL";
  const price = analysis.quote.price;
  const tick = analysis.instrument?.tickSize ?? 0.01;
  if (!Number.isFinite(tick) || tick < 1e-8) return { available: false, reason: "Tick size is not supported for safe scenario rounding." };
  const horizons: (15 | 30)[] = [15, 30];
  const rows = horizons.map((minutes): ScenarioRow => {
    const end = now + minutes * 60_000;
    const endsAt = new Date(end).toISOString();
    if (end > close) return { minutes, endsAt, available: false, reason: "This horizon extends beyond the regular 15:30 IST session close." };
    const distance = atr * Math.sqrt(minutes / 15);
    const lower = price - distance * (bias === "BULLISH" ? 0.5 : 1);
    const upper = price + distance * (bias === "BEARISH" ? 0.5 : 1);
    const lowerTicks = Math.floor(lower / tick + 1e-9);
    const upperTicks = Math.ceil(upper / tick - 1e-9);
    const lowerPrice = Number((lowerTicks * tick).toFixed(8));
    const upperPrice = Number((upperTicks * tick).toFixed(8));
    if (!Number.isSafeInteger(lowerTicks) || !Number.isSafeInteger(upperTicks) ||
      !Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || lowerPrice <= 0 || upperPrice <= lowerPrice) {
      return { minutes, endsAt, available: false, reason: "Positive, finite scenario bounds cannot be represented safely." };
    }
    return { minutes, endsAt, available: true, lowerPrice, upperPrice };
  });
  if (!rows.some((row) => row.available)) {
    return { available: false, reason: rows.flatMap((row) =>
      row.available ? [] : [`${row.minutes}-minute: ${row.reason}`]).join(" ") };
  }
  return { available: true, bias, referencePrice: price, atr, snapshotAt: analysis.fetchedAt, rows };
}
