import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";
import { regularMarketSession } from "./market-session.ts";
import { activePaperOrder, paperOrderRequestSchema, paperOrderSchema, paperProtectionSchema } from "./paper-order-schemas.ts";

export const paperStorageKey = "trade-terminal:paper-account:v1";
const integer = z.number().safe();
const positiveInteger = integer.int().positive();
const identity = { symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]), product: z.enum(["MIS", "CNC"]) };
const positionSchema = z.object({
  ...identity, quantity: integer.int().refine((value) => value !== 0), basis: positiveInteger,
  margin: positiveInteger.optional(),
  openedAt: z.number().int().positive(),
}).transform((position) => ({ ...position, margin: position.margin ?? position.basis }))
  .refine((position) => position.margin <= position.basis &&
    (position.product !== "CNC" || position.quantity > 0 && position.margin === position.basis));
const fillSchema = z.object({
  ...identity, id: z.uuid(), side: z.enum(["BUY", "SELL"]), quantity: positiveInteger,
  price: positiveInteger, at: z.number().int().positive(), quoteTime: z.number().int().positive(), realized: integer.int(),
  reason: z.enum(["MARKET", "LIMIT", "GTT", "TARGET", "STOP_LOSS", "SQUARE_OFF"]).optional(),
});
export const paperAccountSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).transform(() => 2 as const),
  initialBalance: z.literal(10_000_000), cash: integer.int(), realized: integer.int(),
  positions: z.array(positionSchema), fills: z.array(fillSchema), orders: z.array(paperOrderSchema).default([]),
}).superRefine((account, context) => {
  const keys = account.positions.map(positionKey);
  const reserved = account.positions.reduce((total, position) => total + position.margin, 0) +
    account.orders.reduce((total, order) => total + order.reservedCash, 0);
  if (new Set(keys).size !== keys.length || new Set(account.fills.map((fill) => fill.id)).size !== account.fills.length ||
    new Set(account.orders.map((order) => order.id)).size !== account.orders.length ||
    !Number.isSafeInteger(reserved) || account.cash + reserved !== account.initialBalance + account.realized ||
    account.fills.reduce((sum, fill) => sum + fill.realized, 0) !== account.realized) {
    context.addIssue({ code: "custom", message: "Paper account balances or records are inconsistent." });
  }
});
export type PaperAccount = z.infer<typeof paperAccountSchema>;
export const paperSnapshotSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative().safe(),
  account: paperAccountSchema, syncedAt: z.iso.datetime(),
});
const commandFields = {
  operationId: z.uuid(), expectedRevision: z.number().int().nonnegative().safe(),
  accountId: paperSnapshotSchema.shape.accountId,
};
export const paperCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...commandFields, type: z.literal("RESET"), confirmed: z.literal(true) }).strict(),
  z.object({
    ...commandFields, ...identity, type: z.literal("TRADE"), side: z.enum(["BUY", "SELL"]), quantity: positiveInteger,
    quoteProof: z.string().min(1).max(2048).optional(),
    protection: paperProtectionSchema.optional(),
  }).strict(),
  z.object({ ...commandFields, type: z.literal("PLACE"), order: paperOrderRequestSchema }).strict(),
  z.object({ ...commandFields, type: z.literal("CANCEL"), orderId: z.uuid() }).strict(),
  z.object({ ...commandFields, type: z.literal("PROCESS"), symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]),
    quoteProof: z.string().min(1).max(2048).optional() }).strict(),
]);
export type PaperCommand = z.infer<typeof paperCommandSchema>;
type Instruction<T> = T extends unknown ? Omit<T, keyof typeof commandFields> : never;
export type PaperInstruction = Instruction<PaperCommand>;
export type PaperSnapshot = z.infer<typeof paperSnapshotSchema>;
export type PaperPosition = z.infer<typeof positionSchema>;
export type PaperQuote = {
  symbol: string; exchange: "NSE" | "BSE"; product: "MIS" | "CNC";
  segment: "CASH" | "FNO"; price: number; tradeTime: number | null; quoteProof?: string;
};
export type PaperLivePrice = {
  symbol: string; exchange: "NSE" | "BSE"; segment: "CASH" | "FNO";
  price: number; tradeTime: number; receivedAt: string; observedAt: number; paperQuoteProof?: string;
};

