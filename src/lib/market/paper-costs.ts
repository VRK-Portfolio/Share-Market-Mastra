import { z } from "zod";
import { defaultFeeAssumptions, executionFees, feeNames } from "./trade-calculator.ts";
import { paperSegment } from "./paper-instruments.ts";
import type { PaperInstrumentIdentity } from "./paper-instruments.ts";

export const paperCostModel = {
  id: "INDIA_FLAT20_V2" as const,
  brokerage: 20,
  bseIpftPercent: 0.00001,
  reviewedAt: "2026-11-18",
  slippageRate: 0.0005,
};

const paise = z.number().safe().int().nonnegative();
export const paperChargesSchema = z.object({
  brokerage: paise, stt: paise, exchange: paise, ipft: paise,
  sebi: paise, stampDuty: paise, dp: paise, gst: paise, total: paise,
}).refine(value => feeNames.reduce((sum, name) => sum + value[name], 0) === value.total,
  "Paper charge components do not match the total.");
export type PaperCharges = z.infer<typeof paperChargesSchema>;
export type PaperFeeSelection = PaperInstrumentIdentity & { product: "MIS" | "CNC" | "NRML" };
export const paperChargeLabels = {
  brokerage: "Brokerage", stt: "STT", exchange: "Exchange transaction charge", ipft: "IPF / IPFT",
  sebi: "SEBI turnover fee", stampDuty: "Stamp duty", dp: "DP charge", gst: "GST (18%)",
} as const;
export const paperFeeDisclosure = "Flat Rs20 brokerage per executed BUY and SELL, plus estimated STT, exchange/IPF, SEBI, stamp duty, GST and delivery-sell DP charges. Per-fill rounding can differ from contract notes. BSE uses standard-group transaction rates and modeled IPF of Rs0.01/lakh; actual group/contract charges can differ. Income tax, interest, penalties, exercise and physical settlement are excluded.";

export function paperCharges(notional: number, selection: PaperFeeSelection, side: "BUY" | "SELL"): PaperCharges {
  if (!Number.isSafeInteger(notional) || notional <= 0) throw new Error("Paper fee value cannot be represented safely.");
  const plan = { ...selection, segment: paperSegment(selection), mode: selection.product };
  const defaults = defaultFeeAssumptions(plan);
  if (!defaults) throw new Error("Paper charges require a matching exchange, product and verified contract.");
  const ipftPercent = selection.exchange === "BSE" ? paperCostModel.bseIpftPercent : defaults.ipftPercent;
  if (ipftPercent === null) throw new Error("The paper IPF/IPFT rate is unavailable for this exchange.");
  const fees = executionFees(plan, {
    ...defaults, brokerageOverride: paperCostModel.brokerage,
    ipftPercent,
  }, 1, notional / 100, side);
  return paperChargesSchema.parse({
    ...Object.fromEntries(feeNames.map(name => [name, Math.round(fees[name] * 100)])),
    total: Math.round(fees.total * 100),
  });
}

export function paperEstimatedFees(notional: number, selection: PaperFeeSelection, side: "BUY" | "SELL") {
  return paperCharges(notional, selection, side).total;
}

export function paperExecutionPrice(price: number, side: "BUY" | "SELL", tickSize = 0.01, limitPrice?: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error("A positive paper execution price and tick size are required.");
  }
  const slipped = price * (1 + (side === "BUY" ? 1 : -1) * paperCostModel.slippageRate);
  const ticks = side === "BUY" ? Math.ceil(slipped / tickSize - 1e-9) : Math.floor(slipped / tickSize + 1e-9);
  const result = Number((ticks * tickSize).toFixed(8));
  const capped = limitPrice === undefined ? result : side === "BUY" ? Math.min(result, limitPrice) : Math.max(result, limitPrice);
  if (!Number.isFinite(capped) || capped <= 0 || !Number.isSafeInteger(Math.round(capped * 100))) {
    throw new Error("Paper execution price cannot be represented safely.");
  }
  return capped;
}

export function paperPlannedRisk(selection: PaperFeeSelection, quantity: number, entry: number, stop: number, side: "BUY" | "SELL", tickSize = 0.01) {
  const exitSide = side === "BUY" ? "SELL" : "BUY";
  const exit = paperExecutionPrice(stop, exitSide, tickSize);
  const notional = Math.round(entry * 100) * quantity;
  const exitNotional = Math.round(exit * 100) * quantity;
  const distance = Math.max(0, (side === "BUY" ? 1 : -1) * (notional - exitNotional));
  return distance + paperEstimatedFees(notional, selection, side) + paperEstimatedFees(exitNotional, selection, exitSide);
}
