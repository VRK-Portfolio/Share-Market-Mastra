"use client";

import { useId, useRef, useState } from "react";
import { calculateTradeCosts, defaultFeeAssumptions, feeNames, feeSources } from "../../lib/market/trade-calculator";
import type { CalculatorPlan, FeeAssumptions } from "../../lib/market/trade-calculator";
import { decimal, money } from "./format";

type Draft = {
  sizing: "QUANTITY" | "BUDGET"; quantity: string; budget: string;
  entryPrice: string; targetPrice: string; stopLoss: string; entryTriggerPrice: string;
};
type FeeDraft = Record<keyof FeeAssumptions, string>;
function initialDraft(plan: CalculatorPlan): Draft {
  const entry = plan.entryPrice ?? plan.referencePrice;
  return {
    sizing: "QUANTITY", quantity: String(plan.instrument?.lotSize ?? 1), budget: "",
    entryPrice: entry > 0 ? String(entry) : "", targetPrice: String(plan.targetPrices[0] ?? ""),
    stopLoss: String(plan.stopLoss ?? ""), entryTriggerPrice: entry > 0 ? String(entry) : "",
  };
}
function feeDraft(fees: FeeAssumptions | null): FeeDraft {
  const text = (value: number | null | undefined) => value == null ? "" : String(value);
  return {
    brokerageOverride: text(fees?.brokerageOverride), exchangePercent: text(fees?.exchangePercent),
    ipftPercent: text(fees?.ipftPercent), sebiPercent: text(fees?.sebiPercent),
    sttBuyPercent: text(fees?.sttBuyPercent), sttSellPercent: text(fees?.sttSellPercent),
    stampBuyPercent: text(fees?.stampBuyPercent), gstPercent: text(fees?.gstPercent),
    dpNormal: text(fees?.dpNormal), dpSmall: text(fees?.dpSmall),
  };
}
const feeFields: { key: keyof FeeAssumptions; label: string }[] = [
  { key: "brokerageOverride", label: "Flat brokerage per order (Rs; blank = Groww formula)" },
  { key: "exchangePercent", label: "Exchange transaction (%)" }, { key: "ipftPercent", label: "IPFT (%)" },
  { key: "sebiPercent", label: "SEBI turnover (%)" }, { key: "sttBuyPercent", label: "STT BUY (%)" },
  { key: "sttSellPercent", label: "STT SELL (%)" }, { key: "stampBuyPercent", label: "Stamp duty BUY (%)" },
  { key: "gstPercent", label: "GST on taxable fees (%)" },
  { key: "dpNormal", label: "Delivery SELL DP base (Rs; debit >= 100)" },
  { key: "dpSmall", label: "Delivery SELL DP base (Rs; debit < 100)" },
];
const feeLabels = {
  brokerage: "Brokerage", stt: "STT", exchange: "Exchange", ipft: "IPFT", sebi: "SEBI",
  stampDuty: "Stamp duty", dp: "DP", gst: "GST",
};

