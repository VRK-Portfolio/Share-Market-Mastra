"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { infer as Infer, ZodType } from "zod";
import { holdingsResponseSchema, positionsResponseSchema } from "../../lib/groww/portfolio-schemas";
import { portfolioInstrumentKey } from "../../lib/groww/portfolio-instrument-schemas";
import type { PortfolioInstrumentSelection } from "../../lib/groww/portfolio-instrument-schemas";
import { livePriceKey, portfolioLiveMark, portfolioLiveTotals } from "../../lib/market/live-prices";
import { usePortfolioPrices } from "./use-portfolio-prices";
import { money } from "./format";
import { Icon } from "./icons";

type ResourceState<T> =
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; message: string };

function usePortfolioData<T>(url: string, schema: ZodType<T>, onSessionExpired: () => void) {
  const [result, setResult] = useState<{ url: string; state: ResourceState<T> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        const data: unknown = await response.json();
        if (!response.ok) {
          const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : `Groww portfolio request failed (${response.status}).`;
          throw new Error(message);
        }
        const result = schema.safeParse(data);
        if (!result.success) throw new Error("Groww returned an invalid portfolio response. Please refresh to try again.");
        if (!controller.signal.aborted) setResult({ url, state: { status: "success", data: result.data } });
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({ url, state: { status: "error", message: error instanceof Error ? error.message : "Unable to load Groww portfolio." } });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [url, schema, onSessionExpired]);

  return result?.url === url ? result.state : { status: "loading" } as const;
}

type PortfolioPricing = ReturnType<typeof usePortfolioPrices>;

