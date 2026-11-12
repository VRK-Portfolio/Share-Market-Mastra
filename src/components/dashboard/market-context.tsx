import type { MarketAnalysis } from "../../lib/market/types";
import { decimal, money, timeLabel } from "./format";
import { Icon } from "./icons";

export function MarketContext({ data }: { data: MarketAnalysis | null }) {
  const technical = data?.technical;
  const trend = technical?.supertrend?.direction;
  const rows = [
    ["Open", money(data?.quote.open)],
    ["Previous close", money(data?.quote.previousClose)],
    ["Traded volume", data?.quote.volume?.toLocaleString("en-IN") ?? "--"],
    ["Last trade (IST)", data?.quote.lastTradeTime ? `${timeLabel(data.quote.lastTradeTime / 1000, true)} ${timeLabel(data.quote.lastTradeTime / 1000)}` : "--"],
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <section className="panel p-5 sm:p-6"><h2 className="mb-5 flex items-center gap-2 text-sm font-semibold"><Icon name="chart" className="size-4 text-accent" />Market snapshot</h2><dl className="space-y-3">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-3 text-xs"><dt className="text-muted">{label}</dt><dd className="font-mono">{value}</dd></div>)}</dl></section>
      <section className="panel p-5 sm:p-6"><h2 className="mb-5 text-sm font-semibold">Technical context</h2><dl className="space-y-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-muted">SuperTrend direction</dt><dd className={`font-mono uppercase ${trend === "bullish" ? "text-positive" : trend ? "text-negative" : ""}`}>{trend ?? "--"}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">EMA 20 / EMA 50</dt><dd className="font-mono">{technical?.ema20 != null && technical?.ema50 != null ? technical.ema20 > technical.ema50 ? "Above" : technical.ema20 < technical.ema50 ? "Below" : "Equal" : "--"}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">MACD histogram</dt><dd className="font-mono">{decimal(technical?.macd?.histogram)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">ATR (14)</dt><dd className="font-mono">{money(technical?.atr)}</dd></div></dl></section>
      <section className="panel relative overflow-hidden p-5 sm:p-6"><div className="absolute -right-7 -top-7 size-32 rounded-full bg-accent/5 blur-2xl" /><h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><Icon name="shield" className="size-4 text-accent" />Read-only market data. Not investment advice.</h2><p className="text-xs leading-6 text-muted">LTP updates come from Groww&apos;s streaming feed when connected. Other quote fields, historical candles and indicators remain snapshots; refresh to update them. An idle or disconnected feed is explicitly labeled, and market-closed prices may reflect the last trading session. No sample prices or trades are generated.</p><p className="mt-4 border-t border-line pt-3 font-mono text-[10px] text-muted">{data?.fetchedAt ? `Snapshot fetched ${timeLabel(Date.parse(data.fetchedAt) / 1000, true)} ${timeLabel(Date.parse(data.fetchedAt) / 1000)} IST` : "No market data loaded."}</p></section>
    </div>
  );
}