export function positionKey(value: Pick<PaperPosition, "symbol" | "exchange" | "product">) {
  return `${value.exchange}:${value.symbol}:${value.product}`;
}
export function newPaperAccount(): PaperAccount {
  return { version: 2, initialBalance: 10_000_000, cash: 10_000_000, realized: 0, positions: [], fills: [], orders: [] };
}
export class PaperTradingError extends Error {}
export const paperIntradayLeverage = 5;
export function paperRequiredMargin(product: PaperPosition["product"], notional: number) {
  if (!Number.isSafeInteger(notional) || notional <= 0) throw new PaperTradingError("Paper order value exceeds the supported range.");
  return Math.ceil(notional / (product === "MIS" ? paperIntradayLeverage : 1));
}
export const paperIntradayCutoff = (now: number) => regularMarketSession(now).closesAt - 10 * 60_000;
export function readPaperAccount(storage: Pick<Storage, "getItem">): PaperAccount {
  const raw = storage.getItem(paperStorageKey);
  if (raw === null) return newPaperAccount();
  const result = paperAccountSchema.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error("Saved paper account is damaged. Reset it explicitly to start again.");
  return result.data;
}
export function paperQuoteError(quote: PaperQuote | null, now = Date.now()): string | null {
  if (!quote || quote.segment !== "CASH") return "Select a cash stock and load its market price.";
  if (regularMarketSession(now).phase !== "open") return "Paper fills require the regular weekday session, 09:15-15:30 IST.";
  if (!Number.isFinite(quote.price) || quote.price <= 0 || !Number.isSafeInteger(Math.round(quote.price * 100)) ||
    Math.round(quote.price * 100) <= 0 || quote.tradeTime === null || !Number.isSafeInteger(quote.tradeTime) ||
    now - quote.tradeTime > 60_000 || quote.tradeTime > now + 5000 ||
    regularMarketSession(quote.tradeTime).date !== regularMarketSession(now).date) {
    return "A same-day trade price less than 60 seconds old is required. Refresh market data.";
  }
  return null;
}
export function fillPaperOrder(
  account: PaperAccount, quote: PaperQuote, side: "BUY" | "SELL", quantity: number,
  now = Date.now(), id = crypto.randomUUID(),
  reason: z.infer<typeof fillSchema>["reason"] = "MARKET",
): PaperAccount {
  const error = paperQuoteError(quote, now);
  if (error) throw new PaperTradingError(error);
  const order = fillSchema.parse({
    symbol: quote.symbol, exchange: quote.exchange, product: quote.product, id, side, quantity,
    price: Math.round(quote.price * 100), at: now, quoteTime: quote.tradeTime, realized: 0, reason,
  });
  const key = positionKey(order);
  const existing = account.positions.find((position) => positionKey(position) === key);
  const direction = side === "BUY" ? 1 : -1;
  const closing = !!existing && Math.sign(existing.quantity) !== direction;
  const notional = order.price * quantity;
  if (!Number.isSafeInteger(notional)) throw new PaperTradingError("Paper order value exceeds the supported range.");
  if (quote.product === "CNC" && side === "SELL" && !existing) throw new PaperTradingError("Carry-forward SELL requires paper holdings. Uncovered delivery shorts are not allowed.");
  if (closing && quantity > Math.abs(existing.quantity)) throw new PaperTradingError("Close no more than the open quantity. Close first before reversing direction.");
  if (!closing && quote.product === "MIS" && now >= paperIntradayCutoff(now)) {
    throw new PaperTradingError("New intraday entries stop at 15:20 IST. Only exits are allowed afterward.");
  }
  if (!closing && existing?.product === "MIS" && regularMarketSession(existing.openedAt).date !== regularMarketSession(now).date) {
    throw new PaperTradingError("This intraday position is overdue. Close it before adding a new position.");
  }
  const requiredMargin = closing ? 0 : paperRequiredMargin(quote.product, notional);
  if (!closing && requiredMargin > account.cash) throw new PaperTradingError("Insufficient virtual cash. Intraday entries reserve 20% (5x leverage); CNC purchases require full cash.");
  const released = closing ? Math.round(existing.basis * (quantity / Math.abs(existing.quantity))) : 0;
  // Round partial margin releases down without reserving more than the remaining entry basis.
  const releasedMargin = closing ? Math.max(
    Math.floor(existing.margin * (quantity / Math.abs(existing.quantity))),
    existing.margin - (existing.basis - released),
  ) : 0;
  order.realized = closing ? Math.sign(existing.quantity) * (notional - released) : 0;
  const nextQuantity = (existing?.quantity ?? 0) + direction * quantity;
  const position: PaperPosition = {
    symbol: order.symbol, exchange: order.exchange, product: order.product,
    quantity: nextQuantity, basis: (existing?.basis ?? 0) + (closing ? -released : notional),
    margin: (existing?.margin ?? 0) + (closing ? -releasedMargin : requiredMargin),
    openedAt: existing?.openedAt ?? now,
  };
  return paperAccountSchema.parse({
    ...account, cash: account.cash + (closing ? releasedMargin + order.realized : -requiredMargin),
    realized: account.realized + order.realized,
    positions: [...account.positions.filter((item) => positionKey(item) !== key), ...(nextQuantity ? [position] : [])],
    fills: [...account.fills, order],
    orders: account.orders.map((pending) => activePaperOrder(pending) && pending.intent === "CLOSE" && positionKey(pending) === key
      ? { ...pending, status: "CANCELLED", updatedAt: now, reason: "Position quantity changed; reapply exit protection." } : pending),
  });
}

