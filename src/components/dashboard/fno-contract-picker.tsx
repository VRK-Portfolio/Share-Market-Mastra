"use client";

import { useEffect, useId, useRef, useState } from "react";
import { instrumentSearchResponseSchema } from "../../lib/groww/instrument-schemas";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { money } from "./format";

export function FnoContractPicker({ exchange, selected, onSelect, onSessionExpired }: {
  exchange: "NSE" | "BSE";
  selected: FnoInstrument | null;
  onSelect: (instrument: FnoInstrument | null) => void;
  onSessionExpired: () => void;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filters, setFilters] = useState({ q: selected?.tradingSymbol ?? "", type: "ALL", expiry: "", strike: "", page: 1 });
  const [result, setResult] = useState<{
    key: string; data?: ReturnType<typeof instrumentSearchResponseSchema.parse>; error?: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const q = filters.q.trim().toUpperCase();
  const key = JSON.stringify([filters, exchange, revision]);
  const current = result?.key === key ? result : null;
  const loading = q.length >= 2 && !current;
  const matches = current?.data?.instruments;
  const expanded = open && q.length >= 2;
  const activeIndex = Math.min(active, Math.max(0, (matches?.length ?? 0) - 1));

  useEffect(() => {
    if (!open || q.length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const query = new URLSearchParams({
          q, exchange, segment: "FNO", type: filters.type, expiry: filters.expiry, strike: filters.strike, page: String(filters.page),
        });
        const response = await fetch(`/api/groww/instruments?${query}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Unable to search Groww F&O contracts.");
        const data = instrumentSearchResponseSchema.parse(body);
        if (data.page !== filters.page || data.instruments.some((item) => item.exchange !== exchange)) {
          throw new Error("The contract search did not match your exchange or page. Retry search.");
        }
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Unable to search contracts." });
      }
    }, 400);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [q, filters, exchange, key, open, onSessionExpired]);

  useEffect(() => {
    if (expanded) list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, current]);

  function change(name: "q" | "type" | "expiry" | "strike", value: string) {
    setFilters((current) => ({ ...current, [name]: value, page: 1 }));
    setActive(0);
    setOpen(true);
    onSelect(null);
  }

  function select(index: number) {
    const instrument = matches?.[index];
    if (!instrument) return;
    setFilters((current) => ({ ...current, q: instrument.tradingSymbol, page: 1 }));
    setOpen(false);
    setActive(0);
    onSelect(instrument);
  }

  return (
    <div className="field-label min-w-40 flex-1 sm:max-w-72"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <label htmlFor={id}>Selected contract</label>
      <div className="relative mt-2">
        <input id={id} role="combobox" aria-label="Selected contract" aria-autocomplete="list"
          aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
          aria-activedescendant={expanded && matches?.length ? `${id}-option-${activeIndex}` : undefined}
          className="field w-full pr-16 uppercase" value={filters.q} maxLength={50}
          placeholder="Search NIFTY, RELIANCE..." autoComplete="off" spellCheck={false}
          onFocus={() => setOpen(true)} onChange={(event) => change("q", event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
            else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.max(0, Math.min((matches?.length ?? 1) - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter" && expanded && matches?.length) {
              event.preventDefault();
              select(activeIndex);
            }
          }} />
        <span className="pointer-events-none absolute right-3 top-3 rounded bg-panel px-2 py-0.5 text-[10px] text-muted">FNO</span>
        {expanded && <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-panel p-3 text-foreground shadow-xl">
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label col-span-2">Contract type<select aria-label="Contract type" className="field mt-2 w-full" value={filters.type} onChange={(event) => change("type", event.target.value)}><option value="ALL">All futures/options</option><option value="FUT">Futures</option><option value="CE">Call options (CE)</option><option value="PE">Put options (PE)</option></select></label>
            <label className="field-label min-w-0">Expiry (optional)<input aria-label="Contract expiry" type="date" className="field mt-2 w-full min-w-0" value={filters.expiry} onChange={(event) => change("expiry", event.target.value)} /></label>
            <label className="field-label min-w-0">Strike (optional)<input aria-label="Option strike" type="number" min="0.01" step="any" className="field mt-2 w-full min-w-0" value={filters.strike} onChange={(event) => change("strike", event.target.value)} /></label>
          </div>
          {loading && <p role="status" className="mt-3 text-xs text-muted">Searching Groww&apos;s instrument catalog...</p>}
          {current?.error && <div className="mt-3"><p role="alert" className="text-xs text-negative">{current.error}</p><button type="button" className="secondary-button mt-2 text-xs" onClick={() => setRevision((value) => value + 1)}>Retry contract search</button></div>}
          {current?.data && <p role="status" className="my-3 text-xs text-muted">{current.data.total} matching contracts · page {current.data.page}</p>}
          <ul id={`${id}-list`} ref={list} role="listbox" aria-label="Matching contracts" className="mt-2 max-h-64 overflow-y-auto">
            {matches?.map((instrument, index) => <li key={instrument.growwSymbol} id={`${id}-option-${index}`}
              role="option" aria-selected={activeIndex === index}
              className={`cursor-pointer rounded-lg p-3 text-xs ${activeIndex === index ? "bg-accent/10" : "hover:bg-inset"}`}
              onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => select(index)}>
              <span className="block break-all font-mono font-semibold">{instrument.tradingSymbol}</span>
              <span className="mt-1 block text-muted">{instrument.exchange} · {instrument.underlying} · {instrument.instrumentType} · {instrument.expiry}{instrument.strikePrice !== null ? ` · ${money(instrument.strikePrice)}` : ""} · Lot {instrument.lotSize}</span>
            </li>)}
          </ul>
          {matches && !matches.length && <p role="status" className="mt-3 text-xs text-muted">No contracts match these filters. Try another expiry, strike or type.</p>}
          {current?.data && <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="secondary-button text-xs" disabled={filters.page === 1} onClick={() => { setFilters((value) => ({ ...value, page: value.page - 1 })); setActive(0); }}>Previous contracts</button>
            <button type="button" className="secondary-button text-xs" disabled={!current.data.hasMore} onClick={() => { setFilters((value) => ({ ...value, page: value.page + 1 })); setActive(0); }}>Next contracts</button>
          </div>}
          <p className="mt-3 text-[11px] text-muted">Choose an exact, unexpired contract. Catalog matches do not confirm trading eligibility or F&O market-data access.</p>
        </div>}
      </div>
    </div>
  );
}
