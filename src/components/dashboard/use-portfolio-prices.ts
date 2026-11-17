"use client";

import { useEffect, useState } from "react";
import {
  portfolioInstrumentKey, portfolioInstrumentResolutionsSchema,
} from "../../lib/groww/portfolio-instrument-schemas";
import type { PortfolioInstrumentSelection } from "../../lib/groww/portfolio-instrument-schemas";
import type { FeedSelection } from "../../lib/groww/live-schemas";
import { useInstrumentPrices } from "./use-instrument-prices";

export function usePortfolioPrices(selections: PortfolioInstrumentSelection[], onSessionExpired: () => void) {
  const [revision, setRevision] = useState(0);
  const unique = [...new Map(selections.map(item => [portfolioInstrumentKey(item), item])).values()];
  const key = JSON.stringify([unique.sort((a, b) => portfolioInstrumentKey(a).localeCompare(portfolioInstrumentKey(b))), revision]);
  const [result, setResult] = useState<{
    key: string; instruments: Record<string, FeedSelection>; errors: Record<string, string>; error: string;
  } | null>(null);

  useEffect(() => {
    const [requested]: [PortfolioInstrumentSelection[]] = JSON.parse(key);
    if (!requested.length) return;
    const controller = new AbortController();
    async function resolve() {
      try {
        const instruments: Record<string, FeedSelection> = {};
        const errors: Record<string, string> = {};
        for (let offset = 0; offset < requested.length; offset += 50) {
          const batch = requested.slice(offset, offset + 50);
          const response = await fetch("/api/groww/portfolio-instruments", {
            method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]),
          });
          if (controller.signal.aborted) return;
          if (response.status === 401) { controller.abort(); onSessionExpired(); return; }
          const body: unknown = await response.json();
          if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : "Unable to resolve portfolio instruments for live prices.");
          const resolved = portfolioInstrumentResolutionsSchema.parse(body);
          const expected = new Set(batch.map(portfolioInstrumentKey));
          if (resolved.length !== expected.size || new Set(resolved.map(item => portfolioInstrumentKey(item.selection))).size !== expected.size ||
            resolved.some(item => !expected.has(portfolioInstrumentKey(item.selection)))) {
            throw new Error("The live-price lookup did not match the requested portfolio instruments.");
          }
          for (const item of resolved) {
            const identity = portfolioInstrumentKey(item.selection);
            if (item.instrument) instruments[identity] = item.instrument;
            else if (item.error) errors[identity] = item.error;
          }
        }
        if (!controller.signal.aborted) setResult({ key, instruments, errors, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, instruments: {}, errors: {},
          error: error instanceof Error ? error.message : "Unable to resolve live portfolio prices." });
      }
    }
    void resolve();
    return () => controller.abort();
  }, [key, onSessionExpired]);

  const current = result?.key === key ? result : null;
  const live = useInstrumentPrices(Object.values(current?.instruments ?? {}), true, onSessionExpired);
  return {
    ...live, instruments: current?.instruments ?? {}, errors: current?.errors ?? {},
    error: current?.error || live.error, loading: unique.length > 0 && !current,
    reconnect: () => setRevision(value => value + 1),
  };
}
