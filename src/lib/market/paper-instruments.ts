import { z } from "zod";
import { fnoInstrumentSchema, stockSymbolSchema } from "../groww/instrument-schemas.ts";
import type { FnoInstrument } from "../groww/instrument-schemas.ts";
import { intradayEntryCutoff, regularMarketSession } from "./market-session.ts";

export const paperIdentityFields = {
  symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]),
  product: z.enum(["MIS", "CNC", "NRML"]), segment: z.enum(["CASH", "FNO"]).optional(),
};
export const paperContractFields = { instrument: fnoInstrumentSchema.optional() };
export type PaperInstrumentIdentity = {
  symbol: string; exchange: "NSE" | "BSE"; segment?: "CASH" | "FNO"; instrument?: FnoInstrument;
};
export const paperSegment = (value: { segment?: "CASH" | "FNO" }) => value.segment ?? "CASH";
export const paperPriceKey = (value: PaperInstrumentIdentity) =>
  `${paperSegment(value) === "FNO" ? "FNO:" : ""}${value.exchange}:${value.symbol}`;
export const paperUnderlying = (value: PaperInstrumentIdentity) => value.instrument?.underlying ?? value.symbol;
export const validPaperProduct = (value: { product: string; segment?: "CASH" | "FNO" }) =>
  paperSegment(value) === "FNO" ? value.product !== "CNC" : value.product !== "NRML";
export function validPaperInstrument(value: PaperInstrumentIdentity & { product: string; quantity: number }) {
  if (!validPaperProduct(value)) return false;
  if (paperSegment(value) === "CASH") return !value.instrument;
  const instrument = value.instrument;
  return value.product !== "CNC" && !!instrument && instrument.tradingSymbol === value.symbol &&
    instrument.exchange === value.exchange && Number.isSafeInteger(value.quantity) &&
    Math.abs(value.quantity) % instrument.lotSize === 0;
}
export function paperContractError(value: PaperInstrumentIdentity & { product: string }, quantity: number,
  side: "BUY" | "SELL", closing: boolean, prices: number[], now: number) {
  if (!validPaperInstrument({ ...value, quantity })) return "Select a verified contract, matching product and whole-lot quantity.";
  if (paperSegment(value) !== "FNO") return null;
  const instrument = value.instrument!;
  if (prices.some(price => Math.abs(price / instrument.tickSize - Math.round(price / instrument.tickSize)) > 1e-6)) {
    return `Contract prices must follow the INR ${instrument.tickSize} tick size.`;
  }
  const date = regularMarketSession(now).date;
  if (instrument.expiry < date) return "This paper contract has expired. No settlement or expiry price is fabricated.";
  if (!closing && instrument.expiry === date && now >= intradayEntryCutoff(now)) return "New paper contract entries stop at 15:20 IST on expiry day.";
  if (!closing && instrument.instrumentType !== "FUT" && side === "SELL") return "Option SELL is exit-only. Buy contracts first; uncovered option writing is not supported.";
  return null;
}
