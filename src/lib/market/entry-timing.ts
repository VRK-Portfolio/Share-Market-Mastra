import { intradayEntryCutoff, regularMarketSession } from "./market-session.ts";
import type { TechnicalVerdict } from "./technical-verdict.ts";
import type { MarketAnalysis } from "./types.ts";

export type EntryTimingAssessment = ReturnType<typeof calculateEntryTiming>;

export function calculateEntryTiming(analysis: MarketAnalysis, verdict: TechnicalVerdict, now = Date.now()) {
  const session = regularMarketSession(now);
  const reasons: string[] = [];
  if ((analysis.segment ?? "CASH") !== "CASH" || verdict.mode === "NRML") {
    reasons.push("This timing guide is for CASH intraday BUY/short SELL and delivery BUY, not F&O.");
  }

  if (session.phase !== "open") {
    reasons.push(session.phase === "weekend"
      ? "Outside the regular weekday session. Recheck on an exchange trading day."
      : session.phase === "before-open"
        ? "Before 09:15 IST. Wait for regular trading and a fresh quote; opening gaps can invalidate a setup."
        : "At or after 15:30 IST. Review the close and recheck during a later trading session.");
  }
  if (verdict.mode === "MIS" && now >= intradayEntryCutoff(now)) {
    reasons.push("New intraday entries stop at 15:20 IST, ten minutes before the regular close.");
  }
  if (verdict.mode === "CNC" && analysis.interval !== "1day") {
    reasons.push("Select 1D candles to assess the daily trend for carry-forward BUY timing.");
  }
  const tradeTime = analysis.quote.lastTradeTime;
  if (tradeTime === null || !Number.isFinite(tradeTime) || tradeTime <= 0 ||
    tradeTime > now + 5000 || now - tradeTime > 60_000 ||
    new Date(tradeTime + 330 * 60_000).toISOString().slice(0, 10) !== session.date) {
    reasons.push("Entry timing requires a trade from today (IST), no older than 60 seconds. Refresh or reconnect the feed.");
  }
  if (!verdict.dataReady || verdict.decision === "HOLD") {
    reasons.push(verdict.summary);
  } else if (verdict.exitOnly || verdict.mode === "CNC" && verdict.decision !== "BUY") {
    reasons.push("Carry-forward CASH is BUY only. A bearish delivery signal is exit/avoid, not a new short entry.");
  } else if (verdict.entryPrice === null || verdict.stopLoss === null || !verdict.targetPrices.length) {
    reasons.push("A valid entry, stop-loss and target plan is required before entry conditions can be marked met.");
  }
  const lastCandle = analysis.candles.at(-1);
  const provisionalDaily = verdict.mode === "CNC" && analysis.interval === "1day" && !!lastCandle &&
    new Date(lastCandle.time * 1000 + 330 * 60_000).toISOString().slice(0, 10) === session.date &&
    now < session.closesAt;
  return {
    session,
    status: reasons.length ? "WAIT" as const : "CONDITIONS_MET" as const,
    side: reasons.length || verdict.decision === "HOLD" ? null : verdict.decision,
    reasons,
    provisionalDaily,
  };
}
