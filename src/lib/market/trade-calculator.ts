import { z } from "zod";
import { fnoInstrumentSchema } from "../groww/instrument-schemas.ts";
import { onTickSize } from "../groww/order-schemas.ts";
import type { FnoInstrument } from "../groww/instrument-schemas.ts";
import type { AnalysisMode } from "./types.ts";

export interface CalculatorPlan {
  symbol: string;
  exchange: "NSE" | "BSE";
  segment: "CASH" | "FNO";
  mode: AnalysisMode;
  decision: "BUY" | "SELL" | "HOLD";
  referencePrice: number;
  entryPrice: number | null;
  targetPrices: number[];
  stopLoss: number | null;
  snapshotAt: string | null;
  instrument?: FnoInstrument;
}
export const feeSources = [
  { label: "Groww brokerage", url: "https://groww.in/help/stocks,-f&o,-ipo-&-mtf/searchable/how-much-is-the-brokerage" },
  { label: "Groww equity / DP / GST", url: "https://groww.in/pricing" },
  { label: "Groww derivative charges (some rates outdated)", url: "https://915.groww.in/pricing" },
  { label: "NSE transaction/IPFT rates, March 2026", url: "https://nsearchives.nseindia.com/content/circulars/FA73061.pdf" },
  { label: "NSE STT rates, April 2026", url: "https://nsearchives.nseindia.com/content/circulars/FATAX73524.pdf" },
];

const percent = z.number().finite().min(0).max(100);
const charge = z.number().finite().min(0).max(100_000);
const feeSchema = z.object({
  brokerageOverride: charge.nullable(),
  exchangePercent: percent,
  ipftPercent: z.number({ error: "Enter a verified IPFT percentage; BSE has no assumed zero rate." }).finite().min(0).max(100),
  sebiPercent: percent,
  sttBuyPercent: percent,
  sttSellPercent: percent,
  stampBuyPercent: percent,
  gstPercent: percent,
  dpNormal: charge,
  dpSmall: charge,
});
export type FeeAssumptions = Omit<z.infer<typeof feeSchema>, "ipftPercent"> & { ipftPercent: number | null };
type VerifiedFees = z.infer<typeof feeSchema>;
const price = z.number().finite().positive().max(1_000_000);
const inputSchema = z.object({
  sizing: z.enum(["QUANTITY", "BUDGET"]),
  quantity: z.number().int().positive().max(1_000_000).optional(),
  budget: z.number().finite().positive().max(1_000_000_000_000).optional(),
  entryPrice: price,
  targetPrice: price.nullable(),
  stopLoss: price.nullable(),
  entryTriggerPrice: price.nullable(),
}).superRefine((value, context) => {
  if (value.sizing === "QUANTITY" ? value.quantity === undefined : value.budget === undefined) {
    context.addIssue({ code: "custom", message: value.sizing === "QUANTITY" ? "Enter a valid quantity." : "Enter a positive budget." });
  }
});

export const feeNames = ["brokerage", "stt", "exchange", "ipft", "sebi", "stampDuty", "dp", "gst"] as const;
export type Fees = Record<(typeof feeNames)[number], number> & { total: number };
type Scenario = {
  exitPrice: number; exitValue: number; exitFees: Fees; totalFees: number; grossPnl: number; netPnl: number;
};
export type CalculatorResult =
  | { ok: false; error: string }
  | { ok: true; quantity: number; lots: number; lotSize: number; entryValue: number; entryFees: Fees;
    entryExposureWithFees: number; entryCashFlow: number | null; remainingBudget: number | null;
    side: "BUY" | "SELL"; exitOnly: boolean; target: Scenario | null; stop: Scenario | null;
    netRewardRisk: number | null; approximateBreakEven: number | null;
    gtt: { quantity: number; entryTrigger: number; entryLimit: number; targetTrigger: number; stopTrigger: number } | null;
    gttReason: string; warnings: string[] };

function planError(plan: CalculatorPlan) {
  if (plan.segment === "CASH") return plan.mode === "NRML" || !!plan.instrument ? "CASH requires MIS/CNC without a derivative contract." : null;
  const contract = fnoInstrumentSchema.safeParse(plan.instrument);
  return plan.mode === "CNC" || !contract.success || contract.data.tradingSymbol !== plan.symbol || contract.data.exchange !== plan.exchange
    ? "A matching, verified F&O contract and MIS/NRML mode are required." : null;
}

export function defaultFeeAssumptions(plan: CalculatorPlan): FeeAssumptions | null {
  if (planError(plan)) return null;
  const cash = plan.segment === "CASH";
  const delivery = cash && plan.mode === "CNC";
  const future = plan.instrument?.instrumentType === "FUT";
  return {
    brokerageOverride: null,
    exchangePercent: plan.exchange === "NSE" ? cash ? 0.0030699 : future ? 0.0018299 : 0.0355299
      : cash ? 0.00375 : future ? 0 : 0.0325,
    ipftPercent: plan.exchange === "NSE" ? 0.0000001 : null,
    sebiPercent: 0.0001,
    sttBuyPercent: delivery ? 0.1 : 0,
    sttSellPercent: cash ? delivery ? 0.1 : 0.025 : future ? 0.05 : 0.15,
    stampBuyPercent: cash ? delivery ? 0.015 : 0.003 : future ? 0.002 : 0.003,
    gstPercent: 18, dpNormal: 20, dpSmall: 3.5,
  };
}

