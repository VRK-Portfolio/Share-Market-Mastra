"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { nifty100Schema } from "../../lib/groww/nifty100-schemas";
import type { Nifty100 } from "../../lib/groww/nifty100-schemas";
import { liveStockScreen } from "../../lib/market/stock-screener";
import type { ScreenerMode, StockScreenResult } from "../../lib/market/stock-screener";
import type { TechnicalVerdict } from "../../lib/market/technical-verdict";
import { Header } from "./header";
import { money } from "./format";
import { useNifty100Scan } from "./use-nifty100-scan";
import { useInstrumentPrices } from "./use-instrument-prices";
import { freshLivePrice, livePriceKey } from "../../lib/market/live-prices";
import { screenerCache } from "../../lib/market/screener-cache";

export function Nifty100Screener({ terminalExpiresAt }: { terminalExpiresAt: string }) {
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(false);
  const onConnectionChange = useCallback((value: boolean) => { setConnected(value); if (value) setExpired(false); }, []);
  const onSessionExpired = useCallback(() => { setConnected(false); setExpired(true); }, []);
  return <div className="min-h-screen bg-background">
    <Header connected={connected} onConnectionChange={onConnectionChange} terminalExpiresAt={terminalExpiresAt} />
    <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">NIFTY 100 stock screener</h1>
          <p className="mt-2 text-sm text-muted">Separate intraday and carry-forward indicator verdicts across the official NSE index constituents.</p></div>
        <Link href="/" className="secondary-button text-xs">Back to stock terminal</Link>
      </div>
      <section aria-label="Screener limitations" className="panel border-warning/30 p-4 text-xs leading-relaxed text-muted">
        <p>Cached detailed analysis appears first. Groww&apos;s WebSocket-backed price feed updates prices, price-dependent verdict checks and trade levels locally, without an analysis API request on each tick.</p>
        <p className="mt-2">Indicators remain confirmed snapshots from completed 15m / daily candles. Only missing or outdated historical baselines load through paced API requests; the first visit can still take several minutes. A newly completed candle invalidates its baseline until updated history arrives. Volume, new candles and indicators are never invented from LTP ticks.</p>
        <p className="mt-2">A fresh matching live tick and current historical baseline are required; missing/stale feeds show HOLD. MIS requires an open session before 15:20 IST. No AI or orders run here. Technical screening does not confirm news, sector context, ORB/volume or liquidity. CNC SELL means exit/avoid, not a new short.</p>
      </section>
      {expired && <p role="alert" className="text-sm text-negative">Groww session expired. Reconnect in the header to restart the scan.</p>}
      {connected ? <ConnectedScreener onSessionExpired={onSessionExpired} />
        : <section className="panel p-6"><h2 className="font-semibold">Connect Groww to start the NIFTY 100 scan</h2><p className="mt-2 text-sm text-muted">Use the connection control in the header. No sample constituents, prices or verdicts are shown.</p></section>}
    </main>
  </div>;
}

