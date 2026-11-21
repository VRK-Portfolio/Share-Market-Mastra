import { activePaperOrder } from "./paper-order-schemas.ts";
import { freshPaperPrice, paperPositionMark, PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount, PaperLivePrice, PaperPosition } from "./paper-trading.ts";
import type { PaperOrder } from "./paper-order-schemas.ts";
import { paperSquareOffDue } from "./paper-orders.ts";
import { regularMarketSession } from "./market-session.ts";
import { paperEstimatedFees, paperExecutionPrice, paperPlannedRisk } from "./paper-costs.ts";
import type { PaperFeeSelection } from "./paper-costs.ts";
import { paperPriceKey, paperUnderlying } from "./paper-instruments.ts";

export const paperRiskPolicy = { perTrade: 0.005, dailyLoss: 0.015, openRisk: 0.02, stockNotional: 0.20 } as const;
export type PaperRiskPrices = Record<string, PaperLivePrice>;

type PaperExitSuggestion = {
  action: "EXIT" | "REVIEW" | "HOLD" | "WAIT";
  title: string; reason: string; targetPrice?: number; stopPrice?: number;
};

export function paperExitSuggestion(position: PaperPosition, orders: PaperOrder[], tick: PaperLivePrice | undefined,
  now = Date.now()): PaperExitSuggestion {
  const session = regularMarketSession(now);
  if (position.segment === "FNO" && position.instrument!.expiry < session.date) {
    return { action: "REVIEW", title: "Expired position needs review",
      reason: "This contract has expired. A live exit or settlement price cannot be assumed." };
  }
  if (session.phase !== "open") {
    return { action: "WAIT", title: "Market closed",
      reason: "No live exit suggestion outside the regular session. Review again when trading resumes." };
  }
  const mark = paperPositionMark(position, tick, now);
  if (!mark || !tick || regularMarketSession(tick.tradeTime).date !== session.date || tick.tradeTime > now + 5000) {
    return { action: "WAIT", title: "Refresh live price",
      reason: "A fresh, same-day price for this position is required. Do not rely on an old price to exit." };
  }
  if (paperSquareOffDue(position, now)) {
    return { action: "EXIT", title: "Consider closing now",
      reason: position.product === "MIS"
        ? "Intraday square-off is due: it is past 15:20 IST or this position is overdue."
        : "Expiry-day square-off is due after 15:20 IST. Avoid leaving this contract unresolved." };
  }
  const long = position.quantity > 0;
  const protection = orders.find(order => activePaperOrder(order) && order.kind === "BRACKET" &&
    order.intent === "CLOSE" && positionKey(order) === positionKey(position) &&
    order.side === (long ? "SELL" : "BUY") && order.quantity === Math.abs(position.quantity) &&
    (order.expiresAt === undefined || order.expiresAt > now));
  if (!protection?.targetPrice || !protection.stopPrice) {
    return { action: "REVIEW", title: "Set an exit plan",
      reason: "No active target and stop-loss cover the whole position. Add protection or consider closing; profit/loss alone is not an exit signal." };
  }
  const levels = { targetPrice: protection.targetPrice, stopPrice: protection.stopPrice };
  const price = Math.round(mark.price * 100);
  if (long ? price <= protection.stopPrice : price >= protection.stopPrice) {
    return { ...levels, action: "EXIT", title: "Consider exiting: stop-loss reached",
      reason: "Price has reached or crossed your saved stop. Closing follows your risk limit; waiting risks a larger loss." };
  }
  if (long ? price >= protection.targetPrice : price <= protection.targetPrice) {
    return { ...levels, action: "EXIT", title: "Consider exiting: target reached",
      reason: "Price has reached or crossed your saved target. Closing follows your planned exit; net profit still depends on fees and the fill price." };
  }
  return { ...levels, action: "HOLD", title: "Hold only within your exit plan",
    reason: "Price is between your saved stop and target; neither exit has triggered. Keep the stop in place, not a wider stop to avoid a loss." };
}

