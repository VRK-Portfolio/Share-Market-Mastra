"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { fnoInstrumentSchema } from "../../lib/groww/instrument-schemas";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { optionUnderlyingSnapshotSchema } from "../../lib/groww/option-analytics-schemas";
import type { FeedSelection } from "../../lib/groww/live-schemas";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { calculateOptionAnalytics } from "../../lib/market/option-analytics";
import type { OptionAnalyticsInput } from "../../lib/market/option-analytics";
import { calculateOptionVerdict } from "../../lib/market/option-verdict";
import { freshLivePrice, livePriceKey } from "../../lib/market/live-prices";
import { optionStrikeMoneyness } from "../../lib/market/option-guide";
import { useInstrumentPrices } from "./use-instrument-prices";
import { decimal, money } from "./format";
import { VerdictDuration } from "./verdict-duration";
import { verdictTimingContext } from "../../lib/market/verdict-duration";

type Snapshot = z.infer<typeof optionUnderlyingSnapshotSchema>;
const precise = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 6 });
const asOf = (time: number | null | undefined) => time == null ? "unavailable"
  : new Date(time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
const numeric = (value: string) => value.trim() ? Number(value) : NaN;

export function OptionAnalytics({ instrument, data, mode, onSessionExpired }: {
  instrument: FnoInstrument; data: MarketAnalysis | null; mode: AnalysisMode; onSessionExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [revision, setRevision] = useState(0);
  const [rate, setRate] = useState("6");
  const [dividend, setDividend] = useState("0");
  const [iv, setIv] = useState("");
  const [entry, setEntry] = useState("");
  const [lots, setLots] = useState("1");
  const [result, setResult] = useState<{ key: string; requestKey: string; data?: Snapshot; error?: string } | null>(null);
  const key = JSON.stringify([instrument.exchange, instrument.growwSymbol]);
  const snapshotAt = data?.fetchedAt;
  const requestKey = JSON.stringify([key, snapshotAt, revision]);
  const current = result?.key === key ? result : null;
  const snapshot = current?.data;
  const selection: FeedSelection | null = snapshot
    ? { exchange: snapshot.underlying.exchange, symbol: snapshot.underlying.tradingSymbol, segment: "CASH" } : null;
  const live = useInstrumentPrices(selection ? [selection] : [], !!selection, onSessionExpired, 500);
  const tick = selection ? live.prices[livePriceKey(selection)] : undefined;
  const streamedSpot = freshLivePrice(tick, now) && tick.tradeTime >= (snapshot?.quote.lastTradeTime ?? 0) ? tick : null;
  const spot = streamedSpot?.price ?? snapshot?.quote.price;
  const spotTime = streamedSpot?.tradeTime ?? snapshot?.quote.lastTradeTime ?? null;
  const busy = !!snapshotAt && current?.requestKey !== requestKey && instrument.instrumentType !== "FUT";

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (instrument.instrumentType === "FUT" || !snapshotAt) return;
    const controller = new AbortController();
    async function load() {
      try {
        const query = new URLSearchParams({ symbol: instrument.tradingSymbol, exchange: instrument.exchange });
        const response = await fetch(`/api/groww/option-underlying?${query}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Unable to load the option underlying.");
        const verified = optionUnderlyingSnapshotSchema.safeParse(body);
        if (!verified.success || JSON.stringify(verified.data.contract) !== JSON.stringify(fnoInstrumentSchema.parse(instrument))) {
          throw new Error("Underlying response does not match the selected contract metadata. Reselect the contract.");
        }
        if (!controller.signal.aborted) setResult({ key, requestKey, data: verified.data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({
          key, requestKey,
          error: error instanceof Error ? error.message : "The verified underlying could not be loaded.",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [instrument, snapshotAt, key, requestKey, onSessionExpired]);

  if (instrument.instrumentType === "FUT") return <section className="panel p-4" aria-label="Option analytics">
    <h2 className="text-sm font-semibold">Option Greeks &amp; expiry POP</h2>
    <p className="mt-2 text-xs text-muted">Select a CE or PE option for Greeks, IV and long-option POP. These option metrics do not apply to a futures contract; its price-based indicators remain below.</p>
  </section>;

  let analytics: ReturnType<typeof calculateOptionAnalytics> | null = null;
  let modelInput: OptionAnalyticsInput | null = null;
  let unavailable: string | null = null;
  try {
    if (!data || data.segment !== "FNO" || data.symbol !== instrument.tradingSymbol || data.exchange !== instrument.exchange ||
      data.instrument?.growwSymbol !== instrument.growwSymbol) throw new Error("Waiting for the selected option quote.");
    if (!snapshot || spot === undefined) throw new Error("A verified underlying price is required. Load or retry the underlying feed.");
    modelInput = {
      instrument, now, premium: data.quote.price, premiumTime: data.quote.lastTradeTime,
      spot, spotTime, ratePercent: numeric(rate), dividendPercent: numeric(dividend),
      ivPercent: iv.trim() ? numeric(iv) : null, entryPremium: entry.trim() ? numeric(entry) : data.quote.price, lots: numeric(lots),
    };
    analytics = calculateOptionAnalytics(modelInput);
  } catch (error) {
    unavailable = error instanceof Error ? error.message : "Option analytics could not be calculated.";
  }
  const verdict = data?.symbol === instrument.tradingSymbol && data.exchange === instrument.exchange &&
    data.instrument?.growwSymbol === instrument.growwSymbol ? calculateOptionVerdict(data, mode, modelInput, now) : null;
  const inputStyle = "mt-1 w-full min-w-0 rounded-lg border border-line bg-inset px-2 py-2 font-mono text-xs";
  const greeks = analytics ? [
    { name: "Delta", value: analytics.delta, note: "Premium change per +Rs1 spot; CE positive, PE negative." },
    { name: "Gamma", value: analytics.gamma, note: "Delta change per +Rs1 spot; not a directional vote." },
    { name: "Theta", value: analytics.theta, note: "Rs premium change as one calendar day passes." },
    { name: "Vega", value: analytics.vega, note: "Rs premium change per +1 percentage point IV." },
    { name: "Rho", value: analytics.rho, note: "Rs premium change per +1 percentage point interest rate." },
  ] : [];
  return <section className="panel min-w-0 p-4" aria-labelledby="option-analytics-title">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 id="option-analytics-title" className="text-sm font-semibold">Option Greeks &amp; expiry POP</h2>
        <p className="mt-1 text-[11px] text-muted">Selected {instrument.instrumentType} · hypothetical new BUY / long option only</p>
      </div>
      <button type="button" className="rounded-lg border border-line px-2 py-1 text-xs disabled:opacity-50" disabled={busy || !snapshotAt}
        onClick={() => { setRevision(value => value + 1); live.reconnect(); }}>{busy ? "Loading underlying..." : "Refresh underlying"}</button>
    </div>
    <p className="mt-3 break-words text-xs">{snapshot?.underlying.tradingSymbol ?? instrument.underlying} spot {money(spot)}
      <span className="text-muted"> · {streamedSpot ? "stream" : "snapshot"} {asOf(spotTime)} IST · Option {money(data?.quote.price)} as of {asOf(data?.quote.lastTradeTime)} IST</span></p>
    {current?.error && <p role="alert" className="mt-2 break-words text-xs text-negative">Underlying snapshot: {current.error}</p>}
    {live.error && <div role="alert" className="mt-2 text-xs text-warning">{live.error} <button type="button" className="underline" onClick={live.reconnect}>Reconnect underlying</button></div>}
    {data && verdict && <section className="mt-3 rounded-xl border border-line p-3" aria-label="Option-aware verdict">
      <div className="grid grid-cols-2 gap-3">
        <div><p className="text-[11px] text-muted">Technical only · unchanged</p><p className="mt-1 font-semibold">{verdict.technicalDecision}</p></div>
        <div><p className="text-[11px] text-muted">Option-aware · {mode}</p>
          <h3 className={`mt-1 text-lg font-semibold ${verdict.decision === "BUY" ? "text-positive" : verdict.exitOnly ? "text-negative" : "text-warning"}`}>
            {verdict.exitOnly ? "SELL / EXIT ONLY" : verdict.decision === "BUY" ? "BUY CANDIDATE" : "HOLD"}
          </h3></div>
      </div>
      <VerdictDuration kind="option" context={verdictTimingContext(data, mode)} decision={verdict.dataReady ? verdict.decision : null} />
      <p role="status" className="mt-2 break-words text-xs">{verdict.summary}</p>
      {verdict.horizonAt !== null && <p className="mt-2 text-[11px] text-muted">
        Horizon: {mode === "MIS" ? "remaining regular session" : "next 24 calendar hours"}, capped at expiry · through {new Date(verdict.horizonAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.
        Technical target 1 {money(verdict.target)} · stop {money(verdict.stopLoss)}.
      </p>}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer">Why this option-aware verdict?</summary>
        <ul className="mt-2 space-y-2">{verdict.checks.map(check => <li key={check.label}>
          <p className={check.status === "PASS" ? "text-positive" : "text-warning"}>{check.status} · {check.label}</p>
          <p className="mt-1 text-[11px] text-muted">{check.detail}</p>
        </li>)}</ul>
        {verdict.scenarios.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-[11px]" aria-label="Option-aware holding-period scenarios">
          <thead><tr><th className="p-1">Scenario</th><th className="p-1">Spot</th><th className="p-1">Premium / unit</th></tr></thead>
          <tbody>{verdict.scenarios.map(scenario => <tr key={scenario.id} className="border-t border-line">
            <th scope="row" className="p-1 font-normal">{scenario.label}</th><td className="p-1 font-mono">{money(scenario.spot)}</td><td className="p-1 font-mono">{money(scenario.premium)}</td>
          </tr>)}</tbody>
        </table></div>}
        <p className="mt-2 text-[11px] text-muted">Full BSM repricing incorporates delta/gamma, theta, vega and rho, rather than directional votes from individual Greeks. Spot scenarios use spot × exp(±IV × sqrt(calendar horizon / 365)); they are hypothetical moves, not forecasts or calibrated win probabilities. Each IV/rate stress includes time decay and is tested separately, not as a combined shock. The adverse-spot row shows stop exposure but does not veto a planned stop.</p>
        <p className="mt-2 text-[11px] text-muted">BUY requires technical BUY, a market-consistent model, favorable-spot premium reaching target 1 and unchanged-spot/time, IV-down and adverse-rate premiums staying above the existing stop. MIS new-entry guidance ends at 15:20 IST. NRML uses 24 hours, not the entire expiry lifetime. All scenario prices and levels are gross of costs.</p>
      </details>
      <p className="mt-2 text-[11px] text-muted">Live LTP and the current model assumptions drive this separate verdict; edited entry cost/lots do not. Expiry POP is context, not an intraday win rate or a directional vote. Advisory only: this does not change the technical verdict, AI opinion, reference levels, paper-order permissions or existing-position exits.</p>
    </section>}
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      <label className="min-w-0 text-[11px] text-muted">Annual rate (%)<input className={inputStyle} type="number" step="0.1" min="-20" max="50" value={rate} onChange={event => setRate(event.target.value)} /></label>
      <label className="min-w-0 text-[11px] text-muted">Dividend yield (%)<input className={inputStyle} type="number" step="0.1" min="0" max="50" value={dividend} onChange={event => setDividend(event.target.value)} /></label>
      <label className="min-w-0 text-[11px] text-muted">IV override (%)<input className={inputStyle} type="number" step="0.1" min="0.01" max="500" placeholder="Auto from prices" value={iv} onChange={event => setIv(event.target.value)} /></label>
      <label className="min-w-0 text-[11px] text-muted">Entry premium / unit<input className={inputStyle} type="number" step="any" min="0" placeholder={data ? decimal(data.quote.price) : "Auto LTP"} value={entry} onChange={event => setEntry(event.target.value)} /></label>
      <label className="min-w-0 text-[11px] text-muted">Hypothetical lots<input className={inputStyle} type="number" step="1" min="1" max="100000" value={lots} onChange={event => setLots(event.target.value)} /></label>
    </div>
    <p className="mt-2 text-[11px] text-muted">6% rate and 0% dividend are illustrative defaults, not current RBI/broker data. Edit to match your assumptions. Blank IV solves from prices; blank entry follows current premium. Lots here do not change the paper ticket.</p>
    {unavailable && <p role="status" className="mt-3 rounded-lg border border-warning/25 p-3 text-xs text-warning">Analytics unavailable: {unavailable}</p>}
    {analytics && <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          ["Model IV", `${decimal(analytics.ivPercent)}%`, iv.trim() ? "User IV assumption, not broker IV" : "Price-implied BSM estimate; not broker IV"],
          ["Gross expiry POP", `${decimal(analytics.pop * 100)}%`, "Risk-neutral probability of profit BEFORE all costs"],
          ["Gross expiry breakeven", money(analytics.breakeven), analytics.breakeven === null ? "No positive-spot profitable expiry" : "Entry premium only; excludes all charges"],
          ["Time to expiry", `${decimal(analytics.days)} days`, `${instrument.expiry} at 15:30 IST; calendar ACT/365`],
          ["Intrinsic / time value", `${money(analytics.intrinsic)} / ${money(analytics.extrinsic)}`, `${optionStrikeMoneyness(instrument.instrumentType, instrument.strikePrice!, spot!)} at current spot; per unit`],
          ["Probability of ITM", `${decimal(analytics.itmProbability * 100)}%`, "Finishing ITM is not necessarily profitable"],
          ["Model 68% terminal range", `${money(analytics.terminalRange[0])} - ${money(analytics.terminalRange[1])}`, "Risk-neutral lognormal range; not a price target"],
          ["Maximum premium loss", money(analytics.maxLoss), `${analytics.units} units; excludes charges and settlement liabilities`],
        ].map(([label, value, note]) => <article key={label} className="min-w-0 rounded-lg border border-line bg-inset p-2">
          <h3 className="text-[11px] text-muted">{label}</h3><p className="mt-1 break-words font-mono text-sm font-semibold">{value}</p>
          <p className="mt-1 text-[10px] text-muted">{note}</p>
        </article>)}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs" aria-label="Long option Greeks">
          <thead className="text-muted"><tr><th className="p-2">Greek</th><th className="p-2">Per unit</th><th className="p-2">{analytics.units} units</th></tr></thead>
          <tbody>{greeks.map(item => <tr key={item.name} className="border-t border-line">
            <th scope="row" className="p-2 font-medium">{item.name}<span className="mt-1 block max-w-48 text-[10px] font-normal text-muted">{item.note}</span></th>
            <td className="p-2 font-mono">{precise(item.value)}</td><td className="p-2 font-mono">{precise(item.value * analytics.units)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {analytics.extrinsic < 0 && <p className="mt-2 text-xs text-warning">Premium is below spot intrinsic value. Carry/dividends, stale or inconsistent prices can affect this; review inputs before interpreting the model.</p>}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted">Expiry scenarios &amp; interpretation</summary>
        <ul className="mt-2 space-y-1">{analytics.scenarios.map(item => <li key={item.move} className="flex flex-wrap justify-between gap-1">
          <span>Spot {item.move > 0 ? "+" : ""}{Math.round(item.move * 100)}%: {money(item.terminalSpot)}</span>
          <span className={item.grossPnl >= 0 ? "text-positive" : "text-negative"}>Gross P&amp;L {money(item.grossPnl)}</span>
        </li>)}</ul>
        <p className="mt-2 text-muted">A CE generally benefits from rising spot; a PE from falling spot. Positive gamma can accelerate the move; theta can erode premium even when direction is right. Vega and rho measure sensitivity, not BUY/SELL instructions. Selling an owned option closes exposure; this is not an option-writing POP or an existing-position P&amp;L calculator.</p>
      </details>
    </>}
    <p className="mt-3 text-[11px] leading-relaxed text-warning">POP and breakeven are gross, before Rs20/order brokerage, taxes, slippage, financing or exercise/physical-settlement costs. Net-of-cost POP is not calculated. Not a real-world win rate or a recommendation; Greeks alone never mean BUY or SELL.</p>
    <details className="mt-2 text-[11px] leading-relaxed text-muted">
      <summary className="cursor-pointer">Model, live inputs &amp; limitations</summary>
      <p className="mt-2">European Black-Scholes-Merton with continuous rate/dividend yield, constant IV and lognormal spot. Theta is per calendar day; vega/rho per +1 percentage point. All sensitivities are for a long option, holding other inputs fixed. Greeks are estimates, not broker values. POP integrates expiry payoff beyond the entry-premium breakeven under the risk-neutral model, not delta or the historical technical win rate.</p>
      <p className="mt-2">IV is solved from the current premium/spot within 0.01%-500% unless overridden. Broker IV remains raw in the indicator snapshot because its unit convention is unverified. Underlying symbols are verified against the catalog, including stock options and known index aliases; no futures price is substituted for spot. Prices must be from today, within 60 seconds and at most 30 seconds apart. Missing/stale/unidentifiable data shows unavailable, not zero.</p>
      <p className="mt-2">Streaming premium/spot and the one-second clock recalculate locally, with no API/LLM call per tick. Underlying snapshots refresh with the option snapshot or the button; OI, volume, raw broker IV and candle indicators remain snapshots. No volatility smile, jumps, discrete dividends, expiry-day exercise/settlement taxes or delivery funding is modeled. Greeks near expiry can change sharply; actual net P&amp;L belongs in paper history.</p>
    </details>
  </section>;
}
