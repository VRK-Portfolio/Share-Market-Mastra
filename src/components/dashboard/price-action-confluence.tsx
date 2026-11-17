"use client";

import { useEffect, useState } from "react";
import { benchmarkSnapshotSchema, indexListSchema } from "../../lib/groww/benchmark-schemas";
import type { BenchmarkSnapshot } from "../../lib/groww/benchmark-schemas";
import { calculatePriceActionConfluence } from "../../lib/market/price-action-confluence";
import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { headlineBalance, newsSentimentSchema } from "../../lib/market/news-sentiment";
import type { NewsSentiment } from "../../lib/market/news-sentiment";

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error : `Unable to load benchmark data (${response.status}).`);
  return body;
}

export function PriceActionConfluence({ data, mode, loading, error, onSessionExpired }: {
  data: MarketAnalysis | null; mode: AnalysisMode; loading: boolean; error?: string; onSessionExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [listRevision, setListRevision] = useState(0);
  const [listResult, setListResult] = useState<{
    revision: number; indices?: ReturnType<typeof indexListSchema.parse>["indices"]; error?: string;
  } | null>(null);
  const [selected, setSelected] = useState("");
  const [benchmarkRevision, setBenchmarkRevision] = useState(0);
  const [benchmarkResult, setBenchmarkResult] = useState<{ key: string; snapshot?: BenchmarkSnapshot; error?: string } | null>(null);
  const benchmarkKey = JSON.stringify([selected, benchmarkRevision]);
  const currentBenchmark = benchmarkResult?.key === benchmarkKey ? benchmarkResult : null;
  const currentList = listResult?.revision === listRevision ? listResult : null;
  const [newsRevision, setNewsRevision] = useState(0);
  const [newsSelection, setNewsSelection] = useState<{ symbol: string; exchange: "NSE" | "BSE" } | null>(null);
  const [newsResult, setNewsResult] = useState<{ key: string; snapshot?: NewsSentiment; error?: string } | null>(null);
  const newsSymbol = newsSelection?.symbol;
  const newsExchange = newsSelection?.exchange;
  const newsSegment = data?.segment ?? "CASH";
  const newsKey = JSON.stringify([newsSymbol, newsExchange, newsRevision]);
  const currentNews = newsResult?.key === newsKey ? newsResult : null;
  const newsLoading = newsRevision > 0 && !!newsSymbol && !currentNews;
  const verdict = calculatePriceActionConfluence(data, mode, currentBenchmark?.snapshot ?? null, now, currentNews?.snapshot ?? null);
  const newsCounts = currentNews?.snapshot ? headlineBalance(currentNews.snapshot.articles) : null;
  useEffect(() => {
    if (!newsRevision || !newsSymbol || !newsExchange) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/groww/sentiment", {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: newsSymbol, exchange: newsExchange }),
        });
        if (response.status === 401) { onSessionExpired(); return; }
        const snapshot = newsSentimentSchema.parse(await responseBody(response));
        if (snapshot.symbol !== newsSymbol || snapshot.exchange !== newsExchange) throw new Error("News sentiment does not match the selected stock.");
        if (!controller.signal.aborted) setNewsResult({ key: newsKey, snapshot });
      } catch (error) {
        if (!controller.signal.aborted) setNewsResult({
          key: newsKey, error: error instanceof Error ? error.message : "Unable to load news sentiment.",
        });
      }
    })();
    return () => controller.abort();
  }, [newsRevision, newsSymbol, newsExchange, newsKey, onSessionExpired]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!listRevision) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/groww/benchmark?exchange=NSE", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onSessionExpired(); return; }
        const parsed = indexListSchema.parse(await responseBody(response));
        if (parsed.indices.some((item) => item.exchange !== "NSE")) throw new Error("Index-list exchange does not match the request.");
        if (!controller.signal.aborted) {
          setListResult({ revision: listRevision, indices: parsed.indices });
          setSelected((current) => parsed.indices.some((index) => index.tradingSymbol === current) ? current : "");
        }
      } catch (error) {
        if (!controller.signal.aborted) setListResult({
          revision: listRevision, error: error instanceof Error ? error.message : "Unable to load the index catalogue.",
        });
      }
    })();
    return () => controller.abort();
  }, [listRevision, onSessionExpired]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/groww/benchmark?${new URLSearchParams({ exchange: "NSE", symbol: selected })}`,
          { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onSessionExpired(); return; }
        const snapshot = benchmarkSnapshotSchema.parse(await responseBody(response));
        if (snapshot.symbol !== selected || snapshot.exchange !== "NSE") throw new Error("Benchmark does not match the selected index.");
        if (!controller.signal.aborted) setBenchmarkResult({ key: benchmarkKey, snapshot });
      } catch (error) {
        if (!controller.signal.aborted) setBenchmarkResult({
          key: benchmarkKey, error: error instanceof Error ? error.message : "Unable to load the benchmark quote.",
        });
      }
    })();
    return () => controller.abort();
  }, [selected, benchmarkKey, onSessionExpired]);
  const action = loading || error || newsLoading ? "WAIT" : verdict.action;
  const tone = action === "CONDITIONAL BUY" ? "text-positive" : action === "CONDITIONAL SELL" ? "text-negative" : "text-warning";
  return <section className="panel p-4" aria-labelledby="price-action-title">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 id="price-action-title" className="text-xs font-semibold">Price action &amp; confluence</h2>
        <p className={`mt-1 text-xl font-semibold ${tone}`} role="status">{action}</p>
      </div>
      <p className="text-right text-[10px] text-muted">30m ORB · 15m candles<br />Separate advisory, not order approval</p>
    </div>
    {loading ? <p role="status" className="mt-2 text-xs text-muted">Loading structural evidence...</p>
      : error ? <p role="alert" className="mt-2 text-xs text-negative">{error}</p>
        : newsLoading ? <p role="status" className="mt-2 text-xs text-muted">Waiting for the requested news sentiment before updating confluence...</p>
        : <p className="mt-2 text-xs">{verdict.reasons.at(-1)}</p>}
    {!loading && !error && <>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
        <div><dt className="text-muted">09:15-09:45 range · low / high</dt><dd className="mt-1 font-mono">{verdict.openingRange ? `${money(verdict.openingRange.low)} / ${money(verdict.openingRange.high)}` : "--"}</dd></div>
        <div><dt className="text-muted">Same-slot relative volume · needs 1.5x</dt><dd className="mt-1 font-mono">{verdict.volume.ratio === null ? "Unavailable" : `${decimal(verdict.volume.ratio)}x`}</dd></div>
        <div><dt className="text-muted">Opening-range bias</dt><dd className="mt-1">{verdict.bias}</dd></div>
        <div><dt className="text-muted">REST top-five book</dt><dd className="mt-1">{verdict.depth.available ? `${verdict.depth.pressure} · spread ${decimal(verdict.depth.spreadPercent)}%` : "Unavailable / stale"}</dd></div>
      </dl>
      {verdict.boundary && <p className="mt-2 text-[11px]">Setup boundary: {money(verdict.boundary.price)} · {verdict.boundary.source}</p>}
      {verdict.confirmedAt && <p className="mt-1 text-[10px] text-muted">Closed-candle evidence through {new Date(verdict.confirmedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Refresh after the next close.</p>}
      <p className="mt-2 text-[11px] text-muted">Benchmark: {verdict.sector.available
        ? `${verdict.sector.symbol} ${decimal(verdict.sector.changePercent)}% · ${verdict.sector.bias}` : "not selected or stale"}.</p>
      <p className="mt-1 text-[11px] text-muted">News sentiment: {verdict.sentiment.available ? verdict.sentiment.bias : "Unavailable / stale"}.</p>
      <p className="mt-1 text-[10px] text-warning">Market-wide breadth &amp; executed order flow unavailable. This is not a fully confirmed verdict.</p>
      <details className="mt-3 text-[11px] text-muted">
        <summary className="cursor-pointer">Structure, depth &amp; missing evidence · {verdict.missing.length} unavailable inputs</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <p className="mt-2">Volume: {verdict.volume.reason} {verdict.volume.samples}/5 baseline observations.</p>
        <p className="mt-2">Patterns: {verdict.patterns.join("; ") || "No qualifying candlestick micro-structure."}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([["Observed bands below price", verdict.supports], ["Observed bands above price", verdict.resistances]] as const).map(([label, levels]) =>
            <div key={label}><h3 className="font-medium text-foreground">{label}</h3>
              {levels.length ? <ul className="mt-1 space-y-1">{levels.map((level) => <li key={`${level.source}:${level.price}`}>{money(Math.max(0, level.price - verdict.zoneTolerance))} - {money(level.price + verdict.zoneTolerance)} · {level.source}</li>)}</ul>
                : <p className="mt-1">No observed band; no level is invented.</p>}
            </div>)}
        </div>
        {verdict.depth.available ? <div className="mt-3 overflow-x-auto">
          <table className="w-full text-right font-mono text-[10px]">
            <caption className="mb-1 text-left font-sans">Reported top five · bid qty {verdict.depth.bidQuantity.toLocaleString("en-IN")} / ask qty {verdict.depth.askQuantity.toLocaleString("en-IN")}</caption>
            <thead><tr><th scope="col">Bid qty</th><th scope="col">Bid</th><th scope="col">Ask</th><th scope="col">Ask qty</th></tr></thead>
            <tbody>{verdict.depth.bids.map((bid, index) => {
              const ask = verdict.depth.available ? verdict.depth.asks[index] : null;
              return <tr key={bid.price}><td>{bid.quantity}</td><td>{money(bid.price)}</td><td>{money(ask?.price)}</td><td>{ask?.quantity}</td></tr>;
            })}</tbody>
          </table>
        </div> : null}
        <ul className="mt-2 list-disc space-y-1 pl-4 text-warning">{verdict.missing.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <p className="mt-2">Bands use the opening range, previous complete session and two-sided swing pivots confirmed before the signal candle. A +/-0.1% price band (minimum Rs 0.01) defines proximity. Wicks/engulfing qualify only at these boundaries; inside bars alone do not trigger entries. Breakouts require a newly crossed level on a closed candle and a live quote still beyond it.</p>
        <p className="mt-2">Depth uses REST receipt age at most 15s, a 0.2% maximum spread, and +/-20% quantity imbalance for directional pressure. Resting orders can be cancelled or spoofed; they are not executed order flow. Sector alignment compares the selected index&apos;s day direction, not a measured correlation. These heuristic thresholds are not proven optimal.</p>
        <p className="mt-2">No institutional ownership/order blocks are inferred from candles. The eight tracked movers are not market breadth. No success percentage has been measured for this new strategy; existing historical trend-rule percentages do not apply. This verdict never changes order rules, timing gates or submitted orders.</p>
      </details>
    </>}
    <details className="mt-3 min-w-0 text-[11px] text-muted">
      <summary className="cursor-pointer">Company news sentiment · {newsLoading ? "Loading" : currentNews?.error ? "Unavailable"
        : verdict.sentiment.available ? verdict.sentiment.bias : "Not loaded / stale / insufficient"}</summary>
      <p className="mt-2">GNews English headlines from India-based sources in the last 72 hours; not full articles, social sentiment or complete coverage. AI classifies company relevance and headline tone. Fetching uses news/model quota and runs only on request.</p>
      <button type="button" className="secondary-button mt-2 px-2 py-1.5 text-xs"
        disabled={newsLoading || !data || newsSegment !== "CASH"}
        onClick={() => {
          if (data) { setNewsSelection({ symbol: data.symbol, exchange: data.exchange }); setNewsRevision((value) => value + 1); }
        }}>{newsLoading ? "Loading sentiment..." : "Fetch / refresh news sentiment"}</button>
      {newsSegment !== "CASH" && <p className="mt-2 text-warning">News integration currently supports verified CASH equities only, not contract-premium sentiment.</p>}
      {currentNews?.error && <p role="alert" className="mt-2 text-negative">{currentNews.error}</p>}
      {!verdict.sentiment.available && <p className="mt-2 text-warning">{verdict.sentiment.reason}</p>}
      {currentNews?.snapshot && newsCounts && <>
        <p className="mt-2">Headline balance: {currentNews.snapshot.bias} · {newsCounts.positive} positive / {newsCounts.negative} negative / {newsCounts.neutral} neutral · {newsCounts.relevant} company-relevant of {currentNews.snapshot.articles.length} assessed.</p>
        <p className="mt-1">Retrieved {new Date(currentNews.snapshot.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Opposing fresh sentiment blocks confluence; aligned/neutral news never creates a setup or overrides trend/order rules.</p>
        <ul className="mt-3 space-y-3">
          {currentNews.snapshot.articles.map((article) => <li key={article.id} className="min-w-0 break-words border-t border-line pt-2">
            <a className="text-foreground underline underline-offset-2" href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a>
            <p className="mt-1">{article.source} · {new Date(article.publishedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST · {article.relevant ? article.tone : "Not company-relevant"}</p>
            <p className="mt-1">{article.explanation}</p>
          </li>)}
        </ul>
        {!currentNews.snapshot.articles.length && <p className="mt-2">No usable recent headlines returned. This is not a neutral-news signal.</p>}
      </>}
      <p className="mt-2">At least two relevant headlines and one published within six hours are required for intraday use. Snapshots expire after 15 minutes. A +/-25% balance of positive minus negative headlines defines direction; this heuristic is not a confidence or success rate. Syndicated reports can be correlated and news may already be priced in. GNews Free is delayed by 12 hours, so it cannot provide this intraday confirmation; real-time access depends on your plan and licence.</p>
    </details>
    <details className="mt-3 text-[11px] text-muted">
      <summary className="cursor-pointer">Choose / refresh sector-index benchmark{currentBenchmark?.error || currentList?.error
        ? " · Unavailable" : selected && !currentBenchmark ? " · Loading" : ""}</summary>
      <p className="mt-2">Choose a verified NSE index representing this stock&apos;s sector. Sector membership is not auto-detected; a broad index is only a market proxy.</p>
      <button type="button" className="secondary-button mt-2 px-2 py-1.5 text-xs" disabled={listRevision > 0 && !currentList}
        onClick={() => setListRevision((value) => value + 1)}>{listRevision > 0 && !currentList ? "Loading indices..." : "Load / refresh NSE index list"}</button>
      {currentList?.error && <p role="alert" className="mt-2 text-negative">{currentList.error}</p>}
      {currentList?.indices && <label className="mt-2 block">Sector benchmark (NSE)
        <select className="field mt-1 w-full" aria-label="Sector benchmark (NSE)" value={selected} onChange={(event) => {
          setSelected(event.target.value); setBenchmarkRevision(0);
        }}><option value="">Not selected</option>{currentList.indices.map((index) =>
          <option key={index.tradingSymbol} value={index.tradingSymbol}>{index.tradingSymbol}{index.name ? ` · ${index.name}` : ""}</option>)}</select>
      </label>}
      {currentList?.indices?.length === 0 && <p role="status" className="mt-2 text-warning">The catalogue returned no NSE index instruments.</p>}
      {selected && <button type="button" className="secondary-button mt-2 px-2 py-1.5 text-xs" disabled={!currentBenchmark}
        onClick={() => setBenchmarkRevision((value) => value + 1)}>{currentBenchmark ? "Refresh benchmark quote" : "Loading benchmark..."}</button>}
      {currentBenchmark?.error && <p role="alert" className="mt-2 text-negative">{currentBenchmark.error}</p>}
    </details>
  </section>;
}
