"use client";

import { useEffect, useState } from "react";
import { calculateTechnicalVerdict } from "../../lib/market/technical-verdict";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { OrderReview } from "./order-review";
import { IndicatorInfo } from "./indicator-info";
import { calculateShortTermScenarios } from "../../lib/market/short-term-scenarios";
import { TradeCalculator } from "./trade-calculator";

export function TechnicalVerdict({ data, mode, forecastData, forecastLoading, forecastError, onSessionExpired }: {
  data: MarketAnalysis; mode: AnalysisMode; onSessionExpired: () => void;
  forecastData: MarketAnalysis | null; forecastLoading: boolean; forecastError?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const verdict = calculateTechnicalVerdict(data, mode, now);
  const snapshot = verdict.indicatorSnapshot;
  const scenarios = calculateShortTermScenarios(forecastData, now);
  return <section className="panel p-5 sm:p-7" aria-labelledby="technical-verdict-title">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 id="technical-verdict-title" className="text-sm font-semibold tracking-wide">Technical verdict (no LLM)</h2>
      <span className="badge">Code-calculated / zero model calls</span>
    </div>
    <p className="mb-3 text-xs text-muted">{data.symbol} / {data.exchange} / {mode} / {data.interval}</p>
    <span className={`badge ${verdict.decision === "BUY" ? "text-positive" : verdict.decision === "SELL" ? "text-negative" : "text-warning"}`}>
      {verdict.decision}{verdict.exitOnly ? " / EXIT OR AVOID" : ""}
    </span>
    <p role="status" className="my-4 text-sm">{verdict.summary}</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[
        { label: "Conditional entry", value: money(verdict.entryPrice) },
        { label: "Targets (2R / 3R)", value: verdict.targetPrices.length ? verdict.targetPrices.map(money).join(" / ") : "--" },
        { label: "Stop-loss (minimum 1.5xATR)", value: money(verdict.stopLoss) },
        { label: "Reward / risk (first target)", value: verdict.riskRewardRatio === null ? "--" : `${decimal(verdict.riskRewardRatio)} : 1` },
      ].map(({ label, value }) => <div key={label} className="rounded-xl border border-line bg-inset p-4">
        <h3 className="text-xs text-muted">{label}</h3><p className="mt-2 font-mono text-base">{value}</p>
      </div>)}
    </div>
    <section className="mt-5 rounded-xl border border-line bg-inset p-4" aria-label="Next 15 to 30 minute price scenarios">
      <h3 className="text-sm font-semibold">Next 15-30 minute price scenarios (no LLM)</h3>
      {forecastLoading ? <p role="status" className="mt-3 text-xs text-muted">Loading a dedicated 15-minute snapshot for short-term estimates...</p>
        : forecastError ? <p role="alert" className="mt-3 text-xs text-negative">15-minute data could not load: {forecastError} No higher-timeframe ATR is substituted.</p>
          : !scenarios.available ? <p role="status" className="mt-3 text-xs text-muted">Estimate unavailable: {scenarios.reason}</p>
            : <>
              <p className="mt-3 text-xs text-muted">15-minute indicator bias: {scenarios.bias} / Price reference {money(scenarios.referencePrice)} / ATR (14) {money(scenarios.atr)}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {scenarios.rows.map((row) => <div key={row.minutes} className="rounded-xl border border-line bg-panel p-4">
                  <h4 className="text-xs font-semibold">{row.minutes}-minute estimated range</h4>
                  {row.available ? <p className="mt-2 font-mono text-lg">{money(row.lowerPrice)} - {money(row.upperPrice)}</p>
                    : <p className="mt-2 text-xs text-muted">Unavailable: {row.reason}</p>}
                  <p className="mt-2 text-[11px] text-muted">Through {new Date(row.endsAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
                </div>)}
              </div>
              <p className="mt-3 text-xs text-muted">15-minute snapshot: {new Date(scenarios.snapshotAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. These ranges use 15-minute indicators even when your chart is hourly/daily.</p>
            </>}
      <p className="mt-3 text-xs text-muted">Heuristic continuation ranges, not guaranteed prices, calibrated confidence intervals or the 2R/3R trade targets. At 15 minutes: bullish range = price - 0.5xATR to price + ATR; bearish is the inverse; neutral is +/-ATR. At 30 minutes distances scale by sqrt(2). Ranges can be exceeded. No model calls or orders are triggered.</p>
    </section>
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
    <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-muted">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    <p className="mt-3 text-xs text-muted">Rule: price and EMA20/50 ordering, RSI (55-70 BUY / 30-45 SELL), MACD and SuperTrend must all agree. MIS also requires VWAP. Neutral, missing or conflicting signals mean HOLD; ATR is not a directional vote.</p>
    <p className="mt-3 text-xs text-muted">Price reference {money(data.quote.price)}. Indicator snapshot: {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unavailable"} IST. Streaming can update the price check and levels, not the candle-based indicators. Refresh market data to update indicators. MIS requires a trade within 60 seconds and same-session candles within two intervals; CNC/NRML allow at most three calendar days. No raw candles or LLM calls are needed for this verdict.</p>
    <p className="mt-3 text-xs text-muted">Targets are rule-based scenarios, not forecasts or observed resistance. Recent candle low/high: {verdict.supportLevels.map(money).join(" / ") || "--"} / {verdict.resistanceLevels.map(money).join(" / ") || "--"}. {data.segment === "FNO" ? "Contract prices only; account for expiry, leverage, liquidity and option time decay. No uncovered option writing is suggested." : "No news, fundamentals or personal risk profile is considered."} Stops and targets are not automatically placed.</p>
    <OrderReview key={`${data.fetchedAt}:${mode}`} recommendation={verdict} onSessionExpired={onSessionExpired} />
    <TradeCalculator result={verdict} source="TECHNICAL" />
  </section>;
}
