"use client";

import type { EntryTimingAssessment } from "../../lib/market/entry-timing";

export function EntryTiming({ timing, now }: {
  timing: EntryTimingAssessment; now: number;
}) {
  const met = timing.status === "CONDITIONS_MET";
  return <section className="rounded-xl border border-line bg-inset p-3" aria-label="Stock entry timing">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold">Entry check</h3>
      <span className="font-mono text-[10px] text-muted">{new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST</span>
    </div>
    <p role="status" className={`mt-2 text-xs ${met ? "text-positive" : "text-warning"}`}>{met
      ? `${timing.side} conditions met${timing.provisionalDaily ? " - provisional" : ""}. Recheck price and broker eligibility.`
      : timing.reasons[0]}</p>
    {!met && timing.reasons.length > 1 && <details className="mt-2 text-[11px]">
      <summary className="cursor-pointer text-warning">All entry blockers ({timing.reasons.length})</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">{timing.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </details>}
    {timing.provisionalDaily && <p className="mt-2 text-xs text-warning">Daily candle unfinished: not daily-close confirmation.</p>}
    <details className="mt-3 text-[11px]">
    <summary className="cursor-pointer text-muted">Timing guide · 09:15-15:30 IST</summary>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-line bg-panel p-2">
        <h4 className="text-xs font-semibold">Intraday BUY / short SELL</h4>
        <p className="mt-1 text-[11px]">Regular session: 09:15-15:30 IST. Around 09:30, the first 15-minute candle can be reviewed; this is a planning checkpoint, not a proven best entry time.</p>
        <p className="mt-2 text-[11px] text-muted">Enter only after directional rules agree with a fresh quote and a risk plan. Opening volatility and late entries need extra caution. Leave time to exit before your broker&apos;s MIS cutoff, which can be earlier than 15:30.</p>
      </div>
      <div className="rounded-lg border border-line bg-panel p-2">
        <h4 className="text-xs font-semibold">Carry-forward BUY only</h4>
        <p className="mt-1 text-[11px]">For daily-close confirmation, review the completed 1D candle after 15:30 IST and plan a BUY in a later regular session (09:15-15:30), only if the bullish setup still holds.</p>
        <p className="mt-2 text-[11px] text-muted">Recheck the opening gap and a fresh quote before buying. During the session, today&apos;s daily candle is provisional. No overnight CASH short entry is suggested.</p>
      </div>
    </div>
    <p className="mt-3 text-muted">No universally ideal entry time. Checks update every 5 seconds; require a same-day trade within 60 seconds and, for carry-forward timing, 1D candles. No model calls or orders.</p>
    </details>
    <p className="mt-2 text-[10px] text-muted">Weekday schedule only; holidays &amp; special sessions not verified.</p>
  </section>;
}