function LiveValuation({ selection, quantity, entryPrice, pricing, now }: {
  selection: PortfolioInstrumentSelection; quantity: number; entryPrice: number; pricing: PortfolioPricing; now: number;
}) {
  if (quantity === 0) return <p className="mt-3 text-xs text-muted">Closed position · No open P&amp;L</p>;
  const key = portfolioInstrumentKey(selection);
  const instrument = pricing.instruments[key];
  const tick = instrument ? pricing.prices[livePriceKey(instrument)] : undefined;
  const mark = instrument ? portfolioLiveMark(instrument, quantity, entryPrice, tick, now) : null;
  const error = pricing.errors[key] || pricing.error;
  return <div className="mt-3 border-t border-line pt-3">
    <dl className="grid grid-cols-2 gap-3 text-xs">
      <div className="min-w-0"><dt className="text-muted">Live price / share</dt><dd className="mt-1 break-words font-mono font-medium">{mark ? money(mark.price) : "--"}</dd></div>
      <div className="min-w-0"><dt className="text-muted">Unrealized P&amp;L</dt><dd className={`mt-1 break-words font-mono font-medium ${!mark ? "text-muted" : mark.pnl > 0 ? "text-positive" : mark.pnl < 0 ? "text-negative" : "text-muted"}`}>
        {mark ? `${mark.pnl > 0 ? "Profit" : mark.pnl < 0 ? "Loss" : "Break-even"}: ${money(mark.pnl)}` : "Unavailable"}
        {mark?.percent !== null && mark?.percent !== undefined && <span className="mt-1 block text-[10px]">({mark.percent.toFixed(2)}%)</span>}
      </dd></div>
      <div className="min-w-0"><dt className="text-muted">Entry value</dt><dd className="mt-1 break-words font-mono">{mark ? money(mark.entryValue) : "--"}</dd></div>
      <div className="min-w-0"><dt className="text-muted">Current market value</dt><dd className="mt-1 break-words font-mono">{mark ? money(mark.value) : "--"}</dd></div>
    </dl>
    {mark && instrument && tick
      ? <p className="mt-2 text-[10px] text-muted">{instrument.exchange} · {instrument.segment} · {instrument.symbol} · Tick {new Date(tick.tradeTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
      : <p className={`mt-2 break-words text-[11px] ${error || tick ? "text-warning" : "text-muted"}`}>{error || (tick
        ? "The price is stale or the entry basis cannot be valued. Waiting for a fresh valid price."
        : pricing.loading ? "Resolving the exchange and segment..." : "Waiting for a fresh live price.")}</p>}
  </div>;
}

function Holdings({ state, pricing, now }: {
  state: ResourceState<Infer<typeof holdingsResponseSchema>>; pricing: PortfolioPricing; now: number;
}) {
  return (
    <section aria-labelledby="holdings-title" className="min-w-0">
      <h3 id="holdings-title" className="mb-3 text-sm font-semibold">Holdings{state.status === "success" && <span className="ml-2 text-muted">({state.data.payload.holdings.length})</span>}</h3>
      {state.status === "loading" && <p role="status" className="py-6 text-sm text-muted">Loading holdings...</p>}
      {state.status === "error" && <p role="alert" className="rounded-lg border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{state.message}</p>}
      {state.status === "success" && (state.data.payload.holdings.length === 0
        ? <p className="rounded-lg bg-inset p-5 text-sm text-muted">No stocks in your Groww holdings.</p>
        : <ul className="grid gap-3 sm:grid-cols-2" aria-label="Groww holdings">
          {state.data.payload.holdings.map((holding) => <li key={`${holding.isin}:${holding.trading_symbol}`} className="min-w-0 rounded-xl border border-line p-3">
            <h4 className="break-words text-sm font-semibold">{holding.trading_symbol}</h4>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div className="min-w-0"><dt className="text-muted">Purchase price / share</dt><dd className="mt-1 break-words font-mono font-medium">{money(holding.average_price)}</dd></div>
              <div className="min-w-0"><dt className="text-muted">Quantity</dt><dd className="mt-1 break-words font-mono font-medium">{holding.quantity.toLocaleString("en-IN")}</dd></div>
            </dl>
            <p className="mt-3 break-all text-[10px] text-muted">ISIN: {holding.isin}</p>
            <LiveValuation selection={{ symbol: holding.trading_symbol, isin: holding.isin }} quantity={holding.quantity}
              entryPrice={holding.average_price} pricing={pricing} now={now} />
          </li>)}
        </ul>)}
    </section>
  );
}

function Positions({ segment, state, pricing, now }: {
  segment: string; state: ResourceState<Infer<typeof positionsResponseSchema>>; pricing: PortfolioPricing; now: number;
}) {
  return (
    <section aria-labelledby="positions-title" className="min-w-0">
      <h3 id="positions-title" className="mb-3 text-sm font-semibold">Positions{state.status === "success" && <span className="ml-2 text-muted">({state.data.payload.positions.length})</span>}</h3>
      {state.status === "loading" && <p role="status" className="py-6 text-sm text-muted">Loading positions...</p>}
      {state.status === "error" && <p role="alert" className="rounded-lg border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{state.message}</p>}
      {state.status === "success" && (state.data.payload.positions.length === 0
        ? <p className="rounded-lg bg-inset p-5 text-sm text-muted">No Groww positions{segment ? ` in ${segment}` : ""}.</p>
        : <ul className="grid gap-3 sm:grid-cols-2" aria-label="Groww positions">
          {state.data.payload.positions.map((position) => <li key={`${position.exchange}:${position.segment ?? ""}:${position.product}:${position.trading_symbol}`} className="min-w-0 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h4 className="min-w-0 break-words text-sm font-semibold">{position.trading_symbol}</h4>
              <span className="rounded-md bg-inset px-2 py-1 text-[10px] text-muted">{position.quantity < 0 ? "Short" : position.quantity > 0 ? "Long" : "Closed"}</span>
            </div>
            <p className="mt-1 break-words text-[11px] text-muted">{position.exchange} · {position.segment ?? (segment || "Segment unavailable")} · {position.product}</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div className="min-w-0"><dt className="text-muted">Net average price</dt><dd className="mt-1 break-words font-mono font-medium">{money(position.net_price)}</dd></div>
              <div className="min-w-0"><dt className="text-muted">Net quantity</dt><dd className="mt-1 break-words font-mono font-medium">{position.quantity.toLocaleString("en-IN")}</dd></div>
              <div className="col-span-2"><dt className="text-muted">Realised P&amp;L</dt><dd className={`mt-1 break-words font-mono font-medium ${position.realised_pnl < 0 ? "text-negative" : position.realised_pnl > 0 ? "text-positive" : "text-muted"}`}>{money(position.realised_pnl)}</dd></div>
            </dl>
            <LiveValuation selection={{ symbol: position.trading_symbol, exchange: position.exchange, segment: position.segment ?? (segment || undefined) }}
              quantity={position.quantity} entryPrice={position.net_price} pricing={pricing} now={now} />
          </li>)}
        </ul>)}
    </section>
  );
}

function PortfolioSummary({ holdings, positions, segment, pricing, now }: {
  holdings: ResourceState<Infer<typeof holdingsResponseSchema>>;
  positions: ResourceState<Infer<typeof positionsResponseSchema>>;
  segment: string; pricing: PortfolioPricing; now: number;
}) {
  const mark = (selection: PortfolioInstrumentSelection, quantity: number, entryPrice: number) => {
    const instrument = pricing.instruments[portfolioInstrumentKey(selection)];
    return instrument ? portfolioLiveMark(instrument, quantity, entryPrice, pricing.prices[livePriceKey(instrument)], now) : null;
  };
  const holdingMarks = holdings.status === "success" ? holdings.data.payload.holdings.filter(item => item.quantity !== 0)
    .map(item => mark({ symbol: item.trading_symbol, isin: item.isin }, item.quantity, item.average_price)) : null;
  const positionMarks = positions.status === "success" ? positions.data.payload.positions.filter(item => item.quantity !== 0)
    .map(item => mark({ symbol: item.trading_symbol, exchange: item.exchange, segment: item.segment ?? (segment || undefined) },
      item.quantity, item.net_price)) : null;
  const items = [
    { label: "Overall live P&L", marks: holdingMarks && positionMarks ? [...holdingMarks, ...positionMarks] : null,
      failed: holdings.status === "error" || positions.status === "error" },
    { label: "Holdings live P&L", marks: holdingMarks, failed: holdings.status === "error" },
    { label: "Positions live P&L", marks: positionMarks, failed: positions.status === "error" },
  ];
  return <section aria-label="Portfolio profit and loss summary" className="rounded-xl border border-line bg-inset p-3">
    <dl className="grid gap-4 sm:grid-cols-3">
      {items.map(item => {
        const total = item.marks ? portfolioLiveTotals(item.marks) : null;
        const pnl = total?.pnl;
        return <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className={`mt-1 break-words font-mono text-lg font-semibold ${pnl == null ? "text-muted" : pnl > 0 ? "text-positive" : pnl < 0 ? "text-negative" : "text-muted"}`}>
            {pnl == null ? "Unavailable" : `${pnl > 0 ? "Profit" : pnl < 0 ? "Loss" : "Break-even"}: ${money(pnl)}`}
            {total?.percent != null && <span className="mt-1 block text-xs">({total.percent.toFixed(2)}%)</span>}
          </dd>
          <dd className={`mt-1 text-[10px] ${total && total.pricedCount < total.count || item.failed ? "text-warning" : "text-muted"}`}>
            {total ? `${total.pricedCount}/${total.count} open entries with fresh prices${total.pnl === null ? " · Incomplete valuation" : ""}`
              : item.failed ? "Account data unavailable" : "Loading account data..."}
          </dd>
        </div>;
      })}
    </dl>
    <p className="mt-3 text-[10px] text-muted">Overall = holdings + {segment || "all"} positions. Unrealized P&amp;L only; realised P&amp;L and fees are excluded. Totals require fresh valid prices for every open entry.</p>
  </section>;
}

function PortfolioResources({ segment, onSessionExpired }: { segment: string; onSessionExpired: () => void }) {
  const holdings = usePortfolioData("/api/groww/holdings", holdingsResponseSchema, onSessionExpired);
  const positions = usePortfolioData(`/api/groww/positions${segment ? `?${new URLSearchParams({ segment })}` : ""}`, positionsResponseSchema, onSessionExpired);
  const ready = holdings.status !== "loading" && positions.status !== "loading";
  const selections: PortfolioInstrumentSelection[] = ready ? [
    ...(holdings.status === "success" ? holdings.data.payload.holdings.filter(item => item.quantity !== 0)
      .map(item => ({ symbol: item.trading_symbol, isin: item.isin })) : []),
    ...(positions.status === "success" ? positions.data.payload.positions.filter(item => item.quantity !== 0)
      .map(item => ({ symbol: item.trading_symbol, exchange: item.exchange, segment: item.segment ?? (segment || undefined) })) : []),
  ] : [];
  const pricing = usePortfolioPrices(selections, onSessionExpired);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <div className="space-y-5">
    <PortfolioSummary holdings={holdings} positions={positions} segment={segment} pricing={pricing} now={now} />
    <div className="rounded-lg bg-inset p-3 text-[11px] text-muted">
      <p>Prices stream separately from account snapshots. P&amp;L compares live price with your saved average; shorts gain when price falls. Fees are excluded. Holdings use NSE when available, otherwise BSE.</p>
      {pricing.error && <p role="alert" className="mt-2 break-words text-negative">{pricing.error}</p>}
      <button type="button" className="mt-2 text-accent underline underline-offset-2" onClick={pricing.reconnect}>Reconnect portfolio prices</button>
    </div>
    <Holdings state={holdings} pricing={pricing} now={now} />
    <Positions segment={segment} state={positions} pricing={pricing} now={now} />
  </div>;
}

export function GrowwPortfolio({ connected, onSessionExpired }: {
  connected: boolean;
  onSessionExpired: () => void;
}) {
  const [segment, setSegment] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const previewId = useId();
  const dock = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => { setOpen(false); setPinned(false); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) {
        dismiss();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      const restoreFocus = dock.current?.contains(document.activeElement);
      dismiss();
      if (restoreFocus) trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", dismiss);
    };
  }, [open]);

  return (
    <aside className="portfolio-bottom-bar" aria-label="Account quick access">
      <div ref={dock} className="portfolio-dock"
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && !pinned && !event.currentTarget.contains(document.activeElement)) setOpen(false);
        }}
        onFocusCapture={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(true);
        }}
        onBlurCapture={(event) => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
            setOpen(false); setPinned(false);
          }
        }}>
      <button ref={trigger} type="button" className="portfolio-trigger" aria-label="Holdings and positions"
        aria-expanded={open} aria-controls={previewId}
        title={pinned ? "Click to close your portfolio" : "Hover to preview; click to keep open"}
        onClick={() => { setOpen(!pinned); setPinned(!pinned); }}>
        <Icon name="chart" className="hidden size-4 shrink-0 text-accent sm:block" />
        <span className="min-w-0 text-left"><span className="block text-xs font-semibold">Holdings &amp; positions</span><span className="mt-0.5 block text-[10px] text-muted">{connected ? "Groww account snapshots" : "Connect Groww to view"}</span></span>
      </button>
      <div id={previewId} hidden={!open} className="portfolio-preview" role="region" aria-label="Holdings and positions preview">
      <section aria-labelledby="portfolio-title" className="portfolio-preview-content">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow mb-2 text-accent">YOUR GROWW ACCOUNT</p>
          <h2 id="portfolio-title" className="text-lg font-semibold">Holdings &amp; positions</h2>
          <p className="mt-1 text-xs text-muted">{connected ? "Broker holdings with live price P&L, separate from paper trades. Refresh to update quantities and entry prices." : "Connect Groww in the header to view your account."}</p>
        </div>
        <button type="button" className="icon-button shrink-0" aria-label="Close portfolio preview" onClick={() => {
          setOpen(false); setPinned(false); trigger.current?.focus();
        }}><Icon name="close" className="size-4" /></button>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        {connected && <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="position-segment" className="field-label mb-1">Positions segment</label>
            <select id="position-segment" className="field h-9 text-xs" value={segment} onChange={(event) => setSegment(event.target.value)}>
              <option value="">All segments</option>
              <option value="CASH">CASH</option>
              <option value="FNO">FNO</option>
            </select>
          </div>
          <button type="button" className="secondary-button text-xs" onClick={() => setRevision((value) => value + 1)}>
            <Icon name="refresh" className="size-4" />Refresh portfolio
          </button>
        </div>}
      </div>
      {connected
        ? <PortfolioResources key={revision} segment={segment} onSessionExpired={onSessionExpired} />
        : <p className="rounded-lg border border-dashed border-line bg-inset p-5 text-sm text-muted">Your holdings and positions will appear here after connecting. No sample account data is shown.</p>}
    </section>
      </div>
      </div>
      <p className="ml-4 hidden text-[11px] text-muted lg:block">Read-only Groww portfolio · Hover to preview, click to keep open</p>
    </aside>
  );
}
