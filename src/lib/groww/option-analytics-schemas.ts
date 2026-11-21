import { z } from "zod";
import { cashInstrumentSchema, fnoInstrumentSchema } from "./instrument-schemas.ts";
import { benchmarkSnapshotSchema } from "./benchmark-schemas.ts";

export const optionUnderlyingInstrumentSchema = cashInstrumentSchema.extend({ instrumentType: z.enum(["EQ", "IDX"]) });
export const optionUnderlyingSnapshotSchema = z.object({
  contract: fnoInstrumentSchema, underlying: optionUnderlyingInstrumentSchema, quote: benchmarkSnapshotSchema,
}).refine(value => value.contract.instrumentType !== "FUT" && value.contract.exchange === value.underlying.exchange &&
  value.quote.exchange === value.underlying.exchange && value.quote.symbol === value.underlying.tradingSymbol,
"The option underlying response does not match the selected contract.");
