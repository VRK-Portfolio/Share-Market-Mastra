"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { orderPreviewSchema, orderResultSchema, orderSelectionSchema } from "../../lib/groww/order-schemas";
import type { OrderPreview, OrderResult, OrderSelection } from "../../lib/groww/order-schemas";
import type { StockRecommendation } from "../../lib/market/recommendation";
import { money } from "./format";

type OrderRecommendation = Pick<StockRecommendation, "decision" | "instrument" | "entryPrice" | "referencePrice" |
  "symbol" | "exchange" | "segment" | "mode"> & { snapshotAt: string | null };

export function OrderReview({ recommendation: currentRecommendation, onSessionExpired }: {
  recommendation: OrderRecommendation; onSessionExpired: () => void;
}) {
  const [recommendation, setRecommendation] = useState(currentRecommendation);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [execution, setExecution] = useState<OrderSelection["execution"]>("PAPER");
  const [orderType, setOrderType] = useState<OrderSelection["orderType"]>("LIMIT");
  const [quantity, setQuantity] = useState(String(recommendation.instrument?.lotSize ?? 1));
  const [limitPrice, setLimitPrice] = useState(String(recommendation.entryPrice ?? recommendation.referencePrice));
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [result, setResult] = useState<OrderResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const eligible = currentRecommendation.decision !== "HOLD";
  const canReviewAgain = !!result && (result.execution === "PAPER" && result.state !== "UNKNOWN" ||
    result.state === "NOT_SUBMITTED" || !!result.brokerStatus &&
    ["REJECTED", "FAILED", "CANCELLED", "COMPLETED", "EXECUTED", "DELIVERY_AWAITED"].includes(result.brokerStatus));

  async function jsonRequest(init: RequestInit, query = "") {
    const response = await fetch(`/api/groww/orders${query}`, { ...init, signal: AbortSignal.timeout(45_000), cache: "no-store" });
    const body: unknown = await response.json();
    const retainedSession = body && typeof body === "object" && "sessionExpired" in body && body.sessionExpired === false;
    if (response.status === 401 && !retainedSession) onSessionExpired();
    return { response, body };
  }
  function message(body: unknown) {
    return body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : "Order processing failed. If you confirmed, check Groww by reference before creating another order.";
  }
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setPreview(null); setConfirmed(false);
    try {
      const selection = orderSelectionSchema.safeParse({
        symbol: recommendation.symbol, exchange: recommendation.exchange, segment: recommendation.segment,
        product: recommendation.mode, side: recommendation.decision, execution, orderType,
        quantity: Number(quantity), limitPrice: orderType === "LIMIT" ? Number(limitPrice) : null,
      });
      if (!selection.success) throw new Error("Enter a positive integer quantity and a valid limit price when required.");
      const { response, body } = await jsonRequest({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection.data) });
      if (!response.ok) throw new Error(message(body));
      const value = orderPreviewSchema.parse(body);
      if (JSON.stringify(value.order) !== JSON.stringify(selection.data)) throw new Error("Order review did not match your instructions. No order was sent.");
      setPreview(value);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to review this order."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function submit() {
    if (pending.current || !preview || !confirmed || attempted) return;
    pending.current = true; setBusy(true); setAttempted(true); setError("");
    try {
      const { response, body } = await jsonRequest({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: preview.reference, confirmed: true }) });
      const value = orderResultSchema.safeParse(body);
      if (!value.success || value.data.reference !== preview.reference || value.data.execution !== preview.order.execution) {
        throw new Error(message(body));
      }
      setResult(value.data);
      if (!response.ok && value.data.state === "UNKNOWN") setError("The request did not confirm execution. Check status; never submit a duplicate.");
    } catch (error) {
      setResult({ reference: preview.reference, execution: preview.order.execution, state: "UNKNOWN",
        message: "Confirmation was sent, but its outcome could not be verified. Do not submit another order. Check status or check this reference in Groww." });
      setError(error instanceof Error ? error.message : "Unable to confirm order outcome.");
    } finally { pending.current = false; setBusy(false); }
  }
  async function checkStatus() {
    if (pending.current || !preview) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const { response, body } = await jsonRequest({ method: "GET" }, `?${new URLSearchParams({ reference: preview.reference })}`);
      if (!response.ok) throw new Error(message(body));
      const value = orderResultSchema.parse(body);
      if (value.reference !== preview.reference || value.execution !== preview.order.execution) throw new Error("Order status did not match your reference.");
      setResult(value);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not verify order status. Check Groww; do not resubmit."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <div className="mt-5 rounded-xl border border-line bg-inset p-4">
    <h3 className="text-xs font-semibold">Order actions</h3>
    <p className="mt-2 text-xs text-muted">Analysis levels are conditional, not instructions to trade. Review an entry/exit order yourself. Targets, stop-loss and GTT are not submitted or linked. MARKET orders have no price guarantee.</p>
    <button type="button" className="secondary-button mt-3 text-xs" disabled={!eligible && !preview}
      onClick={() => {
        if (!preview && !attempted) {
          setRecommendation(currentRecommendation);
          setLimitPrice(String(currentRecommendation.entryPrice ?? currentRecommendation.referencePrice));
        }
        dialog.current?.showModal();
      }}>Review order / paper trade</button>
    {!eligible && <p className="mt-2 text-xs text-muted">HOLD has no new actionable order. Refresh market data or run a new analysis before reviewing a trade.</p>}
    {preview && <p className="mt-2 break-all font-mono text-xs">Order reference: {preview.reference} · {preview.order.execution}{result ? ` · ${result.brokerStatus ?? result.state}` : ""}</p>}
    <dialog ref={dialog} aria-labelledby="order-review-title"
      className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-panel p-6 text-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <h2 id="order-review-title" className="text-lg font-semibold">Review {recommendation.decision} order</h2>
      <p className="mt-2 text-sm">{recommendation.symbol} · {recommendation.exchange} · {recommendation.segment} · {recommendation.mode}</p>
      <p className="mt-2 text-xs text-muted">Analysis reference {money(recommendation.referencePrice)} from {recommendation.snapshotAt ? new Date(recommendation.snapshotAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "an unavailable snapshot timestamp"} IST. Review fetches a new quote and instrument metadata. This is a single DAY-valid order, not a bracket order.</p>
      <form onSubmit={review} className="mt-4 space-y-3">
        <fieldset disabled={busy || !!preview || attempted} className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">Execution<select aria-label="Order execution" className="field mt-1 w-full" value={execution} onChange={(event) => setExecution(event.target.value === "LIVE" ? "LIVE" : "PAPER")}><option value="PAPER">Paper trading (no real order)</option><option value="LIVE">Real Groww order</option></select></label>
          <label className="field-label">Order type<select aria-label="Order type" className="field mt-1 w-full" value={orderType} onChange={(event) => setOrderType(event.target.value === "MARKET" ? "MARKET" : "LIMIT")}><option value="LIMIT">LIMIT</option><option value="MARKET">MARKET</option></select></label>
          <label className="field-label">Quantity (units)<input aria-label="Order quantity" className="field mt-1 w-full" type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          {orderType === "LIMIT" && <label className="field-label">Limit price (INR)<input aria-label="Order limit price" className="field mt-1 w-full" type="number" min="0.000001" step="any" required value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} /></label>}
        </fieldset>
        {!preview && !attempted && <button type="submit" className="secondary-button text-sm" disabled={busy}>{busy ? "Reviewing..." : "Get order review"}</button>}
      </form>
      {preview && <div className="mt-4 rounded-xl border border-line p-4 text-sm">
        <p className={preview.order.execution === "LIVE" ? "font-semibold text-negative" : "font-semibold text-accent"}>{preview.order.execution === "LIVE" ? "REAL MONEY ORDER" : "PAPER SIMULATION ONLY"}</p>
        <p className="mt-2">{preview.order.side} {preview.order.quantity} units · {preview.order.orderType} · {preview.order.product} · DAY</p>
        <p className="mt-2">Lot size {preview.instrument.lotSize} · Tick size {preview.instrument.tickSize}{preview.instrument.expiry ? ` · Expiry ${preview.instrument.expiry}` : ""}</p>
        <p className="mt-2">Quote {money(preview.quotePrice)} · {preview.order.limitPrice !== null ? `Limit ${money(preview.order.limitPrice)}` : "Market execution price is not guaranteed"}</p>
        <p className="mt-2">Estimated order value {money(preview.estimatedValue)} (not required margin; excludes fees/slippage).</p>
        <p className="mt-2 text-xs text-muted">Review expires {new Date(preview.expiresAt).toLocaleTimeString("en-IN")} · Reference {preview.reference}. Save this reference before confirming.</p>
        <p className="mt-2 text-xs text-muted">Broker eligibility, funds, market hours and existing pending orders must be checked. Option/delivery SELL is exit-only and requires verified long inventory. Paper exits are not supported; paper LIMIT orders have no fill engine. Manage all real exits and cancellations in Groww.</p>
        {!attempted && <>
          <label className="mt-4 flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />{preview.order.execution === "LIVE"
            ? "I reviewed the symbol, side, product, quantity and price. I authorize this real order and understand that no protective exit order is included."
            : "I understand this is a paper simulation, not a real order or a broker fill."}</label>
          <div className="mt-3 flex flex-wrap gap-3"><button type="button" className="primary-button text-sm" disabled={busy || !confirmed} onClick={() => { void submit(); }}>{busy ? "Submitting..." : preview.order.execution === "LIVE" ? "Confirm real order" : "Confirm paper trade"}</button>
            <button type="button" className="secondary-button text-sm" disabled={busy} onClick={() => { setPreview(null); setConfirmed(false); }}>Edit order</button></div>
        </>}
      </div>}
      {result && <div role="status" className="mt-4 rounded-xl border border-line p-4 text-sm"><p className="font-semibold">{result.execution} · {result.brokerStatus ?? result.state}</p><p className="mt-2">{result.message}</p>{result.brokerOrderId && <p className="mt-2 break-all font-mono text-xs">Groww order: {result.brokerOrderId}</p>}{result.simulatedPrice && <p className="mt-2">Simulated fill: {money(result.simulatedPrice)}</p>}</div>}
      {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
      {canReviewAgain && <button type="button" className="secondary-button mt-4 text-sm" disabled={busy || !eligible} onClick={() => {
        setPreview(null); setResult(null); setAttempted(false); setConfirmed(false); setError(""); setExecution("PAPER");
        setRecommendation(currentRecommendation);
        setLimitPrice(String(currentRecommendation.entryPrice ?? currentRecommendation.referencePrice));
      }}>Start new order review</button>}
      <div className="mt-4 flex justify-end gap-3">{attempted && <button type="button" className="secondary-button text-sm" disabled={busy} onClick={() => { void checkStatus(); }}>Check order status</button>}<button type="button" className="secondary-button text-sm" disabled={busy} onClick={() => dialog.current?.close()}>Close</button></div>
    </dialog>
  </div>;
}
