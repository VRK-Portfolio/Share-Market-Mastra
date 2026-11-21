"use client";

import { useCallback, useState } from "react";
import { Header } from "./header";
import { Icon } from "./icons";
import { GrowwPortfolio } from "./groww-portfolio";
import { LiveStockAnalysis } from "./live-stock-analysis";
import { PaperTrading } from "./paper-trading";
import type { MarketSegment } from "../../lib/market/types";
import type { AnalysisLink } from "../../lib/market/analysis-link";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import type { PaperSelection } from "./paper-order-form";

export function Dashboard({ terminalExpiresAt, segment = "CASH", initialSelection, initialSelectionError }: {
  terminalExpiresAt: string; segment?: MarketSegment; initialSelection?: AnalysisLink; initialSelectionError?: string;
}) {
  const [connected, setConnected] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [paperSelection, setPaperSelection] = useState<PaperSelection | null>(null);
  const onFnoSelectionChange = useCallback((instrument: FnoInstrument | null, product: "MIS" | "NRML") => {
    setPaperSelection(instrument ? { symbol: instrument.tradingSymbol, exchange: instrument.exchange,
      product, segment: "FNO", instrument } : null);
  }, []);
  const onConnectionChange = useCallback((value: boolean) => {
    setConnected(value);
    if (!value) setPaperSelection(null);
    if (value) setSessionExpired(false);
  }, []);
  const onSessionExpired = useCallback(() => {
    setConnected(false);
    setSessionExpired(true);
    setPaperSelection(null);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <a href="#market-workspace" className="sr-only z-50 rounded-lg bg-panel px-4 py-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to workspace</a>
      <Header connected={connected} onConnectionChange={onConnectionChange} terminalExpiresAt={terminalExpiresAt} />
      <main id="market-workspace" tabIndex={-1} className="mx-auto max-w-[1600px] space-y-3 px-4 pt-4 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-1">
          <h1 className="text-base font-semibold tracking-tight">{segment === "FNO" ? "Futures & options" : "Trading workspace"}</h1>
          <p className="text-[11px] text-muted">Conditional setups · No automatic real orders</p>
        </div>
        {sessionExpired && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 px-5 py-3 text-sm text-negative">Your Groww session has expired. Connect again to reload your portfolio and market data.</p>}
        {initialSelectionError && <p role="alert" className="text-sm text-negative">{initialSelectionError}</p>}
        {connected
          ? <LiveStockAnalysis key={`${segment}:${initialSelection?.symbol ?? ""}:${initialSelection?.exchange ?? ""}:${initialSelection?.mode ?? ""}`}
            segment={segment} initialSelection={initialSelection} onSessionExpired={onSessionExpired}
            onFnoSelectionChange={onFnoSelectionChange} />
          : <section className="panel p-6" aria-label={segment === "FNO" ? "Contract search" : "Stock search"}><h2 className="text-lg font-semibold">{segment === "FNO" ? "Search futures and options contracts" : "Search actual stock data"}</h2><p className="mt-2 text-sm text-muted">Connect Groww in the header to search {segment === "FNO" ? "contracts" : "symbols"} and load real quotes, candles and technical indicators. No sample prices are displayed.</p></section>}
        {segment === "FNO" && <p className="text-xs text-muted">Review a real F&amp;O order from the setup, or open Paper trading to practice futures and bought options with your shared virtual balance.</p>}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[10px] text-muted"><p className="flex items-center gap-1.5"><Icon name="bolt" className="size-3 text-accent" /><span className="font-medium text-foreground">TradeTerminal</span><span className="mx-1">/</span>Groww portfolio &amp; market data</p><p>Groww snapshots · technicalindicators · Not investment advice</p></footer>
      </main>
      <GrowwPortfolio connected={connected} onSessionExpired={onSessionExpired} />
      <PaperTrading key={`${segment}:${connected ? "paper-connected" : "paper-disconnected"}`}
        connected={connected} segment={segment} onSessionExpired={onSessionExpired}
        workspaceSelection={segment === "FNO" ? paperSelection : null} />
    </div>
  );
}
