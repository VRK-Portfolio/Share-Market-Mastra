"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { activePaperOrder, paperOrderRequestSchema, paperProtectionSchema } from "../../lib/market/paper-order-schemas";
import { paperIntradayLeverage, paperQuoteError, paperRequiredMargin, positionKey } from "../../lib/market/paper-trading";
import type { PaperAccount, PaperInstruction, PaperLivePrice, PaperQuote } from "../../lib/market/paper-trading";
import { paperRiskPolicy, paperRiskReport, paperSuggestedQuantity } from "../../lib/market/paper-risk";
import { CashStockPicker } from "./cash-stock-picker";
import { FnoContractPicker } from "./fno-contract-picker";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { paperSegment } from "../../lib/market/paper-instruments";
import { paperDefaultProtection } from "../../lib/market/paper-orders";
import { paperCharges, paperExecutionPrice, paperFeeDisclosure } from "../../lib/market/paper-costs";
import type { PaperCharges } from "../../lib/market/paper-costs";
import { PaperChargeBreakdown } from "./paper-charge-breakdown";
import { feeSources } from "../../lib/market/trade-calculator";
import { money } from "./format";

export type PaperSelection = { symbol: string; exchange: "NSE" | "BSE"; product: "MIS" | "CNC" | "NRML"; segment?: "CASH" | "FNO"; instrument?: FnoInstrument };
export function PaperOrderForm({ selection, onSelection, quote, unavailable, disabled, busy, disabledReason, submitError, submitMessage, submit, onSessionExpired, account, prices, now }: {
  selection: PaperSelection; onSelection: (value: PaperSelection) => void; quote: PaperQuote | null;
  unavailable: string | null; disabled: boolean; submit: (instruction: PaperInstruction) => Promise<boolean>;
  busy: boolean; disabledReason: string | null; submitError: string; submitMessage: string;
  onSessionExpired: () => void;
  account: PaperAccount | null; prices: Record<string, PaperLivePrice>; now: number | null;
}) {
  const [kind, setKind] = useState("MARKET");
  const [quantity, setQuantity] = useState(String(selection.instrument?.lotSize ?? 1));
  const [limit, setLimit] = useState("");
  const [trigger, setTrigger] = useState("");
  const [direction, setDirection] = useState("UP");
  const [protect, setProtect] = useState(true);
  const [entrySide, setEntrySide] = useState<"BUY" | "SELL">("BUY");
  const [targetEdit, setTargetEdit] = useState<{ key: string; value: string } | null>(null);
  const [stopEdit, setStopEdit] = useState<{ key: string; value: string } | null>(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<"idle" | "cancelled" | "failed" | "success">("idle");
  const [submittingSide, setSubmittingSide] = useState<"BUY" | "SELL" | null>(null);
  const submitting = useRef(false);
  const pending = busy || submittingSide !== null;
  const segment = paperSegment(selection);
  const lotSize = selection.instrument?.lotSize ?? 1;
  const selectionKey = positionKey(selection);
  const [previousSelectionKey, setPreviousSelectionKey] = useState(selectionKey);
  if (segment === "FNO" && previousSelectionKey !== selectionKey) {
    setPreviousSelectionKey(selectionKey);
    setQuantity(String(lotSize)); setKind("MARKET"); setLimit(""); setTrigger("");
    setTargetEdit(null); setStopEdit(null); setEntrySide("BUY"); setError(""); setOutcome("idle");
  }
  const instructionSelection = { symbol: selection.symbol, exchange: selection.exchange, product: selection.product,
    ...(segment === "FNO" ? { segment: "FNO" as const } : {}) };
  const units = Number(quantity);
  const referencePrice = kind === "MARKET" ? quote?.price : kind === "BRACKET" ? undefined : Number(limit);
  const entryValue = referencePrice === undefined ? NaN : Math.round(referencePrice * 100) * units;
  const hasEstimate = Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(entryValue) && entryValue > 0;
  const risk = account && now !== null ? paperRiskReport(account, prices, now) : null;
  const holding = account?.positions.find((position) => position.symbol === selection.symbol &&
    position.exchange === selection.exchange && position.product === selection.product && paperSegment(position) === segment);
  let previewNotional: number | null = null, previewCharges: PaperCharges | null = null, previewError: string | null = null;
  if (hasEstimate && referencePrice !== undefined && kind !== "BRACKET" && selection.symbol &&
    (segment === "CASH" || selection.instrument)) {
    try {
      const price = kind === "MARKET" ? paperExecutionPrice(referencePrice, entrySide, selection.instrument?.tickSize) : referencePrice;
      previewNotional = Math.round(price * 100) * units;
      previewCharges = paperCharges(previewNotional, selection, entrySide);
    } catch (error) {
      previewError = error instanceof Error ? error.message : "Unable to estimate paper charges.";
    }
  }
  const previewClosing = !!holding && Math.sign(holding.quantity) !== (entrySide === "BUY" ? 1 : -1);
  const contractType = segment === "FNO" ? selection.instrument?.instrumentType : undefined;
  const option = contractType === "CE" || contractType === "PE";
  const buyUnavailable = contractType && kind === "BRACKET" && !(holding && holding.quantity < 0)
    ? "BUY exit protection only covers an existing short future. For owned CE/PE, use the SELL exit."
    : null;
  const sellUnavailable = option && !(holding && holding.quantity > 0)
    ? `SELL only closes ${contractType} units owned in this exchange and holding period. Buy to open first; option writing is not supported.`
    : contractType && kind === "BRACKET" && !(holding && holding.quantity > 0)
      ? "SELL exit protection requires an existing long position." : null;
  const buyAction = !contractType ? "Paper BUY" : kind === "BRACKET" ? "Set BUY exit for short"
    : holding && holding.quantity < 0 ? "BUY to close short"
      : `BUY to ${holding ? "add" : "open"} ${option ? contractType : "long future"}`;
  const sellAction = !contractType ? "Paper SELL" : kind === "BRACKET" ? `Set SELL target/stop exit`
    : option ? `SELL to close ${contractType}` : holding && holding.quantity > 0 ? "SELL to close long"
      : `SELL to ${holding ? "add to" : "open"} short future`;
  const protectionSide = kind === "BRACKET" && holding ? holding.quantity > 0 ? "BUY" : "SELL" : entrySide;
  const protectionReference = kind === "BRACKET" ? holding ? quote?.price : undefined : referencePrice;
  function protectionValues(side: "BUY" | "SELL") {
    const key = `${segment}:${selection.exchange}:${selection.symbol}:${selection.product}:${kind === "BRACKET" ? "EXIT" : "ENTRY"}:${side}`;
    const defaults = paperDefaultProtection(protectionReference, side, selection.instrument?.tickSize);
    return { key, defaults, target: targetEdit?.key === key ? targetEdit.value : "",
      stop: stopEdit?.key === key ? stopEdit.value : "" };
  }
  const { key: protectionKey, defaults, target, stop } = protectionValues(protectionSide);
  function sizeToBudget(side: "BUY" | "SELL") {
    setEntrySide(side);
    if (!protect) {
      setError("Enable target/stop only if you want a stop-based sizing suggestion, or enter a quantity manually. Protection is not required to submit.");
      return;
    }
    if (!risk || !account || now === null || risk.equity === null || risk.remainingOpenRisk === null) {
      setError("No sizing suggestion: fresh, complete stop-risk values are unavailable. Manual quantity and submission remain available.");
      return;
    }
    if (risk.remainingOpenRisk === 0) {
      setError("The optional 2% risk guideline has no remaining allowance, so no guideline-based quantity is suggested. You can still enter a quantity manually and submit.");
      return;
    }
    const values = protectionValues(side);
    const protection = paperProtectionSchema.safeParse({ targetPrice: Number(values.target), stopPrice: Number(values.stop) });
    if (!protection.success || referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      setError("Sizing needs a valid entry, target and stop-loss. Wait for a fresh market price or enter a limit price.");
      return;
    }
    if (side === "BUY"
      ? protection.data.stopPrice >= referencePrice || protection.data.targetPrice <= referencePrice
      : protection.data.stopPrice <= referencePrice || protection.data.targetPrice >= referencePrice) {
      setError("For BUY, the stop must be below entry and target above it. For SELL, the stop must be above entry and target below it.");
      return;
    }
    try {
      const sizingRisk = kind === "MARKET" && holding && Math.sign(holding.quantity) === (side === "BUY" ? 1 : -1)
        ? paperRiskReport({ ...account, orders: account.orders.map(order =>
          activePaperOrder(order) && order.kind === "BRACKET" && positionKey(order) === positionKey(holding)
            ? { ...order, targetPrice: Math.round(protection.data.targetPrice * 100), stopPrice: Math.round(protection.data.stopPrice * 100) } : order) }, prices, now)
        : risk;
      if (sizingRisk.remainingOpenRisk === null) {
        setError("Complete stop-risk values are unavailable for a sizing suggestion. The new protection also applies to existing units. Manual quantity and submission remain available.");
        return;
      }
      const entry = kind === "MARKET" ? paperExecutionPrice(referencePrice, side, selection.instrument?.tickSize) : referencePrice;
      const suggested = Math.floor(paperSuggestedQuantity(selection, risk.equity, entry, protection.data.stopPrice, side,
        selection.instrument?.tickSize, sizingRisk.remainingOpenRisk) / lotSize) * lotSize;
      if (!suggested) {
        setError(`The optional remaining risk allowance (${money(sizingRisk.remainingOpenRisk / 100)}) and 0.5% trade guideline do not cover one share or contract lot at this stop. Manual quantity and submission remain available.`);
        return;
      }
      setQuantity(String(suggested)); setError("");
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : "The entry risk could not be calculated. Review the prices before sizing.");
    }
  }
  async function place(side: "BUY" | "SELL") {
    if (submitting.current || busy) return;
    setError("");
    setOutcome("idle");
    if (disabled) {
      setError(disabledReason ?? "A paper account update is in progress. Wait for synchronization before submitting.");
      return;
    }
    const actionProblem = side === "BUY" ? buyUnavailable : sellUnavailable;
    if (actionProblem) { setError(actionProblem); return; }
    const units = Number(quantity);
    if (!selection.symbol || !Number.isSafeInteger(units) || units < 1 || units % lotSize !== 0 ||
      segment === "FNO" && !selection.instrument) {
      setError("Choose a stock or verified contract and enter a positive whole-lot quantity."); return;
    }
    const reducing = !!holding && Math.sign(holding.quantity) !== (side === "BUY" ? 1 : -1);
    if (segment === "FNO" && selection.instrument?.instrumentType !== "FUT" && side === "SELL" && !reducing) {
      setError("Option SELL is exit-only. Buy contracts first; uncovered option writing is not supported."); return;
    }
    if (reducing && units > Math.abs(holding.quantity)) {
      setError("Close no more than the open quantity; close first before reversing direction."); return;
    }
    if (kind !== "BRACKET" && !reducing) setEntrySide(side);
    const values = protectionValues(kind === "BRACKET" ? protectionSide : side);
    const needsProtection = kind === "BRACKET" || !reducing && protect;
    const protection = needsProtection
      ? paperProtectionSchema.safeParse({ targetPrice: Number(values.target), stopPrice: Number(values.stop) }) : null;
    if (protection && !protection.success) { setError("Enter valid target and stop-loss prices for this entry or bracket."); return; }
    let instruction: PaperInstruction;
    if (kind === "MARKET") {
      const problem = paperQuoteError(quote);
      if (!quote || problem) { setError(problem ?? "Wait for a live price."); return; }
      instruction = { type: "TRADE", ...instructionSelection, side, quantity: units,
        ...(quote.quoteProof ? { quoteProof: quote.quoteProof } : {}),
        ...(protection?.success ? { protection: protection.data } : {}) };
    } else {
      const order = paperOrderRequestSchema.safeParse({
        ...instructionSelection, side, quantity: units, kind,
        ...(kind === "BRACKET" ? { targetPrice: Number(values.target), stopPrice: Number(values.stop) }
          : { limitPrice: Number(limit), ...(protection?.success ? { protection: protection.data } : {}) }),
        ...(kind === "GTT" ? { triggerPrice: Number(trigger), triggerDirection: direction } : {}),
      });
      if (!order.success) { setError("Enter valid positive order prices, target and stop-loss where requested."); return; }
      if (kind === "GTT" && selection.product !== "CNC") { setError("Choose CNC delivery for a persistent GTT order."); return; }
      instruction = { type: "PLACE", order: order.data };
    }
    let feeSummary = "Setting protection has no fee now; charges apply only when an exit fills.";
    if (kind !== "BRACKET") {
      try {
        const reference = kind === "MARKET" ? quote?.price : Number(limit);
        if (reference === undefined) throw new Error("Wait for a fresh price to estimate charges.");
        const price = kind === "MARKET" ? paperExecutionPrice(reference, side, selection.instrument?.tickSize) : reference;
        const charges = paperCharges(Math.round(price * 100) * units, selection, side);
        feeSummary = `Estimated ${side} charges: ${money(charges.total / 100)}, including flat Rs20 brokerage plus taxes/levies. Final charges use the executed price.`;
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to estimate paper charges.");
        return;
      }
    }
    if (!window.confirm(`PAPER ONLY: ${kind} ${side} ${units} ${selection.symbol} (${selection.exchange}, ${selection.product})?\n${contractType ? `${side === "BUY" ? buyAction : sellAction}${option ? ` · ${contractType === "CE" ? "CE is bullish" : "PE is bearish"} when bought; SELL closes owned units` : ""}\n` : ""}${protection?.success ? `Target: ${money(protection.data.targetPrice)} · Stop-loss: ${money(protection.data.stopPrice)}\n` : !reducing ? "No new target/stop protection attached. Any existing linked protection is retained.\n" : ""}${feeSummary}\nRisk and strategy guidelines are informational, not entry requirements. Pending entries reserve virtual cash including estimated charges. BROWSER ONLY: exits do not run while offline, closed or suspended. Adverse slippage of 0.05% applies to each fill. Triggers are not guaranteed fill prices. No real broker order.`)) {
      setOutcome("cancelled");
      return;
    }
    submitting.current = true;
    setSubmittingSide(side);
    try { setOutcome(await submit(instruction) ? "success" : "failed"); }
    catch (error) {
      setError(`${error instanceof Error && error.message ? error.message : "Paper submission failed."} Check the synchronized balance and history before retrying.`);
    } finally { submitting.current = false; setSubmittingSide(null); }
  }
  const feedbackError = error || (outcome !== "cancelled" ? submitError : "") ||
    (outcome === "failed" ? "The paper order was not confirmed. Check account synchronization and history before retrying." : "");
  const priceField = (label: string, value: string, change: (value: string) => void) =>
    <label className="field-label">{label}<input className="field mt-1 w-full" aria-label={label} type="number" min={selection.instrument?.tickSize ?? 0.01} step={selection.instrument?.tickSize ?? 0.01}
      value={value} onChange={(event) => change(event.target.value)} /></label>;
  return <form noValidate className="paper-order-form" aria-label="Paper order entry"
    onSubmit={(event) => { event.preventDefault(); void place("BUY"); }}>
    <h3 className="text-sm font-semibold">Place a paper order</h3>
    <p className="mt-1 text-xs text-muted">Choose a {segment === "FNO" ? "contract" : "stock"}, set your quantity and practice a trade.</p>
    <div className="paper-form-grid mt-4">
      <div className="col-span-2 [&>.field-label]:min-w-0 [&>.field-label]:max-w-none">
      {segment === "FNO" ? <FnoContractPicker key={selection.exchange} exchange={selection.exchange}
        selected={selection.instrument ?? null} onSelect={instrument => {
          onSelection({ ...selection, symbol: instrument?.tradingSymbol ?? "", instrument: instrument ?? undefined });
          if (instrument) setQuantity(String(instrument.lotSize));
        }} onSessionExpired={onSessionExpired} />
        : <CashStockPicker symbol={selection.symbol} exchange={selection.exchange}
          onSelect={(symbol) => onSelection({ ...selection, symbol })} onSessionExpired={onSessionExpired} />}
      </div>
      <label className="field-label">Exchange<select aria-label="Paper exchange" className="field mt-1 w-full" value={selection.exchange}
        onChange={(event) => onSelection({ ...selection, exchange: event.target.value === "BSE" ? "BSE" : "NSE", symbol: "", instrument: undefined })}>
        <option>NSE</option><option>BSE</option></select></label>
      <label className="field-label">Holding period<select aria-label="Paper product" className="field mt-1 w-full" value={selection.product}
        onChange={(event) => {
          const product = event.target.value === "CNC" ? "CNC" : event.target.value === "NRML" ? "NRML" : "MIS";
          if (product !== "CNC" && kind === "GTT") setKind("MARKET");
          setError("");
          onSelection({ ...selection, product });
        }}>
        <option value="MIS">Intraday (MIS)</option>{segment === "FNO" ? <option value="NRML">Overnight (NRML)</option> : <option value="CNC">Carry-forward (CNC)</option>}</select></label>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2.5 text-xs" role="status">
      <span className="text-muted">{selection.symbol ? `${selection.symbol} · ${selection.product === "MIS" ? "Intraday" : "Carry-forward"}` : `Choose a ${segment === "FNO" ? "contract" : "stock"} to see its live price`}</span>
      {selection.symbol && <span className="font-mono font-medium">{quote ? money(quote.price) : "Waiting for a fresh tick"}</span>}
    </div>
    {contractType && <section aria-label="F&O action guide" className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs">
      <h4 className="font-semibold">{contractType === "CE" ? "CE call: buying expresses a bullish view"
        : contractType === "PE" ? "PE put: buying expresses a bearish view" : "Futures: long or short exposure"}</h4>
      <p className="mt-2 text-muted">{option
        ? `BUY opens or adds ${contractType} contracts. SELL only reduces or closes contracts you already own; it does not open a short option. A bearish view can mean buying PE, not pressing SELL.`
        : "BUY opens/adds a bullish long, or closes an existing short. SELL opens/adds a bearish short, or closes an existing long. Close first before reversing."}</p>
      <p className="mt-2 font-medium">{account ? <>Position in {selection.product} on {selection.exchange}: {Math.abs(holding?.quantity ?? 0)} units
        {holding ? ` (${Math.abs(holding.quantity) / lotSize} lots, ${holding.quantity > 0 ? "long" : "short"})` : " (no position)"}. Quantities are units in whole lots.</>
        : "Loading paper holdings before identifying open/close actions."}</p>
      {option && <p className="mt-2 text-muted">To profit on a bought option, its premium must rise enough to cover entry and exit costs. An index move alone is not enough: time decay and volatility can reduce both CE and PE premiums. The displayed price is premium per unit, not the strike or index value.</p>}
      <p className="mt-2 text-muted">These labels explain the order, not when to enter. Review the separate analysis on the trading page; no BUY/SELL recommendation or order is selected automatically.</p>
    </section>}
    <div className="paper-form-grid mt-4">
      <label className="field-label col-span-2">Order type<select aria-label="Paper order type" className="field mt-1 w-full" value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="MARKET">Market</option><option value="LIMIT">Limit (day)</option>
        {selection.product === "CNC" && <option value="GTT">GTT trigger + limit (CNC)</option>}
        <option value="BRACKET">Target + stop-loss exit</option></select></label>
      <p className="-mt-1 col-span-2 text-[11px] leading-relaxed text-muted">
        {kind === "MARKET" ? "Uses a fresh live price. Your final simulated fill may differ."
          : kind === "LIMIT" ? `Fills at your limit price or better, while connected. ${selection.product === "MIS" ? "Intraday limits expire at 15:20 IST." : "Carry-forward day limits expire at 15:30 IST."}`
            : kind === "GTT" ? "CNC only. Saved trigger + limit; runs while this terminal is open and connected."
              : "Protect an existing position: SELL exits a long; BUY covers a short."}
      </p>
      <label className="field-label">{segment === "FNO" ? "Contract units" : "Number of shares"}<input id="paper-quantity" aria-label="Paper quantity" className="field mt-1 w-full" type="number"
        min={lotSize} step={lotSize} required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      {selection.instrument && <p className="col-span-2 break-words text-[11px] text-muted">{selection.instrument.instrumentType} · Expiry {selection.instrument.expiry} · Lot {lotSize} · {units / lotSize} lots · Tick {money(selection.instrument.tickSize)}. Option SELL only closes owned contracts.</p>}
      {kind !== "MARKET" && kind !== "BRACKET" && priceField("Limit price (INR)", limit, setLimit)}
      {kind === "GTT" && <>
        {priceField("GTT trigger (INR)", trigger, setTrigger)}
        <label className="field-label col-span-2">Trigger condition<select className="field mt-1 w-full" value={direction} onChange={(event) => setDirection(event.target.value)}>
          <option value="UP">Price at or above trigger</option><option value="DOWN">Price at or below trigger</option></select></label>
      </>}
      {kind !== "BRACKET" && <label className="col-span-2 flex min-h-10 items-center gap-2 text-xs">
        <input type="checkbox" checked={protect} onChange={(event) => setProtect(event.target.checked)} />Attach target + stop-loss (optional)</label>}
      {!protect && kind !== "BRACKET" && <p className="col-span-2 text-[11px] text-warning">No new target/stop will be attached. Existing linked protection is retained/resized; without it, the position has no automatic target/stop exit.</p>}
      {(protect || kind === "BRACKET") && <>
        {kind !== "BRACKET" && <label className="field-label col-span-2">Protection direction<select aria-label="Protection direction"
          className="field mt-1 w-full" value={entrySide} onChange={(event) => setEntrySide(event.target.value === "SELL" ? "SELL" : "BUY")}>
          <option value="BUY">BUY / long</option><option value="SELL">SELL / short (where permitted)</option>
        </select></label>}
        <div>
          {priceField("Target price (INR)", target, value => setTargetEdit({ key: protectionKey, value }))}
          {defaults && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-muted">Suggested: {money(defaults.targetPrice)}</span>
            <button type="button" className="text-accent underline" aria-label="Use suggested target price"
              onClick={() => setTargetEdit({ key: protectionKey, value: defaults.targetPrice.toFixed(2) })}>Use</button>
          </div>}
        </div>
        <div>
          {priceField("Stop-loss price (INR)", stop, value => setStopEdit({ key: protectionKey, value }))}
          {defaults && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-muted">Suggested: {money(defaults.stopPrice)}</span>
            <button type="button" className="text-accent underline" aria-label="Use suggested stop-loss price"
              onClick={() => setStopEdit({ key: protectionKey, value: defaults.stopPrice.toFixed(2) })}>Use</button>
          </div>}
        </div>
        <div className="col-span-2 text-[11px] leading-relaxed text-muted">
          <p>Suggested levels: {protectionSide === "BUY" ? "target +5%, stop -5%" : "target -5%, stop +5%"} from the {kind === "LIMIT" || kind === "GTT" ? "limit" : "fresh live"} price, rounded to the price tick. Type each price or click its Use button. Entered prices stay fixed as the reference changes.</p>
          {kind === "BRACKET" ? <p>Direction follows the existing position. SELL exits a long; BUY covers a short.</p>
            : <p>Set protection direction to match your intended Paper BUY/SELL action, then enter both prices. Review them in confirmation. Existing short-selling restrictions still apply.</p>}
          {!defaults && <p className="mt-1 text-warning">Suggested levels need a valid reference price{kind === "BRACKET" ? " and an existing position" : ""}, with positive, distinct prices after tick rounding. Wait for a live price or enter valid prices manually.</p>}
        </div>
      </>}
    </div>
    {kind !== "BRACKET" && <div className="mt-4 rounded-xl border border-line p-3 text-xs" aria-label="Paper entry margin comparison">
      {hasEstimate ? <dl className="paper-metrics grid-cols-2">
        <div><dt>Selected {selection.product} collateral before charges</dt><dd className="text-base text-accent">{money(paperRequiredMargin(selection.product, entryValue, segment) / 100)}</dd></div>
        <div><dt className="text-muted">Full entry value</dt><dd className="mt-1 font-mono">{money(entryValue / 100)}</dd></div>
      </dl> : <p className="text-muted">Your estimated cost appears after you enter a valid quantity and {kind === "MARKET" ? "receive a fresh price" : "limit price"}.</p>}
      {segment === "CASH" ? <details className="mt-3 text-[11px]">
        <summary className="cursor-pointer text-muted">Compare intraday &amp; delivery costs</summary>
        {hasEstimate && <dl className="paper-metrics mt-3">
          <div><dt>Intraday margin ({paperIntradayLeverage}x / 20%)</dt><dd>{money(paperRequiredMargin("MIS", entryValue) / 100)}</dd></div>
          <div><dt>Carry-forward cost (100%)</dt><dd>{money(entryValue / 100)}</dd></div>
        </dl>}
        <p className="mt-2 leading-relaxed text-muted">The stock price is the same for MIS and CNC on this exchange. New MIS entries use simulated 5x leverage; CNC uses full cash. Exits release saved collateral. This is not verified broker margin.</p>
      </details> : <p className="mt-3 text-[11px] text-muted">Futures reserve 100% of notional; option buys reserve 100% of premium, plus fees. No F&amp;O leverage or option writing. This is not actual broker margin.</p>}
    </div>}
    {kind !== "BRACKET" && <section className="mt-4 rounded-xl border border-line p-3 text-xs" aria-label="Estimated paper charges">
      <h3 className="font-semibold">Brokerage, taxes &amp; other charges</h3>
      <label className="mt-3 block text-muted">Charge preview side
        <select aria-label="Charge preview side" className="field mt-1 w-full" value={entrySide}
          onChange={event => setEntrySide(event.target.value === "SELL" ? "SELL" : "BUY")}>
          <option value="BUY">BUY</option><option value="SELL">SELL</option>
        </select>
      </label>
      {previewCharges && previewNotional !== null ? <>
        <p className="mt-2 text-muted">{entrySide} turnover: {money(previewNotional / 100)}.
          {kind === "MARKET" ? " Includes modeled 0.05% adverse price slippage." : " Based on the limit price; final charges use the fill price."}</p>
        <PaperChargeBreakdown charges={previewCharges} />
        {!previewClosing && <p className="mt-3 font-medium">Estimated entry funds including charges: {money(
          (paperRequiredMargin(selection.product, previewNotional, segment) + previewCharges.total) / 100)}</p>}
      </> : previewError ? <p role="alert" className="mt-3 text-negative">{previewError}</p>
        : <p className="mt-3 text-muted">Select a stock/contract and enter a valid quantity and price to see the breakdown.</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-muted">{paperFeeDisclosure}</p>
      <p className="mt-2 text-[11px] text-muted">Rates reviewed 18 Nov 2026. STT rounds to whole rupees per fill; other items round to paise. Delivery DP uses Rs20 before GST (Rs3.50 when sell value is below Rs100), per simulated sell fill. Brokerage is your flat-fee simulation policy, not Groww&apos;s equity pricing.</p>
      <details className="mt-2 text-[11px] text-muted"><summary className="cursor-pointer">Fee sources</summary>
        <ul className="mt-2 space-y-1">{feeSources.filter(source => !source.label.includes("outdated")).map(source =>
          <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer" className="text-accent underline">{source.label}</a></li>)}
          <li><a href="https://www.bseindia.com/static/investors/claim-against-defaulter" target="_blank" rel="noreferrer" className="text-accent underline">BSE IPF contribution</a></li>
        </ul>
      </details>
    </section>}
    <div className="mt-4 rounded-xl border border-warning/30 p-3 text-xs" aria-label="Paper entry risk policy">
      <p className="font-medium">Entry guidance · information only · <Link href="/risk" className="text-accent underline">Risk &amp; performance</Link></p>
      <p className="mt-2 text-muted">Optional guidelines: per trade 0.5% of live equity · Daily loss 1.5% · Combined open risk 2% · Per-stock/underlying gross exposure 20% (not margin). These do not block entries.</p>
      <p className="mt-2">Live equity: {risk?.equity != null ? money(risk.equity / 100) : "Awaiting fresh prices"} · Trade risk budget: {risk?.equity != null ? money(risk.equity * paperRiskPolicy.perTrade / 100) : "--"}</p>
      <dl className="paper-metrics mt-3 grid-cols-2" aria-label="Combined paper risk budget">
        <div><dt>Open-position stop risk</dt><dd>{risk?.positionRisk != null ? money(risk.positionRisk / 100) : "Unavailable"}</dd></div>
        <div><dt>Pending entry risk</dt><dd>{risk?.openRisk != null ? money(risk.pendingRisk / 100) : "Unavailable"}</dd></div>
        <div><dt>Combined risk / 2% guideline</dt><dd>{risk?.openRisk != null ? money(risk.openRisk / 100) : "Unavailable"} / {risk?.openRiskLimit != null ? money(risk.openRiskLimit / 100) : "Unavailable"}</dd></div>
        <div><dt>Remaining guideline allowance</dt><dd>{risk?.remainingOpenRisk != null ? money(risk.remainingOpenRisk / 100) : "Unavailable"}</dd></div>
      </dl>
      <p className="mt-2 text-[11px] text-muted">Risk is the modeled loss from current marks to stops plus pending-entry risk and estimated costs, not cash margin. Missing protection or stale account marks makes estimates incomplete, but does not block a fresh-price entry.</p>
      {kind !== "BRACKET" && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="secondary-button text-xs" onClick={() => sizeToBudget("BUY")}>Size BUY to risk budget</button>
        <button type="button" className="secondary-button text-xs" onClick={() => sizeToBudget("SELL")}>Size SELL to risk budget</button>
        <p className="w-full text-[11px] text-muted">Optional suggestion uses the smaller of the 0.5% trade guideline and remaining combined allowance, including estimated costs and whole lots. Market additions account for changed protection on existing units. You can enter a different quantity; risk guidelines do not restrict submission.</p>
      </div>}
      {risk && <p className="mt-2 text-muted">Daily consumed loss budget: {money(risk.dailyLoss / 100)} / {money(risk.dailyLimit / 100)}. Conservative: negative net fills today + current unrealized losses, including carried positions; profits never replenish it. Limit uses start-of-day book equity. Missing marks make consumed loss incomplete.</p>}
      {risk && <p className={`mt-2 ${risk.dailyLocked || risk.unprotected ? "text-warning" : "text-muted"}`}>
        {risk.dailyLocked ? "Daily loss guideline reached (advisory only). " : ""}{risk.unprotected} unprotected positions · {risk.freshPrices}/{risk.positions} fresh marks.
      </p>}
      {!!risk?.blockers.length && <p role="status" className="mt-2 text-warning">Advisory: {risk.blockers.join(" ")} These warnings do not block orders.</p>}
      <p className="mt-2 leading-relaxed text-muted">Indicator, depth, timing and opening-range analysis is informational, not required for paper entry. Strategy history/depth is not fetched for order approval. Fresh execution prices, sufficient funds, valid contracts/lots/ticks, regular-session hours and the 15:20 MIS square-off cutoff remain enforced. Sector, news and market-breadth context are not integrated.</p>
      <p className="mt-2 text-warning">Browser-only protection: attached stops and scheduled square-offs cannot execute while closed, offline or suspended. Gaps can exceed the risk guideline.</p>
      <p className="mt-2 text-muted">New fills use flat Rs20 brokerage per executed order plus itemized estimated taxes/charges and 0.05% adverse slippage. Existing cost-free and V1 history is unchanged; live broker execution is unchanged.</p>
    </div>
    {(protect || kind === "BRACKET") && <p className="mt-3 text-[11px] leading-relaxed text-muted">Long stop must be below target; the reverse applies to shorts. Attached entry protection covers the resulting position.</p>}
    <div className="sticky bottom-0 -mx-4 mt-4 border-t border-line bg-panel px-4 pb-4 pt-3" aria-label="Paper order actions" aria-busy={pending}>
    {pending ? <p role="status" className="mb-3 text-xs text-accent">Submitting or synchronizing the paper account. Waiting for server confirmation; do not submit again.</p>
      : feedbackError ? <p role="alert" className="paper-notice mb-3 max-h-32 overflow-y-auto text-xs text-negative">{feedbackError}</p>
      : outcome === "cancelled" ? <p role="status" className="mb-3 text-xs text-muted">Paper order cancelled. No order was submitted.</p>
      : submitMessage && <p role="status" className="paper-notice mb-3 max-h-32 overflow-y-auto text-xs text-positive">{submitMessage}</p>}
    {!pending && disabled && disabledReason && !feedbackError && <p role="status" className="mb-3 text-xs text-warning">{disabledReason}</p>}
    {unavailable && selection.symbol && <p role="status" className="mb-3 text-xs text-warning">{unavailable}{selection.product === "CNC" && " Pending GTT placement and cancellation do not require a live fill price."}</p>}
    {(buyUnavailable || sellUnavailable) && <p role="status" className="mb-3 text-xs text-muted">{buyUnavailable || sellUnavailable}</p>}
    <div className="grid grid-cols-2 gap-3">
      <button type="submit" className="paper-trade-button border-positive/25 bg-positive/10 text-positive" disabled={disabled || pending || !!buyUnavailable || kind === "MARKET" && !!unavailable}>{submittingSide === "BUY" ? "Submitting BUY..." : pending ? "Updating account..." : buyAction}</button>
      <button type="button" className="paper-trade-button border-negative/25 bg-negative/10 text-negative" disabled={disabled || pending || !!sellUnavailable || kind === "MARKET" && !!unavailable}
        onClick={() => { void place("SELL"); }}>{submittingSide === "SELL" ? "Submitting SELL..." : pending ? "Updating account..." : sellAction}</button>
    </div>
    <p className="mt-2 text-center text-[10px] text-muted">Simulated orders only. Nothing is sent to your broker.</p>
    </div>
  </form>;
}