const paise = (value: number) => Math.round((value + Number.EPSILON) * 100);
const rupees = (value: number) => value / 100;
const amount = (value: number) => rupees(paise(value));

function charges(plan: CalculatorPlan, fees: VerifiedFees, quantity: number, unitPrice: number, side: "BUY" | "SELL"): Fees {
  const turnover = amount(quantity * unitPrice);
  const brokerage = fees.brokerageOverride ?? (plan.segment === "FNO" ? 20
    : Math.min(20, Math.max(turnover * 0.001, Math.min(5, turnover * 0.025))));
  const dp = plan.segment === "CASH" && plan.mode === "CNC" && side === "SELL"
    ? turnover < 100 ? fees.dpSmall : fees.dpNormal : 0;
  const values = {
    brokerage: paise(brokerage),
    stt: Math.round(turnover * (side === "BUY" ? fees.sttBuyPercent : fees.sttSellPercent) / 100) * 100,
    exchange: paise(turnover * fees.exchangePercent / 100),
    ipft: paise(turnover * fees.ipftPercent / 100),
    sebi: paise(turnover * fees.sebiPercent / 100),
    stampDuty: side === "BUY" ? paise(turnover * fees.stampBuyPercent / 100) : 0,
    dp: paise(dp),
  };
  const gst = Math.round((values.brokerage + values.exchange + values.ipft + values.sebi + values.dp) * fees.gstPercent / 100);
  return {
    brokerage: rupees(values.brokerage), stt: rupees(values.stt), exchange: rupees(values.exchange),
    ipft: rupees(values.ipft), sebi: rupees(values.sebi), stampDuty: rupees(values.stampDuty), dp: rupees(values.dp),
    gst: rupees(gst), total: rupees(Object.values(values).reduce((sum, value) => sum + value, gst)),
  };
}

