"use client";

import { useEffect, useState } from "react";
import { marketAnalysisSchema, stockSymbolSchema } from "../../lib/groww/market-schemas";
import type { AnalysisMode, Interval, MarketAnalysis, MarketSegment } from "../../lib/market/types";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { FnoContractPicker } from "./fno-contract-picker";
import { IndicatorPanel } from "./indicator-panel";
import { MarketContext } from "./market-context";
import { PriceChart } from "./price-chart";
import { StockOverview } from "./stock-overview";
import { StockRecommendation } from "./stock-recommendation";
import { useLiveQuote } from "./use-live-quote";
import { applyLiveTick } from "../../lib/groww/live-schemas";

type SearchResult =
  | { key: string; data: MarketAnalysis; error?: never }
  | { key: string; error: string; data?: never };

export function LiveStockAnalysis({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [cashSymbol, setSymbol] = useState("");
  const [segment, setSegment] = useState<MarketSegment>("CASH");
  const [contract, setContract] = useState<FnoInstrument | null>(null);
  const symbol = segment === "CASH" ? cashSymbol : contract?.tradingSymbol ?? "";
  const [exchange, setExchange] = useState<"NSE" | "BSE">("NSE");
  const [interval, setInterval] = useState<Interval>("15minute");
  const [mode, setMode] = useState<AnalysisMode>("MIS");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
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

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ symbol: normalized, exchange, interval, segment });
        const response = await fetch(`/api/groww/analysis?${query}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        const body: unknown = await response.json();
        if (!response.ok) {
          const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : `Groww market-data request failed (${response.status}).`;
          throw new Error(message);
        }
        const parsed = marketAnalysisSchema.safeParse(body);
        if (!parsed.success || parsed.data.symbol !== normalized || parsed.data.exchange !== exchange || parsed.data.interval !== interval ||
          parsed.data.segment !== segment || (segment === "FNO" && parsed.data.instrument?.growwSymbol !== contract?.growwSymbol)) {
          throw new Error("The market-data response did not match your selected stock. Please retry.");
        }
        if (!controller.signal.aborted) setResult({ key, data: parsed.data });
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({ key, error: error instanceof Error ? error.message : "Unable to fetch Groww market data." });
        }
      }
    }, 500);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [valid, normalized, exchange, interval, segment, contract, key, onSessionExpired]);

  return (
    <>
      <StockOverview
        data={displayData} symbol={symbol} exchange={exchange} mode={mode} loading={loading} segment={segment}
        onSegmentChange={(value) => { setSegment(value); setContract(null); setMode((current) => current === "MIS" ? "MIS" : value === "FNO" ? "NRML" : "CNC"); setRevision((current) => current + 1); }}
        onSymbolChange={(value) => { setSymbol(value); setRevision((current) => current + 1); }}
        onExchangeChange={(value) => { setExchange(value); setContract(null); setRevision((current) => current + 1); }}
        onModeChange={setMode}
        onRefresh={() => setRevision((value) => value + 1)}
      />
      {data && <div className="rounded-xl border border-line bg-panel p-4 text-xs">
        <p role="status" className={live.fresh ? "text-positive" : "text-muted"}>{live.error ? "Price feed disconnected; latest known data is shown."
          : live.fresh ? "Groww streaming LTP is receiving fresh trade ticks."
          : live.tick ? "No fresh trade tick in the last 60 seconds; last known price is shown."
          : live.connected ? "Groww feed connected; waiting for trade ticks." : "Connecting to Groww streaming; REST snapshot is shown."}</p>
        {live.error && <><p role="alert" className="mt-2 text-negative">{live.error}</p><button type="button" className="secondary-button mt-2 text-xs" onClick={live.reconnect}>Reconnect feed</button></>}
        <p className="mt-2 text-muted">LTP and derived day change stream in real time. Day OHLC, volume, OI/IV, candles and indicators remain REST snapshots; Refresh market data updates them. Gemini runs only on button click.</p>
      </div>}
      {segment === "FNO" && <FnoContractPicker key={exchange} exchange={exchange} selected={contract} onSelect={setContract} onSessionExpired={onSessionExpired} />}
      {!normalized && <p role="status" className="text-sm text-muted">{segment === "CASH" ? "Type an exact stock symbol to fetch the latest Groww quote and historical candles." : "Select a futures or option contract to load its quote, candles and technical indicators."}</p>}
      {normalized && !valid && <p role="alert" className="text-sm text-negative">Enter an exact stock trading symbol such as RELIANCE, TCS or M&amp;M.</p>}
      {loading && <p role="status" className="text-sm text-muted">Loading {normalized} quote, candles and indicators...</p>}
      {valid && current?.error && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{current.error}</p>}
      {!!data?.omittedCandles && <p role="status" className="text-sm text-muted">Groww returned {data.omittedCandles} incomplete candle(s) with missing OHLC prices. These were omitted; the chart and indicators use only complete candles, without filling missing prices.</p>}
      {data && !data.candles.length && <p role="status" className="text-sm text-muted">Groww returned no candles for this stock and interval. The quote is available; chart and indicators are unavailable.</p>}
      <IndicatorPanel data={data} mode={mode} />
      {displayData && <StockRecommendation key={`${key}:${mode}`} data={displayData} mode={mode} onSessionExpired={onSessionExpired} />}
      <PriceChart data={data} interval={interval} onInterval={(value) => { setInterval(value); setRevision((current) => current + 1); }} />
      <MarketContext data={displayData} />
    </>
  );
}
