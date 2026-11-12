import { z } from "zod";

const holdingSchema = z.object({
  isin: z.string().min(1),
  trading_symbol: z.string().min(1),
  quantity: z.number().finite(),
  average_price: z.number().finite(),
});

const positionSchema = z.object({
  trading_symbol: z.string().min(1),
  segment: z.string().optional(),
  exchange: z.string().min(1),
  product: z.string().min(1),
  quantity: z.number().finite(),
  net_price: z.number().finite(),
  realised_pnl: z.number().finite(),
});

export const holdingsResponseSchema = z.object({
  status: z.literal("SUCCESS"),
  payload: z.object({ holdings: z.array(holdingSchema) }),
});

export const positionsResponseSchema = z.object({
  status: z.literal("SUCCESS"),
  payload: z.object({ positions: z.array(positionSchema) }),
});
