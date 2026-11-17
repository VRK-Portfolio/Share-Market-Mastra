"use client";

import { useState } from "react";
import Link from "next/link";
import { paperOrderRequestSchema, paperProtectionSchema } from "../../lib/market/paper-order-schemas";
import { paperIntradayLeverage, paperQuoteError, paperRequiredMargin } from "../../lib/market/paper-trading";
import type { PaperAccount, PaperInstruction, PaperLivePrice, PaperQuote } from "../../lib/market/paper-trading";
import { paperRiskPolicy, paperRiskReport, paperSuggestedQuantity } from "../../lib/market/paper-risk";
import { CashStockPicker } from "./cash-stock-picker";
import { FnoContractPicker } from "./fno-contract-picker";
import type { FnoInstrument } from "../../lib/groww/instrument-schemas";
import { paperSegment } from "../../lib/market/paper-instruments";
import { money } from "./format";

export type PaperSelection = { symbol: string; exchange: "NSE" | "BSE"; product: "MIS" | "CNC" | "NRML"; segment?: "CASH" | "FNO"; instrument?: FnoInstrument };
export function PaperOrderForm({ selection, onSelection, quote, unavailable, disabled, submit, onSessionExpired, account, prices, now }: {
  selection: PaperSelection; onSelection: (value: PaperSelection) => void; quote: PaperQuote | null;
  unavailable: string | null; disabled: boolean; submit: (instruction: PaperInstruction) => Promise<boolean>;
  onSessionExpired: () => void;
  account: PaperAccount | null; prices: Record<string, PaperLivePrice>; now: number | null;
}) {
  const [kind, setKind] = useState("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limit, setLimit] = useState("");
  const [trigger, setTrigger] = useState("");
  const [direction, setDirection] = useState("UP");
  const [protect, setProtect] = useState(true);
  const [target, setTarget] = useState("");
  const [stop, setStop] = useState("");
  const [error, setError] = useState("");
  const segment = paperSegment(selection);
  const lotSize = selection.instrument?.lotSize ?? 1;
  const instructionSelection = { symbol: selection.symbol, exchange: selection.exchange, product: selection.product,
    ...(segment === "FNO" ? { segment: "FNO" as const } : {}) };
  const units = Number(quantity);
  const referencePrice = kind === "MARKET" ? quote?.price : kind === "BRACKET" ? undefined : Number(limit);
  const entryValue = referencePrice === undefined ? NaN : Math.round(referencePrice * 100) * units;
  const hasEstimate = Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(entryValue) && entryValue > 0;
  const risk = account && now !== null ? paperRiskReport(account, prices, now) : null;
  const holding = account?.positions.find((position) => position.symbol === selection.symbol &&
    position.exchange === selection.exchange && position.product === selection.product && paperSegment(position) === segment);
  function sizeToBudget(side: "BUY" | "SELL") {
    const suggested = risk?.equity != null && referencePrice != null
      ? Math.floor(paperSuggestedQuantity(risk.equity, referencePrice, Number(stop), side, selection.instrument?.tickSize) / lotSize) * lotSize : 0;
    if (!suggested) {
      setError("Sizing needs live equity, a valid entry price and a stop on the correct side. The current budget may not cover one share or contract lot.");
      return;
    }
    setQuantity(String(suggested)); setError("");
  }
  async function place(side: "BUY" | "SELL") {
    setError("");
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
    const needsProtection = kind === "BRACKET" || !reducing;
    if (needsProtection && kind !== "BRACKET" && !protect) {
      setError("Every new entry requires a target and stop-loss. Enable entry protection."); return;
    }
    const protection = needsProtection
      ? paperProtectionSchema.safeParse({ targetPrice: Number(target), stopPrice: Number(stop) }) : null;
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
        ...(kind === "BRACKET" ? { targetPrice: Number(target), stopPrice: Number(stop) }
          : { limitPrice: Number(limit), ...(protection?.success ? { protection: protection.data } : {}) }),
        ...(kind === "GTT" ? { triggerPrice: Number(trigger), triggerDirection: direction } : {}),
      });
      if (!order.success) { setError("Enter valid positive order prices, target and stop-loss where requested."); return; }
      if (kind === "GTT" && selection.product !== "CNC") { setError("Choose CNC delivery for a persistent GTT order."); return; }
      instruction = { type: "PLACE", order: order.data };
    }
    if (!window.confirm(`PAPER ONLY: ${kind} ${side} ${units} ${selection.symbol} (${selection.exchange}, ${selection.product})?\nPending entries reserve virtual cash. BROWSER ONLY: exits do not run while offline, closed or suspended. Each new fill includes estimated fees of 0.10% of turnover and adverse slippage of 0.05%. Triggers are not guaranteed fill prices. No real broker order.`)) return;
    await submit(instruction);
  }
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
        <input type="checkbox" checked={protect} onChange={(event) => setProtect(event.target.checked)} />Target + stop-loss (mandatory for new entries; not required to close)</label>}
      {(protect || kind === "BRACKET") && <>
        {priceField("Target price (INR)", target, setTarget)}
        {priceField("Stop-loss price (INR)", stop, setStop)}
      </>}
    </div>
    {kind !== "BRACKET" && <div className="mt-4 rounded-xl border border-line p-3 text-xs" aria-label="Paper entry margin comparison">
      {hasEstimate ? <dl className="paper-metrics grid-cols-2">
        <div><dt>Selected {selection.product} entry reserve</dt><dd className="text-base text-accent">{money(paperRequiredMargin(selection.product, entryValue, segment) / 100)}</dd></div>
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
    <div className="mt-4 rounded-xl border border-warning/30 p-3 text-xs" aria-label="Paper entry risk policy">
      <p className="font-medium">Entry safeguards · <Link href="/risk" className="text-accent underline">Risk &amp; performance</Link></p>
      <p className="mt-2 text-muted">Per trade 0.5% of live equity · Daily loss 1.5% · Combined open risk 2% · Per-stock/underlying gross exposure 20% (not margin).</p>
      <p className="mt-2">Live equity: {risk?.equity != null ? money(risk.equity / 100) : "Awaiting fresh prices"} · Trade risk budget: {risk?.equity != null ? money(risk.equity * paperRiskPolicy.perTrade / 100) : "--"}</p>
      {kind !== "BRACKET" && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="secondary-button text-xs" onClick={() => sizeToBudget("BUY")}>Size BUY to risk budget</button>
        <button type="button" className="secondary-button text-xs" onClick={() => sizeToBudget("SELL")}>Size SELL to risk budget</button>
        <p className="w-full text-[11px] text-muted">Suggestion includes estimated costs and the 20% stock cap; existing/pending exposure and remaining combined risk are revalidated by the server.</p>
      </div>}
      {risk && <p className="mt-2 text-muted">Daily consumed loss budget: {money(risk.dailyLoss / 100)} / {money(risk.dailyLimit / 100)}. Conservative: negative net fills today + current unrealized losses, including carried positions; profits never replenish it. Limit uses start-of-day book equity. Missing marks make consumed loss incomplete.</p>}
      {risk && <p className={`mt-2 ${risk.dailyLocked || risk.unprotected ? "text-warning" : "text-muted"}`}>
        {risk.dailyLocked ? "Daily entry lock active. " : ""}{risk.unprotected} unprotected positions · {risk.freshPrices}/{risk.positions} fresh marks.
      </p>}
      {!!risk?.blockers.length && <p role="status" className="mt-2 text-warning">{risk.blockers.join(" ")} Reducing/closing orders remain available.</p>}
      <p className="mt-2 leading-relaxed text-muted">Server entry checks are authoritative: completed-candle technical agreement, fresh trade and depth{segment === "CASH" ? ", timing and MIS opening range" : ". CASH-only opening-range confluence is not used for contracts"}. Sector, news and market-breadth context are not integrated. No claim of independent confirmation from those sources.</p>
      <p className="mt-2 text-warning">Browser-only protection: stops and daily safeguards cannot execute exits while closed, offline or suspended. Gaps can exceed the risk budget.</p>
      <p className="mt-2 text-muted">Future paper fills: 0.10% estimated fees + 0.05% adverse slippage on each entry and exit. Legacy fills stay cost-free; live broker execution is unchanged.</p>
    </div>
    {(protect || kind === "BRACKET") && <p className="mt-3 text-[11px] leading-relaxed text-muted">Long stop must be below target; the reverse applies to shorts. Attached entry protection covers the resulting position.</p>}
    {unavailable && selection.symbol && <p className="mt-3 text-xs text-warning">{unavailable}{selection.product === "CNC" && " Pending GTT placement and cancellation do not require a live fill price."}</p>}
    {error && <p role="alert" className="paper-notice mt-3 text-xs text-negative">{error}</p>}
    <div className="sticky bottom-0 -mx-4 mt-4 border-t border-line bg-panel px-4 pb-4 pt-3">
    <div className="grid grid-cols-2 gap-3">
      <button type="submit" className="paper-trade-button border-positive/25 bg-positive/10 text-positive" disabled={disabled || kind === "MARKET" && !!unavailable}>Paper BUY</button>
      <button type="button" className="paper-trade-button border-negative/25 bg-negative/10 text-negative" disabled={disabled || kind === "MARKET" && !!unavailable}
        onClick={() => { void place("SELL"); }}>Paper SELL</button>
    </div>
    <p className="mt-2 text-center text-[10px] text-muted">Simulated orders only. Nothing is sent to your broker.</p>
    </div>
  </form>;
}
