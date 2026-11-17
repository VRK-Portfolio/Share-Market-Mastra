import { z } from "zod";
import { cashInstrumentSchema, stockSymbolSchema } from "./instrument-schemas.ts";

export const indexInstrumentSchema = cashInstrumentSchema.extend({ instrumentType: z.literal("IDX") });
export const indexListSchema = z.object({ indices: z.array(indexInstrumentSchema) });
export const benchmarkSnapshotSchema = z.object({
  symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]), name: z.string().nullable(),
  price: z.number().finite().positive(), previousClose: z.number().finite().positive(),
  lastTradeTime: z.number().finite().positive().max(8_640_000_000_000_000 - 330 * 60_000).nullable(),
  fetchedAt: z.iso.datetime(),
});
export type BenchmarkSnapshot = z.infer<typeof benchmarkSnapshotSchema>;
