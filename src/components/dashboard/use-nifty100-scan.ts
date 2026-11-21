"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Nifty100Stock } from "../../lib/groww/nifty100-schemas";
import { loadStockScreen, requiredScreenerClose, screenerHistoryReady, StockScanError } from "../../lib/market/stock-screener";
import type { ScreenerMode, StockScreenResult } from "../../lib/market/stock-screener";
import { screenerCache } from "../../lib/market/screener-cache";

export function useNifty100Scan(stocks: Nifty100Stock[], onSessionExpired: () => void) {
  const jobs = useMemo(() => stocks.flatMap(stock => (["MIS", "CNC"] as const).map(mode => ({ stock, symbol: stock.symbol, mode }))), [stocks]);
  const saved = useRef<Record<string, StockScreenResult>>({});
  const attempted = useRef<Record<string, number>>({});
  const cacheEnabled = useRef(true);
  const [results, setResults] = useState<Record<string, StockScreenResult>>({});
  const [hydrated, setHydrated] = useState(false);
  const [cacheNotice, setCacheNotice] = useState("");
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState<{ symbol: string; mode: ScreenerMode } | null>(null);
  const [notice, setNotice] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const historyEpoch = `${requiredScreenerClose("MIS", now)}:${requiredScreenerClose("CNC", now)}`;
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const cached = await screenerCache.baselines(stocks, Date.now());
        if (!active) return;
        saved.current = cached.results;
        setResults(cached.results);
        if (cached.invalid) setCacheNotice(`${cached.invalid} invalid cached histories were rejected rather than reused.`);
      } catch (error) {
        if (!active) return;
        cacheEnabled.current = false;
        setCacheNotice(`Browser history cache unavailable: ${error instanceof Error ? error.message : "Storage failed."} History must load for this visit.`);
      }
      if (active) setHydrated(true);
    }
    void restore();
    return () => { active = false; };
  }, [stocks]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (paused || !hydrated) return;
    const controller = new AbortController();
    async function run() {
      let consecutiveFailures = 0;
      try {
        for (const job of jobs) {
          if (controller.signal.aborted) return;
          const key = `${job.symbol}:${job.mode}`;
          const previous = saved.current[key];
          const boundary = requiredScreenerClose(job.mode, Date.now());
          if (previous?.data && screenerHistoryReady(previous.data, job.mode, Date.now()) ||
            attempted.current[key] === boundary) continue;
          setActive(job);
          let result: StockScreenResult;
          let shouldStop = false;
          try {
            await pace(controller.signal);
            attempted.current[key] = boundary;
            const data = await loadStockScreen(job.symbol, job.mode,
              AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
            if (controller.signal.aborted) { delete attempted.current[key]; return; }
            result = { data };
            consecutiveFailures = 0;
          } catch (error) {
            if (controller.signal.aborted) { delete attempted.current[key]; return; }
            if (error instanceof StockScanError && error.status === 401) { onSessionExpired(); return; }
            if (error instanceof StockScanError && error.status === 429) {
              delete attempted.current[key];
              setRetryAt(Date.now() + error.retryAfterSeconds * 1000);
              setNotice(`Groww rate limit: ${error.message} This job remains pending. Resume after the cooldown.`);
              setPaused(true);
              return;
            }
            const message = error instanceof Error ? error.message : "Stock analysis could not be loaded.";
            result = previous?.data ? { ...previous, refreshError: message } : { error: message };
            consecutiveFailures++;
            if ((error instanceof StockScanError && error.status === 403) || consecutiveFailures >= 3) {
              shouldStop = true;
              setNotice(error instanceof StockScanError && error.status === 403
                ? "Groww denied market-data access. Scan paused; verify your subscription before retrying."
                : "Three consecutive analyses failed. Scan paused to avoid repeatedly calling a failing service.");
              setPaused(true);
            }
          }
          if (controller.signal.aborted) return;
          saved.current = { ...saved.current, [key]: result };
          setResults(saved.current);
          if (result.data && !result.refreshError && cacheEnabled.current) {
            try { await screenerCache.save(job.stock, job.mode, result.data); }
            catch (error) {
              cacheEnabled.current = false;
              if (!controller.signal.aborted) setCacheNotice(`Browser history could not be saved: ${error instanceof Error ? error.message : "Storage failed."} Results remain in memory only.`);
            }
          }
          if (shouldStop) return;
        }
      } finally {
        if (!controller.signal.aborted) setActive(null);
      }
    }
    const timer = setTimeout(() => { void run(); }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [jobs, onSessionExpired, paused, revision, hydrated, historyEpoch]);

  function resume() {
    if (Date.now() < retryAt) return;
    setNotice(""); setPaused(false); setRevision(value => value + 1);
  }
  function rescan() {
    if (Date.now() < retryAt) return;
    attempted.current = {};
    saved.current = Object.fromEntries(Object.entries(saved.current).flatMap(([key, result]) => {
      if (result.data) return [[key, { data: result.data, fromCache: result.fromCache }]];
      return [];
    }));
    setResults(saved.current); setNotice(""); setRetryAt(0); setPaused(false); setRevision(value => value + 1);
  }
  return {
    results, paused, active, notice, cacheNotice, now, total: jobs.length,
    loading: !hydrated || active !== null && !paused,
    available: Object.values(results).filter(result => result.data).length,
    done: jobs.filter(job => {
      const data = results[`${job.symbol}:${job.mode}`]?.data;
      return data && screenerHistoryReady(data, job.mode, now);
    }).length,
    cooldown: Math.max(0, Math.ceil((retryAt - now) / 1000)),
    pause: () => setPaused(true), resume, rescan,
  };
}

function pace(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1100);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}
