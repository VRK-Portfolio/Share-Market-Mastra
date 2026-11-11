import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { Icon } from "./icons";

export function IndicatorPanel({ data, mode }: { data: MarketAnalysis | null; mode: AnalysisMode }) {
  const technical = data?.technical;
  const rsi = technical?.rsi;
  const cards = mode === "MIS" ? [
    { label: "VWAP", value: money(technical?.vwap), note: "Session volume-weighted price", tone: "" },
    { label: "SuperTrend (10, 3)", value: technical?.supertrend?.direction.toUpperCase() ?? "--", note: technical?.supertrend ? `Trend line ${money(technical.supertrend.value)}` : "ATR-based trend direction", tone: technical?.supertrend?.direction === "bullish" ? "text-positive" : technical?.supertrend ? "text-negative" : "" },
    { label: "RSI (14)", value: decimal(rsi), note: rsi == null ? "Momentum oscillator" : rsi > 70 ? "Overbought territory" : rsi < 30 ? "Oversold territory" : "Neutral momentum range", tone: rsi == null ? "" : "text-warning" },
    { label: "ATR (14)", value: money(technical?.atr), note: "Average true range · volatility", tone: "" },
  ] : [
    { label: "EMA (20)", value: money(technical?.ema20), note: "Short-term exponential average", tone: "" },
    { label: "EMA (50)", value: money(technical?.ema50), note: "Medium-term exponential average", tone: "" },
    { label: "RSI (14)", value: decimal(rsi), note: "Momentum oscillator", tone: rsi == null ? "" : "text-warning" },
    { label: "MACD (12, 26, 9)", value: decimal(technical?.macd?.value), note: technical?.macd ? `Signal ${decimal(technical.macd.signal)} · Hist ${decimal(technical.macd.histogram)}` : "Trend and momentum", tone: "" },
  ];

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby="indicators-title">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><Icon name="chart" className="size-5 text-accent" /><h2 id="indicators-title" className="text-sm font-semibold tracking-wide">Dynamic technical indicators</h2><span className="badge">{mode === "MIS" ? "INTRADAY (MIS)" : "DELIVERY (CNC)"}</span></div>
        <span className="font-mono text-[10px] text-muted">technicalindicators · calculated from sample OHLCV</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card, index) => <article key={card.label} className="rounded-xl border border-line bg-inset p-5"><div className="flex items-center justify-between"><h3 className="text-xs text-muted">{card.label}</h3><span className="font-mono text-[10px] text-muted/50">0{index + 1}</span></div><p className={`my-3 font-mono text-2xl font-semibold tracking-tight ${card.tone}`}>{card.value}</p><p className="text-[11px] text-muted">{card.note}</p></article>)}
      </div>
      {data && <p className="mt-4 text-[11px] text-muted">Based on {data.candles.length} candles · {data.interval === "15minute" ? "15-minute" : data.interval === "1hour" ? "Hourly" : "Daily"} interval. &quot;--&quot; means insufficient history or unavailable volume.</p>}
    </section>
  );
}