export function calculateTradeCosts(plan: CalculatorPlan, rawInput: unknown, rawFees: unknown): CalculatorResult {
  const invalidPlan = planError(plan);
  if (invalidPlan) return { ok: false, error: invalidPlan };
  const input = inputSchema.safeParse(rawInput);
  if (!input.success) return { ok: false, error: input.error.issues[0].message };
  const schedule = feeSchema.safeParse(rawFees);
  if (!schedule.success) return { ok: false, error: `Fee assumptions: ${schedule.error.issues[0].message}` };
  const fees = schedule.data;
  const { entryPrice, targetPrice, stopLoss, entryTriggerPrice, sizing } = input.data;
  const lotSize = plan.instrument?.lotSize ?? 1;
  const tick = plan.instrument?.tickSize ?? 0.01;
  const side = plan.decision === "SELL" ? "SELL" : "BUY";
  const long = side === "BUY";
  const exitOnly = !long && (plan.mode === "CNC" || plan.instrument?.instrumentType !== "FUT" && plan.segment === "FNO");
  if (tick < 1e-8) return { ok: false, error: "Tick size cannot be represented safely." };
  if (plan.segment === "FNO" && [entryPrice, targetPrice, stopLoss].some((value) =>
    value !== null && !onTickSize(value, tick))) return { ok: false, error: `F&O prices must be multiples of the verified tick size ${tick}.` };
  if (!exitOnly && (targetPrice !== null && (long ? targetPrice <= entryPrice : targetPrice >= entryPrice) ||
    stopLoss !== null && (long ? stopLoss >= entryPrice : stopLoss <= entryPrice))) {
    return { ok: false, error: "Targets and stop-loss must lie on the correct side of the execution price." };
  }
  if (exitOnly && sizing === "BUDGET") return { ok: false, error: "Exit-only SELL uses owned units, not an investment budget. Select manual quantity." };
  if (exitOnly && (targetPrice !== null || stopLoss !== null)) {
    return { ok: false, error: "Exit-only SELL cannot suggest a new target/stop trade plan." };
  }
  const exposure = (quantity: number) => paise(quantity * entryPrice) + paise(charges(plan, fees, quantity, entryPrice, side).total);
  let quantity = input.data.quantity ?? 0;
  if (sizing === "BUDGET") {
    const budget = input.data.budget;
    if (budget === undefined) return { ok: false, error: "Enter a positive budget." };
    const budgetPaise = Math.floor(budget * 100 + 1e-6);
    let low = 0;
    let high = Math.floor(1_000_000 / lotSize);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (exposure(middle * lotSize) <= budgetPaise) low = middle;
      else high = middle - 1;
    }
    quantity = low * lotSize;
    if (!quantity) return { ok: false, error: `The budget cannot cover one lot (${lotSize} unit${lotSize === 1 ? "" : "s"}) plus entry charges.` };
  }
  if (quantity % lotSize !== 0) return { ok: false, error: `Quantity must be a multiple of the lot size (${lotSize}).` };
  const entryValue = amount(quantity * entryPrice);
  const entryFees = charges(plan, fees, quantity, entryPrice, side);
  const entryExposureWithFees = rupees(exposure(quantity));
  function scenario(exitPrice: number): Scenario {
    const exitFees = charges(plan, fees, quantity, exitPrice, long ? "SELL" : "BUY");
    const grossPnl = amount((exitPrice - entryPrice) * quantity * (long ? 1 : -1));
    const totalFees = amount(entryFees.total + exitFees.total);
    return { exitPrice, exitValue: amount(quantity * exitPrice), exitFees, totalFees, grossPnl, netPnl: amount(grossPnl - totalFees) };
  }
  const target = !exitOnly && targetPrice !== null ? scenario(targetPrice) : null;
  const stop = !exitOnly && stopLoss !== null ? scenario(stopLoss) : null;
  const exitAtEntryFees = charges(plan, fees, quantity, entryPrice, long ? "SELL" : "BUY");
  const breakEven = entryPrice + (entryFees.total + exitAtEntryFees.total) / quantity * (long ? 1 : -1);
  const roundedBreakEven = !exitOnly && breakEven > 0
    ? Number(((long ? Math.ceil(breakEven / tick - 1e-9) : Math.floor(breakEven / tick + 1e-9)) * tick).toFixed(8)) : null;
  const approximateBreakEven = roundedBreakEven !== null && roundedBreakEven > 0 ? roundedBreakEven : null;
  let gtt: Extract<CalculatorResult, { ok: true }>["gtt"] = null;
  let gttReason = "GTT is advisory only for a CASH delivery BUY result; never MIS, F&O, SELL or HOLD.";
  if (plan.segment === "CASH" && plan.mode === "CNC" && plan.decision === "BUY") {
    if (targetPrice === null || stopLoss === null || entryTriggerPrice === null) {
      gttReason = "Enter entry trigger, target and stop-loss to preview advisory delivery GTT levels.";
    } else if (stopLoss >= Math.min(entryPrice, entryTriggerPrice) || targetPrice <= Math.max(entryPrice, entryTriggerPrice)) {
      return { ok: false, error: "GTT stop must be below both entry/trigger; target must be above both." };
    } else {
      gtt = { quantity, entryTrigger: entryTriggerPrice, entryLimit: entryPrice, targetTrigger: targetPrice, stopTrigger: stopLoss };
      gttReason = "Confirm broker eligibility, trigger direction, exit limit prices, quantity, validity and separate exit protection. These are not linked/OCO or submitted orders.";
    }
  }
  const warnings = [
    "Estimates assume one full executed order per leg; STT rounds to whole rupees per leg and other charges to paise. Actual client-day aggregation/contract-note rounding can differ.",
    "Standard resident Groww brokerage: equity lower of Rs20 or 0.1%, with minimum lower of Rs5 or 2.5% of value; F&O Rs20. NRI, UPI-mandate and MTF plans are not modeled.",
    "DP defaults are before GST; confirm normal/small-debit charges for your account. CASH assumes single-share units; actual tradable lot/tick sizes must be verified in order review.",
    "Personal income/capital-gains tax, slippage, spreads, market impact, recurring API fees, interest, penalties, auto square-off, option exercise and physical settlement are excluded.",
    "Approximate break-even holds exit charges at the entry price; it is not an exact contract-note threshold.",
  ];
  if (plan.segment === "FNO" || plan.mode === "MIS") warnings.push("Budget uses full notional/premium plus entry charges, NOT available leverage or SPAN/exposure margin. Verify blocked funds/margin with Groww.");
  if (plan.exchange === "BSE") warnings.push("BSE transaction rates vary by security group/contract; verify the default rate and your manually confirmed IPFT rate.");
  if (plan.decision === "HOLD") warnings.push("HOLD has no actionable trade plan. BUY-side costs and any manually entered levels are illustrations, not a new BUY recommendation.");
  if (exitOnly) warnings.push("SELL is exit-only: enter verified owned units. Without your acquisition cost no profit, loss or new short plan is calculated.");
  if (target && target.netPnl <= 0) warnings.push("Estimated target profit does not cover trading charges.");
  if (!exitOnly && approximateBreakEven === null) warnings.push("No positive break-even is representable under the entry-price fee approximation.");
  if (sizing === "BUDGET" && quantity + lotSize > 1_000_000) warnings.push("Quantity is capped at the app limit of 1,000,000 units, even if the budget permits more.");
  return {
    ok: true, quantity, lotSize, lots: quantity / lotSize, entryValue, entryFees, entryExposureWithFees,
    entryCashFlow: plan.instrument?.instrumentType === "FUT" ? null : amount(long ? -entryValue - entryFees.total : entryValue - entryFees.total),
    remainingBudget: sizing === "BUDGET" && input.data.budget !== undefined
      ? amount(Math.floor(input.data.budget * 100 + 1e-6) / 100 - entryExposureWithFees) : null,
    side, exitOnly, target, stop,
    netRewardRisk: target && stop && target.netPnl > 0 && stop.netPnl < 0 ? target.netPnl / -stop.netPnl : null,
    approximateBreakEven, gtt, gttReason, warnings,
  };
}
