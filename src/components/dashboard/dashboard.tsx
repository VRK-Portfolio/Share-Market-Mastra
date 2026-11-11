"use client";

import { useState } from "react";
import type { AnalysisMode, Interval, MarketAnalysis } from "../../lib/market/types";
import { Header } from "./header";
import { Icon } from "./icons";
import { IndicatorPanel } from "./indicator-panel";
import { MarketContext } from "./market-context";
import { PriceChart } from "./price-chart";
import { StockOverview } from "./stock-overview";

export function Dashboard({ samples }: { samples: Record<Interval, MarketAnalysis> }) {
  const [mode, setMode] = useState<AnalysisMode>("MIS");
  const [interval, setInterval] = useState<Interval>("15minute");
  const data = samples[interval];

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-1">
          <div><p className="eyebrow mb-2 text-accent">THE BIGGER PICTURE</p><h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Stock analysis dashboard<span className="text-accent">.</span></h1><p className="mt-2 text-xs text-muted">Less noise. More context. Your edge starts with better data.</p></div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-2 font-mono text-[10px] text-muted"><span className="size-1.5 rounded-full bg-warning" />STATIC PREVIEW · SAMPLE DATA</div>
        </div>
        <p className="rounded-xl border border-accent/20 bg-accent/5 px-5 py-3 text-xs leading-5 text-muted">Illustrative sample prices, indicators and candles only. This dashboard has no live market connection, login or API calls.</p>
        <StockOverview data={data} mode={mode} onModeChange={setMode} />
        <IndicatorPanel data={data} mode={mode} />
        <PriceChart data={data} interval={interval} onInterval={setInterval} />
        <MarketContext data={data} />
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[10px] text-muted"><p className="flex items-center gap-1.5"><Icon name="bolt" className="size-3 text-accent" /><span className="font-medium text-foreground">TradeTerminal</span><span className="mx-1">/</span>Static component preview</p><p>Illustrative sample data · technicalindicators · Not investment advice</p></footer>
      </main>
    </div>
  );
}
