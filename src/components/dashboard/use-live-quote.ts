"use client";

import { useEffect, useState } from "react";
import { LiveEventDecoder } from "../../lib/groww/live-schemas";
import type { LiveTick } from "../../lib/groww/live-schemas";
import type { MarketAnalysis } from "../../lib/market/types";

export function useLiveQuote(data: MarketAnalysis | null, onSessionExpired: () => void) {
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<{
    key: string; connected: boolean; tick?: LiveTick; error?: string; observedAt?: number;
  } | null>(null);
  const symbol = data?.symbol;
  const exchange = data?.exchange;
  const segment = data?.segment ?? "CASH";
  const key = JSON.stringify([symbol, exchange, segment, revision]);
  const current = result?.key === key ? result : null;

  useEffect(() => {
    if (!symbol || !exchange) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ symbol, exchange, segment });
    async function connect() {
      setResult({ key, connected: false });
      try {
        const response = await fetch(`/api/groww/stream?${query}`, { signal: controller.signal, cache: "no-store" });
        if (controller.signal.aborted) return;
        if (response.status === 401) { controller.abort(); onSessionExpired(); return; }
        if (!response.ok) {
          const body: unknown = await response.json();
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : "Unable to connect to Groww streaming.");
        }
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          throw new Error("The Groww price stream is unavailable.");
        }
        const reader = response.body.getReader();
        const text = new TextDecoder();
        const decoder = new LiveEventDecoder();
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("The Groww stream disconnected. Reconnect the feed.");
            if (controller.signal.aborted) return;
            for (const event of decoder.push(text.decode(chunk.value, { stream: true }))) {
              if (event.symbol !== symbol || event.exchange !== exchange || event.segment !== segment) {
                throw new Error("The Groww feed did not match your selected instrument.");
              }
              if (event.type === "error") {
                if (event.code === 401) { controller.abort(); onSessionExpired(); return; }
                throw new Error(event.error);
              }
              if (event.type === "connected") setResult({ key, connected: true });
              else setResult((previous) => previous?.key === key && previous.tick && previous.tick.tradeTime > event.tradeTime
                ? previous : { key, connected: true, tick: event, observedAt: Date.now() });
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        if (!controller.signal.aborted) setResult((previous) => ({
          ...(previous?.key === key ? previous : { key }), connected: false,
          error: error instanceof Error ? error.message : "The Groww price stream failed.",
        }));
        controller.abort();
      }
    }
    const timeout = setTimeout(() => { void connect(); }, 0);
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => { clearTimeout(timeout); clearInterval(clock); controller.abort(); };
  }, [symbol, exchange, segment, key, onSessionExpired]);

  const ageAtReceipt = current?.tick ? Date.parse(current.tick.receivedAt) - current.tick.tradeTime : Infinity;
  const fresh = !!current?.connected && ageAtReceipt >= -5000 &&
    ageAtReceipt + Math.max(0, now - (current.observedAt ?? now)) <= 60_000;
  return { ...current, fresh, reconnect: () => setRevision((value) => value + 1) };
}
