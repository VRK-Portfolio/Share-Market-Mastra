import type { AnalysisMode, MarketAnalysis, MarketSegment } from "../../lib/market/types";
import { decimal, money } from "./format";
import { Icon } from "./icons";
import { CashStockPicker } from "./cash-stock-picker";
import { FnoContractPicker } from "./fno-contract-picker";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";

export function StockOverview({ data, symbol, exchange, mode, segment, contract, loading, onSegmentChange, onSymbolChange, onContractChange, onExchangeChange, onModeChange, onRefresh, onSessionExpired }: {
  data: MarketAnalysis | null;
  symbol: string;
  exchange: "NSE" | "BSE";
  mode: AnalysisMode;
  segment: MarketSegment;
  contract: FnoInstrument | null;
  onContractChange: (contract: FnoInstrument | null) => void;
  onSegmentChange: (segment: MarketSegment) => void;
  loading: boolean;
  onSymbolChange: (symbol: string) => void;
  onExchangeChange: (exchange: "NSE" | "BSE") => void;
  onModeChange: (mode: AnalysisMode) => void;
  onRefresh: () => void;
  onSessionExpired: () => void;
}) {
  const quote = data?.quote;
  return (
    <section className="panel" aria-label="Stock selection and quote">
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="field-label w-32">Market segment<select aria-label="Market segment" className="field mt-2 w-full" value={segment} onChange={(event) => { if (event.target.value === "CASH" || event.target.value === "FNO") onSegmentChange(event.target.value); }}><option value="CASH">Cash stocks</option><option value="FNO">Futures / options</option></select></label>
          {segment === "CASH" ? <CashStockPicker symbol={symbol} exchange={exchange} onSelect={onSymbolChange} onSessionExpired={onSessionExpired} />
            : <FnoContractPicker key={exchange} exchange={exchange} selected={contract} onSelect={onContractChange} onSessionExpired={onSessionExpired} />}
          <label className="field-label w-24">Exchange<select aria-label="Exchange" className="field mt-2 block w-full" value={exchange} onChange={(event) => { if (event.target.value === "NSE" || event.target.value === "BSE") onExchangeChange(event.target.value); }}><option value="NSE">NSE</option><option value="BSE">BSE</option></select></label>
          <label className="field-label flex-1 sm:max-w-56">Analysis mode<select aria-label="Analysis mode" className="field mt-2 block w-full min-w-44" value={mode} onChange={(event) => { if (event.target.value === "MIS" || (segment === "CASH" && event.target.value === "CNC") || (segment === "FNO" && event.target.value === "NRML")) onModeChange(event.target.value); }}><option value="MIS">Intraday (MIS)</option>{segment === "CASH" ? <option value="CNC">Delivery (CNC)</option> : <option value="NRML">Overnight (NRML)</option>}</select></label>
          <button type="button" className="secondary-button text-xs" onClick={onRefresh} disabled={loading || !symbol.trim()}><Icon name="refresh" className="size-4" />Refresh market data</button>
        </div>
        {data?.instrument && <p className="mt-2 text-xs text-muted">{data.instrument.underlying} · {data.instrument.instrumentType} · Expiry {data.instrument.expiry} · Strike {money(data.instrument.strikePrice)} · Lot size {data.instrument.lotSize} · Tick {money(data.instrument.tickSize)} · Prices are {data.instrument.instrumentType === "FUT" ? "futures prices" : "option premiums"} per unit, not underlying prices.</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-[1fr_1fr_auto]">
        <div><p className="eyebrow">Latest LTP <span className="normal-case tracking-normal">({exchange})</span></p><p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{money(quote?.price)}</p></div>
        <div><p className="eyebrow">Day change</p><p className={`mt-2 flex items-center gap-2 font-mono text-xl font-medium sm:text-2xl ${quote?.change != null ? quote.change >= 0 ? "text-positive" : "text-negative" : "text-muted"}`}>{quote?.change != null ? `${quote.change >= 0 ? "+" : ""}${decimal(quote.change)} (${quote.changePercent == null ? "--" : `${quote.changePercent >= 0 ? "+" : ""}${decimal(quote.changePercent)}` }%)` : "--"}{quote?.change != null && <Icon name="arrow" className={`size-5 ${quote.change < 0 ? "rotate-90" : ""}`} />}</p></div>
        <div className="col-span-2 flex items-center gap-5 sm:col-span-1 sm:border-l sm:border-line sm:pl-5">
          <div><p className="eyebrow">Day high (snapshot)</p><p className="mt-2 font-mono text-sm">{money(quote?.high)}</p></div>
          <div><p className="eyebrow">Day low (snapshot)</p><p className="mt-2 font-mono text-sm">{money(quote?.low)}</p></div>
        </div>
      </div>
    </section>
  );
}
