import { activePaperOrder, paperOrderRequestSchema } from "./paper-order-schemas.ts";
import type { PaperOrder, PaperOrderRequest, PaperProtection } from "./paper-order-schemas.ts";
import { fillPaperOrder, freshPaperPrice, paperAccountSchema, paperIntradayCutoff, paperQuoteError, paperRequiredMargin, PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount, PaperInstruction, PaperLivePrice, PaperQuote } from "./paper-trading.ts";
import { regularMarketSession } from "./market-session.ts";

const cents = (value: number) => Math.round(value * 100);
const findPosition = (account: PaperAccount, order: Pick<PaperOrder, "symbol" | "exchange" | "product">) =>
  account.positions.find((position) => positionKey(position) === positionKey(order));
function protectionValid(protection: PaperProtection, long: boolean, reference: number) {
  if (!(long ? protection.stopPrice < reference && reference < protection.targetPrice
    : protection.targetPrice < reference && reference < protection.stopPrice)) {
    throw new PaperTradingError("For longs, stop < entry < target; for shorts, target < entry < stop.");
  }
}
export function checkPaperEntryProtection(protection: PaperProtection, side: "BUY" | "SELL", price: number) {
  protectionValid({ targetPrice: cents(protection.targetPrice), stopPrice: cents(protection.stopPrice) }, side === "BUY", cents(price));
}
function settle(account: PaperAccount, id: string, status: PaperOrder["status"], now: number, reason: string, fillPrice?: number) {
  const order = account.orders.find((item) => item.id === id);
  if (!order || !activePaperOrder(order)) throw new PaperTradingError("This paper order is no longer active. Refresh the account.");
  return paperAccountSchema.parse({
    ...account, cash: account.cash + order.reservedCash,
    orders: account.orders.map((item) => item.id === id
      ? { ...item, status, reservedCash: 0, updatedAt: now, reason, ...(fillPrice ? { fillPrice } : {}) } : item),
  });
}
export function cancelPaperOrder(account: PaperAccount, id: string, now = Date.now()) {
  return settle(account, id, "CANCELLED", now, "Cancelled by user.");
}
export function placePaperOrder(account: PaperAccount, input: PaperOrderRequest, now = Date.now(), id = crypto.randomUUID()): PaperAccount {
  const request = paperOrderRequestSchema.parse(input);
  const session = regularMarketSession(now);
  if (request.kind === "GTT" && request.product !== "CNC") throw new PaperTradingError("GTT is available only for CNC delivery. Intraday orders expire at 15:20 IST.");
  if (request.kind !== "GTT" && session.phase !== "open") throw new PaperTradingError("Place day orders and exit protection during the regular market session.");
  if (request.product === "MIS" && now >= paperIntradayCutoff(now)) throw new PaperTradingError("New intraday orders stop at 15:20 IST.");
  const existing = findPosition(account, request);
  const closing = !!existing && Math.sign(existing.quantity) !== (request.side === "BUY" ? 1 : -1);
  if (!closing && existing?.product === "MIS" && regularMarketSession(existing.openedAt).date !== session.date) {
    throw new PaperTradingError("Close the overdue intraday position before placing another entry.");
  }
  if (request.product === "CNC" && request.side === "SELL" && !closing) throw new PaperTradingError("A delivery SELL requires paper holdings.");
  if (closing && request.quantity > Math.abs(existing.quantity)) throw new PaperTradingError("The exit quantity exceeds paper holdings.");
  if (request.kind === "BRACKET" && !closing) throw new PaperTradingError("Target/stop protection requires an existing opposite-side position.");
  if (request.kind !== "BRACKET" && request.protection && closing) throw new PaperTradingError("Attach target/stop protection to an entry, not an exit.");
  if (request.kind === "BRACKET" && account.orders.some((item) => activePaperOrder(item) && item.kind === "BRACKET" && positionKey(item) === positionKey(request))) {
    throw new PaperTradingError("Cancel the existing target/stop order before replacing it.");
  }
  const protection = request.kind !== "BRACKET" && request.protection
    ? { targetPrice: cents(request.protection.targetPrice), stopPrice: cents(request.protection.stopPrice) } : undefined;
  const limitPrice = request.kind !== "BRACKET" ? cents(request.limitPrice) : undefined;
  if (protection && limitPrice) protectionValid(protection, request.side === "BUY", limitPrice);
  if (request.kind === "BRACKET" && existing &&
    !(existing.quantity > 0 ? cents(request.stopPrice) < cents(request.targetPrice) : cents(request.targetPrice) < cents(request.stopPrice))) {
    throw new PaperTradingError("Long exits require stop < target; short exits require target < stop.");
  }
  const reservedCash = closing ? 0 : paperRequiredMargin(request.product, (limitPrice ?? 0) * request.quantity);
  if (!Number.isSafeInteger(reservedCash) || !closing && reservedCash > account.cash) throw new PaperTradingError("Insufficient virtual cash to reserve this pending order.");
  const order: PaperOrder = {
    symbol: request.symbol, exchange: request.exchange, product: request.product, side: request.side, quantity: request.quantity,
    id, kind: request.kind, status: "PENDING", intent: closing ? "CLOSE" : "OPEN", reservedCash, createdAt: now, updatedAt: now,
    ...(request.product === "MIS" ? { expiresAt: paperIntradayCutoff(now) }
      : request.kind === "LIMIT" ? { expiresAt: session.closesAt } : {}),
    ...(limitPrice ? { limitPrice } : {}),
    ...(request.kind === "GTT" ? { triggerPrice: cents(request.triggerPrice), triggerDirection: request.triggerDirection } : {}),
    ...(request.kind === "BRACKET" ? { targetPrice: cents(request.targetPrice), stopPrice: cents(request.stopPrice) } : {}),
    ...(protection ? { protection } : {}),
  };
  return paperAccountSchema.parse({ ...account, cash: account.cash - reservedCash, orders: [...account.orders, order] });
}
export function protectPaperPosition(account: PaperAccount, selection: Pick<PaperQuote, "symbol" | "exchange" | "product">,
  protection: PaperProtection, now = Date.now()) {
  const position = findPosition(account, selection);
  if (!position) throw new PaperTradingError("The paper position no longer exists.");
  return placePaperOrder(account, { symbol: selection.symbol, exchange: selection.exchange, product: selection.product,
    kind: "BRACKET", side: position.quantity > 0 ? "SELL" : "BUY",
    quantity: Math.abs(position.quantity), ...protection }, now);
}
export function expirePaperOrders(account: PaperAccount, now: number) {
  let next = account;
  for (const order of account.orders) if (activePaperOrder(order) && order.expiresAt !== undefined && order.expiresAt <= now) {
    next = settle(next, order.id, "EXPIRED", now, "Day-order validity ended; reserved cash released.");
  }
  return next;
}
export function paperOrderPriceReady(order: PaperOrder, price: number) {
  const value = cents(price);
  if (order.kind === "BRACKET") return order.side === "SELL"
    ? value >= order.targetPrice! || value <= order.stopPrice!
    : value <= order.targetPrice! || value >= order.stopPrice!;
  if (order.kind === "GTT" && order.status === "PENDING") {
    return order.triggerDirection === "UP" ? value >= order.triggerPrice! : value <= order.triggerPrice!;
  }
  return order.side === "BUY" ? value <= order.limitPrice! : value >= order.limitPrice!;
}
export function paperSquareOffDue(position: PaperAccount["positions"][number], now: number) {
  const session = regularMarketSession(now);
  return position.product === "MIS" && session.phase === "open" &&
    (now >= paperIntradayCutoff(now) || regularMarketSession(position.openedAt).date !== session.date);
}
export function processPaperOrders(account: PaperAccount, quote: PaperQuote | null, now = Date.now()): PaperAccount {
  let next = expirePaperOrders(account, now);
  if (!quote) return next;
  const quoteError = paperQuoteError(quote, now);
  if (quoteError) throw new PaperTradingError(quoteError);
  const matching = (item: { symbol: string; exchange: string }) => item.symbol === quote.symbol && item.exchange === quote.exchange;
  for (const position of [...next.positions]) if (matching(position) && paperSquareOffDue(position, now)) {
    next = fillPaperOrder(next, { ...quote, product: "MIS" }, position.quantity > 0 ? "SELL" : "BUY", Math.abs(position.quantity), now, crypto.randomUUID(), "SQUARE_OFF");
  }
  for (const original of [...next.orders]) {
    const order = next.orders.find((item) => item.id === original.id)!;
    if (!activePaperOrder(order) || !matching(order)) continue;
    const existing = findPosition(next, order);
    const opposite = !!existing && Math.sign(existing.quantity) !== (order.side === "BUY" ? 1 : -1);
    if (order.intent === "CLOSE" && (!opposite || order.quantity > Math.abs(existing.quantity)) ||
      order.intent === "OPEN" && opposite) {
      next = settle(next, order.id, "CANCELLED", now, "Position changed; this order can no longer execute as intended.");
      continue;
    }
    if (!paperOrderPriceReady(order, quote.price)) continue;
    if (order.kind === "GTT" && order.status === "PENDING") {
      next = paperAccountSchema.parse({ ...next, orders: next.orders.map((item) => item.id === order.id
        ? { ...item, status: "TRIGGERED", updatedAt: now, reason: "Trigger reached; waiting for limit price or better." } : item) });
      const triggered = next.orders.find((item) => item.id === order.id)!;
      if (!paperOrderPriceReady(triggered, quote.price)) continue;
    }
    const reason = order.kind === "BRACKET"
      ? ((order.side === "SELL" ? cents(quote.price) >= order.targetPrice! : cents(quote.price) <= order.targetPrice!) ? "TARGET" : "STOP_LOSS")
      : order.kind;
    const released = settle(next, order.id, "FILLED", now,
      `${reason} filled at the verified market price; linked triggers are no longer active.`, cents(quote.price));
    try {
      next = fillPaperOrder(released, { ...quote, product: order.product }, order.side, order.quantity, now, order.id, reason);
    } catch (error) {
      if (!(error instanceof PaperTradingError)) throw error;
      next = paperAccountSchema.parse({ ...released, orders: released.orders.map((item) => item.id === order.id
        ? { ...item, status: "REJECTED", fillPrice: undefined, reason: error.message.slice(0, 250) } : item) });
      continue;
    }
    if (order.protection) next = protectPaperPosition(next, order, {
      targetPrice: order.protection.targetPrice / 100, stopPrice: order.protection.stopPrice / 100,
    }, now);
  }
  return next;
}
export function nextPaperProcessing(account: PaperAccount, prices: Record<string, PaperLivePrice>, now: number): PaperInstruction | null {
  const expired = account.orders.find((order) => activePaperOrder(order) && order.expiresAt !== undefined && order.expiresAt <= now);
  if (expired) return { type: "PROCESS", symbol: expired.symbol, exchange: expired.exchange };
  const instruments = [...account.positions, ...account.orders.filter(activePaperOrder)];
  for (const item of instruments) {
    const tick = prices[`${item.exchange}:${item.symbol}`];
    if (!tick?.paperQuoteProof) continue;
    const quote: PaperQuote = { ...item, segment: "CASH", price: tick.price, tradeTime: tick.tradeTime };
    if (!freshPaperPrice(tick, now) || paperQuoteError(quote, now)) continue;
    if (account.positions.some((position) => position.symbol === item.symbol && position.exchange === item.exchange && paperSquareOffDue(position, now)) ||
      account.orders.some((order) => activePaperOrder(order) && order.symbol === item.symbol && order.exchange === item.exchange && paperOrderPriceReady(order, tick.price))) {
      return { type: "PROCESS", symbol: item.symbol, exchange: item.exchange, quoteProof: tick.paperQuoteProof };
    }
  }
  return null;
}
