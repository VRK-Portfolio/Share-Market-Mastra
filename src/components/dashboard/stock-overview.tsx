import type { AnalysisMode, MarketAnalysis, MarketSegment } from "../../lib/market/types";
import { decimal, money } from "./format";
import { Icon } from "./icons";
import { CashStockPicker } from "./cash-stock-picker";
import { FnoContractPicker } from "./fno-contract-picker";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";

export function StockOverview({ data, symbol, exchange, mode, segment, contract, loading, onSymbolChange, onContractChange, onExchangeChange, onModeChange, onRefresh, onSessionExpired }: {
  data: MarketAnalysis | null;
  symbol: string;
  exchange: "NSE" | "BSE";
  mode: AnalysisMode;
  segment: MarketSegment;
  contract: FnoInstrument | null;
  onContractChange: (contract: FnoInstrument | null) => void;
  loading: boolean;
  onSymbolChange: (symbol: string) => void;
  onExchangeChange: (exchange: "NSE" | "BSE") => void;
  onModeChange: (mode: AnalysisMode) => void;
  onRefresh: () => void;
  onSessionExpired: () => void;
}) {
  const quote = data?.quote;
  return (
    <section className="panel" aria-label={segment === "FNO" ? "Contract selection and quote" : "Stock selection and quote"}>
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          {segment === "CASH" ? <CashStockPicker symbol={symbol} exchange={exchange} onSelect={onSymbolChange} onSessionExpired={onSessionExpired} />
            : <FnoContractPicker key={exchange} exchange={exchange} selected={contract} onSelect={onContractChange} onSessionExpired={onSessionExpired} />}
          <label className="field-label w-24">Exchange<select aria-label="Exchange" className="field mt-2 block w-full" value={exchange} onChange={(event) => { if (event.target.value === "NSE" || event.target.value === "BSE") onExchangeChange(event.target.value); }}><option value="NSE">NSE</option><option value="BSE">BSE</option></select></label>
          <label className="field-label flex-1 sm:max-w-56">Analysis mode<select aria-label="Analysis mode" className="field mt-2 block w-full min-w-44" value={mode} onChange={(event) => { if (event.target.value === "MIS" || (segment === "CASH" && event.target.value === "CNC") || (segment === "FNO" && event.target.value === "NRML")) onModeChange(event.target.value); }}><option value="MIS">Intraday (MIS)</option>{segment === "CASH" ? <option value="CNC">Delivery (CNC)</option> : <option value="NRML">Overnight (NRML)</option>}</select></label>
          <button type="button" className="secondary-button text-xs" onClick={onRefresh} disabled={loading || !symbol.trim()}><Icon name="refresh" className="size-4" />Refresh market data</button>
        </div>
        {data?.instrument && <p className="mt-2 text-xs text-muted">{data.instrument.underlying} · {data.instrument.instrumentType} · Expiry {data.instrument.expiry} · Strike {money(data.instrument.strikePrice)} · Lot size {data.instrument.lotSize} · Tick {money(data.instrument.tickSize)} · Prices are {data.instrument.instrumentType === "FUT" ? "futures prices" : "option premiums"} per unit, not underlying prices.</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="break-words text-xs font-semibold">{data?.symbol || symbol || (segment === "FNO" ? "Choose a contract" : "Choose a stock")} <span className="font-normal text-muted">· {exchange} · {segment}</span></h2>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="font-mono text-3xl font-semibold tracking-tight" aria-label="Latest LTP">{money(quote?.price)}</p>
            <p aria-label="Day change" className={`font-mono text-sm ${quote?.change != null ? quote.change >= 0 ? "text-positive" : "text-negative" : "text-muted"}`}>{quote?.change != null ? `${quote.change >= 0 ? "+" : ""}${decimal(quote.change)} (${quote.changePercent == null ? "--" : `${quote.changePercent >= 0 ? "+" : ""}${decimal(quote.changePercent)}` }%)` : "--"}</p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-[11px]">
          <div><dt className="text-muted">Day high / low · snapshot</dt><dd className="mt-1 font-mono">{money(quote?.high)} / {money(quote?.low)}</dd></div>
          <div><dt className="text-muted">Last trade · IST</dt><dd className="mt-1 font-mono">{quote?.lastTradeTime == null ? "--" : new Date(quote.lastTradeTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</dd></div>
        </dl>
      </div>
    </section>
  );
}
