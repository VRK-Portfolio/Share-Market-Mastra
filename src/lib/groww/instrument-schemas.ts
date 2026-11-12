import { z } from "zod";

export const stockSymbolSchema = z.string().trim().toUpperCase().regex(
  /^[A-Z0-9][A-Z0-9&._-]{0,49}$/,
  "Enter an exact trading symbol.",
);
export const fnoInstrumentSchema = z.object({
  exchange: z.enum(["NSE", "BSE"]),
  tradingSymbol: stockSymbolSchema,
  growwSymbol: z.string().min(1).max(120),
  underlying: stockSymbolSchema,
  instrumentType: z.enum(["FUT", "CE", "PE"]),
  expiry: z.iso.date(),
  strikePrice: z.number().finite().positive().nullable(),
  lotSize: z.number().int().positive(),
  tickSize: z.number().finite().positive(),
}).refine((instrument) => instrument.instrumentType === "FUT"
  ? instrument.strikePrice === null : instrument.strikePrice !== null, "Invalid contract strike.");
export type FnoInstrument = z.infer<typeof fnoInstrumentSchema>;

export const instrumentSearchSchema = z.object({
  q: z.string().trim().toUpperCase().min(2).max(50).regex(/^[A-Z0-9&._ -]+$/),
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  type: z.enum(["ALL", "FUT", "CE", "PE"]).default("ALL"),
  expiry: z.iso.date().optional(),
  strike: z.coerce.number().finite().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
});
export const instrumentSearchResponseSchema = z.object({
  instruments: z.array(fnoInstrumentSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(30),
  hasMore: z.boolean(),
});
