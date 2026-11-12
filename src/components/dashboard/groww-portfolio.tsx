"use client";

import { useEffect, useState } from "react";
import type { ZodType } from "zod";
import { holdingsResponseSchema, positionsResponseSchema } from "../../lib/groww/portfolio-schemas";
import { money } from "./format";
import { Icon } from "./icons";

type ResourceState<T> =
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; message: string };

function usePortfolioData<T>(url: string, schema: ZodType<T>, onSessionExpired: () => void) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });

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
        if (!controller.signal.aborted) setState({ status: "success", data: result.data });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "Unable to load Groww portfolio." });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [url, schema, onSessionExpired]);

  return state;
}

function Holdings({ onSessionExpired }: { onSessionExpired: () => void }) {
  const state = usePortfolioData("/api/groww/holdings", holdingsResponseSchema, onSessionExpired);
  return (
    <section aria-labelledby="holdings-title" className="min-w-0">
      <h3 id="holdings-title" className="mb-3 text-sm font-semibold">Holdings{state.status === "success" && <span className="ml-2 text-muted">({state.data.payload.holdings.length})</span>}</h3>
      {state.status === "loading" && <p role="status" className="py-6 text-sm text-muted">Loading holdings...</p>}
      {state.status === "error" && <p role="alert" className="rounded-lg border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{state.message}</p>}
      {state.status === "success" && (state.data.payload.holdings.length === 0
        ? <p className="rounded-lg bg-inset p-5 text-sm text-muted">No stocks in your Groww holdings.</p>
        : <div className="overflow-x-auto rounded-lg border border-line" role="region" aria-label="Holdings table" tabIndex={0}>
          <table className="w-full whitespace-nowrap text-left text-xs">
            <caption className="sr-only">Stock holdings in your Groww DEMAT account</caption>
            <thead className="bg-inset text-muted"><tr>
              <th scope="col" className="px-4 py-3 font-medium">Stock / ISIN</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Quantity</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Avg. buy price</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {state.data.payload.holdings.map((holding) => <tr key={`${holding.isin}:${holding.trading_symbol}`}>
                <th scope="row" className="px-4 py-3 font-medium"><span className="block">{holding.trading_symbol}</span><span className="mt-1 block font-mono text-[10px] font-normal text-muted">{holding.isin}</span></th>
                <td className="px-4 py-3 text-right font-mono">{holding.quantity.toLocaleString("en-IN")}</td>
                <td className="px-4 py-3 text-right font-mono">{money(holding.average_price)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>)}
    </section>
  );
}

function Positions({ segment, onSessionExpired }: { segment: string; onSessionExpired: () => void }) {
  const query = segment ? `?${new URLSearchParams({ segment })}` : "";
  const state = usePortfolioData(`/api/groww/positions${query}`, positionsResponseSchema, onSessionExpired);
  return (
    <section aria-labelledby="positions-title" className="min-w-0">
      <h3 id="positions-title" className="mb-3 text-sm font-semibold">Positions{state.status === "success" && <span className="ml-2 text-muted">({state.data.payload.positions.length})</span>}</h3>
      {state.status === "loading" && <p role="status" className="py-6 text-sm text-muted">Loading positions...</p>}
      {state.status === "error" && <p role="alert" className="rounded-lg border border-negative/25 bg-negative/5 p-4 text-sm text-negative">{state.message}</p>}
      {state.status === "success" && (state.data.payload.positions.length === 0
        ? <p className="rounded-lg bg-inset p-5 text-sm text-muted">No Groww positions{segment ? ` in ${segment}` : ""}.</p>
        : <div className="overflow-x-auto rounded-lg border border-line" role="region" aria-label="Positions table" tabIndex={0}>
          <table className="w-full whitespace-nowrap text-left text-xs">
            <caption className="sr-only">Groww positions{segment ? ` in ${segment}` : " across all segments"}</caption>
            <thead className="bg-inset text-muted"><tr>
              <th scope="col" className="px-4 py-3 font-medium">Stock / contract</th>
              <th scope="col" className="px-4 py-3 font-medium">Exchange</th>
              <th scope="col" className="px-4 py-3 font-medium">Segment</th>
              <th scope="col" className="px-4 py-3 font-medium">Product</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Net quantity</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Net avg. price</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Realised P&amp;L</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {state.data.payload.positions.map((position) => <tr key={`${position.exchange}:${position.segment ?? ""}:${position.product}:${position.trading_symbol}`}>
                <th scope="row" className="px-4 py-3 font-medium">{position.trading_symbol}</th>
                <td className="px-4 py-3 text-muted">{position.exchange}</td>
                <td className="px-4 py-3 text-muted">{position.segment ?? (segment || "--")}</td>
                <td className="px-4 py-3 text-muted">{position.product}</td>
                <td className="px-4 py-3 text-right font-mono">{position.quantity.toLocaleString("en-IN")}</td>
                <td className="px-4 py-3 text-right font-mono">{money(position.net_price)}</td>
                <td className={`px-4 py-3 text-right font-mono ${position.realised_pnl < 0 ? "text-negative" : position.realised_pnl > 0 ? "text-positive" : "text-muted"}`}>{money(position.realised_pnl)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>)}
    </section>
  );
}

export function GrowwPortfolio({ connected, onSessionExpired }: {
  connected: boolean;
  onSessionExpired: () => void;
}) {
  const [segment, setSegment] = useState("");
  const [revision, setRevision] = useState(0);

  return (
    <section aria-labelledby="portfolio-title" className="panel p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="eyebrow mb-2 text-accent">YOUR GROWW ACCOUNT</p>
          <h2 id="portfolio-title" className="text-lg font-semibold">Holdings &amp; positions</h2>
          <p className="mt-1 text-xs text-muted">{connected ? "Account snapshots from Groww. Refresh to fetch the latest data." : "Connect Groww in the header to view your account."}</p>
        </div>
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
        ? <div key={revision} className="space-y-6">
          <Holdings onSessionExpired={onSessionExpired} />
          <Positions key={segment} segment={segment} onSessionExpired={onSessionExpired} />
        </div>
        : <p className="rounded-lg border border-dashed border-line bg-inset p-5 text-sm text-muted">Your holdings and positions will appear here after connecting. No sample account data is shown.</p>}
    </section>
  );
}
