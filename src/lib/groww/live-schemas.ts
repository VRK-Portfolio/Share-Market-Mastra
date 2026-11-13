import { z } from "zod";
import { stockSymbolSchema } from "./instrument-schemas.ts";
import type { MarketAnalysis } from "../market/types.ts";

export const feedInstrumentSchema = z.object({
  symbol: stockSymbolSchema,
  exchange: z.enum(["NSE", "BSE"]),
  segment: z.enum(["CASH", "FNO"]),
  exchangeToken: z.string().regex(/^\d{1,20}$/),
  instrumentType: z.enum(["EQ", "IDX", "FUT", "CE", "PE"]),
});
export type FeedInstrument = z.infer<typeof feedInstrumentSchema>;
export const feedDiagnosticSchema = z.object({
  stage: z.enum(["startup", "socket-token", "connection", "subscription", "decoding", "disconnected"]).optional(),
  failureType: z.enum(["missing-dependency", "authentication", "rate-limit", "timeout", "tls", "invalid-tick",
    "invalid-response", "invalid-config", "disconnected", "sdk-failure", "connection-failed",
    "subscription-failed", "worker-failure"]).optional(),
  upstreamCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
export type FeedDiagnostic = z.infer<typeof feedDiagnosticSchema>;
export const workerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected") }),
  z.object({ type: z.literal("tick"), price: z.number().finite().positive(), tradeTime: z.number().int().positive().max(8_640_000_000_000_000) }),
  feedDiagnosticSchema.extend({ type: z.literal("error"), code: z.union([z.literal(401), z.literal(403), z.literal(429), z.literal(502), z.literal(503), z.literal(504)]) }),
]);
const identity = feedInstrumentSchema.pick({ symbol: true, exchange: true, segment: true });
export const liveEventSchema = z.discriminatedUnion("type", [
  identity.extend({ type: z.literal("connected") }),
  identity.extend({ type: z.literal("tick"), price: z.number().finite().positive(), tradeTime: z.number().int().positive().max(8_640_000_000_000_000), receivedAt: z.iso.datetime() }),
  identity.extend({ ...feedDiagnosticSchema.shape, type: z.literal("error"), code: z.number().int(), error: z.string().min(1).max(300) }),
]);
export type LiveTick = Extract<z.infer<typeof liveEventSchema>, { type: "tick" }>;

export class LiveEventDecoder {
  private buffer = "";

  push(chunk: string): z.infer<typeof liveEventSchema>[] {
    this.buffer += chunk;
    if (this.buffer.length > 65_536) throw new Error("The Groww stream message exceeded the allowed size.");
    const events: z.infer<typeof liveEventSchema>[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) {
        try {
          events.push(liveEventSchema.parse(JSON.parse(data)));
        } catch {
          throw new Error("Groww returned an invalid live price message.");
        }
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

export function applyLiveTick(analysis: MarketAnalysis, tick: LiveTick): MarketAnalysis {
  if (tick.symbol !== analysis.symbol || tick.exchange !== analysis.exchange || tick.segment !== (analysis.segment ?? "CASH") ||
    tick.tradeTime < (analysis.quote.lastTradeTime ?? 0)) return analysis;
  const previousClose = analysis.quote.previousClose;
  return {
    ...analysis,
    quote: {
      ...analysis.quote, price: tick.price, lastTradeTime: tick.tradeTime,
      change: previousClose > 0 ? tick.price - previousClose : null,
      changePercent: previousClose > 0 ? (tick.price - previousClose) / previousClose * 100 : null,
    },
  };
}
