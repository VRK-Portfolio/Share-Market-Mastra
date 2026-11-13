"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cashInstrumentSearchResponseSchema } from "../../lib/groww/instrument-schemas";

type SearchResponse = ReturnType<typeof cashInstrumentSearchResponseSchema.parse>;

export function CashStockPicker({ symbol, exchange, onSelect, onSessionExpired }: {
  symbol: string;
  exchange: "NSE" | "BSE";
  onSelect: (symbol: string) => void;
  onSessionExpired: () => void;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(symbol);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: SearchResponse; error?: string } | null>(null);
  const q = query.trim().toUpperCase();
  const key = JSON.stringify([q, exchange, revision]);
  const current = result?.key === key ? result : null;
  const matches = current?.data?.instruments;
  const expanded = open && q.length >= 2;
  const activeIndex = Math.min(active, Math.max(0, (matches?.length ?? 0) - 1));

  useEffect(() => {
    if (!open || q.length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/groww/instruments?${new URLSearchParams({ q, exchange, segment: "CASH" })}`,
          { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Unable to search Groww stocks.");
        const data = cashInstrumentSearchResponseSchema.parse(body);
        if (data.q !== q || data.exchange !== exchange || data.page !== 1 ||
          data.instruments.some((instrument) => instrument.exchange !== exchange)) {
          throw new Error("The stock search did not match your query or exchange. Retry search.");
        }
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Unable to search Groww stocks." });
      }
    }, 400);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [q, exchange, key, open, onSessionExpired]);

  useEffect(() => {
    if (expanded) list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, current]);

  function select(index: number) {
    const instrument = matches?.[index];
    if (!instrument) return;
    setQuery(instrument.tradingSymbol);
    setOpen(false);
    setActive(0);
    onSelect(instrument.tradingSymbol);
  }

  return <div className="field-label min-w-40 flex-1 sm:max-w-72">
    <label htmlFor={id}>Stock name or symbol</label>
    <div className="relative mt-2">
      <input id={id} role="combobox" aria-label="Stock symbol" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && matches?.length ? `${id}-option-${activeIndex}` : undefined}
        className="field w-full pr-16" value={query} maxLength={100} autoComplete="off" spellCheck={false}
        placeholder="Name or symbol, e.g. Reliance"
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); onSelect(""); }}
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
      <span className="pointer-events-none absolute right-3 top-3 rounded bg-panel px-2 py-0.5 text-[10px] text-muted">CASH</span>
      {expanded && <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-xl border border-line bg-panel p-2 text-foreground shadow-xl">
        {!current && <p role="status" className="p-2 text-xs text-muted">Searching Groww stocks...</p>}
        {current?.error && <div className="p-2">
          <p role="alert" className="text-xs text-negative">{current.error}</p>
          <button type="button" className="secondary-button mt-2 text-xs" onPointerDown={(event) => event.preventDefault()}
            onClick={() => setRevision((value) => value + 1)}>Retry stock search</button>
        </div>}
        <ul id={`${id}-list`} ref={list} role="listbox" aria-label="Matching stocks" className="max-h-64 overflow-y-auto">
          {matches?.map((instrument, index) => <li key={instrument.growwSymbol} id={`${id}-option-${index}`}
            role="option" aria-selected={activeIndex === index}
            className={`cursor-pointer rounded-lg p-3 text-xs ${activeIndex === index ? "bg-accent/10" : "hover:bg-inset"}`}
            onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => select(index)}>
            <span className="block font-mono font-semibold">{instrument.tradingSymbol} · {instrument.exchange}</span>
            {instrument.name && <span className="mt-1 block text-muted">{instrument.name}</span>}
          </li>)}
        </ul>
        {matches && !matches.length && <p role="status" className="p-2 text-xs text-muted">No matching stocks on {exchange}. Try another name or symbol.</p>}
        {current?.data?.hasMore && <p className="p-2 text-xs text-muted">Showing the first 30 of {current.data.total} matches. Type more characters to narrow the search.</p>}
      </div>}
    </div>
  </div>;
}
