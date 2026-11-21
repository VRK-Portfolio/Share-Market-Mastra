"use client";

import { useEffect, useRef, useState } from "react";
import { observeVerdict, verdictDurationLabel, verdictObservationSchema } from "../../lib/market/verdict-duration";
import type { TimedDecision, VerdictObservation } from "../../lib/market/verdict-duration";

type View = { context: string; decision: TimedDecision | null; record: VerdictObservation | null; active: boolean; warning: string | null };
type Runtime = { record: VerdictObservation | null; continuous: boolean; warning: string | null };
const at = (time: number) => new Date(time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

export function VerdictDuration({ kind, context, decision }: {
  kind: "technical" | "option"; context: string; decision: TimedDecision | null;
}) {
  const runtimeRef = useRef<Runtime | null>(null);
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    const storageKey = `terminal-verdict-duration-v1:${kind}`;
    if (!runtimeRef.current) {
      let record: VerdictObservation | null = null;
      let warning: string | null = null;
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved !== null) record = verdictObservationSchema.parse(JSON.parse(saved));
        if (record && record.lastObservedAt > Date.now()) throw new Error("Saved verdict timing is ahead of the device clock.");
      } catch {
        record = null;
        warning = "Saved timer history could not be read or validated. Current-session timing continues; reload history may be unavailable.";
      }
      runtimeRef.current = { record, continuous: false, warning };
    }
    const runtime = runtimeRef.current;
    function update() {
      const active = decision !== null && document.visibilityState === "visible";
      if (active) {
        try {
          runtime.record = observeVerdict(runtime.record, context, decision, Date.now(), runtime.continuous);
        } catch (error) {
          runtime.warning = error instanceof Error ? error.message : "Verdict timer history was invalid; timing restarted.";
          runtime.record = observeVerdict(null, context, decision, Date.now(), false);
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(runtime.record));
        } catch {
          runtime.warning = "Timer history could not be saved in this browser. Current-session timing continues, but it may not survive reload.";
        }
      }
      runtime.continuous = active;
      setView({ context, decision, record: runtime.record?.context === context ? runtime.record : null, active, warning: runtime.warning });
    }
    const first = setTimeout(update, 0);
    const interval = setInterval(update, 1000);
    const pause = () => { runtime.continuous = false; };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", update);
    return () => {
      clearTimeout(first); clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", update);
    };
  }, [kind, context, decision]);

  const current = view?.context === context && view.decision === decision ? view : null;
  const record = current?.record;
  const gap = record?.lastGap;
  const label = kind === "technical" ? "Technical signal duration" : "Option-aware verdict duration";
  return <div className="mt-2 min-w-0 break-words text-[11px] text-muted" role="group" aria-label={label}>
    {!current ? <p>Loading observed verdict duration...</p> : !current.active ? <>
      <p>Timing paused: verdict data is unavailable or the page is hidden.</p>
      {record && <p className="mt-1">Last observed {record.decision} at {at(record.lastObservedAt)} IST · {verdictDurationLabel(record.observedMs)} observed.</p>}
    </> : record && <>
      <p className="font-medium text-foreground">{kind === "technical" ? "Signal " : ""}{record.decision} {gap ? "observed for" : "for"} {verdictDurationLabel(record.observedMs)}{gap ? " total (not continuous)" : ""}</p>
      <p className="mt-1">First observed <time dateTime={new Date(record.firstObservedAt).toISOString()}>{at(record.firstObservedAt)} IST</time>.</p>
      {gap && <details className="mt-1">
        <summary className="cursor-pointer text-warning">Unmonitored gap excluded · continuity unknown</summary>
        <p className="mt-1">Last observation before the latest gap: {gap.previousDecision} at {at(gap.from)} IST. Resumed observing {record.decision} at {at(gap.to)} IST. Gap: {verdictDurationLabel(gap.to - gap.from)}. Unmonitored time is not counted.</p>
        {gap.previousDecision !== record.decision && <p className="mt-1">The verdict changed while unmonitored; its exact transition time is unknown. This timer starts at the new observation.</p>}
      </details>}
    </>}
    {current?.warning && <p role="status" className="mt-1 text-warning">{current.warning}</p>}
  </div>;
}
