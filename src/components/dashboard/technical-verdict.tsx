"use client";

import { useEffect, useState } from "react";
import { calculateTechnicalVerdict } from "../../lib/market/technical-verdict";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { OrderReview } from "./order-review";
import { IndicatorInfo } from "./indicator-info";
import { calculateShortTermScenarios } from "../../lib/market/short-term-scenarios";
import { TradeCalculator } from "./trade-calculator";
import type { ShortTermScenarios } from "../../lib/market/short-term-scenarios";

export function TechnicalVerdict({ data, mode, forecastData, forecastLoading, forecastError, onSessionExpired, onSaveScenarios, canSaveScenarios }: {
  data: MarketAnalysis; mode: AnalysisMode; onSessionExpired: () => void;
  forecastData: MarketAnalysis | null; forecastLoading: boolean; forecastError?: string;
  onSaveScenarios: (data: MarketAnalysis, scenarios: ShortTermScenarios) => void;
  canSaveScenarios: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const verdict = calculateTechnicalVerdict(data, mode, now);
  const snapshot = verdict.indicatorSnapshot;
  const scenarios = calculateShortTermScenarios(forecastData, now);
  const bullish = verdict.directionalSignals.filter((item) => item.signal === "BULLISH").length;
  const bearish = verdict.directionalSignals.filter((item) => item.signal === "BEARISH").length;
  return <section className="panel p-4" aria-labelledby="technical-verdict-title">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 id="technical-verdict-title" className="text-sm font-semibold tracking-wide">Technical verdict (no LLM)</h2>
      <span className="badge">Code-calculated / zero model calls</span>
    </div>
    <div className="flex flex-wrap items-center gap-2">
    <p className="text-xs text-muted">{data.symbol} / {data.exchange} / {mode} / {data.interval}</p>
    <span className={`badge ${verdict.decision === "BUY" ? "text-positive" : verdict.decision === "SELL" ? "text-negative" : "text-warning"}`}>
      {verdict.decision}{verdict.exitOnly ? " / EXIT OR AVOID" : ""}
    </span>
    </div>
    <p role="status" className="my-3 text-sm">{verdict.summary}</p>
    <details open={verdict.decision === "HOLD"} className="mb-3 rounded-xl border border-line bg-inset p-3" aria-label="Decision checks">
      <summary className="cursor-pointer text-xs font-semibold">{verdict.decision === "HOLD" ? "Why HOLD?" : "Directional confirmation"} · Data checks {verdict.dataReady ? "passed" : "failed"} · Bullish {bullish}/{verdict.directionalSignals.length} / Bearish {bearish}/{verdict.directionalSignals.length}</summary>
      <p className={`mt-2 text-xs ${verdict.dataReady ? "text-positive" : "text-warning"}`}>{verdict.dataReady
        ? "Data quality and freshness checks passed." : "Data quality or freshness checks failed; signal agreement cannot override them."}</p>
      <p className="mt-2 text-xs text-muted">Bullish {bullish}/{verdict.directionalSignals.length} · Bearish {bearish}/{verdict.directionalSignals.length}. All checks must agree; these counts are not a profit probability. ATR sizes risk and is not a directional vote.</p>
      <ul className="mt-3 flex flex-wrap gap-2">{verdict.directionalSignals.map((item) => <li key={item.indicator}
        className={`badge ${item.signal === "BULLISH" ? "text-positive" : item.signal === "BEARISH" ? "text-negative" : "text-warning"}`}>
        {item.indicator}: {item.signal}
      </li>)}</ul>
      {verdict.decision === "HOLD" && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    </details>
    {verdict.decision === "HOLD" ? <p className="rounded-xl border border-line bg-inset p-3 text-xs text-muted">
      No actionable trade setup is confirmed. Entry, targets, stop-loss and reward/risk are intentionally unavailable for HOLD, rather than invented from conflicting or stale signals.
    </p> : <div className="grid gap-2 sm:grid-cols-2">
      {[
        { label: "Conditional entry", value: money(verdict.entryPrice) },
        { label: "Targets (2R / 3R)", value: verdict.targetPrices.length ? verdict.targetPrices.map(money).join(" / ") : "--" },
        { label: "Stop-loss (minimum 1.5xATR)", value: money(verdict.stopLoss) },
        { label: "Reward / risk (first target)", value: verdict.riskRewardRatio === null ? "--" : `${decimal(verdict.riskRewardRatio)} : 1` },
      ].map(({ label, value }) => <div key={label} className="rounded-xl border border-line bg-inset p-2">
        <h3 className="text-xs text-muted">{label}</h3><p className="mt-1 font-mono text-sm">{value}</p>
      </div>)}
    </div>}
    <section className="mt-3 rounded-xl border border-line bg-inset p-3" aria-label="Next 15 to 30 minute price scenarios">
      <h3 className="text-xs font-semibold">Next 15-30 minute price scenarios (no LLM)</h3>
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
              <button type="button" className="secondary-button mt-2 px-3 py-1.5 text-xs" disabled={!canSaveScenarios} onClick={() => { if (forecastData) onSaveScenarios(forecastData, scenarios); }}>Save scenario alerts</button>
            </>}
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Range assumptions - not guaranteed prices</summary><p className="mt-2">Heuristic continuation ranges, not guaranteed prices, calibrated confidence intervals or the 2R/3R trade targets. At 15 minutes: bullish range = price - 0.5xATR to price + ATR; bearish is the inverse; neutral is +/-ATR. At 30 minutes distances scale by sqrt(2). Ranges can be exceeded. No model calls or orders are triggered.</p></details>
    </section>
    <details className="workspace-details mt-3">
    <summary>Full indicator evidence, rules &amp; risk notes</summary>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Code-calculated indicator evidence">
      {verdict.indicatorAssessments.map((item) => {
        const value = { VWAP: snapshot.vwap, RSI: snapshot.rsi, ATR: snapshot.atr, EMA20: snapshot.ema20,
          EMA50: snapshot.ema50, MACD: snapshot.macd, SUPERTREND: snapshot.supertrend }[item.indicator];
        const label = value === null ? "Unavailable" : typeof value === "number" ? decimal(value)
          : "histogram" in value ? `Line ${decimal(value.value)} / Signal ${decimal(value.signal)} / Histogram ${decimal(value.histogram)}`
          : `${decimal(value.value)} / ${value.direction}`;
        return <article key={item.indicator} className="rounded-xl border border-line bg-inset p-4">
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">{item.indicator} / {item.signal}</h3><IndicatorInfo name={item.indicator} values={snapshot} /></div>
          <p className="mt-2 font-mono text-xs">{label}</p><p className="mt-2 text-xs text-muted">{item.explanation}</p>
        </article>;
      })}
    </div>
    {verdict.decision !== "HOLD" && <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-muted">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    <p className="mt-3 text-xs text-muted">Rule: price and EMA20/50 ordering, RSI (55-70 BUY / 30-45 SELL), MACD and SuperTrend must all agree. MIS also requires VWAP. Neutral, missing or conflicting signals mean HOLD; ATR is not a directional vote.</p>
    <p className="mt-3 text-xs text-muted">Price reference {money(data.quote.price)}. Indicator snapshot: {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unavailable"} IST. Streaming can update the price check and levels, not the candle-based indicators. Refresh market data to update indicators. MIS requires a trade within 60 seconds and same-session candles within two intervals; CNC/NRML allow at most three calendar days. No raw candles or LLM calls are needed for this verdict.</p>
    <p className="mt-3 text-xs text-muted">Targets are rule-based scenarios, not forecasts or observed resistance. Recent candle low/high: {verdict.supportLevels.map(money).join(" / ") || "--"} / {verdict.resistanceLevels.map(money).join(" / ") || "--"}. {data.segment === "FNO" ? "Contract prices only; account for expiry, leverage, liquidity and option time decay. No uncovered option writing is suggested." : "No news, fundamentals or personal risk profile is considered."} Stops and targets are not automatically placed.</p>
    </details>
    <details className="workspace-details mt-3">
    <summary>Order review &amp; cost / shares / GTT calculator</summary>
    <OrderReview key={`${data.fetchedAt}:${mode}`} recommendation={verdict} onSessionExpired={onSessionExpired} />
    <TradeCalculator result={verdict} source="TECHNICAL" />
    </details>
    <p className="mt-3 text-[11px] text-muted">Conditional scenarios, not guaranteed returns. No orders, stops or targets are placed automatically.</p>
  </section>;
}
