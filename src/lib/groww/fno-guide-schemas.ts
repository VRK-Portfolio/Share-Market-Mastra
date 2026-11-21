import { z } from "zod";
import { fnoInstrumentSchema, stockSymbolSchema } from "./instrument-schemas.ts";
import { benchmarkSnapshotSchema } from "./benchmark-schemas.ts";
import { optionUnderlyingInstrumentSchema } from "./option-analytics-schemas.ts";

// Retain the guide's wire keys while supporting both stock and index underlyings.
export const optionIndexSchema = z.object({ underlying: stockSymbolSchema, index: optionUnderlyingInstrumentSchema });
export const optionIndexListSchema = z.object({ indices: z.array(optionIndexSchema) });
export const optionTrendSchema = z.object({
  bias: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  closedThrough: z.number().safe().positive().nullable(),
  reasons: z.array(z.string()), error: z.string().optional(),
});
export const fnoGuideSchema = z.object({
  underlying: stockSymbolSchema, index: optionUnderlyingInstrumentSchema,
  expiry: z.iso.date(), expiries: z.array(z.iso.date()), type: z.enum(["CE", "PE"]),
  spot: benchmarkSnapshotSchema, trend: optionTrendSchema,
  nearestStrike: z.number().positive(), strikes: z.array(z.number().positive()), contracts: z.array(fnoInstrumentSchema),
});
export type FnoGuide = z.infer<typeof fnoGuideSchema>;
export type OptionTrend = z.infer<typeof optionTrendSchema>;
