"use client";

import { calculateFifteenMinuteOutlook } from "../../lib/market/fifteen-minute-outlook";
import type { FifteenMinuteHistory } from "../../lib/market/fifteen-minute-outlook";
import type { summarizeBinaryOutcomes } from "../../lib/market/backtest";
import type { TechnicalVerdict } from "../../lib/market/technical-verdict";
import type { MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";

function OutcomeRate({ sample }: { sample: ReturnType<typeof summarizeBinaryOutcomes> }) {
  if (sample.winRate === null) return <p className="mt-1 text-xs text-warning">Unavailable: 0 matching historical outcomes.</p>;
  return <>
    <p className="mt-1 font-mono text-lg font-semibold">{decimal(sample.winRate)}% <span className="text-[10px] font-normal text-muted">{sample.wins}/{sample.total} observed</span></p>
    {sample.confidenceInterval && <p className="text-[10px] text-muted">95% Wilson interval: {sample.confidenceInterval.map((value) => `${decimal(value)}%`).join(" - ")}</p>}
    {sample.total < 30 && <p className="mt-1 text-[10px] text-warning">Low sample: unreliable for prediction.</p>}
  </>;
}

export function FifteenMinuteOutlook({ analysis, history, plan, now, loading, error }: {
  analysis: MarketAnalysis | null; history: FifteenMinuteHistory | null;
  plan: TechnicalVerdict | null; now: number; loading: boolean; error?: string;
}) {
  const outlook = calculateFifteenMinuteOutlook(analysis, history, plan, now);
  return <section className="my-4 border-y border-line py-3" aria-labelledby="fifteen-minute-outlook-title">
    <h3 id="fifteen-minute-outlook-title" className="text-xs font-semibold">Next 15 minutes · historical evidence</h3>
    {loading ? <p role="status" className="mt-2 text-xs text-muted">Loading 15-minute outcome history...</p>
      : error ? <p role="alert" className="mt-2 text-xs text-negative">Outlook unavailable: {error}</p>
        : !outlook.available ? <p role="status" className="mt-2 text-xs text-warning">{outlook.reason}</p>
          : <>
            <p className="mt-1 text-[10px] text-muted">Reference {money(outlook.referencePrice)} · through {new Date(outlook.endsAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Historical frequency, not calibrated live odds.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <h4 className="text-[11px] font-medium">{outlook.trade ? `${outlook.trade.side} target before stop` : "Trade-plan success"}</h4>
                {outlook.trade ? <>
                  <OutcomeRate sample={outlook.trade} />
                  <p className="mt-1 text-[10px] text-muted">{outlook.trade.stopped} stopped · {outlook.trade.neither} neither hit within 15m.</p>
                </> : <p className="mt-1 text-xs text-muted">No eligible MIS 15m BUY/SELL plan. WAIT/exit-only has no new-entry success rate.</p>}
              </div>
              <div>
                <h4 className="text-[11px] font-medium">RSI {decimal(outlook.rsi)} · {outlook.zone === "OVERBOUGHT" ? "70+ to 30 or below" : outlook.zone === "OVERSOLD" ? "30 or below to 70+" : "Not overbought / oversold"}</h4>
                {outlook.reversal ? <OutcomeRate sample={outlook.reversal} />
                  : <p className="mt-1 text-xs text-muted">No extreme-to-extreme reversal setup at this snapshot RSI.</p>}
                {outlook.reversal && <p className="mt-1 text-[10px] text-muted">Opposite RSI zone at the next 15m close; not merely price moving in that direction.</p>}
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-line bg-inset p-2">
              <h4 className="text-[11px] font-medium">Historical-analogue close estimate · {outlook.priceSamples} same-RSI samples</h4>
              {outlook.prices ? <>
                <p className="mt-1 font-mono text-sm">{money(outlook.prices.lower)} - {money(outlook.prices.upper)}</p>
                <p className="mt-1 text-[10px] text-muted">Median {money(outlook.prices.median)} · historical 10th-90th percentiles rebased to the current price. Not a calibrated 80% forecast.</p>
              </> : <p className="mt-1 text-xs text-warning">{outlook.priceReason}</p>}
            </div>
            {outlook.provisional && <p className="mt-2 text-[10px] text-warning">Snapshot RSI includes an unfinished candle; its zone and matching samples can change.</p>}
            <details className="mt-2 text-[11px] text-muted">
              <summary className="cursor-pointer">RSI price references &amp; study limits</summary>
              {outlook.history.references ? <>
                <p className="mt-2">Hypothetical next 15m candle-close prices: RSI 70 near {money(outlook.history.references.overbought)}; RSI 30 near {money(outlook.history.references.oversold)}. These are tick-rounded Wilder RSI(14) threshold calculations, not predicted prices.</p>
                <p className="mt-2">Calculated from the last closed candle at {new Date(outlook.history.endTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST, close {money(outlook.history.references.close)}, RSI {decimal(outlook.history.references.rsi)}. They do not use live LTP as a replacement candle close. &quot;--&quot; means no positive, tick-aligned threshold is representable.</p>
              </> : <p className="mt-2">RSI threshold prices are unavailable for flat or insufficient closed-candle history.</p>}
              <p className="mt-2">Trade success means target 1 (2R) before the 1.5xATR stop within one subsequent 15m candle, using the same stock/contract, strict MIS rules and side. Neither hit counts as not successful. Known opening gaps are evaluated first; an otherwise ambiguous stop/target bar is stop-first. This is target attainment, not after-cost profitability.</p>
              <p className="mt-2">RSI matches use 70+ overbought, 30 or below oversold, or the same 10-point middle band. Reversal success requires the opposite extreme at the next close; intrabar RSI touches cannot be observed. Samples use only closed-candle prefixes and never cross overnight gaps. History: {new Date(outlook.history.startTime).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} - {new Date(outlook.history.endTime).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}, {outlook.history.closedCandles} closed candles.</p>
              <p className="mt-2">Historical trials start at candle closes, not arbitrary intrabar timestamps. Applying their returns to the live quote is an analogue estimate, not a validated rolling-15-minute probability. Serially correlated samples can make Wilson intervals optimistic; there is no out-of-sample calibration. Overbought can stay overbought. No full-market history, news or fundamentals are included. Weekday session schedule only; holidays and special sessions are not verified. These studies never change order eligibility or place orders.</p>
            </details>
          </>}
  </section>;
}