export function TradeCalculator({ result, source }: { result: CalculatorPlan; source: "TECHNICAL" | "GEMINI" }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [plan, setPlan] = useState(result);
  const [draft, setDraft] = useState(() => initialDraft(result));
  const [fees, setFees] = useState(() => feeDraft(defaultFeeAssumptions(result)));
  const nullableNumber = (value: string) => value.trim() === "" ? null : Number(value);
  const calculation = calculateTradeCosts(plan, {
    sizing: draft.sizing,
    ...(draft.sizing === "QUANTITY" ? { quantity: Number(draft.quantity) } : { budget: Number(draft.budget) }),
    entryPrice: Number(draft.entryPrice), targetPrice: nullableNumber(draft.targetPrice),
    stopLoss: nullableNumber(draft.stopLoss), entryTriggerPrice: nullableNumber(draft.entryTriggerPrice),
  }, Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, nullableNumber(value)])));
  const exitOnly = plan.decision === "SELL" && (plan.mode === "CNC" || plan.segment === "FNO" && plan.instrument?.instrumentType !== "FUT");
  const gttEligible = plan.segment === "CASH" && plan.mode === "CNC" && plan.decision === "BUY";
  const change = (key: Exclude<keyof Draft, "sizing">, value: string) => setDraft((previous) => ({ ...previous, [key]: value }));

  return <div className="mt-5 border-t border-line pt-4">
    <button type="button" className="secondary-button text-sm" aria-haspopup="dialog"
      onClick={() => {
        const snapshot = { ...result, targetPrices: [...result.targetPrices] };
        setPlan(snapshot); setDraft(initialDraft(snapshot)); setFees(feeDraft(defaultFeeAssumptions(snapshot)));
        dialog.current?.showModal();
      }}>Calculate cost / shares / GTT</button>
    <dialog ref={dialog} aria-labelledby={titleId}
      className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto rounded-2xl border border-line bg-panel p-5 text-foreground shadow-xl backdrop:bg-black/50 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold">Trade cost, quantity &amp; GTT calculator</h2>
        <button type="button" className="secondary-button text-xs" onClick={() => dialog.current?.close()}>Close calculator</button>
      </div>
      <p className="mt-3 text-sm">{source} result / {plan.symbol} / {plan.exchange} / {plan.segment} / {plan.mode} / {plan.decision}</p>
      <p className="mt-2 text-xs text-muted">Analysis snapshot: {plan.snapshotAt ? new Date(plan.snapshotAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unavailable"} IST. Prices are captured on opening and do not change with streaming ticks. Calculations update locally as you edit; nothing is sent to Google, Groww or the order journal.</p>
      {plan.entryPrice === null && <p className="mt-3 text-xs text-warning">This result has no new entry plan. The reference quote is used only as an editable cost illustration; missing targets/stop-loss are not fabricated.</p>}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="field-label">Sizing mode<select className="field mt-1 w-full" aria-label="Calculator sizing mode" value={draft.sizing}
          onChange={(event) => setDraft((previous) => ({ ...previous, sizing: event.target.value === "BUDGET" ? "BUDGET" : "QUANTITY" }))}>
          <option value="QUANTITY">Manual quantity / units</option><option value="BUDGET" disabled={exitOnly}>Full notional budget + fees</option>
        </select></label>
        {draft.sizing === "QUANTITY" ? <label className="field-label">{plan.segment === "CASH" ? "Number of shares" : "Number of units (lot multiples)"}
          <input aria-label="Calculator quantity" className="field mt-1 w-full" type="number" min={plan.instrument?.lotSize ?? 1} step={plan.instrument?.lotSize ?? 1}
            value={draft.quantity} onChange={(event) => change("quantity", event.target.value)} /></label>
          : <label className="field-label">Budget ceiling (Rs, includes entry charges)<input aria-label="Calculator budget" className="field mt-1 w-full" type="number" min="0.01" step="0.01"
            value={draft.budget} onChange={(event) => change("budget", event.target.value)} /></label>}
        <label className="field-label">Planned execution / cost price (Rs)<input aria-label="Calculator entry price" className="field mt-1 w-full" type="number" min="0.00000001" step={plan.instrument?.tickSize ?? 0.01}
          value={draft.entryPrice} onChange={(event) => change("entryPrice", event.target.value)} /></label>
        <label className="field-label">Target price (Rs)<input aria-label="Calculator target price" className="field mt-1 w-full" type="number" min="0.00000001" step={plan.instrument?.tickSize ?? 0.01} disabled={exitOnly}
          value={draft.targetPrice} onChange={(event) => change("targetPrice", event.target.value)} /></label>
        <label className="field-label">Stop-loss price (Rs)<input aria-label="Calculator stop price" className="field mt-1 w-full" type="number" min="0.00000001" step={plan.instrument?.tickSize ?? 0.01} disabled={exitOnly}
          value={draft.stopLoss} onChange={(event) => change("stopLoss", event.target.value)} /></label>
        {gttEligible && <label className="field-label">Advisory GTT entry trigger (Rs)<input aria-label="Calculator GTT entry trigger" className="field mt-1 w-full" type="number" min="0.01" step="0.01"
          value={draft.entryTriggerPrice} onChange={(event) => change("entryTriggerPrice", event.target.value)} /></label>}
      </div>
      {!!plan.targetPrices.length && <div className="mt-3 flex flex-wrap gap-2">{plan.targetPrices.map((target, index) =>
        <button key={`${index}:${target}`} type="button" className="secondary-button text-xs" onClick={() => change("targetPrice", String(target))}>Use target {index + 1}: {money(target)}</button>)}</div>}
      <p className="mt-3 text-xs text-muted">Lot size {plan.instrument?.lotSize ?? 1}{plan.instrument ? ` / verified tick ${plan.instrument.tickSize}` : " / CASH tick not verified here"}. Budget uses full notional/premium plus entry fees, not leveraged buying power or futures margin. Exit-only SELL requires owned units.</p>
      {calculation.ok && <section aria-label="Overall estimated profit and loss" className="mt-5 rounded-xl border border-accent/30 bg-accent/5 p-4">
        <h3 className="text-sm font-semibold">Overall estimated profit / loss</h3>
        <p className="mt-2 text-xs text-muted">For all {calculation.quantity.toLocaleString("en-IN")} {plan.segment === "CASH" ? "shares" : `contract units (${calculation.lots.toLocaleString("en-IN")} lot(s))`}, after estimated entry and exit fees and transaction taxes.</p>
        {calculation.exitOnly ? <p className="mt-3 text-sm text-muted">Profit/loss is unavailable for this owned-position exit without the original acquisition cost.</p>
          : <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              { label: "Target outcome", title: "If target is reached", scenario: calculation.target, missing: "Enter a target price to estimate the outcome." },
              { label: "Stop-loss outcome", title: "If stop-loss is reached", scenario: calculation.stop, missing: "Enter a stop-loss price to estimate the outcome." },
            ].map(({ label, title, scenario, missing }) => <article key={label} aria-label={label} className="rounded-xl border border-line bg-panel p-4">
              <h4 className="text-xs text-muted">{title}{scenario ? ` (${money(scenario.exitPrice)})` : ""}</h4>
              <p className={`mt-2 font-mono text-2xl font-semibold ${scenario && scenario.netPnl > 0 ? "text-positive" : scenario && scenario.netPnl < 0 ? "text-negative" : "text-muted"}`}>{money(scenario?.netPnl)}</p>
              {scenario ? <>
                <p className="mt-1 text-sm font-medium">{scenario.netPnl > 0 ? "Net profit" : scenario.netPnl < 0 ? "Net loss" : "Break-even"}</p>
                <p className="mt-3 text-xs text-muted">Gross P/L {money(scenario.grossPnl)} · Total fees / taxes {money(scenario.totalFees)}</p>
              </> : <p className="mt-2 text-xs text-muted">{missing}</p>}
            </article>)}
          </div>}
        <p className="mt-3 text-xs text-muted">These are alternative exit scenarios, not amounts to add together or guaranteed profit/maximum loss. Slippage and personal income/capital-gains tax are excluded.</p>
      </section>}
      <details className="mt-5 rounded-xl border border-line p-4" open={plan.exchange === "BSE"}>
        <summary className="cursor-pointer text-sm font-semibold">Review / edit fee assumptions (verified 13 Nov 2026)</summary>
        <p className="mt-3 text-xs text-muted">NSE transaction/IPFT rates use the March 2026 circular; derivative STT uses April 2026 rates, not older Groww tables. GST applies to brokerage, exchange, IPFT, SEBI and DP, not STT/stamp duty. Brokerage assumes one executed order per leg.</p>
        {plan.exchange === "BSE" && <p className="mt-3 text-xs text-warning">Confirm your BSE security-group transaction rate and enter a verified IPFT percentage (0 only if your broker confirms none). An unknown rate is never silently assumed zero.</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{feeFields.map(({ key, label }) =>
          <label key={key} className="field-label">{label}<input aria-label={`Calculator ${key}`} className="field mt-1 w-full" type="number" min="0" step="any"
            value={fees[key]} onChange={(event) => setFees((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">{feeSources.map((item) => <a key={item.url} className="text-accent underline" href={item.url} target="_blank" rel="noopener noreferrer">{item.label}</a>)}</div>
      </details>
      {!calculation.ok ? <p role="alert" className="mt-5 rounded-xl border border-negative/25 p-4 text-sm text-negative">{calculation.error}</p> : <>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Calculated trade totals">
          {[
            { label: "Total shares / contract units", value: `${calculation.quantity.toLocaleString("en-IN")} / ${calculation.lots.toLocaleString("en-IN")} lot(s)` },
            { label: "Entry notional / premium", value: money(calculation.entryValue) },
            { label: "Entry charges incl tax", value: money(calculation.entryFees.total) },
            { label: "Full notional + entry charges (not margin)", value: money(calculation.entryExposureWithFees) },
            { label: "Estimated entry cash flow (not funds available)", value: calculation.entryCashFlow === null ? "Futures margin/MTM not estimated" : money(calculation.entryCashFlow) },
            { label: "Unused budget", value: money(calculation.remainingBudget) },
            { label: "Net P/L at target", value: money(calculation.target?.netPnl) },
            { label: "Net P/L at stop", value: money(calculation.stop?.netPnl) },
            { label: "Gross P/L at target", value: money(calculation.target?.grossPnl) },
            { label: "Gross P/L at stop", value: money(calculation.stop?.grossPnl) },
            { label: "Net reward / risk", value: calculation.netRewardRisk === null ? "--" : `${decimal(calculation.netRewardRisk)} : 1` },
            { label: "Approx break-even incl fees", value: money(calculation.approximateBreakEven) },
            { label: "Target exit turnover", value: money(calculation.target?.exitValue) },
            { label: "Total entry + target exit charges", value: money(calculation.target?.totalFees) },
          ].map(({ label, value }) => <div key={label} className="rounded-xl border border-line bg-inset p-4"><h3 className="text-xs text-muted">{label}</h3><p className="mt-2 font-mono text-sm">{value}</p></div>)}
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs"><caption className="mb-3 text-left font-semibold">Estimated fees / taxes (Rs)</caption>
            <thead><tr><th className="p-2">Charge</th><th className="p-2">Entry {calculation.side}</th><th className="p-2">Target exit</th><th className="p-2">Stop exit</th></tr></thead>
            <tbody>{feeNames.map((key) => <tr key={key} className="border-t border-line"><th className="p-2 font-normal">{feeLabels[key]}</th><td className="p-2">{money(calculation.entryFees[key])}</td><td className="p-2">{money(calculation.target?.exitFees[key])}</td><td className="p-2">{money(calculation.stop?.exitFees[key])}</td></tr>)}
              <tr className="border-t border-line font-semibold"><th className="p-2">Total</th><td className="p-2">{money(calculation.entryFees.total)}</td><td className="p-2">{money(calculation.target?.exitFees.total)}</td><td className="p-2">{money(calculation.stop?.exitFees.total)}</td></tr></tbody>
          </table>
        </div>
        <div className="mt-5 rounded-xl border border-line bg-inset p-4">
          <h3 className="text-sm font-semibold">Advisory GTT / trigger preview (not placed)</h3>
          {calculation.gtt && <p className="mt-3 text-sm">{calculation.gtt.quantity} shares / Entry trigger {money(calculation.gtt.entryTrigger)} / Entry limit-cost assumption {money(calculation.gtt.entryLimit)} / Target trigger {money(calculation.gtt.targetTrigger)} / Stop trigger {money(calculation.gtt.stopTrigger)}</p>}
          <p className="mt-3 text-xs text-muted">{calculation.gttReason}</p>
        </div>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-xs text-muted">{calculation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </>}
      <p className="mt-5 text-xs text-warning">This calculator does not place orders, GTTs, targets or stops, verify funds/inventory, or calculate personal income tax. Use the existing separate order review for an explicitly confirmed entry/exit order.</p>
    </dialog>
  </div>;
}
