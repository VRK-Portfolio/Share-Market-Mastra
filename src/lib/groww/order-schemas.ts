import { z } from "zod";
import { stockSymbolSchema } from "./instrument-schemas.ts";

export const orderSelectionSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.enum(["NSE", "BSE"]),
  segment: z.enum(["CASH", "FNO"]),
  product: z.enum(["MIS", "CNC", "NRML"]),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT"]),
  quantity: z.number().int().positive().max(1_000_000),
  limitPrice: z.number().finite().positive().nullable(),
  execution: z.enum(["PAPER", "LIVE"]),
}).strict().superRefine((value, context) => {
  if (value.segment === "CASH" ? value.product === "NRML" : value.product === "CNC") {
    context.addIssue({ code: "custom", message: "Use MIS/CNC for CASH and MIS/NRML for F&O." });
  }
  if ((value.orderType === "LIMIT") !== (value.limitPrice !== null)) {
    context.addIssue({ code: "custom", message: "A LIMIT order needs a price; a MARKET order must not supply a limit price." });
  }
});
export type OrderSelection = z.infer<typeof orderSelectionSchema>;
export const orderInstrumentSchema = z.object({
  symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]), segment: z.enum(["CASH", "FNO"]),
  instrumentType: z.enum(["EQ", "FUT", "CE", "PE"]),
  lotSize: z.number().int().positive(), tickSize: z.number().finite().positive(),
  expiry: z.iso.date().nullable(),
}).refine((value) => value.segment === "CASH" ? value.instrumentType === "EQ" && value.expiry === null
  : value.instrumentType !== "EQ" && value.expiry !== null, "Order metadata must match its market segment.");
export const orderPreviewSchema = z.object({
  reference: z.string().regex(/^[a-f0-9]{20}$/),
  order: orderSelectionSchema,
  instrument: orderInstrumentSchema,
  quotePrice: z.number().finite().positive(),
  quoteTime: z.number().finite().nonnegative().nullable(),
  estimatedValue: z.number().finite().positive(),
  preparedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
});
export type OrderPreview = z.infer<typeof orderPreviewSchema>;
export const orderResultSchema = z.object({
  reference: orderPreviewSchema.shape.reference,
  execution: z.enum(["PAPER", "LIVE"]),
  state: z.enum(["NOT_SUBMITTED", "UNKNOWN", "BROKER_REPORTED", "PAPER_FILLED", "PAPER_PENDING"]),
  message: z.string().min(1).max(600),
  brokerOrderId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  brokerStatus: z.enum(["NEW", "ACKED", "TRIGGER_PENDING", "APPROVED", "REJECTED", "FAILED", "EXECUTED",
    "DELIVERY_AWAITED", "CANCELLED", "CANCELLATION_REQUESTED", "MODIFICATION_REQUESTED", "COMPLETED"]).optional(),
  simulatedPrice: z.number().finite().positive().optional(),
});
export type OrderResult = z.infer<typeof orderResultSchema>;
export const brokerOrderSchema = z.object({
  groww_order_id: orderResultSchema.shape.brokerOrderId.unwrap(),
  order_status: orderResultSchema.shape.brokerStatus.unwrap(),
  order_reference_id: orderPreviewSchema.shape.reference.optional(),
});
export function parseBrokerOrder(body: unknown) {
  const envelope = z.object({ status: z.literal("SUCCESS"), payload: brokerOrderSchema.optional() }).passthrough().parse(body);
  return brokerOrderSchema.parse(envelope.payload ?? body);
}

export function onTickSize(price: number, tickSize: number) {
  const ticks = price / tickSize;
  return Math.abs(ticks - Math.round(ticks)) < 1e-7;
}