export function paperRiskReport(account: PaperAccount, prices: PaperRiskPrices, now = Date.now()) {
  const date = regularMarketSession(now).date;
  const blockers: string[] = [];
  let pnl = 0, freshPrices = 0, positionRisk = 0, unprotected = 0, pendingRisk = 0;
  const active = account.orders.filter(activePaperOrder);
  for (const position of account.positions) {
    const mark = paperPositionMark(position, prices[paperPriceKey(position)], now);
    if (mark) { pnl += mark.pnl; freshPrices++; }
    const protection = active.find(order => order.kind === "BRACKET" && positionKey(order) === positionKey(position) &&
      order.quantity === Math.abs(position.quantity));
    if (!protection?.stopPrice) { unprotected++; continue; }
    if (mark) {
      const direction = position.quantity > 0 ? 1 : -1;
      const stopExit = paperExecutionPrice(protection.stopPrice / 100, direction > 0 ? "SELL" : "BUY", position.instrument?.tickSize);
      positionRisk += Math.max(0, direction * Math.abs(position.quantity) * (Math.round(mark.price * 100) - Math.round(stopExit * 100))) +
        paperEstimatedFees(Math.abs(position.quantity) * Math.round(stopExit * 100), position, direction > 0 ? "SELL" : "BUY");
      if (direction > 0 ? mark.price * 100 <= protection.stopPrice || mark.price * 100 >= protection.targetPrice!
        : mark.price * 100 >= protection.stopPrice || mark.price * 100 <= protection.targetPrice!) {
        blockers.push("A protective exit is due. Browser-only exits require connected automation or a manual close.");
      }
    }
  }
  let pendingUnprotected = false;
  for (const order of active.filter(order => order.intent === "OPEN")) {
    if (!order.protection || !order.limitPrice) { pendingUnprotected = true; continue; }
    pendingRisk += paperPlannedRisk(order, order.quantity, order.limitPrice / 100, order.protection.stopPrice / 100, order.side, order.instrument?.tickSize);
  }
  const equity = freshPrices === account.positions.length ? account.initialBalance + account.realized + pnl : null;
  const priorRealized = account.fills.filter(fill => regularMarketSession(fill.at).date < date).reduce((sum, fill) => sum + fill.realized, 0);
  const dailyLimit = Math.max(0, Math.floor((account.initialBalance + priorRealized) * paperRiskPolicy.dailyLoss));
  const realizedLoss = account.fills.filter(fill => regularMarketSession(fill.at).date === date)
    .reduce((sum, fill) => sum - Math.min(0, fill.realized), 0);
  const openLoss = account.positions.reduce((sum, position) => {
    const mark = paperPositionMark(position, prices[paperPriceKey(position)], now);
    return sum - Math.min(0, mark?.pnl ?? 0);
  }, 0);
  const dailyLoss = realizedLoss + openLoss;
  const dailyLocked = dailyLoss >= dailyLimit;
  if (equity === null) blockers.push("Fresh prices for every open position are needed for complete risk guidance.");
  else if (!Number.isSafeInteger(equity) || equity <= 0) blockers.push("Positive, safely valued account equity is required.");
  if (dailyLocked) blockers.push("Daily paper loss guideline reached. This is informational; new entries are not locked.");
  if (unprotected || pendingUnprotected) blockers.push("Unprotected exposure has no complete stop-risk estimate. Adding protection is optional.");
  const totalRisk = positionRisk + pendingRisk;
  const openRisk = !unprotected && !pendingUnprotected && equity !== null && Number.isSafeInteger(totalRisk) ? totalRisk : null;
  const openRiskLimit = equity !== null && Number.isSafeInteger(equity) && equity > 0
    ? Math.floor(equity * paperRiskPolicy.openRisk) : null;
  const remainingOpenRisk = openRisk !== null && openRiskLimit !== null ? Math.max(0, openRiskLimit - openRisk) : null;
  if (!Number.isSafeInteger(totalRisk)) blockers.push("Combined paper risk cannot be represented safely; risk guidance is unavailable.");
  if (openRisk !== null && equity !== null && openRisk > equity * paperRiskPolicy.openRisk) blockers.push("Combined open risk exceeds 2% of equity.");
  return { equity, dailyLoss, dailyLimit, dailyLocked, openRisk, openRiskLimit, remainingOpenRisk,
    positionRisk: openRisk === null ? null : positionRisk, unprotected, freshPrices,
    positions: account.positions.length, pendingRisk, blockers };
}

export function paperSuggestedQuantity(selection: PaperFeeSelection, equity: number, entry: number, stop: number, side: "BUY" | "SELL", tickSize = 0.01,
  remainingOpenRisk = equity * paperRiskPolicy.openRisk) {
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(stop) || stop <= 0 || !Number.isFinite(remainingOpenRisk) || remainingOpenRisk <= 0 ||
    (side === "BUY" ? stop >= entry : stop <= entry)) return 0;
  const budget = Math.min(equity * paperRiskPolicy.perTrade, remainingOpenRisk);
  const byStock = Math.floor(equity * paperRiskPolicy.stockNotional / Math.round(entry * 100));
  const lotSize = selection.instrument?.lotSize ?? 1;
  let low = 0, high = Math.floor(byStock / lotSize);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (paperPlannedRisk(selection, middle * lotSize, entry, stop, side, tickSize) <= budget) low = middle;
    else high = middle - 1;
  }
  return low * lotSize;
}

// Optional strict-policy diagnostic; paper submissions do not invoke this assertion.
export function assertPaperEntryRisk(previous: PaperAccount, next: PaperAccount, entry: PaperFeeSelection & {
  symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; stop: number;
  underlying?: string; tickSize?: number;
}, prices: PaperRiskPrices, now = Date.now()) {
  const before = paperRiskReport(previous, prices, now);
  if (before.blockers.length) throw new PaperTradingError(before.blockers.join(" "));
  const after = paperRiskReport(next, prices, now);
  if (after.blockers.length) throw new PaperTradingError(after.blockers.join(" "));
  if (before.equity === null || after.equity === null) throw new PaperTradingError("Fresh account equity is required.");
  const equity = Math.min(before.equity, after.equity);
  if (paperPlannedRisk(entry, entry.quantity, entry.price, entry.stop, entry.side, entry.tickSize) > equity * paperRiskPolicy.perTrade) {
    throw new PaperTradingError("Planned entry loss including estimated costs exceeds 0.5% of equity. Reduce quantity or review the stop.");
  }
  let stockNotional = 0;
  for (const position of next.positions.filter(position => paperUnderlying(position) === (entry.underlying ?? entry.symbol))) {
    const tick = prices[paperPriceKey(position)];
    if (!freshPaperPrice(tick, now)) throw new PaperTradingError("A fresh stock price is required for concentration checks.");
    stockNotional += Math.abs(position.quantity) * Math.round((position.symbol === entry.symbol ? Math.max(tick.price, entry.price) : tick.price) * 100);
  }
  stockNotional += next.orders.filter(order => activePaperOrder(order) && order.intent === "OPEN" &&
    paperUnderlying(order) === (entry.underlying ?? entry.symbol))
    .reduce((sum, order) => sum + order.quantity * order.limitPrice!, 0);
  if (!Number.isSafeInteger(stockNotional) || stockNotional > equity * paperRiskPolicy.stockNotional) {
    throw new PaperTradingError("Combined stock exposure including pending entries exceeds 20% of equity. Reduce quantity.");
  }
}
