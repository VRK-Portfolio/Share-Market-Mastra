"use client";

import { useEffect, useState } from "react";
import { LiveEventDecoder } from "../../lib/groww/live-schemas";
import type { FeedSelection, LiveTick } from "../../lib/groww/live-schemas";
import { livePriceKey } from "../../lib/market/live-prices";
import type { ObservedPrice } from "../../lib/market/live-prices";

export function useInstrumentPrices(instruments: FeedSelection[], connected: boolean, onSessionExpired: () => void, publishIntervalMs = 0) {
  const [revision, setRevision] = useState(0);
  const selections = [...new Map(instruments.map((item) => [livePriceKey(item), item])).values()]
    .sort((a, b) => livePriceKey(a).localeCompare(livePriceKey(b)));
  const key = JSON.stringify(selections);
  const [result, setResult] = useState<{
    key: string; prices: Record<string, ObservedPrice>; errors: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    if (!connected) return;
    const stocks: FeedSelection[] = JSON.parse(key);
    if (!stocks.length) return;
    const controller = new AbortController();
    const pending: Record<string, ObservedPrice> = {};
    function publish(prices: Record<string, ObservedPrice>) {
      setResult(previous => {
        if (previous?.key !== key) return previous;
        const next = { ...previous.prices };
        for (const [identity, tick] of Object.entries(prices)) {
          if ((next[identity]?.tradeTime ?? 0) <= tick.tradeTime) next[identity] = tick;
        }
        return { ...previous, prices: next };
      });
    }
    const publisher = publishIntervalMs > 0 ? setInterval(() => {
      if (!Object.keys(pending).length) return;
      const batch = { ...pending };
      for (const identity of Object.keys(pending)) delete pending[identity];
      publish(batch);
    }, publishIntervalMs) : undefined;
    async function connect(group: typeof stocks, groupId: string) {
      const identities = new Set(group.map(livePriceKey));
      try {
        const query = new URLSearchParams({ instruments: JSON.stringify(group) });
        const response = await fetch(`/api/groww/stream?${query}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { controller.abort(); onSessionExpired(); return; }
        if (!response.ok) {
          const body: unknown = await response.json();
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error : "Unable to connect live instrument prices.");
        }
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          throw new Error("The live instrument price stream is unavailable.");
        }
        const reader = response.body.getReader();
        const decoder = new LiveEventDecoder();
        const text = new TextDecoder();
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (controller.signal.aborted) return;
            if (chunk.done) throw new Error("Live instrument prices disconnected. Reconnect the price feed.");
            for (const event of decoder.push(text.decode(chunk.value, { stream: true }))) {
              const identity = livePriceKey(event);
              if (!identities.has(identity)) throw new Error("The live price stream returned an unexpected instrument.");
              if (event.type === "error") {
                if (event.code === 401) { controller.abort(); onSessionExpired(); return; }
                throw new Error(event.error);
              }
              if (event.type !== "tick") continue;
              const tick: LiveTick = event;
              const observedAt = Date.now();
              const observed = { ...tick, observedAt };
              if (publishIntervalMs > 0) {
                if ((pending[identity]?.tradeTime ?? 0) <= tick.tradeTime) pending[identity] = observed;
              } else publish({ [identity]: observed });
            }
          }
        } finally {
          try { await reader.cancel(); }
          finally { reader.releaseLock(); }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        for (const identity of identities) delete pending[identity];
        setResult((previous) => previous?.key !== key ? previous : {
          ...previous,
          prices: Object.fromEntries(Object.entries(previous.prices).filter(([identity]) => !identities.has(identity))),
          errors: { ...previous.errors, [groupId]: error instanceof Error ? error.message : "Live instrument prices failed." },
        });
      }
    }
    const timer = setTimeout(() => {
      setResult({ key, prices: {}, errors: {} });
      for (let offset = 0; offset < stocks.length; offset += 50) void connect(stocks.slice(offset, offset + 50), String(offset));
    }, 0);
    return () => { clearTimeout(timer); if (publisher) clearInterval(publisher); controller.abort(); };
  }, [key, connected, onSessionExpired, revision, publishIntervalMs]);

  const current = connected && result?.key === key ? result : null;
  return {
    prices: current?.prices ?? {}, error: Object.values(current?.errors ?? {}).join(" "),
    reconnect: () => setRevision((value) => value + 1),
  };
}
