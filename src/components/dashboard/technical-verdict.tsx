"use client";

import { useEffect, useState } from "react";
import { calculateTechnicalVerdict } from "../../lib/market/technical-verdict";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { OrderReview } from "./order-review";
import { calculateShortTermScenarios } from "../../lib/market/short-term-scenarios";
import { TradeCalculator } from "./trade-calculator";
import { EntryTiming } from "./entry-timing";
import { calculateEntryTiming } from "../../lib/market/entry-timing";
import { FifteenMinuteOutlook } from "./fifteen-minute-outlook";
import type { FifteenMinuteHistory } from "../../lib/market/fifteen-minute-outlook";
import { VerdictDuration } from "./verdict-duration";
import { verdictTimingContext } from "../../lib/market/verdict-duration";

export function TechnicalVerdict({ data, mode, forecastData, forecastHistory, forecastLoading, forecastError, onSessionExpired }: {
  data: MarketAnalysis; mode: AnalysisMode; onSessionExpired: () => void;
  forecastData: MarketAnalysis | null; forecastLoading: boolean; forecastError?: string;
  forecastHistory: FifteenMinuteHistory | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const verdict = calculateTechnicalVerdict(data, mode, now);
  const scenarios = calculateShortTermScenarios(forecastData, now);
  const bullish = verdict.directionalSignals.filter((item) => item.signal === "BULLISH").length;
  const bearish = verdict.directionalSignals.filter((item) => item.signal === "BEARISH").length;
  const timing = (data.segment ?? "CASH") === "CASH" ? calculateEntryTiming(data, verdict, now) : null;
  const action = verdict.exitOnly ? "EXIT / AVOID" : verdict.decision === "HOLD" || timing?.status === "WAIT" ? "WAIT" : verdict.decision;
  const tone = action === "BUY" ? "text-positive" : action === "SELL" ? "text-negative" : "text-warning";
  return <section className="panel p-4" aria-labelledby="technical-verdict-title">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="eyebrow">Trend-rule decision</p>
        <h2 id="technical-verdict-title" className={`mt-1 text-3xl font-semibold tracking-tight ${tone}`}>{action}</h2>
      </div>
      <div className="text-right text-[11px] text-muted">
        <p>{mode} · {data.interval}</p>
        <p className="mt-1">Rules, not AI</p>
        <p className="mt-1">Signal: <span className="font-semibold text-foreground">{verdict.decision}</span></p>
      </div>
    </div>
    <VerdictDuration kind="technical" context={verdictTimingContext(data, mode)} decision={verdict.dataReady ? verdict.decision : null} />
    <p role="status" className="mt-3 text-xs leading-relaxed">{verdict.exitOnly
      ? "Bearish setup: exit an existing long or avoid entry. Do not open a new short."
      : action === "WAIT" && verdict.decision !== "HOLD"
        ? "The rule signal has a reference plan, but entry timing is not cleared."
        : verdict.summary}</p>
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Signal agreement</h3>
        <p className="text-[10px] text-muted">Bullish {bullish}/{verdict.directionalSignals.length} · Bearish {bearish}/{verdict.directionalSignals.length}</p>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {verdict.directionalSignals.map((item) => <li key={item.indicator} className="decision-signal">
          <span>{item.indicator === "EMA20/EMA50" ? "EMA trend" : item.indicator === "SUPERTREND" ? "SuperTrend" : item.indicator}</span>
          <span className={`text-[10px] font-semibold ${item.signal === "BULLISH" ? "text-positive" : item.signal === "BEARISH" ? "text-negative" : "text-warning"}`}>{item.signal}</span>
        </li>)}
      </ul>
      <p className={`mt-2 text-[11px] ${verdict.dataReady ? "text-muted" : "text-warning"}`}>{verdict.dataReady
        ? "Data checks passed. All directional rules must agree."
        : verdict.reasons[0] ?? "Data checks failed. Refresh market data."}</p>
    </div>
    <div className="my-4 border-y border-line py-3" aria-label="Reference risk plan">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold">Reference plan</h3>
      <span className="text-[10px] text-muted">{verdict.exitOnly ? "Exit only" : action === "WAIT" ? "Not cleared for entry" : "Conditional, not an order"}</span>
    </div>
    {verdict.decision === "HOLD" || verdict.exitOnly ? <p className="text-xs text-muted">
      {verdict.exitOnly ? "No new entry, short targets or stop plan." : "Entry, stop and targets stay unavailable until a valid setup is confirmed."}
    </p> : <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      {[
        { label: "Entry", value: money(verdict.entryPrice) },
        { label: "Stop-loss", value: money(verdict.stopLoss) },
        { label: "Targets · 2R / 3R", value: verdict.targetPrices.map(money).join(" / ") },
        { label: "Reward / risk · target 1", value: verdict.riskRewardRatio === null ? "--" : `${decimal(verdict.riskRewardRatio)} : 1` },
      ].map(({ label, value }) => <div key={label} className="min-w-0">
        <dt className="text-[10px] text-muted">{label}</dt><dd className="mt-1 break-words font-mono text-sm font-semibold">{value}</dd>
      </div>)}
    </dl>}
    </div>
    <FifteenMinuteOutlook analysis={forecastData} history={forecastHistory}
      plan={data.interval === "15minute" ? verdict : null} now={now} loading={forecastLoading} error={forecastError} />
    {timing && <EntryTiming timing={timing} now={now} />}
    <details className="mt-3 text-xs" aria-label="Decision checks">
      <summary className="cursor-pointer font-medium">Why this decision? · {verdict.reasons.length} checks</summary>
      <p className={`mt-2 text-xs ${verdict.dataReady ? "text-positive" : "text-warning"}`}>{verdict.dataReady
        ? "Data quality and freshness checks passed." : "Data quality or freshness checks failed; signal agreement cannot override them."}</p>
      <p className="mt-2 text-xs text-muted">Bullish {bullish}/{verdict.directionalSignals.length} · Bearish {bearish}/{verdict.directionalSignals.length}. All checks must agree; these counts are not a profit probability. ATR sizes risk and is not a directional vote.</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </details>
    <details className="workspace-details mt-3" aria-label="Next 15 to 30 minute price scenarios">
      <summary>15-30m scenarios{forecastError ? " · Unavailable" : forecastLoading ? " · Loading" : !scenarios.available ? " · Unavailable" : ""}</summary>
      {forecastLoading ? <p role="status" className="mt-3 text-xs text-muted">Loading a dedicated 15-minute snapshot for short-term estimates...</p>
        : forecastError ? <p role="alert" className="mt-3 text-xs text-negative">15-minute data could not load: {forecastError} No higher-timeframe ATR is substituted.</p>
          : !scenarios.available ? <p role="status" className="mt-3 text-xs text-muted">Estimate unavailable: {scenarios.reason}</p>
            : <>
              <p className="mt-2 text-[11px] text-muted">15-minute bias: {scenarios.bias} · Reference {money(scenarios.referencePrice)} · ATR {money(scenarios.atr)}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {scenarios.rows.map((row) => <div key={row.minutes} className="rounded-xl border border-line bg-panel p-2">
                  <h4 className="text-[11px] font-semibold">{row.minutes}-minute range · through {new Date(row.endsAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</h4>
                  {row.available ? <p className="mt-1 font-mono text-sm">{money(row.lowerPrice)} - {money(row.upperPrice)}</p>
                    : <p className="mt-1 text-xs text-muted">Unavailable: {row.reason}</p>}
                </div>)}
              </div>
              <p className="mt-2 text-[11px] text-muted" title={new Date(scenarios.snapshotAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>Snapshot {new Date(scenarios.snapshotAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST · always uses 15-minute indicators.</p>
            </>}
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Range assumptions - not guaranteed prices</summary><p className="mt-2">Heuristic continuation ranges, not guaranteed prices, calibrated confidence intervals or the 2R/3R trade targets. At 15 minutes: bullish range = price - 0.5xATR to price + ATR; bearish is the inverse; neutral is +/-ATR. At 30 minutes distances scale by sqrt(2). Ranges can be exceeded. No model calls or orders are triggered.</p></details>
    </details>
    <details className="workspace-details mt-3">
    <summary>Review order &amp; position size</summary>
    <OrderReview key={`${data.fetchedAt}:${mode}`} recommendation={verdict} onSessionExpired={onSessionExpired} />
    <TradeCalculator result={verdict} source="TECHNICAL" />
    </details>
    <p className="mt-3 text-[10px] text-muted">Not a profit forecast. Orders, stops &amp; targets are never placed automatically.</p>
  </section>;
}
