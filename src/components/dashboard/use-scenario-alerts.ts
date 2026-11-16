"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  completeScenarioAlerts, createScenarioAlerts, mergeScenarioAlerts,
  scenarioAlertsStorageKey, updateStoredScenarioAlerts,
} from "../../lib/market/scenario-alerts";
import type { ScenarioAlert, ScenarioPriceObservation } from "../../lib/market/scenario-alerts";
import type { MarketAnalysis } from "../../lib/market/types";
import type { ShortTermScenarios } from "../../lib/market/short-term-scenarios";

export function useScenarioAlerts() {
  const [alerts, setAlerts] = useState<ScenarioAlert[]>([]);
  const [ready, setReady] = useState(false);
  const [crossTabSafe, setCrossTabSafe] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const serialized = useRef("");
  const run = useCallback(async (
    update: (previous: ScenarioAlert[]) => ScenarioAlert[], feedback?: () => string,
  ) => {
    if (feedback && mounted.current) setMessage("");
    try {
      const commit = () => {
        const next = updateStoredScenarioAlerts(localStorage, update);
        if (!mounted.current) return;
        const value = JSON.stringify(next);
        if (serialized.current !== value) { serialized.current = value; setAlerts(next); }
        setReady(true);
        setCrossTabSafe(!!navigator.locks);
        setStorageError("");
        if (feedback) { setActionError(""); setMessage(feedback()); }
      };
      if (navigator.locks) await navigator.locks.request(scenarioAlertsStorageKey, commit);
      else commit();
    } catch (error) {
      if (mounted.current) {
        setReady(false);
        setStorageError(`Scenario alert storage failed: ${error instanceof Error ? error.message : "Browser storage is unavailable."}`);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const check = () => {
      const now = Date.now();
      void run((previous) => completeScenarioAlerts(previous, now));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === scenarioAlertsStorageKey || event.key === null) check();
    };
    check();
    const timer = setInterval(check, 1000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [run]);

  const save = useCallback((analysis: MarketAnalysis, scenarios: ShortTermScenarios) => {
    setMessage("");
    let candidates: ScenarioAlert[];
    try { candidates = createScenarioAlerts(analysis, scenarios); } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save this scenario snapshot.");
      return;
    }
    let count = 0;
    void run((previous) => {
      const next = mergeScenarioAlerts(previous, candidates);
      count = next.length - previous.length;
      return next;
    }, () => count ? `Saved ${count} scenario alert(s) in this browser.` : "These exact scenario snapshots are already saved.");
  }, [run]);
  const observe = useCallback((observation: ScenarioPriceObservation) => {
    const now = Date.now();
    void run((previous) => completeScenarioAlerts(previous, now, observation));
  }, [run]);
  const dismiss = useCallback((id: string) => {
    void run((previous) => previous.map((alert) =>
      alert.id === id && alert.completion ? { ...alert, acknowledged: true } : alert));
  }, [run]);
  const remove = useCallback((id: string) => {
    void run((previous) => previous.filter((alert) => alert.id !== id), () => "Saved scenario alert removed.");
  }, [run]);
  const clear = useCallback(() => {
    if (!window.confirm("Delete all saved scenario alerts and notification history from this browser?")) return;
    void run(() => [], () => "Saved scenario alerts cleared.");
  }, [run]);
  const resetInvalidStorage = useCallback(() => {
    if (!window.confirm("Delete the saved scenario alert storage, including any damaged records?")) return;
    void (async () => {
      try {
        const reset = () => localStorage.removeItem(scenarioAlertsStorageKey);
        if (navigator.locks) await navigator.locks.request(scenarioAlertsStorageKey, reset);
        else reset();
        await run(() => [], () => "Saved scenario alert storage reset.");
      } catch (error) {
        if (mounted.current) setStorageError(`Could not reset scenario alerts: ${error instanceof Error ? error.message : "Browser storage is unavailable."}`);
      }
    })();
  }, [run]);
  return { alerts, ready, crossTabSafe, error: storageError || actionError, message, save, observe, dismiss, remove, clear, resetInvalidStorage };
}

export type ScenarioAlertController = ReturnType<typeof useScenarioAlerts>;
