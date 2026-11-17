"use client";

import { useState } from "react";
import { paperOrderRequestSchema, paperProtectionSchema } from "../../lib/market/paper-order-schemas";
import { paperIntradayLeverage, paperQuoteError, paperRequiredMargin } from "../../lib/market/paper-trading";
import type { PaperInstruction, PaperQuote } from "../../lib/market/paper-trading";
import { CashStockPicker } from "./cash-stock-picker";
import { money } from "./format";

export type PaperSelection = { symbol: string; exchange: "NSE" | "BSE"; product: "MIS" | "CNC" };
export function PaperOrderForm({ selection, onSelection, quote, unavailable, disabled, submit, onSessionExpired }: {
  selection: PaperSelection; onSelection: (value: PaperSelection) => void; quote: PaperQuote | null;
  unavailable: string | null; disabled: boolean; submit: (instruction: PaperInstruction) => Promise<boolean>;
  onSessionExpired: () => void;
}) {
  const [kind, setKind] = useState("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limit, setLimit] = useState("");
  const [trigger, setTrigger] = useState("");
  const [direction, setDirection] = useState("UP");
  const [protect, setProtect] = useState(false);
  const [target, setTarget] = useState("");
  const [stop, setStop] = useState("");
  const [error, setError] = useState("");
  const units = Number(quantity);
  const referencePrice = kind === "MARKET" ? quote?.price : kind === "BRACKET" ? undefined : Number(limit);
  const entryValue = referencePrice === undefined ? NaN : Math.round(referencePrice * 100) * units;
  const hasEstimate = Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(entryValue) && entryValue > 0;
  async function place(side: "BUY" | "SELL") {
    setError("");
    const units = Number(quantity);
    if (!selection.symbol || !Number.isSafeInteger(units) || units < 1) {
      setError("Choose a stock and enter a positive whole-share quantity."); return;
    }
    let instruction: PaperInstruction;
    if (kind === "MARKET") {
      const problem = paperQuoteError(quote);
      if (!quote || problem) { setError(problem ?? "Wait for a live price."); return; }
      const protection = protect ? paperProtectionSchema.safeParse({ targetPrice: Number(target), stopPrice: Number(stop) }) : null;
      if (protection && !protection.success) { setError("Enter valid target and stop-loss prices."); return; }
      instruction = { type: "TRADE", ...selection, side, quantity: units,
        ...(quote.quoteProof ? { quoteProof: quote.quoteProof } : {}),
        ...(protection?.success ? { protection: protection.data } : {}) };
    } else {
      const order = paperOrderRequestSchema.safeParse({
        ...selection, side, quantity: units, kind,
        ...(kind === "BRACKET" ? { targetPrice: Number(target), stopPrice: Number(stop) }
          : { limitPrice: Number(limit), ...(protect ? { protection: { targetPrice: Number(target), stopPrice: Number(stop) } } : {}) }),
        ...(kind === "GTT" ? { triggerPrice: Number(trigger), triggerDirection: direction } : {}),
      });
      if (!order.success) { setError("Enter valid positive order prices, target and stop-loss where requested."); return; }
      if (kind === "GTT" && selection.product !== "CNC") { setError("Choose CNC delivery for a persistent GTT order."); return; }
      instruction = { type: "PLACE", order: order.data };
    }
    if (!window.confirm(`PAPER ONLY: ${kind} ${side} ${units} ${selection.symbol} (${selection.exchange}, ${selection.product})?\nPending entries reserve virtual cash. Triggers execute only while the terminal is open and connected. Limit fills require the limit or better; market/target/stop fills use the observed price, not a guaranteed trigger price. No real broker order.`)) return;
    await submit(instruction);
  }
  const priceField = (label: string, value: string, change: (value: string) => void) =>
    <label className="field-label">{label}<input className="field mt-1 w-full" aria-label={label} type="number" min="0.01" step="0.01" required
      value={value} onChange={(event) => change(event.target.value)} /></label>;
  return <form className="paper-order-form" aria-label="Paper order entry"
    onSubmit={(event) => { event.preventDefault(); void place("BUY"); }}>
    <h3 className="text-sm font-semibold">Place a paper order</h3>
    <p className="mt-1 text-xs text-muted">Choose a stock, set your quantity and practice a trade.</p>
    <div className="paper-form-grid mt-4">
      <div className="col-span-2 [&>.field-label]:min-w-0 [&>.field-label]:max-w-none">
      <CashStockPicker symbol={selection.symbol} exchange={selection.exchange}
        onSelect={(symbol) => onSelection({ ...selection, symbol })} onSessionExpired={onSessionExpired} />
      </div>
      <label className="field-label">Exchange<select aria-label="Paper exchange" className="field mt-1 w-full" value={selection.exchange}
        onChange={(event) => onSelection({ ...selection, exchange: event.target.value === "BSE" ? "BSE" : "NSE", symbol: "" })}>
        <option>NSE</option><option>BSE</option></select></label>
      <label className="field-label">Holding period<select aria-label="Paper product" className="field mt-1 w-full" value={selection.product}
        onChange={(event) => onSelection({ ...selection, product: event.target.value === "CNC" ? "CNC" : "MIS" })}>
        <option value="MIS">Intraday (MIS)</option><option value="CNC">Carry-forward (CNC)</option></select></label>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2.5 text-xs" role="status">
      <span className="text-muted">{selection.symbol ? `${selection.symbol} · ${selection.product === "MIS" ? "Intraday" : "Carry-forward"}` : "Choose a stock to see its live price"}</span>
      {selection.symbol && <span className="font-mono font-medium">{quote ? money(quote.price) : "Waiting for a fresh tick"}</span>}
    </div>
    <div className="paper-form-grid mt-4">
      <label className="field-label col-span-2">Order type<select aria-label="Paper order type" className="field mt-1 w-full" value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="MARKET">Market</option><option value="LIMIT">Limit (day)</option><option value="GTT">GTT trigger + limit (CNC)</option>
        <option value="BRACKET">Target + stop-loss exit</option></select></label>
      <p className="-mt-1 col-span-2 text-[11px] leading-relaxed text-muted">
        {kind === "MARKET" ? "Uses a fresh live price. Your final simulated fill may differ."
          : kind === "LIMIT" ? "Fills at your limit price or better, while connected."
            : kind === "GTT" ? "CNC only. Saved trigger + limit; runs while this terminal is open and connected."
              : "Protect an existing position: SELL exits a long; BUY covers a short."}
      </p>
      <label className="field-label">Number of shares<input id="paper-quantity" aria-label="Paper quantity" className="field mt-1 w-full" type="number"
        min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      {kind !== "MARKET" && kind !== "BRACKET" && priceField("Limit price (INR)", limit, setLimit)}
      {kind === "GTT" && <>
        {priceField("GTT trigger (INR)", trigger, setTrigger)}
        <label className="field-label col-span-2">Trigger condition<select className="field mt-1 w-full" value={direction} onChange={(event) => setDirection(event.target.value)}>
          <option value="UP">Price at or above trigger</option><option value="DOWN">Price at or below trigger</option></select></label>
      </>}
      {kind !== "BRACKET" && <label className="col-span-2 flex min-h-10 items-center gap-2 text-xs">
        <input type="checkbox" checked={protect} onChange={(event) => setProtect(event.target.checked)} />Attach target + stop-loss to entry</label>}
      {(protect || kind === "BRACKET") && <>
        {priceField("Target price (INR)", target, setTarget)}
        {priceField("Stop-loss price (INR)", stop, setStop)}
      </>}
    </div>
    {kind !== "BRACKET" && <div className="mt-4 rounded-xl border border-line p-3 text-xs" aria-label="Paper entry margin comparison">
      {hasEstimate ? <dl className="paper-metrics grid-cols-2">
        <div><dt>Selected {selection.product} entry reserve</dt><dd className="text-base text-accent">{money(paperRequiredMargin(selection.product, entryValue) / 100)}</dd></div>
        <div><dt className="text-muted">Full entry value</dt><dd className="mt-1 font-mono">{money(entryValue / 100)}</dd></div>
      </dl> : <p className="text-muted">Your estimated cost appears after you enter a valid quantity and {kind === "MARKET" ? "receive a fresh price" : "limit price"}.</p>}
      <details className="mt-3 text-[11px]">
        <summary className="cursor-pointer text-muted">Compare intraday &amp; delivery costs</summary>
        {hasEstimate && <dl className="paper-metrics mt-3">
          <div><dt>Intraday margin ({paperIntradayLeverage}x / 20%)</dt><dd>{money(paperRequiredMargin("MIS", entryValue) / 100)}</dd></div>
          <div><dt>Carry-forward cost (100%)</dt><dd>{money(entryValue / 100)}</dd></div>
        </dl>}
        <p className="mt-2 leading-relaxed text-muted">The stock price is the same for MIS and CNC on this exchange. New MIS entries use simulated 5x leverage; CNC uses full cash. Exits release saved collateral. This is not verified broker margin.</p>
      </details>
    </div>}
    {(protect || kind === "BRACKET") && <p className="mt-3 text-[11px] leading-relaxed text-muted">Long stop must be below target; the reverse applies to shorts. Attached entry protection covers the resulting position.</p>}
    {unavailable && selection.symbol && <p className="mt-3 text-xs text-warning">{unavailable} Pending GTT placement and cancellation do not require a live fill price.</p>}
    {error && <p role="alert" className="paper-notice mt-3 text-xs text-negative">{error}</p>}
    <div className="sticky bottom-0 -mx-4 mt-4 border-t border-line bg-panel px-4 pb-4 pt-3">
    <div className="grid grid-cols-2 gap-3">
      <button type="submit" className="paper-trade-button border-positive/25 bg-positive/10 text-positive" disabled={disabled || kind === "MARKET" && !!unavailable}>Paper BUY</button>
      <button type="button" className="paper-trade-button border-negative/25 bg-negative/10 text-negative" disabled={disabled || kind === "MARKET" && !!unavailable}
        onClick={(event) => { if (event.currentTarget.form?.reportValidity()) void place("SELL"); }}>Paper SELL</button>
    </div>
    <p className="mt-2 text-center text-[10px] text-muted">Simulated orders only. Nothing is sent to your broker.</p>
    </div>
  </form>;
}
