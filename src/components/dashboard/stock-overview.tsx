import type { AnalysisMode, MarketAnalysis } from "../../lib/market/types";
import { decimal, money } from "./format";
import { Icon } from "./icons";

export function StockOverview({ data, mode, onModeChange }: {
  data: MarketAnalysis;
  mode: AnalysisMode;
  onModeChange: (mode: AnalysisMode) => void;
}) {
  const quote = data?.quote;
  return (
    <section className="panel overflow-hidden" aria-label="Stock selection and quote">
      <div className="border-b border-line px-5 py-5 sm:px-7">
        <div className="flex flex-wrap items-end gap-3">
          <label className="field-label min-w-40 flex-1 sm:max-w-72">Stock symbol
            <div className="relative mt-2"><input className="field w-full pr-20 font-mono font-semibold uppercase tracking-wide" value={data.symbol} readOnly aria-label="Sample stock symbol" /><span className="pointer-events-none absolute right-3 top-3 rounded bg-panel px-2 py-0.5 text-[10px] text-muted">SAMPLE</span></div>
          </label>
          <label className="field-label w-24">Exchange<input className="field mt-2 block w-full" value={data.exchange} readOnly /></label>
          <label className="field-label flex-1 sm:max-w-56">Analysis mode<select className="field mt-2 block w-full min-w-44" value={mode} onChange={(event) => onModeChange(event.target.value as AnalysisMode)}><option value="MIS">Intraday (MIS)</option><option value="CNC">Delivery (CNC)</option></select></label>
          <span className="badge mb-3">SAMPLE ANALYSIS</span>
          <span className="ml-auto hidden items-center gap-2 pb-3 text-[11px] text-muted xl:flex"><Icon name="shield" className="size-3.5" />Read-only · No orders placed</span>
        </div>
      </div>
      <div className="grid gap-6 px-5 py-6 sm:grid-cols-[1fr_1fr_auto] sm:px-7">
        <div><p className="eyebrow">Sample LTP <span className="normal-case tracking-normal">({data.exchange})</span></p><p className="mt-2 font-mono text-3xl font-semibold tracking-tight sm:text-4xl">{money(quote?.price)}</p></div>
        <div><p className="eyebrow">Day change</p><p className={`mt-2 flex items-center gap-2 font-mono text-xl font-medium sm:text-2xl ${quote ? quote.change >= 0 ? "text-positive" : "text-negative" : "text-muted"}`}>{quote ? `${quote.change >= 0 ? "+" : ""}${decimal(quote.change)} (${quote.changePercent >= 0 ? "+" : ""}${decimal(quote.changePercent)}%)` : "--"}{quote && <Icon name="arrow" className={`size-5 ${quote.change < 0 ? "rotate-90" : ""}`} />}</p></div>
        <div className="flex items-center gap-7 sm:border-l sm:border-line sm:pl-7">
          <div><p className="eyebrow">Day high</p><p className="mt-2 font-mono text-sm">{money(quote?.high)}</p></div>
          <div><p className="eyebrow">Day low</p><p className="mt-2 font-mono text-sm">{money(quote?.low)}</p></div>
        </div>
      </div>
    </section>
  );
}
