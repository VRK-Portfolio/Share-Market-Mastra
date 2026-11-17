import { activePaperOrder } from "./paper-order-schemas.ts";
import { freshPaperPrice, paperPositionMark, PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount, PaperLivePrice } from "./paper-trading.ts";
import { regularMarketSession } from "./market-session.ts";
import { paperEstimatedFees, paperExecutionPrice, paperPlannedRisk } from "./paper-costs.ts";
import { paperPriceKey, paperUnderlying } from "./paper-instruments.ts";

export const paperRiskPolicy = { perTrade: 0.005, dailyLoss: 0.015, openRisk: 0.02, stockNotional: 0.20 } as const;
export type PaperRiskPrices = Record<string, PaperLivePrice>;

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
        paperEstimatedFees(Math.abs(position.quantity) * Math.round(stopExit * 100));
      if (direction > 0 ? mark.price * 100 <= protection.stopPrice || mark.price * 100 >= protection.targetPrice!
        : mark.price * 100 >= protection.stopPrice || mark.price * 100 <= protection.targetPrice!) {
        blockers.push("A protective exit is due. Process or close it before adding risk.");
      }
    }
  }
  let pendingUnprotected = false;
  for (const order of active.filter(order => order.intent === "OPEN")) {
    if (!order.protection || !order.limitPrice) { pendingUnprotected = true; continue; }
    pendingRisk += paperPlannedRisk(order.quantity, order.limitPrice / 100, order.protection.stopPrice / 100, order.side, order.instrument?.tickSize);
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
  const dailyLocked = account.riskHaltDate === date || dailyLoss >= dailyLimit;
  if (equity === null) blockers.push("Fresh prices for every open position are required before increasing risk.");
  else if (!Number.isSafeInteger(equity) || equity <= 0) blockers.push("Positive, safely valued account equity is required.");
  if (dailyLocked) blockers.push("Daily paper loss limit reached. New entries are locked for this IST date; exits remain available.");
  if (unprotected || pendingUnprotected) blockers.push("Protect or cancel all unprotected exposure before adding risk.");
  const totalRisk = positionRisk + pendingRisk;
  const openRisk = !unprotected && !pendingUnprotected && equity !== null && Number.isSafeInteger(totalRisk) ? totalRisk : null;
  if (!Number.isSafeInteger(totalRisk)) blockers.push("Combined paper risk cannot be represented safely. Reduce exposure before adding risk.");
  if (openRisk !== null && equity !== null && openRisk > equity * paperRiskPolicy.openRisk) blockers.push("Combined open risk exceeds 2% of equity.");
  return { equity, dailyLoss, dailyLimit, dailyLocked, openRisk, unprotected, freshPrices,
    positions: account.positions.length, pendingRisk, blockers };
}

export function paperSuggestedQuantity(equity: number, entry: number, stop: number, side: "BUY" | "SELL", tickSize = 0.01) {
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(stop) || stop <= 0 || (side === "BUY" ? stop >= entry : stop <= entry)) return 0;
  const unitRisk = paperPlannedRisk(1, entry, stop, side, tickSize);
  const byRisk = Math.floor(equity * paperRiskPolicy.perTrade / unitRisk);
  const byStock = Math.floor(equity * paperRiskPolicy.stockNotional / Math.round(entry * 100));
  return Math.max(0, Math.min(byRisk, byStock));
}

export function assertPaperEntryRisk(previous: PaperAccount, next: PaperAccount, entry: {
  symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; stop: number;
  underlying?: string; tickSize?: number;
}, prices: PaperRiskPrices, now = Date.now()) {
  const before = paperRiskReport(previous, prices, now);
  if (before.blockers.length) throw new PaperTradingError(before.blockers.join(" "));
  const after = paperRiskReport(next, prices, now);
  if (after.blockers.length) throw new PaperTradingError(after.blockers.join(" "));
  if (before.equity === null || after.equity === null) throw new PaperTradingError("Fresh account equity is required.");
  const equity = Math.min(before.equity, after.equity);
  if (paperPlannedRisk(entry.quantity, entry.price, entry.stop, entry.side, entry.tickSize) > equity * paperRiskPolicy.perTrade) {
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
