import { z } from "zod";
import { paperContractFields, paperIdentityFields, validPaperInstrument, validPaperProduct } from "./paper-instruments.ts";

const paise = z.number().safe().int().positive();
const rupees = z.number().finite().positive().refine((value) =>
  Number.isSafeInteger(Math.round(value * 100)) && Math.round(value * 100) > 0, "Enter a valid price of at least INR 0.01.");
export const paperProtectionSchema = z.object({ targetPrice: rupees, stopPrice: rupees }).strict();
const identity = {
  ...paperIdentityFields,
  side: z.enum(["BUY", "SELL"]), quantity: z.number().safe().int().positive(),
};
export const paperOrderRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("LIMIT"), limitPrice: rupees, protection: paperProtectionSchema.optional() }).strict(),
  z.object({ ...identity, kind: z.literal("GTT"), limitPrice: rupees, triggerPrice: rupees,
    triggerDirection: z.enum(["UP", "DOWN"]), protection: paperProtectionSchema.optional() }).strict(),
  z.object({ ...identity, kind: z.literal("BRACKET"), targetPrice: rupees, stopPrice: rupees }).strict(),
]).refine(validPaperProduct, "Use CASH MIS/CNC or F&O MIS/NRML.");
export const paperOrderSchema = z.object({
  ...identity, ...paperContractFields, id: z.uuid(), kind: z.enum(["LIMIT", "GTT", "BRACKET"]),
  status: z.enum(["PENDING", "TRIGGERED", "FILLED", "CANCELLED", "EXPIRED", "REJECTED"]),
  intent: z.enum(["OPEN", "CLOSE"]), reservedCash: z.number().safe().int().nonnegative(),
  createdAt: paise, updatedAt: paise, expiresAt: paise.optional(),
  limitPrice: paise.optional(), triggerPrice: paise.optional(), triggerDirection: z.enum(["UP", "DOWN"]).optional(),
  targetPrice: paise.optional(), stopPrice: paise.optional(),
  protection: z.object({ targetPrice: paise, stopPrice: paise }).optional(),
  fillPrice: paise.optional(), reason: z.string().max(250).optional(),
}).superRefine((order, context) => {
  if (!validPaperInstrument(order) ||
    (order.segment === "FNO" && order.intent === "OPEN" && order.side === "SELL" && order.instrument?.instrumentType !== "FUT") ||
    (order.kind !== "BRACKET" && !order.limitPrice) ||
    (order.kind === "GTT" && (!order.triggerPrice || !order.triggerDirection || order.product !== "CNC")) ||
    (order.kind === "BRACKET" && (!order.targetPrice || !order.stopPrice || order.intent !== "CLOSE")) ||
    (!["PENDING", "TRIGGERED"].includes(order.status) && order.reservedCash !== 0) ||
    (order.intent === "CLOSE" && order.reservedCash !== 0)) {
    context.addIssue({ code: "custom", message: "Invalid saved paper order." });
  }
});
export type PaperOrder = z.infer<typeof paperOrderSchema>;
export type PaperOrderRequest = z.infer<typeof paperOrderRequestSchema>;
export type PaperProtection = z.infer<typeof paperProtectionSchema>;
export const activePaperOrder = (order: Pick<PaperOrder, "status">) => order.status === "PENDING" || order.status === "TRIGGERED";
