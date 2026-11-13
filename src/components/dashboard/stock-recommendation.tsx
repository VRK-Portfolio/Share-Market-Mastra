"use client";

import { useEffect, useRef, useState } from "react";
import { recommendationResponseSchema } from "../../lib/market/recommendation";
import type { StockRecommendation as Recommendation } from "../../lib/market/recommendation";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { OrderReview } from "./order-review";
import { IndicatorInfo } from "./indicator-info";
import { TradeCalculator } from "./trade-calculator";

export function StockRecommendation({ data, mode, onSessionExpired }: {
  data: MarketAnalysis;
  mode: AnalysisMode;
  onSessionExpired: () => void;
}) {
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => () => { requestController.current?.abort(); }, []);

  async function analyze() {
    if (requestController.current) return;
    const controller = new AbortController();
    requestController.current = controller;
      setLoading(true);
      setRecommendation(null);
      setError("");
      try {
        const response = await fetch("/api/groww/recommendation", {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: data.symbol, exchange: data.exchange, interval: data.interval, segment: data.segment ?? "CASH", mode }),
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : `Gemini analysis failed (${response.status}).`);
        }
        const parsed = recommendationResponseSchema.safeParse(body);
        if (!parsed.success || parsed.data.symbol !== data.symbol || parsed.data.exchange !== data.exchange ||
          parsed.data.interval !== data.interval || parsed.data.mode !== mode || parsed.data.segment !== (data.segment ?? "CASH") ||
          (data.segment === "FNO" && parsed.data.instrument?.growwSymbol !== data.instrument?.growwSymbol)) {
          throw new Error("Gemini's response did not match the selected stock or analysis mode. Retry analysis.");
        }
        if (!controller.signal.aborted) setRecommendation(parsed.data);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load Gemini analysis.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        if (requestController.current === controller) requestController.current = null;
      }
  }

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby="recommendation-title" aria-busy={loading}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="recommendation-title" className="text-sm font-semibold tracking-wide">Gemini stock analysis</h2>
          <p className="mt-1 text-xs text-muted">{data.symbol} · {data.exchange} · {data.segment ?? "CASH"} · {mode === "MIS" ? "Intraday" : mode === "NRML" ? "Overnight F&O" : "Delivery swing"} · Mastra / Gemini 3.8 Flash</p>
        </div>
        <button type="button" className="secondary-button text-xs" disabled={loading} onClick={() => { void analyze(); }}>{loading ? "Analyzing..." : "Analyze with Gemini"}</button>
      </div>
      {loading && <p role="status" className="text-sm text-muted">Gemini is interpreting the precomputed indicators and technical verdict...</p>}
      {!loading && !recommendation && !error && <p className="text-sm text-muted">The technical verdict above needs no LLM. Click Analyze with Gemini for an optional independent interpretation of server-verified indicator parameters. Raw candles and repeated per-indicator model explanations are omitted to reduce tokens. Streaming prices never trigger the agent.</p>}
      {error && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{error}</p>}
      {recommendation && <>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <span className={`badge ${recommendation.decision === "BUY" ? "text-positive" : recommendation.decision === "SELL" ? "text-negative" : "text-warning"}`}>{recommendation.decision}{recommendation.decision === "SELL" && (mode === "CNC" || (data.instrument && data.instrument.instrumentType !== "FUT")) ? " / EXIT OR AVOID" : ""}</span>
          <span className="text-xs text-muted">Subjective model confidence: {recommendation.confidencePercent}% (not a profit probability)</span>
        </div>
        <p className="mb-5 text-sm">{recommendation.summary}</p>
        <p className="mb-3 text-xs text-muted">Code-derived signals from the freshly fetched Gemini input snapshot, not model-generated indicator values or explanations:</p>
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Code-derived Gemini input evidence">
          {recommendation.indicatorAssessments.map((item) => {
            const snapshot = recommendation.indicatorSnapshot;
            const value = { VWAP: snapshot.vwap, RSI: snapshot.rsi, ATR: snapshot.atr, EMA20: snapshot.ema20,
              EMA50: snapshot.ema50, MACD: snapshot.macd, SUPERTREND: snapshot.supertrend }[item.indicator];
            const label = value === null ? "Unavailable" : typeof value === "number" ? decimal(value)
              : "histogram" in value ? `Line ${decimal(value.value)} / Signal ${decimal(value.signal)} / Histogram ${decimal(value.histogram)}`
              : `${decimal(value.value)} / ${value.direction}`;
            return <div key={item.indicator} className="rounded-xl border border-line bg-inset p-4">
              <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">{item.indicator} · {item.signal}</h3><IndicatorInfo name={item.indicator} values={snapshot} /></div>
              <p className="mt-2 font-mono text-xs">{label}</p><p className="mt-2 text-xs text-muted">{item.explanation}</p>
            </div>;
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Conditional entry", value: money(recommendation.entryPrice) },
            { label: "Target prices", value: recommendation.targetPrices.length ? recommendation.targetPrices.map(money).join(" / ") : "--" },
            { label: "Stop-loss", value: money(recommendation.stopLoss) },
            { label: "Reward / risk (first target)", value: recommendation.riskRewardRatio === null ? "--" : `${decimal(recommendation.riskRewardRatio)} : 1` },
          ].map(({ label, value }) => <div key={label} className="rounded-xl border border-line bg-inset p-4"><h3 className="text-xs text-muted">{label}</h3><p className="mt-2 font-mono text-base">{value}</p></div>)}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <p className="text-sm"><span className="text-muted">Support: </span>{recommendation.supportLevels.length ? recommendation.supportLevels.map(money).join(" / ") : "--"}</p>
          <p className="text-sm"><span className="text-muted">Resistance: </span>{recommendation.resistanceLevels.length ? recommendation.resistanceLevels.map(money).join(" / ") : "--"}</p>
          {[
            { label: "Evidence", items: recommendation.rationale },
            { label: "Risks and data limitations", items: recommendation.risks },
          ].map(({ label, items }) => <div key={label}><h3 className="mb-2 text-xs font-semibold text-muted">{label}</h3><ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
        </div>
        <p className="mt-4 text-sm"><span className="text-muted">Invalidation: </span>{recommendation.invalidation}</p>
        <div className="mt-5 rounded-xl border border-line bg-inset p-4">
          <h3 className="mb-2 text-xs font-semibold">Suggested GTT triggers (not orders)</h3>
          {recommendation.gtt ? <>
            <p className="text-sm">Entry {money(recommendation.gtt.entryTriggerPrice)} · Target {money(recommendation.gtt.targetTriggerPrice)} · Stop-loss {money(recommendation.gtt.stopLossTriggerPrice)}</p>
            <p className="mt-2 text-xs text-muted">{recommendation.gtt.note}</p>
          </> : <p className="text-xs text-muted">{data.segment === "FNO" ? "GTT is not suggested for F&O contracts." : mode === "MIS" ? "GTT is not suggested for intraday MIS." : "No GTT setup suggested for this recommendation."}</p>}
          <p className="mt-2 text-xs text-muted">These suggestions do not submit or link protective orders. Confirm broker eligibility, limit prices, quantity, validity and separate exit protection before placing any order.</p>
        </div>
        <p className="mt-4 text-[11px] text-muted">Reference quote {money(recommendation.referencePrice)} · snapshot {new Date(recommendation.snapshotAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST · {recommendation.candleSampleCount} recent candles sent, indicators based on {recommendation.candleCount} complete candles · {recommendation.omittedCandles} incomplete candles omitted.</p>
        <OrderReview key={recommendation.generatedAt} recommendation={recommendation} onSessionExpired={onSessionExpired} />
        <TradeCalculator result={recommendation} source="GEMINI" />
      </>}
      <p className="mt-4 text-xs text-muted">AI-generated technical scenarios, not personalized investment advice or guaranteed targets. News and fundamentals are not included. Only public stock market data is sent to Google; your Groww token and portfolio are not sent. Each button-triggered analysis may incur Google API charges. Recommendations remain snapshots; click again to reassess newer prices.</p>
    </section>
  );
}
