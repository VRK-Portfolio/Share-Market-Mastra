"use client";

import { useEffect, useState } from "react";
import { instrumentSearchResponseSchema } from "../../lib/groww/instrument-schemas";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { money } from "./format";

export function FnoContractPicker({ exchange, selected, onSelect, onSessionExpired }: {
  exchange: "NSE" | "BSE";
  selected: FnoInstrument | null;
  onSelect: (instrument: FnoInstrument | null) => void;
  onSessionExpired: () => void;
}) {
  const [filters, setFilters] = useState({ q: "", type: "ALL", expiry: "", strike: "", page: 1 });
  const [result, setResult] = useState<{
    key: string; data?: ReturnType<typeof instrumentSearchResponseSchema.parse>; error?: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const q = filters.q.trim().toUpperCase();
  const key = JSON.stringify([filters, exchange, revision]);
  const current = result?.key === key ? result : null;
  const loading = q.length >= 2 && !current;

  useEffect(() => {
    if (q.length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const query = new URLSearchParams({
          q, exchange, type: filters.type, expiry: filters.expiry, strike: filters.strike, page: String(filters.page),
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
  }, [q, filters, exchange, key, onSessionExpired]);

  function change(name: "q" | "type" | "expiry" | "strike", value: string) {
    setFilters((current) => ({ ...current, [name]: value, page: 1 }));
    onSelect(null);
  }

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby="contract-search-title">
      <h2 id="contract-search-title" className="mb-4 text-sm font-semibold">Search Groww futures and options</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="field-label">Underlying / contract<input aria-label="Underlying or contract" className="field mt-2 w-full uppercase" value={filters.q} maxLength={50} placeholder="NIFTY, BANKNIFTY, RELIANCE" onChange={(event) => change("q", event.target.value)} /></label>
        <label className="field-label">Contract type<select aria-label="Contract type" className="field mt-2 w-full" value={filters.type} onChange={(event) => change("type", event.target.value)}><option value="ALL">All futures/options</option><option value="FUT">Futures</option><option value="CE">Call options (CE)</option><option value="PE">Put options (PE)</option></select></label>
        <label className="field-label">Expiry (optional)<input aria-label="Contract expiry" type="date" className="field mt-2 w-full" value={filters.expiry} onChange={(event) => change("expiry", event.target.value)} /></label>
        <label className="field-label">Strike (options, optional)<input aria-label="Option strike" type="number" min="0.01" step="any" className="field mt-2 w-full" value={filters.strike} onChange={(event) => change("strike", event.target.value)} /></label>
      </div>
      {q.length < 2 && <p className="mt-4 text-sm text-muted">Type at least two characters, then choose an exact contract. Expired contracts are excluded.</p>}
      {loading && <p role="status" className="mt-4 text-sm text-muted">Searching Groww&apos;s instrument catalog...</p>}
      {current?.error && <div className="mt-4"><p role="alert" className="text-sm text-negative">{current.error}</p><button type="button" className="secondary-button mt-2 text-xs" onClick={() => setRevision((value) => value + 1)}>Retry contract search</button></div>}
      {current?.data && <>
        <p role="status" className="my-4 text-xs text-muted">{current.data.total} matching contracts · page {current.data.page}</p>
        <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {current.data.instruments.map((instrument) => <button
            key={instrument.growwSymbol} type="button"
            aria-pressed={selected?.growwSymbol === instrument.growwSymbol}
            className={`rounded-xl border p-3 text-left ${selected?.growwSymbol === instrument.growwSymbol ? "border-accent bg-accent/5" : "border-line bg-inset"}`}
            onClick={() => onSelect(instrument)}
          ><span className="block font-mono text-xs font-semibold">{instrument.tradingSymbol}</span><span className="mt-1 block text-xs text-muted">{instrument.underlying} · {instrument.instrumentType} · {instrument.expiry}{instrument.strikePrice !== null ? ` · ${money(instrument.strikePrice)}` : ""} · Lot {instrument.lotSize}</span></button>)}
        </div>
        {!current.data.instruments.length && <p className="text-sm text-muted">No contracts match these filters. Try another expiry, strike or type.</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" className="secondary-button text-xs" disabled={filters.page === 1} onClick={() => setFilters((value) => ({ ...value, page: value.page - 1 }))}>Previous contracts</button>
          <button type="button" className="secondary-button text-xs" disabled={!current.data.hasMore} onClick={() => setFilters((value) => ({ ...value, page: value.page + 1 }))}>Next contracts</button>
        </div>
      </>}
      <p className="mt-4 text-xs text-muted">Catalog matches identify contracts, not trading eligibility. Quotes and history require Groww F&O market-data permissions.</p>
    </section>
  );
}
