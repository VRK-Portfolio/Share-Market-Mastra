"use client";

import { useEffect, useRef, useState } from "react";
import { paperEntryContext, paperEntryQualitySchema, paperEntryVerdictLabels } from "../../lib/market/paper-entry-quality";
import type { PaperEntryQuality } from "../../lib/market/paper-entry-quality";
import { paperSegment } from "../../lib/market/paper-instruments";
import { PaperTradingError, positionKey } from "../../lib/market/paper-trading";
import type { PaperAccount, PaperPosition } from "../../lib/market/paper-trading";
import { money } from "./format";

const time = (at: number) => `${new Date(at).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
})} IST`;

export function PaperEntryQualityPanel({ account, position, connected, onSessionExpired }: {
  account: PaperAccount; position: PaperPosition; connected: boolean; onSessionExpired: () => void;
}) {
  let context: ReturnType<typeof paperEntryContext>;
  try { context = paperEntryContext(account, position); }
  catch (error) {
    if (!(error instanceof PaperTradingError)) throw error;
    return <p role="alert" className="mt-3 text-xs text-negative">{error.message}</p>;
  }
  return <EntryCheck key={context.entry.id} {...context} connected={connected} onSessionExpired={onSessionExpired} />;
}

function EntryCheck({ entry, additions, connected, onSessionExpired }: ReturnType<typeof paperEntryContext> & {
  connected: boolean; onSessionExpired: () => void;
}) {
  const [report, setReport] = useState<PaperEntryQuality | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function checkEntry() {
    if (!connected || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(""); setReport(null);
    try {
      const query = new URLSearchParams({
        symbol: entry.symbol, exchange: entry.exchange, product: entry.product,
        segment: paperSegment(entry), entryId: entry.id,
      });
      const response = await fetch(`/api/groww/paper/entry-quality?${query}`, {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onSessionExpired(); setError("Reconnect Groww to check entry history."); return; }
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error : "Historical entry assessment failed. Please retry.");
      const verified = paperEntryQualitySchema.parse(body);
      if (verified.entryId !== entry.id || verified.entryAt !== entry.at || verified.entryPrice !== entry.price ||
        verified.entrySide !== entry.side || positionKey(verified) !== positionKey(entry) ||
        verified.intraday.interval !== "15minute" || verified.daily.interval !== "1day") {
        throw new Error("Historical assessment does not match this opening trade. Refresh the paper account.");
      }
      if (!controller.signal.aborted) setReport(verified);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Entry history could not be loaded.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="mt-3 rounded-lg border border-line p-3 text-xs" aria-label={`${entry.symbol} historical entry quality`}>
    <h5 className="font-semibold">Was my entry price well supported?</h5>
    <p className="mt-1 leading-relaxed text-muted">
      First {entry.side === "BUY" ? "buy" : "short"}: {money(entry.price / 100)} · {time(entry.at)}.
      {additions > 0 && " Later additions and the current average entry are not graded here."}
    </p>
    <p className="mt-1 text-[11px] leading-relaxed text-muted">Compare 14 calendar days of 15-minute history and 90 calendar days of daily history, using only candles completed before entry.</p>
    <button type="button" className="secondary-button mt-3 text-xs" disabled={!connected || busy} onClick={() => { void checkEntry(); }}>
      {busy ? "Checking historical entry..." : report ? "Recheck entry history" : "Check entry with history"}
    </button>
    {!connected && <p className="mt-2 text-warning">Connect Groww to load historical data.</p>}
    {error && <p role="alert" className="mt-2 text-negative">{error}</p>}
    {report && <div className="mt-3">
      <p className={`font-semibold ${report.verdict === "FAVOURABLE" ? "text-positive" : "text-warning"}`}>
        {report.headline}
      </p>
      <p className="mt-1 leading-relaxed text-muted">{report.summary}</p>
      <p className="mt-1 text-[11px] text-muted">Main timeframe for {entry.product}: {report.primaryInterval === "15minute" ? "15 minute" : "daily"}. {report.coverage !== "FULL" && "Partial evidence is not a confirmed entry verdict."}</p>
      {([["Intraday · 15 minute", report.intraday], ["Daily · 3 months", report.daily]] as const).map(([label, frame]) =>
        <div key={frame.interval} className="mt-3 border-t border-line pt-3">
          <p className="font-medium">{label}: {paperEntryVerdictLabels[frame.verdict]}</p>
          <p className="mt-1 text-[11px] text-muted">{frame.count} completed pre-entry candles · {frame.requiredCount} required</p>
          <ul className="mt-1 list-inside list-disc space-y-1 text-muted">{frame.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <details className="mt-2">
            <summary className="cursor-pointer text-accent">Historical evidence ({frame.count} completed candles)</summary>
            <p className="mt-2 text-muted">Last candle closed: {frame.lastClosedAt === null ? "Unavailable" : time(frame.lastClosedAt)}.</p>
            <p className="mt-1 text-muted">Expected through: {time(frame.expectedClosedAt)}.</p>
            {frame.metrics && <dl className="paper-metrics mt-2">
              <div><dt>EMA20 / EMA50</dt><dd>{money(frame.metrics.ema20)} / {money(frame.metrics.ema50)}</dd></div>
              <div><dt>RSI14 / ATR14</dt><dd>{frame.metrics.rsi.toFixed(1)} / {money(frame.metrics.atr)}</dd></div>
              <div><dt>20-bar low / high</dt><dd>{money(frame.metrics.rangeLow)} / {money(frame.metrics.rangeHigh)}</dd></div>
            </dl>}
            {!!frame.candles.length && <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-[10px]">
                <caption className="mb-1 text-left text-muted">Last 5 completed pre-entry candles. Times identify candle starts.</caption>
                <thead><tr>{["Time (IST)", "Open", "High", "Low", "Close"].map(name => <th key={name} scope="col" className="whitespace-nowrap p-1 font-medium">{name}</th>)}</tr></thead>
                <tbody>{frame.candles.map(bar => <tr key={bar.time} className="border-t border-line">
                  <td className="whitespace-nowrap p-1">{time(bar.time * 1000)}</td>
                  {[bar.open, bar.high, bar.low, bar.close].map((price, index) => <td key={index} className="whitespace-nowrap p-1 font-mono">{money(price)}</td>)}
                </tr>)}</tbody>
              </table>
            </div>}
          </details>
        </div>)}
      <p className="mt-3 text-[10px] leading-relaxed text-muted">Historical context, not a correct/incorrect guarantee or an exit signal. Range edges are support/resistance references, not confirmed turning points. F&amp;O checks use the exact contract price/premium, not the underlying trend. History may be adjusted/revised by the provider.</p>
    </div>}
  </section>;
}
