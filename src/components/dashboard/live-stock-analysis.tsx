"use client";

import { useEffect, useRef, useState } from "react";
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
import { MarketMovers } from "./market-movers";
import { scenarioInstrument } from "../../lib/market/scenario-alerts";
import type { ScenarioAlertController } from "./use-scenario-alerts";

type SearchResult =
  | { key: string; data: MarketAnalysis; error?: never }
  | { key: string; error: string; retryAfterSeconds?: number; data?: never };

export function LiveStockAnalysis({ onSessionExpired, scenarioAlerts }: {
  onSessionExpired: () => void; scenarioAlerts: ScenarioAlertController;
}) {
  const analysisRef = useRef<HTMLDivElement>(null);
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
  const forecastData = forecastSnapshot && live.tick ? applyLiveTick(forecastSnapshot, live.tick) : forecastSnapshot;
  const refreshCurrent = refreshStatus?.key === key ? refreshStatus : null;
  const missingVolumes = data?.candles.filter((candle) => candle.volume === null).length ?? 0;
  const observeScenarioPrice = scenarioAlerts.observe;

  useEffect(() => {
    if (live.fresh && live.tick && streamData) observeScenarioPrice({
      ...scenarioInstrument(streamData), price: live.tick.price, tradeTime: live.tick.tradeTime,
    });
  }, [live.fresh, live.tick, streamData, observeScenarioPrice]);

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
    <div className="market-workspace grid items-start gap-4 xl:grid-cols-[20rem_minmax(0,1fr)] 2xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="min-w-0" aria-label="Today's gainers and losers">
      <MarketMovers onSessionExpired={onSessionExpired} onSelect={(stock) => {
        setSegment("CASH");
        setContract(null);
        setSymbol(stock.symbol);
        setExchange(stock.exchange);
        setInterval("15minute");
        setMode("MIS");
        setRevision((value) => value + 1);
        analysisRef.current?.focus({ preventScroll: true });
        analysisRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }} />
      </aside>
      <div className="min-w-0 space-y-3">
      <div ref={analysisRef} tabIndex={-1} className="scroll-mt-5" aria-label="Selected stock analysis">
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
      {segment === "FNO" && valid && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel p-3 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          Auto-refresh F&amp;O data (30s)
        </label>
        <p role="status" className="text-muted">{refreshCurrent?.refreshing ? "Refreshing contract quote, candles and indicators..."
          : autoRefresh ? "Automatic snapshot refresh is enabled; it pauses in hidden tabs and respects rate-limit cooldowns."
          : "Automatic refresh is off. Use Refresh market data to update contract indicators."}</p>
        {data?.fetchedAt && <details className="text-muted"><summary className="cursor-pointer">Snapshot {new Date(data.fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</summary><p className="mt-2">Last successful snapshot: {new Date(data.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Values change only when Groww supplies different trades or candles.</p></details>}
        {data && refreshCurrent?.error && <p role="alert" className="w-full text-negative">Snapshot refresh failed: {refreshCurrent.error} The last successful snapshot remains displayed.</p>}
      </div>}
      {data && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-panel p-3 text-xs">
        <p role="status" className={live.fresh ? "text-positive" : "text-muted"}>{live.error ? "Price feed disconnected; latest known data is shown."
          : live.fresh ? "Groww streaming LTP is receiving fresh trade ticks."
          : live.tick ? "No fresh trade tick in the last 60 seconds; last known price is shown."
          : live.connected ? "Groww feed connected; waiting for trade ticks." : "Connecting to Groww streaming; REST snapshot is shown."}</p>
        {live.error && <><p role="alert" className="text-negative">{live.error}</p><button type="button" className="secondary-button px-3 py-1.5 text-xs" onClick={live.reconnect}>Reconnect feed</button></>}
        <details className="text-muted"><summary className="cursor-pointer">Feed and snapshot details</summary><p className="mt-2">LTP and derived day change stream in real time. Day OHLC, volume, OI/IV, candles and indicators are REST snapshots; {segment === "FNO" && autoRefresh ? "automatic F&O refresh and " : ""}Refresh market data updates them. Gemini runs only on button click.</p></details>
      </div>}
      {!normalized && <p role="status" className="text-sm text-muted">{segment === "CASH" ? "Type at least two stock-name or symbol characters and select a dropdown result to load Groww quotes and historical candles." : "Type at least two underlying or contract characters in Selected contract, then choose a dropdown result to load its quote, candles and technical indicators."}</p>}
      {normalized && !valid && <p role="alert" className="text-sm text-negative">Enter an exact stock trading symbol such as RELIANCE, TCS or M&amp;M.</p>}
      {loading && <p role="status" className="text-sm text-muted">Loading {normalized} quote, candles and indicators...</p>}
      {valid && current?.error && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{current.error}</p>}
      {!!data?.omittedCandles && <p role="status" className="text-sm text-muted">Groww returned {data.omittedCandles} incomplete candle(s) with missing OHLC prices. These were omitted; the chart and indicators use only complete candles, without filling missing prices.</p>}
      {!!missingVolumes && <p role="status" className="text-sm text-muted">Groww returned {missingVolumes} candle(s) with unavailable volume. Their OHLC prices are preserved for the chart, RSI, ATR, EMAs, MACD and SuperTrend. Volume bars are omitted, and VWAP is unavailable from the first missing-volume candle until the next IST session. Missing volume is not treated as zero.</p>}
      {data && !data.candles.length && <p role="status" className="text-sm text-muted">Groww returned no candles for this stock and interval. The quote is available; chart and indicators are unavailable.</p>}
      <div className="grid items-start gap-3 2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
      <PriceChart data={data} interval={interval} onInterval={(value) => { setInterval(value); setRevision((current) => current + 1); }} />
      <IndicatorPanel data={data} mode={mode} />
      <details className="workspace-details">
        <summary>Market snapshot &amp; technical context</summary>
        <div className="mt-3"><MarketContext data={displayData} /></div>
      </details>
      </div>
      <div className="min-w-0 space-y-3">
      {displayData && <TechnicalVerdict key={`technical:${key}:${mode}`} data={displayData} mode={mode}
        forecastData={forecastData} forecastLoading={valid && !forecastCurrent} forecastError={forecastCurrent?.error}
        onSaveScenarios={scenarioAlerts.save} canSaveScenarios={scenarioAlerts.ready}
        onSessionExpired={onSessionExpired} />}
      {displayData && <details className="workspace-details">
        <summary>Optional Gemini analysis - runs only on explicit button click</summary>
        <div className="mt-3"><StockRecommendation key={`${key}:${mode}`} data={displayData} mode={mode} onSessionExpired={onSessionExpired} /></div>
      </details>}
      </div>
      </div>
      </div>
    </div>
  );
}