function ConnectedScreener({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; data?: Nifty100; error?: string } | null>(null);
  const [cacheNotice, setCacheNotice] = useState("");
  const current = result?.revision === revision ? result : null;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        try {
          const cached = await screenerCache.universe(Date.now());
          if (controller.signal.aborted) return;
          if (cached) { setResult({ revision, data: cached }); return; }
        } catch (error) {
          if (!controller.signal.aborted) setCacheNotice(`Membership cache unavailable: ${error instanceof Error ? error.message : "Storage failed."}`);
        }
        const response = await fetch("/api/groww/nifty100", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Unable to load NIFTY 100 constituents.");
        const parsed = nifty100Schema.safeParse(body);
        if (!parsed.success) throw new Error("The official constituent response was malformed. No stocks were scanned.");
        if (!controller.signal.aborted) {
          setResult({ revision, data: parsed.data });
          try { await screenerCache.saveUniverse(parsed.data); }
          catch (error) {
            if (!controller.signal.aborted) setCacheNotice(`Membership cache could not be saved: ${error instanceof Error ? error.message : "Storage failed."}`);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setResult({ revision, error: error instanceof Error ? error.message : "Unable to load index membership." });
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, onSessionExpired]);
  if (!current) return <p role="status" className="text-sm text-muted">Verifying the official 100-stock NIFTY 100 constituent list...</p>;
  if (!current.data) return <section className="panel p-5"><p role="alert" className="text-sm text-negative">{current.error}</p>
    <button type="button" className="secondary-button mt-3 text-xs" onClick={() => setRevision(value => value + 1)}>Retry constituent list</button></section>;
  return <>{cacheNotice && <p role="alert" className="text-xs text-warning">{cacheNotice}</p>}
    <ScreenerResults key={current.data.fetchedAt} universe={current.data} onSessionExpired={onSessionExpired} /></>;
}

function ScreenerResults({ universe, onSessionExpired }: { universe: Nifty100; onSessionExpired: () => void }) {
  const scan = useNifty100Scan(universe.stocks, onSessionExpired);
  const selections = useMemo(() => universe.stocks.map(stock => ({ symbol: stock.symbol, exchange: "NSE" as const, segment: "CASH" as const })), [universe.stocks]);
  const live = useInstrumentPrices(selections, true, onSessionExpired, 250);
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<ScreenerMode>("MIS");
  const [filter, setFilter] = useState("ALL");
  const evaluated = useMemo(() => universe.stocks.map(stock => {
    const MIS = scan.results[`${stock.symbol}:MIS`];
    const CNC = scan.results[`${stock.symbol}:CNC`];
    const tick = live.prices[livePriceKey({ symbol: stock.symbol, exchange: "NSE", segment: "CASH" })];
    const now = Math.max(scan.now, tick?.observedAt ?? 0);
    const states = {
      MIS: MIS?.data ? liveStockScreen(MIS.data, "MIS", tick, now) : null,
      CNC: CNC?.data ? liveStockScreen(CNC.data, "CNC", tick, now) : null,
    };
    return { stock, states, MIS: MIS?.data && states.MIS ? { ...MIS, data: states.MIS.data } : MIS,
      CNC: CNC?.data && states.CNC ? { ...CNC, data: states.CNC.data } : CNC,
      statuses: { MIS: MIS?.error || MIS?.refreshError ? "ERROR" : states.MIS?.verdict.decision ?? "PENDING",
        CNC: CNC?.error || CNC?.refreshError ? "ERROR" : states.CNC?.verdict.decision ?? "PENDING" },
      verdicts: { MIS: states.MIS?.verdict ?? null, CNC: states.CNC?.verdict ?? null } };
  }), [universe.stocks, scan.results, scan.now, live.prices]);
  const search = query.trim().toUpperCase();
  const visible = evaluated.filter(row => `${row.stock.symbol} ${row.stock.name} ${row.stock.industry}`.toUpperCase().includes(search) &&
    (filter === "ALL" || row.statuses[filterMode] === filter));
  const failures = Object.values(scan.results).filter(result => result.error || result.refreshError).length;
  const complete = scan.done === scan.total;
  const scanning = scan.loading;
  const fresh = Object.values(live.prices).filter(tick => freshLivePrice(tick, Math.max(scan.now, tick.observedAt))).length;
  return <>
    <section className="panel p-4" aria-label="Live screener feed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold">Live price analysis</h2><p role="status" className="mt-1 text-xs text-muted">{fresh}/{universe.stocks.length} stocks with fresh live ticks · two subscriptions of up to 50 stocks · updates batched every 250ms</p></div>
        <button type="button" className="secondary-button text-xs" onClick={live.reconnect}>Reconnect live feed</button>
      </div>
      {live.error && <p role="alert" className="mt-3 text-xs text-negative">{live.error}</p>}
      <p className="mt-2 text-[11px] text-muted">Groww WebSocket → terminal event stream. No REST price polling. Feed disconnects or missing ticks cannot approve entries.</p>
    </section>
    <section className="panel p-4" aria-label="Scan progress">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold">{scan.paused ? "History loading paused" : complete ? "Closed-candle history ready" : scanning ? "Loading missing/outdated history" : "History loaded · some evidence unavailable"}</h2>
          <p role="status" className="mt-1 text-xs text-muted">{scan.done}/{scan.total} current histories · {scan.available} available including cached/outdated · {failures} failed
            {scanning && scan.active ? ` · ${scan.active.symbol} ${scan.active.mode}` : ""}</p></div>
        <div className="flex flex-wrap gap-2">
          {!complete && <button type="button" className="secondary-button text-xs" disabled={scan.cooldown > 0}
            onClick={scan.paused ? scan.resume : scan.pause}>{scan.paused ? scan.cooldown ? `Resume in ${scan.cooldown}s` : "Resume history" : "Pause history"}</button>}
          <button type="button" className="secondary-button text-xs" disabled={scanning || scan.cooldown > 0} onClick={scan.rescan}>Refresh missing/outdated history</button>
          {!!failures && <button type="button" className="secondary-button text-xs" disabled={scanning || scan.cooldown > 0} onClick={scan.rescan}>Retry failed histories</button>}
        </div>
      </div>
      <progress aria-label="NIFTY 100 scan progress" value={scan.done} max={scan.total} className="mt-3 h-2 w-full accent-accent" />
      {scan.notice && <p role="alert" className="mt-3 text-xs text-warning">{scan.notice}</p>}
      {scan.cacheNotice && <p role="alert" className="mt-3 text-xs text-warning">{scan.cacheNotice}</p>}
      <p className="mt-2 text-[11px] text-muted">Membership: <a href={universe.source} target="_blank" rel="noreferrer" className="text-accent underline">official NSE CSV</a> · fetched {snapshotTime(universe.fetchedAt)} IST · cached up to 1h. Validated market histories persist in this browser&apos;s IndexedDB, not account credentials or live tick proofs. Streaming/history work stops when this page closes or Groww disconnects.</p>
    </section>
    <div className="grid gap-3 sm:grid-cols-2" aria-label="Current screener counts">
      {(["MIS", "CNC"] as const).map(mode => <section key={mode} className="panel p-4">
        <h2 className="text-sm font-semibold">{mode === "MIS" ? "Intraday · 15m" : "Carry forward · daily"}</h2>
        <p className="mt-2 text-xs text-muted">{(["BUY", "SELL", "HOLD"] as const).map(side =>
          `${evaluated.filter(row => row.statuses[mode] === side).length} ${side}`).join(" · ")}
          {" · "}{evaluated.filter(row => row.statuses[mode] === "ERROR").length} failed · {evaluated.filter(row => row.statuses[mode] === "PENDING").length} pending</p>
      </section>)}
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="field-label min-w-0 flex-1">Search stock or sector<input type="search" className="field mt-2 w-full" value={query} onChange={event => setQuery(event.target.value)} placeholder="RELIANCE, banking..." /></label>
      <label className="field-label">Filter timeframe<select className="field mt-2 block" value={filterMode} onChange={event => setFilterMode(event.target.value === "CNC" ? "CNC" : "MIS")}><option value="MIS">Intraday</option><option value="CNC">Carry forward</option></select></label>
      <label className="field-label">Verdict<select className="field mt-2 block" value={filter} onChange={event => setFilter(event.target.value)}>
        {["ALL", "BUY", "SELL", "HOLD", "ERROR", "PENDING"].map(value => <option key={value} value={value}>{value === "ALL" ? "All verdicts" : value}</option>)}
      </select></label>
    </div>
    <p role="status" className="text-xs text-muted">Showing {visible.length} of {universe.stocks.length} stocks. Current prices drive verdicts and levels; historical indicators change only when closed-candle history refreshes.</p>
    <div role="region" aria-label="Stock screener results" tabIndex={0} className="panel min-w-0 overflow-x-auto">
      <table className="w-full min-w-[56rem] table-fixed text-left text-xs">
        <caption className="sr-only">NIFTY 100 stocks with intraday and carry-forward verdicts, indicators and analysis links</caption>
        <thead className="bg-inset text-muted">
          <tr><th scope="col" className="w-[22%] p-4 font-medium">Stock</th><th scope="col" className="w-[18%] p-4 font-medium">Sector</th>
            <th scope="col" className="w-[30%] p-4 font-medium">Intraday · 15m (MIS)</th><th scope="col" className="w-[30%] p-4 font-medium">Carry forward · daily (CNC)</th></tr>
        </thead>
        <tbody>
          {!visible.length && <tr><td colSpan={4} className="p-5 text-muted">No stocks match these filters.</td></tr>}
          {visible.map(row => <tr key={row.stock.symbol} aria-label={`${row.stock.symbol} stock screen`} className="border-t border-line align-top hover:bg-inset/50">
            <th scope="row" className="break-words p-4"><span className="block font-mono font-semibold">{row.stock.symbol}</span>
              <span className="mt-1 block font-normal text-muted">{row.stock.name}</span></th>
            <td className="break-words p-4 text-muted">{row.stock.industry}</td>
            {(["MIS", "CNC"] as const).map(mode => <td key={mode} className="p-4"><ModeScreen mode={mode} symbol={row.stock.symbol}
              result={row[mode]} verdict={row.verdicts[mode]} live={row.states[mode]?.live ?? false}
              historyReady={row.states[mode]?.historyReady ?? false} now={scan.now} /></td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </>;
}

function baselineAge(now: number, fetchedAt: string) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(fetchedAt)) / 60_000));
  return minutes < 60 ? `${minutes}m old` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m old`
    : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h old`;
}

function ModeScreen({ mode, symbol, result, verdict, live, historyReady, now }: {
  mode: ScreenerMode; symbol: string; result: StockScreenResult | undefined; verdict: TechnicalVerdict | null;
  live: boolean; historyReady: boolean; now: number;
}) {
  const data = result?.data;
  const values = verdict?.indicatorSnapshot;
  return <section aria-label={`${symbol} ${mode}`} className="min-w-0 space-y-2 text-xs">
    {!result ? <p className="text-muted">Pending</p> : result.error ? <p className="break-words text-negative">Unavailable: {result.error}</p> : data && verdict && <>
      <p className={`font-semibold ${verdict.decision === "BUY" ? "text-positive" : verdict.decision === "SELL" ? "text-negative" : "text-muted"}`}>{verdict.decision}{verdict.exitOnly ? " · exit/avoid" : verdict.decision !== "HOLD" ? " · conditional" : ""}</p>
      <p className="font-mono tabular-nums">{money(data.quote.price)}</p>
      <p className={`text-[11px] ${live ? "text-positive" : "text-warning"}`}>{live ? "Live price" : "Snapshot price · waiting/stale feed"}</p>
      <p className="break-words text-[10px] text-muted">{result.fromCache ? "Cached" : "Loaded"} history {snapshotTime(data.fetchedAt!)} IST · {baselineAge(now, data.fetchedAt!)}</p>
      {!historyReady && <p className="text-[11px] text-warning">History outdated/incomplete · confirmation paused</p>}
      {result.refreshError && <p role="alert" className="text-[11px] text-negative">History refresh failed: {result.refreshError}</p>}
      <details className="text-[11px] text-muted"><summary className="cursor-pointer">Indicators &amp; reasons</summary>
        <p className="mt-2">{verdict.summary}</p>
        <p className="mt-2 break-words">Last trade {data.quote.lastTradeTime ? snapshotTime(new Date(data.quote.lastTradeTime).toISOString()) : "unavailable"} IST</p>
        <dl className="mt-2 space-y-2 break-words">
          <div><dt>RSI</dt><dd>{number(values?.rsi)}</dd></div>
          <div><dt>VWAP</dt><dd>{number(values?.vwap)}</dd></div>
          <div><dt>EMA20 / EMA50</dt><dd>{number(values?.ema20)} / {number(values?.ema50)}</dd></div>
          <div><dt>ATR</dt><dd>{number(values?.atr)}</dd></div>
          <div><dt>MACD / signal / histogram</dt><dd>{number(values?.macd?.value)} / {number(values?.macd?.signal)} / {number(values?.macd?.histogram)}</dd></div>
          <div><dt>SuperTrend</dt><dd>{values?.supertrend ? `${values.supertrend.direction} · ${number(values.supertrend.value)}` : "Unavailable"}</dd></div>
          <div><dt>Closed candles</dt><dd>{data.candles.length}</dd></div>
          <div><dt>Conditional entry / stop</dt><dd>{number(verdict.entryPrice)} / {number(verdict.stopLoss)}</dd></div>
          <div><dt>Targets</dt><dd>{verdict.targetPrices.length ? verdict.targetPrices.map(value => number(value)).join(" / ") : "No new entry"}</dd></div>
        </dl>
        <ul className="mt-3 list-disc space-y-2 pl-3">{verdict.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      </details>
    </>}
    <Link href={`/?${new URLSearchParams({ symbol, mode })}`} className="block text-accent underline underline-offset-2">Open full {mode === "MIS" ? "intraday" : "carry"} analysis</Link>
  </section>;
}

function number(value: number | null | undefined) { return value == null ? "Unavailable" : value.toFixed(2); }
function snapshotTime(value: string) { return new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }); }
