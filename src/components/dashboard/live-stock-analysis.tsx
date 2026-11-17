"use client";

import { useEffect, useMemo, useState } from "react";
import { marketAnalysisSchema, stockSymbolSchema } from "../../lib/groww/market-schemas";
import type { AnalysisMode, Interval, MarketAnalysis, MarketSegment } from "../../lib/market/types";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { IndicatorPanel } from "./indicator-panel";
import { MarketContext } from "./market-context";
import { PriceChart } from "./price-chart";
import { StockOverview } from "./stock-overview";
import { StockRecommendation } from "./stock-recommendation";
import { useLiveQuote } from "./use-live-quote";
import { applyLiveTick } from "../../lib/groww/live-schemas";
import { TechnicalVerdict } from "./technical-verdict";
import { buildFifteenMinuteHistory } from "../../lib/market/fifteen-minute-outlook";
import { PriceActionConfluence } from "./price-action-confluence";

type SearchResult =
  | { key: string; data: MarketAnalysis; error?: never }
  | { key: string; error: string; retryAfterSeconds?: number; data?: never };

export function LiveStockAnalysis({ onSessionExpired }: {
  onSessionExpired: () => void;
}) {
  const [cashSymbol, setSymbol] = useState("");
  const [segment, setSegment] = useState<MarketSegment>("CASH");
  const [contract, setContract] = useState<FnoInstrument | null>(null);
  const symbol = segment === "CASH" ? cashSymbol : contract?.tradingSymbol ?? "";
  const [exchange, setExchange] = useState<"NSE" | "BSE">("NSE");
  const [interval, setInterval] = useState<Interval>("15minute");
  const [mode, setMode] = useState<AnalysisMode>("MIS");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [forecastResult, setForecastResult] = useState<SearchResult | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshStatus, setRefreshStatus] = useState<{ key: string; refreshing: boolean; error?: string } | null>(null);
  const normalized = symbol.trim().toUpperCase();
  const valid = stockSymbolSchema.safeParse(normalized).success;
  const key = JSON.stringify([normalized, exchange, interval, segment, contract?.growwSymbol, revision]);
  const current = result?.key === key ? result : null;
  const data = valid ? current?.data ?? null : null;
  const loading = valid && !current;
  const streamData = valid && result?.data?.symbol === normalized && result.data.exchange === exchange &&
    result.data.segment === segment ? result.data : null;
  const live = useLiveQuote(streamData, onSessionExpired);
  const displayData = data && live.tick ? applyLiveTick(data, live.tick) : data;
  const forecastCurrent = interval === "15minute" ? current : forecastResult?.key === key ? forecastResult : null;
  const forecastSnapshot = valid ? forecastCurrent?.data ?? null : null;
  const forecastHistory = useMemo(() => forecastSnapshot ? buildFifteenMinuteHistory(forecastSnapshot) : null, [forecastSnapshot]);
  const forecastData = forecastSnapshot && live.tick ? applyLiveTick(forecastSnapshot, live.tick) : forecastSnapshot;
  const refreshCurrent = refreshStatus?.key === key ? refreshStatus : null;
  const missingVolumes = data?.candles.filter((candle) => candle.volume === null).length ?? 0;
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const automatic = segment === "FNO" && autoRefresh;
    async function load(targetInterval: Interval): Promise<SearchResult | null> {
      let retryAfterSeconds: number | undefined;
      try {
        const query = new URLSearchParams({ symbol: normalized, exchange, interval: targetInterval, segment });
        const response = await fetch(`/api/groww/analysis?${query}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return null;
        if (response.status === 401) {
          controller.abort();
          onSessionExpired();
          return null;
        }
        const body: unknown = await response.json();
        if (!response.ok) {
          if (response.status === 429) {
            const retryAfter = response.headers.get("retry-after");
            retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter)
              ? Math.max(30, Math.min(86400, Number(retryAfter))) : 60;
          }
          const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : `Groww market-data request failed (${response.status}).`;
          throw new Error(message);
        }
        const parsed = marketAnalysisSchema.safeParse(body);
        if (!parsed.success || parsed.data.symbol !== normalized || parsed.data.exchange !== exchange || parsed.data.interval !== targetInterval ||
          parsed.data.segment !== segment || (segment === "FNO" && parsed.data.instrument?.growwSymbol !== contract?.growwSymbol)) {
          throw new Error("The market-data response did not match your selected stock. Please retry.");
        }
        return controller.signal.aborted ? null : { key, data: parsed.data };
      } catch (error) {
        return controller.signal.aborted ? null : {
          key, error: error instanceof Error ? error.message : "Unable to fetch Groww market data.", retryAfterSeconds,
        };
      }
    }
    async function refresh(background = false) {
      if (controller.signal.aborted) return;
      if (background && automatic && document.hidden) {
        timeout = setTimeout(() => { void refresh(true); }, 30_000);
        return;
      }
      setRefreshStatus({ key, refreshing: true });
      const [main, forecast] = await Promise.all([
        load(interval),
        interval !== "15minute" ? load("15minute") : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      if (main) setResult((previous) => main.error && previous?.key === key && previous.data ? previous : main);
      if (forecast) setForecastResult(forecast);
      setRefreshStatus({ key, refreshing: false, error: main?.error });
      if (automatic) {
        const seconds = Math.max(30,
          main && "retryAfterSeconds" in main ? main.retryAfterSeconds ?? 0 : 0,
          forecast && "retryAfterSeconds" in forecast ? forecast.retryAfterSeconds ?? 0 : 0);
        timeout = setTimeout(() => { void refresh(true); }, seconds * 1000);
      }
    }
    timeout = setTimeout(() => { void refresh(); }, 500);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [valid, normalized, exchange, interval, segment, contract, key, autoRefresh, onSessionExpired]);

  return (
    <div className="market-workspace min-w-0 space-y-3">
      <div aria-label="Selected stock analysis">
      <StockOverview
        data={displayData} symbol={symbol} exchange={exchange} mode={mode} loading={loading} segment={segment}
        contract={contract} onContractChange={setContract}
        onSegmentChange={(value) => { setSegment(value); setContract(null); setMode((current) => current === "MIS" ? "MIS" : value === "FNO" ? "NRML" : "CNC"); setRevision((current) => current + 1); }}
        onSymbolChange={(value) => { setSymbol(value); setRevision((current) => current + 1); }}
        onExchangeChange={(value) => { setExchange(value); setContract(null); setRevision((current) => current + 1); }}
        onModeChange={setMode}
        onRefresh={() => setRevision((value) => value + 1)}
        onSessionExpired={onSessionExpired}
      />
      </div>
      {(data || segment === "FNO" && valid) && <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[11px]" aria-label="Market data status">
        {data && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p role="status" className={live.fresh ? "text-positive" : "text-warning"}>{live.error ? "Feed disconnected · last-known price"
            : live.fresh ? "Live price"
            : live.tick ? "Price stale · no fresh tick in 60s"
            : live.connected ? "Feed connected · waiting for a trade" : "Connecting feed · snapshot price"}</p>
          <span className="text-muted">Indicators: {data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "--"} IST snapshot</span>
          {live.error && <button type="button" className="text-accent underline underline-offset-2" onClick={live.reconnect}>Reconnect feed</button>}
        </div>}
        {segment === "FNO" && valid && <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          Auto-refresh F&amp;O · 30s
        </label>
        <span role="status" className="text-muted">{refreshCurrent?.refreshing ? "Refreshing..." : autoRefresh ? "On" : "Off"}</span>
        </div>}
        {live.error && <p role="alert" className="w-full break-words text-negative">{live.error}</p>}
        {refreshCurrent?.error && <p role="alert" className="w-full break-words text-negative">Snapshot refresh failed: {refreshCurrent.error} Last successful snapshot shown.</p>}
      </div>}
      {!normalized && <div role="status" className="rounded-xl border border-dashed border-line px-5 py-7">
        <p className="text-sm font-semibold">Start with one {segment === "CASH" ? "stock" : "contract"}</p>
        <p className="mt-1 text-xs text-muted">Search at least two characters above and choose a result. Price, chart and setup checks will appear here.</p>
      </div>}
      {normalized && !valid && <p role="alert" className="text-sm text-negative">Enter an exact stock trading symbol such as RELIANCE, TCS or M&amp;M.</p>}
      {loading && <p role="status" className="text-sm text-muted">Loading {normalized} quote, candles and indicators...</p>}
      {valid && current?.error && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{current.error}</p>}
      {(!!data?.omittedCandles || !!missingVolumes) && <details className="rounded-lg border border-warning/25 bg-warning/5 p-3 text-xs text-warning">
        <summary className="cursor-pointer">Data quality: {data?.omittedCandles ?? 0} incomplete candles excluded · {missingVolumes} candles without volume</summary>
        <p className="mt-2">Only complete OHLC prices are used; missing prices are not filled. Missing volume is not zero. Price-based indicators remain available, but session VWAP cannot confirm after missing volume until the next IST session.</p>
      </details>}
      {data && !data.candles.length && <p role="status" className="text-xs text-warning">No candle history. The quote is available, but indicators cannot confirm a setup.</p>}
      {valid && <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(22rem,1fr)]">
      <div className="min-w-0 space-y-3 lg:col-start-2 lg:row-start-1">
      <PriceActionConfluence key={JSON.stringify([normalized, exchange, segment])} data={forecastData} mode={mode}
        loading={valid && !forecastCurrent} error={forecastCurrent?.error} onSessionExpired={onSessionExpired} />
      {displayData ? <TechnicalVerdict key={`technical:${key}:${mode}`} data={displayData} mode={mode}
        forecastData={forecastData} forecastHistory={forecastHistory} forecastLoading={valid && !forecastCurrent} forecastError={forecastCurrent?.error}
        onSessionExpired={onSessionExpired} /> : loading && <div role="status" className="panel p-5 text-sm text-muted">Checking the setup for {normalized}...</div>}
      </div>
      <div className="min-w-0 space-y-3 lg:col-start-1 lg:row-start-1">
      <PriceChart data={data} interval={interval} onInterval={(value) => { setInterval(value); setRevision((current) => current + 1); }} />
      {data && <IndicatorPanel data={data} mode={mode} referencePrice={displayData?.quote.price} />}
      </div>
      </div>}
      <div className="grid items-start gap-3 md:grid-cols-2">
      {data && <details className="workspace-details">
        <summary>Session data &amp; market context</summary>
        <div className="mt-3"><MarketContext data={displayData} /></div>
        <p className="mt-3 text-xs text-muted">LTP and day change can stream. OHLC, volume, OI/IV, candles and indicators are snapshots; use Refresh market data to update. Automatic F&amp;O refresh pauses in hidden tabs and respects rate-limit cooldowns.</p>
      </details>}
      {displayData && <details className="workspace-details">
        <summary>Optional AI second opinion <span className="ml-2 font-normal text-muted">Runs only when requested</span></summary>
        <div className="mt-3"><StockRecommendation key={`${key}:${mode}`} data={displayData} mode={mode} onSessionExpired={onSessionExpired} /></div>
      </details>}
      </div>
    </div>
  );
}
