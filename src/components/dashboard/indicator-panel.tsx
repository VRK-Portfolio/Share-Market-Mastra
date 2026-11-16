"use client";

import { useMemo } from "react";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { backtestTechnicalRules } from "../../lib/market/backtest";
import { decimal, money } from "./format";
import { Icon } from "./icons";
import { IndicatorInfo, InfoTooltip } from "./indicator-info";
import type { IndicatorName } from "../../lib/market/technical-verdict";

export function IndicatorPanel({ data, mode }: { data: MarketAnalysis | null; mode: AnalysisMode }) {
  const backtest = useMemo(() => data ? backtestTechnicalRules(data, mode) : null, [data, mode]);
  const technical = data?.technical;
  const rsi = technical?.rsi;
  const cards: { indicator: IndicatorName; label: string; value: string; note: string; tone: string }[] = mode === "MIS" ? [
    { indicator: "VWAP", label: "VWAP", value: money(technical?.vwap), note: "Session volume-weighted price", tone: "" },
    { indicator: "SUPERTREND", label: "SuperTrend (10, 3)", value: technical?.supertrend?.direction.toUpperCase() ?? "--", note: technical?.supertrend ? `Trend line ${money(technical.supertrend.value)}` : "ATR-based trend direction", tone: technical?.supertrend?.direction === "bullish" ? "text-positive" : technical?.supertrend ? "text-negative" : "" },
    { indicator: "RSI", label: "RSI (14)", value: decimal(rsi), note: rsi == null ? "Momentum oscillator" : rsi > 70 ? "Overbought territory" : rsi < 30 ? "Oversold territory" : "Neutral momentum range", tone: rsi == null ? "" : "text-warning" },
    { indicator: "ATR", label: "ATR (14)", value: money(technical?.atr), note: "Average true range · volatility", tone: "" },
  ] : [
    { indicator: "EMA20", label: "EMA (20)", value: money(technical?.ema20), note: "Short-term exponential average", tone: "" },
    { indicator: "EMA50", label: "EMA (50)", value: money(technical?.ema50), note: "Medium-term exponential average", tone: "" },
    { indicator: "RSI", label: "RSI (14)", value: decimal(rsi), note: "Momentum oscillator", tone: rsi == null ? "" : "text-warning" },
    { indicator: "MACD", label: "MACD (12, 26, 9)", value: decimal(technical?.macd?.value), note: technical?.macd ? `Signal ${decimal(technical.macd.signal)} · Hist ${decimal(technical.macd.histogram)}` : "Trend and momentum", tone: "" },
  ];

  return (
    <section className="panel p-4" aria-labelledby="indicators-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3"><Icon name="chart" className="size-5 text-accent" /><h2 id="indicators-title" className="text-sm font-semibold tracking-wide">Dynamic technical indicators</h2><span className="badge">{mode === "MIS" ? "INTRADAY (MIS)" : mode === "NRML" ? "OVERNIGHT (NRML)" : "DELIVERY (CNC)"}</span></div>
      </div>
      {data?.segment === "FNO" && <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Open interest", rawValue: data.quote.openInterest ?? data.candles.at(-1)?.openInterest, note: "Groww quote or latest contract candle; outstanding contracts, not a standalone directional signal." },
          { label: "OI day change", rawValue: data.quote.oiDayChange, note: "Reported by Groww; positive/negative change in open interest is not independently bullish/bearish." },
          { label: "IV (Groww value)", rawValue: data.quote.impliedVolatility, note: "Raw provider-reported implied volatility. Units are not converted; no IV or Greeks are estimated." },
        ].map(({ label, rawValue, note }) => <article key={label} className="rounded-xl border border-line bg-inset p-2"><div className="flex items-center justify-between"><h3 className="text-xs text-muted">{label}</h3><InfoTooltip label={label} value={rawValue == null ? "Unavailable: not reported by Groww." : String(rawValue)} description={note} /></div><p className="mt-1 font-mono text-base">{decimal(rawValue)}</p></article>)}
      </div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map((card, index) => <article key={card.label} className="rounded-xl border border-line bg-inset p-2"><div className="flex items-center justify-between"><h3 className="text-xs text-muted">{card.label}</h3><div className="flex items-center gap-2"><span className="font-mono text-[10px] text-muted/50">0{index + 1}</span><IndicatorInfo name={card.indicator} values={technical ?? null} /></div></div><p className={`my-2 font-mono text-xl font-semibold tracking-tight ${card.tone}`}>{card.value}</p><p className="text-[11px] text-muted">{card.note}</p></article>)}
      </div>
      {backtest && <div className="mt-2 border-t border-line pt-2" aria-label="Historical strategy win rates">
        <h3 className="text-xs font-semibold">Historical win rate · after estimated costs</h3>
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
      </div>}
      {data && <details className="mt-3 text-[11px] text-muted"><summary className="cursor-pointer">{data.candles.length} candles · {data.interval}{data.fetchedAt ? ` · ${new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : ""}</summary><p className="mt-2">technicalindicators · calculated from Groww OHLCV. &quot;--&quot; means insufficient history or unavailable volume. Indicators change only when the returned candle data changes, not on every LTP tick.</p></details>}
    </section>
  );
}
