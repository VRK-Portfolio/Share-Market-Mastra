"use client";

import { useEffect, useState } from "react";
import { topPicksResponseSchema } from "../../lib/market/top-picks";
import type { TopPickSelection, TopPicksResponse } from "../../lib/market/top-picks";
import { money } from "./format";

export function TopPicks({ onSelect, onSessionExpired }: {
  onSelect: (pick: TopPickSelection) => void;
  onSessionExpired: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; data?: TopPicksResponse; error?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const current = result?.revision === revision ? result : null;
  const loading = !current;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/groww/top-picks", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : `Top-picks request failed (${response.status}).`);
        }
        const data = topPicksResponseSchema.parse(body);
        if (!controller.signal.aborted) setResult({ revision, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({
          revision, error: error instanceof Error ? error.message : "Unable to load today's top picks.",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, onSessionExpired]);
  const data = current?.data;
  const today = new Date(now + 330 * 60_000).toISOString().slice(0, 10);

  return <section className="panel p-4 focus-visible:outline-2 focus-visible:outline-accent xl:max-h-[calc(100dvh-14rem)] xl:overflow-y-auto" aria-labelledby="top-picks-title" tabIndex={0}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="top-picks-title" className="text-sm font-semibold">Today&apos;s top stock picks</h2>
      <button type="button" className="secondary-button px-2 py-1.5 text-xs" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh picks</button>
    </div>
    <p className="mt-2 text-xs text-muted">Rule-qualified NSE CASH setups. Click to analyze; no orders or model calls. Not guaranteed winners.</p>
    {loading && <p role="status" className="mt-4 text-sm text-muted">Screening Groww quotes and 15-minute / daily candles for intraday and carry-forward picks...</p>}
    {current?.error && <p role="alert" className="mt-4 text-sm text-negative">{current.error}</p>}
    {data && <>
      <p className="mt-3 text-xs text-muted">{data.date} · {data.screened}/{data.universe.length} screened · {new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
      {data.date !== today && <p role="status" className="mt-3 text-sm text-warning">These picks are from a previous date. Refresh picks for today.</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        {([
          { title: "Intraday (MIS)", mode: "MIS", picks: data.intraday, description: "15-minute · BUY / short SELL · quotes <=60s" },
          { title: "Carry forward (CNC)", mode: "CNC", picks: data.carryForward, description: "Daily · BUY only · <=3 days · Gap risk" },
        ]).map(({ title, mode, picks, description }) => <section key={title} className="rounded-xl border border-line bg-inset p-2" aria-label={title}>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
          {!picks.length && <p role="status" className="mt-3 text-xs text-muted">No qualifying picks. Expand screened stocks below for the actual blockers. No picks are forced.</p>}
          <ol className="mt-2 space-y-2">
            {picks.map((pick, index) => {
              const stale = data.date !== today || now - pick.lastTradeTime > (pick.mode === "MIS" ? 60_000 : 3 * 86_400_000);
              return <li key={pick.symbol}>
                <button type="button" onClick={() => onSelect(pick)} className="w-full rounded-xl border border-line bg-panel p-2 text-left text-xs transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Analyze ${pick.symbol} for ${pick.mode === "MIS" ? "intraday" : "carry forward"}`}>
                  <span className="flex items-center justify-between gap-2"><span className="font-mono font-semibold">{index + 1}. {pick.symbol}</span><span title={`Last trade ${new Date(pick.lastTradeTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`} className={`text-[10px] ${stale ? "text-warning" : "text-muted"}`}>{new Date(pick.lastTradeTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST{stale ? " - stale" : ""}</span><span className={pick.decision === "BUY" ? "text-positive" : "text-negative"}>{pick.decision}</span></span>
                  <span className="mt-1 block text-xs">LTP {money(pick.price)} · Entry {money(pick.entryPrice)}</span>
                  <span className="mt-1 block text-xs text-muted">Stop {money(pick.stopLoss)} · Targets {pick.targetPrices.map(money).join(" / ")}</span>
                </button>
              </li>;
            })}
          </ol>
          <details className="mt-2 text-xs">
          <summary className="cursor-pointer font-semibold text-accent">Screened stocks ({data.screenedStocks.filter((stock) => stock.mode === mode).length}) - not additional picks</summary>
          <p className="mt-2 text-xs text-muted">Checks reflect the scan time, not live signals. Click any stock to load fresh analysis, even if it did not qualify.</p>
          <ul className="mt-3 space-y-3">
            {data.screenedStocks.filter((stock) => stock.mode === mode).map((stock) => <li key={stock.symbol} className="rounded-xl border border-line p-3">
              <button type="button" onClick={() => onSelect(stock)} className="secondary-button w-full text-left text-xs" aria-label={`Analyze screened ${stock.symbol} for ${mode === "MIS" ? "intraday" : "carry forward"}`}>
                {stock.symbol} - {stock.qualified ? "Rule-qualified" : "Not a pick"} - View analysis
              </button>
              <p className="mt-2 text-xs text-muted">Data checks: {stock.dataReady ? "Passed" : "Failed"} · {stock.summary}</p>
              <p className="mt-2 text-xs text-muted">{stock.directionalSignals.map((item) => `${item.indicator}: ${item.signal}`).join(" · ")}</p>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-accent">{stock.qualified ? "Setup details" : "Why not a pick?"}</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">{stock.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
              </details>
            </li>)}
          </ul>
          </details>
        </section>)}
      </div>
      {!!data.warnings.length && <div role="alert" className="mt-4 text-xs text-warning"><p>Partial scan: unavailable stocks were excluded.</p><ul className="mt-2 list-disc space-y-1 pl-5">{data.warnings.map((warning) => <li key={warning.symbol}>{warning.symbol}: {warning.error}</li>)}</ul></div>}
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Universe &amp; screening rules</summary><p className="mt-2">Universe: {data.universe.join(", ")}. Up to three setups per mode, ranked by approximate reported-session traded value (LTP x volume), not a profit score or a whole-market ranking. EMA20/50, RSI, MACD and SuperTrend must agree; MIS also requires VWAP. Missing quote volume prevents ranking; incomplete current-session candle volume prevents MIS VWAP confirmation. Refresh to rescreen; closed markets can show last-session carry-forward setups.</p></details>
    </>}
  </section>;
}
