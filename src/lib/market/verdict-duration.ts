import { z } from "zod";
import type { AnalysisMode, MarketAnalysis } from "./types.ts";

const timestamp = z.number().int().positive().max(8_640_000_000_000_000 - 330 * 60_000);
const decisionSchema = z.enum(["BUY", "SELL", "HOLD"]);
export type TimedDecision = z.infer<typeof decisionSchema>;
export const verdictObservationSchema = z.object({
  version: z.literal(1), context: z.string().min(1).max(500), decision: decisionSchema,
  firstObservedAt: timestamp, lastObservedAt: timestamp, observedMs: z.number().int().nonnegative(),
  lastGap: z.object({ from: timestamp, to: timestamp, previousDecision: decisionSchema }).nullable(),
}).refine(value => value.firstObservedAt <= value.lastObservedAt &&
  value.observedMs <= value.lastObservedAt - value.firstObservedAt &&
  (!value.lastGap || value.lastGap.from <= value.lastGap.to && value.lastGap.to <= value.lastObservedAt),
"Invalid verdict observation timeline.");
export type VerdictObservation = z.infer<typeof verdictObservationSchema>;

export function verdictTimingContext(data: MarketAnalysis, mode: AnalysisMode) {
  return JSON.stringify([data.exchange, data.segment ?? "CASH", data.symbol, data.instrument?.growwSymbol ?? null, mode, data.interval]);
}

export function observeVerdict(previous: VerdictObservation | null, context: string, decision: TimedDecision,
  now: number, continuous: boolean): VerdictObservation {
  timestamp.parse(now);
  if (previous?.context === context && now < previous.lastObservedAt) {
    throw new Error("Device clock moved backwards. Verdict timing has restarted.");
  }
  const sameContext = previous?.context === context;
  const span = sameContext ? now - previous.lastObservedAt : 0;
  const uninterrupted = sameContext && continuous && span <= 5000;
  const sameState = sameContext && previous.decision === decision;
  return verdictObservationSchema.parse({
    version: 1, context, decision,
    firstObservedAt: sameState ? previous.firstObservedAt : now,
    lastObservedAt: now,
    observedMs: sameState ? previous.observedMs + (uninterrupted ? span : 0) : 0,
    lastGap: sameContext && !uninterrupted && span > 0
      ? { from: previous.lastObservedAt, to: now, previousDecision: previous.decision }
      : sameState ? previous.lastGap : null,
  });
}

export function verdictDurationLabel(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Verdict duration must be finite and nonnegative.");
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60), remaining = seconds % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${remaining}s`].filter(Boolean).join(" ");
}
