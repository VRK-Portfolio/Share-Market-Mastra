"use client";

import { money } from "./format";
import type { ScenarioAlertController } from "./use-scenario-alerts";

const istTime = (time: string) => new Date(time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export function ScenarioAlerts({ controller }: { controller: ScenarioAlertController }) {
  const { alerts, ready, error, message } = controller;
  const pending = alerts.filter((alert) => !alert.completion);
  const notifications = alerts.filter((alert) => alert.completion && !alert.acknowledged);
  return <>
    {error && <div role="alert" className="rounded-xl border border-negative/25 bg-negative/5 p-3 text-xs text-negative">
      <p>{error}</p>
      {!ready && <button type="button" className="secondary-button mt-2 text-xs" onClick={controller.resetInvalidStorage}>Reset saved alert storage</button>}
    </div>}
    {message && <p role="status" className="text-xs text-accent">{message}</p>}
    <details className="workspace-details">
      <summary>Saved scenario alerts · {pending.length} pending · {alerts.length - pending.length} completed</summary>
      <p className="mt-3 text-xs text-muted">Saved bounds and deadlines do not move with new estimates. Bullish alerts use the upper bound; bearish use the lower bound; neutral alerts use either. Price checks use only the selected instrument&apos;s fresh live ticks after saving. Deadlines cover every saved stock while the dashboard is open, even when disconnected.</p>
      <p className="mt-2 text-xs text-muted">The first observed price hit or deadline completes each horizon once; time wins ties. Closed or suspended browsers cannot alert immediately. Overdue time notifications appear when the dashboard resumes. No extra market-data requests, model calls or orders.</p>
      {ready && !controller.crossTabSafe && <p className="mt-2 text-xs text-warning">This browser cannot coordinate alert updates across tabs. Keep one dashboard tab open to avoid simultaneous notifications.</p>}
      {!ready && !error && <p role="status" className="mt-3 text-xs text-muted">Loading saved alerts...</p>}
      {ready && !alerts.length && <p className="mt-3 text-xs text-muted">No saved alerts. Select a stock and use Save scenario alerts in its 15-30 minute scenarios.</p>}
      {!!alerts.length && <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">
        {alerts.map((alert) => <li key={alert.id} className="rounded-lg border border-line p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">{alert.symbol} / {alert.exchange} / {alert.segment} · {alert.minutes} minutes · {alert.completion?.reason ?? "PENDING"}</p>
            <button type="button" className="secondary-button px-2 py-1 text-xs" disabled={!ready} onClick={() => controller.remove(alert.id)} aria-label={`${alert.completion ? "Delete" : "Cancel"} ${alert.symbol} ${alert.minutes}-minute alert`}>{alert.completion ? "Delete" : "Cancel"}</button>
          </div>
          <p className="mt-2">{alert.bias} · Range {money(alert.lowerPrice)} - {money(alert.upperPrice)} · Reference {money(alert.referencePrice)} · ATR {money(alert.atr)}</p>
          <p className="mt-1 text-muted">Deadline {istTime(alert.endsAt)} IST · Snapshot {istTime(alert.snapshotAt)} IST · Saved {istTime(alert.createdAt)} IST</p>
          {alert.growwSymbol && <p className="mt-1 break-all text-muted">Contract: {alert.growwSymbol}</p>}
          {alert.completion && <p className="mt-1 text-accent">Completed {istTime(alert.completion.completedAt)} IST{alert.completion.reason === "PRICE" ? ` · ${alert.completion.boundary} bound reached at observed price ${money(alert.completion.price)}` : " · Deadline reached; no earlier qualifying price observation was recorded."}</p>}
        </li>)}
      </ul>}
      {!!alerts.length && <button type="button" className="secondary-button mt-3 text-xs" disabled={!ready} onClick={controller.clear}>Clear saved alerts</button>}
    </details>
    {!!notifications.length && <aside className="fixed bottom-4 right-4 z-50 max-h-[60vh] w-[calc(100%-2rem)] max-w-sm space-y-2 overflow-y-auto" aria-label="Scenario alert notifications">
      <div role="status" aria-live="polite" aria-atomic="false" className="space-y-2">
        {notifications.map((alert) => <section key={alert.id} className="rounded-xl border border-accent/40 bg-panel p-4 shadow-xl">
          <h2 className="text-sm font-semibold">{alert.symbol} · {alert.minutes}-minute alert</h2>
          <p className="mt-2 text-xs">{alert.completion?.reason === "PRICE"
            ? `${alert.completion.boundary} target reached: ${money(alert.completion.price)} (target ${money(alert.completion.boundary === "UPPER" ? alert.upperPrice : alert.lowerPrice)}).`
            : `Time reached: ${istTime(alert.endsAt)} IST. No earlier qualifying price hit was observed.`}</p>
          <p className="mt-1 text-[11px] text-muted">{alert.exchange} / {alert.segment} · Snapshot {istTime(alert.snapshotAt)} IST</p>
          <button type="button" className="secondary-button mt-3 px-3 py-1.5 text-xs" disabled={!ready} onClick={() => controller.dismiss(alert.id)} aria-label={`Dismiss ${alert.symbol} ${alert.minutes}-minute alert`}>Dismiss</button>
        </section>)}
      </div>
    </aside>}
  </>;
}
