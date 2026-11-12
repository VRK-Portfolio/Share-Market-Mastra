"use client";

import { useCallback, useState } from "react";
import { Header } from "./header";
import { Icon } from "./icons";
import { GrowwPortfolio } from "./groww-portfolio";
import { LiveStockAnalysis } from "./live-stock-analysis";

export function Dashboard() {
  const [connected, setConnected] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const onConnectionChange = useCallback((value: boolean) => {
    setConnected(value);
    if (value) setSessionExpired(false);
  }, []);
  const onSessionExpired = useCallback(() => {
    setConnected(false);
    setSessionExpired(true);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Header connected={connected} onConnectionChange={onConnectionChange} />
      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-1">
          <div><p className="eyebrow mb-2 text-accent">THE BIGGER PICTURE</p><h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Stock analysis dashboard<span className="text-accent">.</span></h1><p className="mt-2 text-xs text-muted">Less noise. More context. Your edge starts with better data.</p></div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-2 font-mono text-[10px] text-muted"><span className={`size-1.5 rounded-full ${connected ? "bg-positive" : "bg-warning"}`} />{connected ? "GROWW PORTFOLIO · MARKET DATA" : "GROWW DISCONNECTED"}</div>
        </div>
        {sessionExpired && <p role="alert" className="rounded-xl border border-negative/25 bg-negative/5 px-5 py-3 text-sm text-negative">Your Groww session has expired. Connect again to reload your portfolio and market data.</p>}
        <GrowwPortfolio connected={connected} onSessionExpired={onSessionExpired} />
        {connected
          ? <LiveStockAnalysis onSessionExpired={onSessionExpired} />
          : <section className="panel p-6" aria-label="Stock search"><h2 className="text-lg font-semibold">Search actual stock data</h2><p className="mt-2 text-sm text-muted">Connect Groww in the header to search symbols and load real quotes, candles and technical indicators. No sample prices are displayed.</p></section>}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[10px] text-muted"><p className="flex items-center gap-1.5"><Icon name="bolt" className="size-3 text-accent" /><span className="font-medium text-foreground">TradeTerminal</span><span className="mx-1">/</span>Groww portfolio &amp; market data</p><p>Groww snapshots · technicalindicators · Not investment advice</p></footer>
      </main>
    </div>
  );
}
