import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { feedInstrumentSchema } from "../groww/live-schemas.ts";
import { sessionKey } from "../groww/session.ts";

const executionQuoteSchema = feedInstrumentSchema.pick({ symbol: true, exchange: true }).extend({
  segment: z.literal("CASH"), price: z.number().finite().positive(),
  tradeTime: z.number().safe().int().positive(), issuedAt: z.number().safe().int().positive(),
}).strict();
type ExecutionQuote = z.infer<typeof executionQuoteSchema>;

function signature(token: string, payload: string) {
  return createHmac("sha256", sessionKey()).update("paper-execution:v1\0")
    .update(token).update("\0").update(payload).digest();
}

export function signExecutionQuote(token: string, quote: Omit<ExecutionQuote, "issuedAt">) {
  const payload = Buffer.from(JSON.stringify({ ...quote, issuedAt: Date.now() })).toString("base64url");
  return `${payload}.${signature(token, payload).toString("base64url")}`;
}

export function verifyExecutionQuote(token: string, proof: string, now = Date.now()): ExecutionQuote {
  const invalid = () => new Error("The live paper price could not be verified. Reconnect the live feed before submitting.");
  if (proof.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(proof)) throw invalid();
  const [payload, mac] = proof.split(".");
  const actual = Buffer.from(mac, "base64url");
  const expected = signature(token, payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw invalid(); }
  const result = executionQuoteSchema.safeParse(decoded);
  if (!result.success) throw invalid();
  if (now - result.data.issuedAt > 60_000 || result.data.issuedAt > now + 5000) {
    throw new Error("The verified live paper price expired. Wait for a new live tick before submitting.");
  }
  return result.data;
}