export function paperPositionPnl(position: PaperPosition, price: number) {
  return Math.sign(position.quantity) * (Math.round(price * 100) * Math.abs(position.quantity) - position.basis);
}

export function paperPositionMark(position: PaperPosition, tick: PaperLivePrice | undefined, now = Date.now()) {
  if (!tick || tick.symbol !== position.symbol || tick.exchange !== position.exchange || !freshPaperPrice(tick, now)) return null;
  const pnl = paperPositionPnl(position, tick.price);
  return { price: tick.price, value: Math.round(tick.price * 100) * Math.abs(position.quantity),
    pnl, pnlPercent: pnl / position.basis * 100 };
}
export function paperProductSummary(account: PaperAccount, product: PaperPosition["product"],
  prices: Record<string, PaperLivePrice>, now: number) {
  const positions = account.positions.filter((position) => position.product === product);
  const marks = positions.map((position) => paperPositionMark(position, prices[`${position.exchange}:${position.symbol}`], now));
  const freshPrices = marks.filter((mark) => mark !== null).length;
  return {
    positions: positions.length, freshPrices,
    margin: positions.reduce((sum, position) => sum + position.margin, 0),
    entryValue: positions.reduce((sum, position) => sum + position.basis, 0),
    value: freshPrices === positions.length ? marks.reduce((sum, mark) => sum + (mark?.value ?? 0), 0) : null,
    pnl: freshPrices === positions.length ? marks.reduce((sum, mark) => sum + (mark?.pnl ?? 0), 0) : null,
    realized: account.fills.filter((fill) => fill.product === product).reduce((sum, fill) => sum + fill.realized, 0),
  };
}
export function freshPaperPrice(tick: PaperLivePrice | undefined, now = Date.now()): tick is PaperLivePrice {
  if (!tick || tick.segment !== "CASH" ||
    !Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.observedAt) ||
    !Number.isSafeInteger(tick.tradeTime)) return false;
  const ageAtReceipt = Date.parse(tick.receivedAt) - tick.tradeTime;
  return Number.isFinite(ageAtReceipt) && ageAtReceipt >= -5000 &&
    ageAtReceipt + Math.max(0, now - tick.observedAt) <= 60_000;
}
