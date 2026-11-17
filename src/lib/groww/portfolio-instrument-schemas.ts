import { z } from "zod";
import { feedSelectionSchema } from "./live-schemas.ts";

export const portfolioInstrumentSelectionSchema = z.object({
  symbol: z.string().trim().min(1).max(100),
  isin: z.string().trim().min(1).max(50).optional(),
  exchange: z.string().trim().min(1).max(20).optional(),
  segment: z.string().trim().min(1).max(20).optional(),
}).strict();
export const portfolioInstrumentSelectionsSchema = z.array(portfolioInstrumentSelectionSchema).min(1).max(50);
export type PortfolioInstrumentSelection = z.infer<typeof portfolioInstrumentSelectionSchema>;
export const portfolioInstrumentKey = (item: PortfolioInstrumentSelection) =>
  JSON.stringify([item.symbol.trim().toUpperCase(), item.isin?.trim() ?? "", item.exchange?.trim().toUpperCase() ?? "", item.segment?.trim().toUpperCase() ?? ""]);

export const portfolioInstrumentResolutionSchema = z.object({
  selection: portfolioInstrumentSelectionSchema,
  instrument: feedSelectionSchema.nullable(),
  error: z.string().min(1).nullable(),
}).refine(value => (value.instrument !== null) !== (value.error !== null), "Return an instrument or an explicit resolution error.");
export const portfolioInstrumentResolutionsSchema = z.array(portfolioInstrumentResolutionSchema).min(1).max(50);
