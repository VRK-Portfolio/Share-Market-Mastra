"use client";

import { useMemo } from "react";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { backtestTechnicalRules } from "../../lib/market/backtest";
import { decimal, money } from "./format";
import { IndicatorInfo, InfoTooltip } from "./indicator-info";
import { calculateTechnicalVerdict } from "../../lib/market/technical-verdict";
import type { IndicatorName } from "../../lib/market/technical-verdict";

export function IndicatorPanel({ data, mode, referencePrice = data?.quote.price }: {
  data: MarketAnalysis | null; mode: AnalysisMode; referencePrice?: number;
}) {
  const backtest = useMemo(() => data ? backtestTechnicalRules(data, mode) : null, [data, mode]);
  const verdict = data ? calculateTechnicalVerdict(
    referencePrice === undefined ? data : { ...data, quote: { ...data.quote, price: referencePrice } }, mode,
  ) : null;
  const technical = data?.technical;
  const rsi = technical?.rsi;
  const rsiSignal = verdict?.indicatorAssessments.find((item) => item.indicator === "RSI")?.signal;
  const rsiNote = rsi == null ? "Momentum unavailable" : rsiSignal === "BULLISH" ? "Bullish momentum"
    : rsiSignal === "BEARISH" ? "Bearish momentum" : rsi > 70 ? "Overbought; no confirmation"
      : rsi < 30 ? "Oversold; no confirmation" : "No momentum confirmation";
  const rsiTone = rsiSignal === "BULLISH" ? "text-positive" : rsiSignal === "BEARISH" ? "text-negative"
    : rsi == null ? "" : "text-warning";
  const cards: Record<IndicatorName, { label: string; value: string; note: string; tone: string }> = {
    VWAP: { label: "VWAP", value: money(technical?.vwap), note: "Session volume-weighted price", tone: "" },
    SUPERTREND: { label: "SuperTrend (10, 3)", value: technical?.supertrend?.direction.toUpperCase() ?? "--", note: technical?.supertrend ? `Trend line ${money(technical.supertrend.value)}` : "ATR-based trend direction", tone: technical?.supertrend?.direction === "bullish" ? "text-positive" : technical?.supertrend ? "text-negative" : "" },
    RSI: { label: "RSI (14)", value: decimal(rsi), note: rsiNote, tone: rsiTone },
    ATR: { label: "ATR (14)", value: money(technical?.atr), note: "Average true range · volatility", tone: "" },
    EMA20: { label: "EMA (20)", value: money(technical?.ema20), note: "Short-term exponential average", tone: "" },
    EMA50: { label: "EMA (50)", value: money(technical?.ema50), note: "Medium-term exponential average", tone: "" },
    MACD: { label: "MACD (12, 26, 9)", value: decimal(technical?.macd?.value), note: technical?.macd ? `Signal ${decimal(technical.macd.signal)} · Hist ${decimal(technical.macd.histogram)}` : "Trend and momentum", tone: "" },
  };
  const order: IndicatorName[] = mode === "MIS"
    ? ["VWAP", "SUPERTREND", "RSI", "ATR", "EMA20", "EMA50", "MACD"]
    : ["EMA20", "EMA50", "RSI", "MACD", "SUPERTREND", "ATR", "VWAP"];

  return (
    <section className="panel p-4" aria-labelledby="indicators-title">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="indicators-title" className="text-sm font-semibold">Indicator snapshot</h2>
        <span className="text-[10px] text-muted">i = decision reference</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Code-calculated indicator evidence">
        {order.map((indicator) => {
          const card = cards[indicator];
          const assessment = verdict?.indicatorAssessments.find((item) => item.indicator === indicator);
          const signal = assessment?.signal ?? "UNAVAILABLE";
          return <article key={indicator} className="min-w-0 rounded-xl border border-line bg-inset p-2">
            <div className="flex items-center justify-between gap-1"><h3 className="text-[11px] text-muted">{card.label}</h3><IndicatorInfo name={indicator} /></div>
            <p className={`mb-1 break-words font-mono text-lg font-semibold tracking-tight ${card.tone}`}>{card.value}</p>
            <p className="text-[10px] text-muted">{card.note}</p>
            <p className={`mt-2 text-[10px] font-semibold ${signal === "BULLISH" ? "text-positive" : signal === "BEARISH" ? "text-negative" : "text-muted"}`}>{signal}</p>
            {assessment && <p className="mt-1 text-[10px] leading-relaxed text-muted">{assessment.explanation}</p>}
          </article>;
        })}
      </div>
      {data && verdict && <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">Rules, freshness &amp; risk notes</summary>
        <p className="mt-3">Rule: price and EMA20/50 ordering, RSI (55-70 BUY / 30-45 SELL), MACD and SuperTrend must all agree. MIS also requires VWAP. Neutral, missing or conflicting signals mean HOLD; ATR is not a directional vote.</p>
        <p className="mt-3">Price reference {money(referencePrice)}. Indicator snapshot: {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unavailable"} IST. Streaming can update the price check and levels, not the candle-based indicators. Refresh market data to update indicators. MIS requires a trade within 60 seconds and same-session candles within two intervals; CNC/NRML allow at most three calendar days. No raw candles or LLM calls are needed for this verdict.</p>
        <p className="mt-3">Targets are rule-based scenarios, not forecasts or observed resistance. Recent candle low/high: {verdict.supportLevels.map(money).join(" / ") || "--"} / {verdict.resistanceLevels.map(money).join(" / ") || "--"}. {data.segment === "FNO" ? "Contract prices only; account for expiry, leverage, liquidity and option time decay. No uncovered option writing is suggested." : "No news, fundamentals or personal risk profile is considered."} Stops and targets are not automatically placed.</p>
      </details>}
      {data?.segment === "FNO" && <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted">Contract open interest &amp; volatility</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {[
          { label: "Open interest", rawValue: data.quote.openInterest ?? data.candles.at(-1)?.openInterest, reference: "No universal ideal open interest. OI alone does not confirm bullish or bearish direction.", note: "Groww quote or latest contract candle; outstanding contracts, not a standalone directional signal." },
          { label: "OI day change", rawValue: data.quote.oiDayChange, reference: "No ideal positive or negative change. Interpret with price and contract context, not as a standalone BUY/SELL rule.", note: "Reported by Groww; positive/negative change in open interest is not independently bullish/bearish." },
          { label: "IV (Groww value)", rawValue: data.quote.impliedVolatility, reference: "No universal ideal IV. Compare only known, consistent units for the same contract context; this app does not set an IV threshold.", note: "Raw provider-reported implied volatility. Units are not converted; no IV or Greeks are estimated." },
        ].map(({ label, rawValue, reference, note }) => <article key={label} className="rounded-xl border border-line bg-inset p-2"><div className="flex items-center justify-between"><h3 className="text-xs text-muted">{label}</h3><InfoTooltip label={label} reference={reference} description={note} /></div><p className="mt-1 font-mono text-base">{decimal(rawValue)}</p></article>)}
      </div></details>}
      {backtest && <details className="mt-3 border-t border-line pt-3" aria-label="Historical strategy win rates">
        <summary className="cursor-pointer text-xs text-muted">Historical win rates &amp; backtest{backtest.error ? " · Insufficient data" : ""}</summary>
        {backtest.excludedOffSession > 0 && <p role="status" className="mt-1 text-[11px] text-warning">
          Excluded {backtest.excludedOffSession} candle(s) outside 09:15-15:30 IST from the backtest only.
        </p>}
        {backtest.error ? <p role="status" className="mt-2 text-xs text-warning">{backtest.error}</p> : <>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {([["BUY", backtest.buy], ["SELL", backtest.sell]] as const).map(([side, sample]) =>
              <article key={side} className="rounded-xl border border-line bg-inset p-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className={`text-xs ${side === "BUY" ? "text-positive" : "text-negative"}`}>{side}</h4>
                  <p className="font-mono text-xl font-semibold">{side === "SELL" && !backtest.sellEligible
                    ? "Exit only" : sample.winRate === null ? "--" : `${decimal(sample.winRate)}%`}</p>
                </div>
                <p className="mt-1 text-[11px] text-muted">{side === "SELL" && !backtest.sellEligible ? "No new short positions tested."
                  : `${sample.wins} wins / ${sample.total} closed trades`}</p>
                {sample.confidenceInterval && <p className="mt-1 text-[11px] text-muted">95% Wilson interval: {decimal(sample.confidenceInterval[0])}–{decimal(sample.confidenceInterval[1])}%</p>}
                {sample.total > 0 && sample.total < 30 && <p className="mt-1 text-[11px] text-warning">Limited sample; unreliable for forecasting.</p>}
              </article>)}
          </div>
          <p className="mt-2 text-[11px] text-muted">Past results, not today&apos;s success probability. No trades means no rate; 0% is possible. Live BUY/SELL rules are unchanged.</p>
        </>}
        <details className="mt-2 text-[11px] text-muted">
          <summary className="cursor-pointer">Backtest rules &amp; history · {backtest.closedCandles} closed candles</summary>
          <p className="mt-2">Strict signals from closed candles only, with a 50-candle warm-up. Next-open entry, at least 1.5×ATR stop and 2R target. One position at a time; same-bar stop/target ambiguity is stop-first. Stop gaps fill at the opening price; target gaps are capped at the target.</p>
          <p className="mt-2">MIS closes at session end; CNC/NRML after five observed trading sessions, or contract expiry if earlier. Estimated {backtest.roundTripCostPercent}% total round-trip fees, taxes and slippage, split between entry and exit. A win means positive return after these costs, including timed exits. This is not a broker fee calculation.</p>
          <p className="mt-2">{backtest.pending} unfinished trade(s) excluded. Only this stock&apos;s loaded Groww history is used; no additional API, model or order calls. Missing OHLC bars prevent testing; unavailable volume prevents intraday VWAP confirmation. Correlated trades can make the Wilson interval optimistic; this is not out-of-sample validation.</p>
          <p className="mt-2">Intraday backtests use candle starts from 09:15 inclusive to 15:30 exclusive IST. Off-hours and special evening-session candles are excluded before warm-up and signal calculations, not shifted or filled. The chart and live indicators retain the original Groww history; missing bars within regular sessions still prevent testing.</p>
          {backtest.startTime !== null && backtest.endTime !== null && <p className="mt-2">{new Date(backtest.startTime * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}–{new Date(backtest.endTime * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} IST · {data?.interval}. CASH levels assume paise precision; F&amp;O uses the selected contract&apos;s tick size and history.</p>}
        </details>
      </details>}
      {data && <details className="mt-3 text-[11px] text-muted"><summary className="cursor-pointer">{data.candles.length} candles · {data.interval}{data.fetchedAt ? ` · ${new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : ""}</summary><p className="mt-2">technicalindicators · calculated from Groww OHLCV. &quot;--&quot; means insufficient history or unavailable volume. Indicators change only when the returned candle data changes, not on every LTP tick.</p></details>}
    </section>
  );
}
