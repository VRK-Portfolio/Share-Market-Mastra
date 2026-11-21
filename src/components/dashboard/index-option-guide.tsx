"use client";

import { useEffect, useId, useState } from "react";
import { fnoGuideSchema, optionIndexListSchema } from "../../lib/groww/fno-guide-schemas";
import type { FnoGuide } from "../../lib/groww/fno-guide-schemas";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { optionSideGuidance, optionStrikeMoneyness } from "../../lib/market/option-guide";
import { money } from "./format";

export function IndexOptionGuide({ exchange, selected, onSelect, onSessionExpired }: {
  exchange: "NSE" | "BSE"; selected: FnoInstrument | null;
  onSelect: (instrument: FnoInstrument | null) => void; onSessionExpired: () => void;
}) {
  const underlyingListId = useId();
  const [indices, setIndices] = useState<ReturnType<typeof optionIndexListSchema.parse> | null>(null);
  const [listError, setListError] = useState("");
  const [filters, setFilters] = useState<{ underlying: string; expiry: string; type: "CE" | "PE"; strike: string }>({
    underlying: selected?.underlying ?? "", expiry: selected?.instrumentType === "FUT" ? "" : selected?.expiry ?? "",
    type: selected?.instrumentType === "PE" ? "PE" : "CE",
    strike: selected?.strikePrice?.toString() ?? "",
  });
  const [listRevision, setListRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: FnoGuide; error?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const key = JSON.stringify([exchange, filters, revision]);
  const current = result?.key === key ? result : null;
  const data = current?.data;
  const expiryOptions = result?.data?.underlying === filters.underlying ? result.data.expiries : [];
  const previous = result?.data;
  const chain = previous?.underlying === filters.underlying && previous.index.exchange === exchange &&
    previous.type === filters.type && (!filters.expiry || previous.expiry === filters.expiry) ? previous : null;
  const validUnderlying = indices?.indices.some(item => item.underlying === filters.underlying && item.index.exchange === exchange);
  const guidance = data ? optionSideGuidance(data.spot, data.trend, filters.type, now) : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/groww/fno-guide?exchange=${exchange}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(apiError(body));
        const list = optionIndexListSchema.parse(body);
        if (list.indices.some(item => item.index.exchange !== exchange)) throw new Error("Underlying list did not match the selected exchange.");
        if (controller.signal.aborted) return;
        setIndices(list);
        setListError("");
        setFilters(previous => ({ ...previous,
          underlying: list.indices.some(item => item.underlying === previous.underlying) ? previous.underlying : list.indices[0]?.underlying ?? "",
          expiry: list.indices.some(item => item.underlying === previous.underlying) ? previous.expiry : "",
          strike: list.indices.some(item => item.underlying === previous.underlying) ? previous.strike : "",
        }));
      } catch (error) {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "Unable to load option underlyings.");
      }
    }
    void load();
    return () => controller.abort();
  }, [exchange, onSessionExpired, listRevision]);

  useEffect(() => {
    if (!validUnderlying) return;
    const controller = new AbortController();
    async function load() {
      try {
        const query = new URLSearchParams({ exchange, ...filters });
        const response = await fetch(`/api/groww/fno-guide?${query}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onSessionExpired(); return; }
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(apiError(body));
        const snapshot = fnoGuideSchema.parse(body);
        if (snapshot.underlying !== filters.underlying || snapshot.index.exchange !== exchange || snapshot.type !== filters.type ||
          (filters.expiry && snapshot.expiry !== filters.expiry) || snapshot.spot.symbol !== snapshot.index.tradingSymbol ||
          snapshot.spot.exchange !== exchange || (filters.strike && !snapshot.contracts.some(item => item.strikePrice === Number(filters.strike))) ||
          snapshot.contracts.some(item => item.exchange !== exchange ||
            item.underlying !== filters.underlying || item.instrumentType !== filters.type || item.expiry !== snapshot.expiry)) {
          throw new Error("Option guide did not match the selected underlying, expiry, strike or side. Refresh to retry.");
        }
        if (!controller.signal.aborted) { setNow(Date.now()); setResult({ key, data: snapshot }); }
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Unable to load nearby options." });
      }
    }
    void load();
    return () => controller.abort();
  }, [exchange, filters, validUnderlying, key, onSessionExpired]);

  function change(update: Partial<typeof filters>) {
    setFilters(previous => ({ ...previous, ...update }));
    onSelect(null);
  }

  return <section aria-label="Stock and index option guide" className="my-3 min-w-0 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs normal-case tracking-normal">
    <div className="flex items-start justify-between gap-2">
      <div><h3 className="font-semibold text-foreground">Find options near spot</h3><p className="mt-1 text-muted">Stock or index → expiry → CE/PE → strike price</p></div>
      <button type="button" className="secondary-button shrink-0 text-xs" onClick={() => listError ? setListRevision(value => value + 1) : setRevision(value => value + 1)}>Refresh</button>
    </div>
    {listError && <p role="alert" className="mt-3 text-negative">{listError}</p>}
    {!indices && !listError && <p role="status" className="mt-3 text-muted">Loading verified stock and index options...</p>}
    {indices && !indices.indices.length && <p role="status" className="mt-3 text-muted">No verified stock/index options are listed. Use exact contract search below.</p>}
    {!!indices?.indices.length && <>
      <label className="field-label mt-3 block">Underlying stock or index
        <input aria-label="Underlying stock or index" type="search" list={underlyingListId} className="field mt-1 w-full uppercase"
          value={filters.underlying} maxLength={50} placeholder="Search NIFTY, RELIANCE..." autoComplete="off" spellCheck={false}
          onChange={event => change({ underlying: event.target.value.toUpperCase(), expiry: "", strike: "" })} />
      </label>
      <datalist id={underlyingListId}>
        {indices.indices.map(item => <option key={item.underlying} value={item.underlying}>
          {item.index.instrumentType === "IDX" ? "Index" : "Stock"} · {item.index.name ?? item.index.tradingSymbol}
        </option>)}
      </datalist>
      {!validUnderlying && <p className="mt-2 text-muted">Choose an exact stock or index from the suggestions. Only underlyings with verified listed options are supported.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="field-label min-w-0">Listed expiry<select aria-label="Listed option expiry" className="field mt-1 w-full min-w-0"
          value={filters.expiry || data?.expiry || ""} onChange={event => change({ expiry: event.target.value, strike: "" })}>
          {!filters.expiry && !data && <option value="">Nearest expiry</option>}
          {expiryOptions.map(expiry => <option key={expiry}>{expiry}</option>)}
        </select></label>
        <label className="field-label min-w-0">Option side<select aria-label="Option side" className="field mt-1 w-full" value={filters.type}
          onChange={event => change({ type: event.target.value === "PE" ? "PE" : "CE", expiry: filters.expiry || data?.expiry || "", strike: "" })}>
          <option value="CE">CE · Call</option><option value="PE">PE · Put</option>
        </select></label>
      </div>
      <label className="field-label mt-3 block">Strike price
        <select aria-label="Listed strike price" className="field mt-1 w-full" value={filters.strike} disabled={!chain}
          onChange={event => change({ strike: event.target.value, expiry: filters.expiry || chain?.expiry || "" })}>
          <option value="">{chain ? `Nearest to spot · ${money(chain.nearestStrike)}` : "Choose an underlying to load strikes"}</option>
          {chain?.strikes.map(strike => <option key={strike} value={strike}>{money(strike)}{strike === chain.nearestStrike ? " · Nearest to spot" : ""}</option>)}
        </select>
      </label>
      {validUnderlying && !current && <p role="status" className="mt-3 text-muted">Loading underlying spot and listed strikes...</p>}
      {current?.error && <p role="alert" className="mt-3 text-negative">{current.error}</p>}
      {data && guidance && <>
        <div className="mt-3 rounded-lg bg-panel p-3">
          <p className="text-muted">{data.index.name ?? data.underlying} · underlying spot, not option premium</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{money(data.spot.price)}</p>
          <p className="mt-1 text-[11px] text-muted">Last trade: {data.spot.lastTradeTime ? new Date(data.spot.lastTradeTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "Time unavailable"} IST · snapshot, refresh manually</p>
        </div>
        <p className="mt-3 font-semibold text-foreground">Nearby listed strikes · {data.type}</p>
        <p className="mt-1 text-muted">Nearest listed strike highlighted, never selected automatically. Ties use the lower strike; nearest does not mean exact ATM.</p>
        {filters.strike && <p className="mt-1 text-muted">Showing contracts around {money(Number(filters.strike))}. Nearest to spot: {money(data.nearestStrike)}.</p>}
        <p className="mt-1 text-muted">Select a contract card below to use that exact strike in the trading ticket.</p>
        <div aria-label="Nearby option strikes" className="mt-2 grid grid-cols-2 gap-2">
          {data.contracts.map(instrument => {
            const strike = instrument.strikePrice!;
            const nearest = strike === data.nearestStrike;
            const distance = strike - data.spot.price;
            const moneyness = optionStrikeMoneyness(data.type, strike, data.spot.price);
            return <button type="button" key={instrument.growwSymbol} aria-pressed={selected?.growwSymbol === instrument.growwSymbol}
              className={`min-w-0 rounded-lg border p-2 text-left ${nearest ? "border-accent bg-accent/10" : "border-line bg-panel"} aria-pressed:ring-2 aria-pressed:ring-accent`}
              onClick={() => onSelect(instrument)}>
              <span className="block font-semibold text-foreground">{money(strike)} {data.type}</span>
              <span className="mt-1 block text-muted">{nearest ? "Nearest · " : ""}{moneyness} · {distance > 0 ? "+" : ""}{Number(distance.toFixed(2))} pts</span>
              <span className="mt-1 block text-[11px] text-muted">Lot {instrument.lotSize}{selected?.growwSymbol === instrument.growwSymbol ? " · Selected" : ""}</span>
            </button>;
          })}
        </div>
        <div role="status" className="mt-3 rounded-lg border border-line bg-panel p-3">
          <p className={`font-semibold ${guidance.action === "WAIT" ? "text-muted" : "text-accent"}`}>{guidance.action} · {data.type}{guidance.preferred ? ` · preferred side ${guidance.preferred}` : ""}</p>
          <p className="mt-1 text-muted">{guidance.reason}</p>
          <p className="mt-2 text-[11px] text-muted">Trend-only candidate, not entry approval. Confirm the option premium setup, spread, IV, time decay and risk. SELL only closes owned options; no option writing.</p>
          <details className="mt-2 text-muted"><summary className="cursor-pointer">Underlying evidence · 15m closed candles</summary>
            <p className="mt-1">EMA order, RSI, MACD and SuperTrend must all agree. This guide uses price-only checks, not VWAP/volume confirmation or the CASH breakout strategy.</p>
            {data.trend.reasons.map(reason => <p key={reason} className="mt-1">{reason}</p>)}
            {data.trend.error && <p className="mt-1 text-negative">{data.trend.error}</p>}
          </details>
        </div>
      </>}
    </>}
  </section>;
}

function apiError(body: unknown) {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error : "Unable to load the option guide. Refresh to retry.";
}
