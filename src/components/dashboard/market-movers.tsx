"use client";

import { useEffect, useState } from "react";
import { marketMoversResponseSchema } from "../../lib/market/market-movers";
import type { MarketMover, MarketMoversResponse } from "../../lib/market/market-movers";
import { decimal, money } from "./format";

export function MarketMovers({ onSelect, onSessionExpired }: {
  onSelect: (stock: MarketMover) => void;
  onSessionExpired: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; data?: MarketMoversResponse; error?: string } | null>(null);
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
        const response = await fetch("/api/groww/market-movers", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : `Market-movers request failed (${response.status}).`);
        }
        const data = marketMoversResponseSchema.parse(body);
        if (!controller.signal.aborted) setResult({ revision, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({
          revision, error: error instanceof Error ? error.message : "Unable to load today's gainers and losers.",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, onSessionExpired]);
  const data = current?.data;
  const today = new Date(now + 330 * 60_000).toISOString().slice(0, 10);

  return <section className="panel p-4 focus-visible:outline-2 focus-visible:outline-accent xl:max-h-[calc(100dvh-14rem)] xl:overflow-y-auto" aria-labelledby="market-movers-title" tabIndex={0}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="market-movers-title" className="text-sm font-semibold">Today&apos;s gainers &amp; losers</h2>
      <button type="button" className="secondary-button px-2 py-1.5 text-xs" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh list</button>
    </div>
    <p className="mt-2 text-xs text-muted">Tracked NSE CASH stocks ranked by day change vs previous close. Click to analyze; not buy/sell recommendations.</p>
    {loading && <p role="status" className="mt-4 text-sm text-muted">Loading today&apos;s Groww stock quotes...</p>}
    {current?.error && <p role="alert" className="mt-4 text-sm text-negative">{current.error}</p>}
    {data && <>
      <p className="mt-3 text-xs text-muted">{data.date} · Updated {new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
      {data.date !== today ? <p role="status" className="mt-3 text-sm text-warning">This list is from a previous date. Refresh for today&apos;s gainers and losers.</p> : <>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          {([
            { title: "Gainers", stocks: data.gainers, color: "text-positive" },
            { title: "Losers", stocks: data.losers, color: "text-negative" },
          ]).map(({ title, stocks, color }) => <section key={title} className="rounded-xl border border-line bg-inset p-2" aria-label={title}>
            <h3 className={`text-sm font-semibold ${color}`}>{title} ({stocks.length})</h3>
            {!stocks.length && <p role="status" className="mt-3 text-xs text-muted">No {title.toLowerCase()} among tracked stocks with valid trades today (IST).</p>}
            <ol className="mt-2 space-y-2">
              {stocks.map((stock, index) => <li key={stock.symbol}>
                <button type="button" onClick={() => onSelect(stock)} className="w-full rounded-xl border border-line bg-panel p-2 text-left text-xs transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Analyze ${stock.symbol}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{index + 1}. {stock.symbol}</span>
                    <span className={color}>{stock.changePercent > 0 ? "+" : ""}{decimal(stock.changePercent)}%</span>
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2">
                    <span>LTP {money(stock.price)}</span>
                    <span className={color}>{stock.change > 0 ? "+" : ""}{money(stock.change)}</span>
                  </span>
                  <span className="mt-1 block text-[10px] text-muted">Last trade {new Date(stock.lastTradeTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST{now - stock.lastTradeTime > 60_000 ? " - stale" : ""}</span>
                </button>
              </li>)}
            </ol>
          </section>)}
        </div>
        <p className="mt-3 text-xs text-muted">{data.unchanged} unchanged. Only quotes traded today (IST) are included; before trading or on holidays this list may be empty.</p>
      </>}
      {!!data.warnings.length && <div role="alert" className="mt-4 text-xs text-warning"><p>Excluded stocks: unavailable, invalid or not traded today.</p><ul className="mt-2 list-disc space-y-1 pl-5">{data.warnings.map((warning) => <li key={warning.symbol}>{warning.symbol}: {warning.error}</li>)}</ul></div>}
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Coverage &amp; ranking</summary><p className="mt-2">Tracked stocks: {data.universe.join(", ")}. This is not a whole-market ranking. Gainers are sorted by largest percentage rise; losers by largest percentage fall. Unchanged stocks are counted separately. Refresh to fetch a new snapshot; no automatic polling, candle screening, model calls or orders.</p></details>
    </>}
  </section>;
}
