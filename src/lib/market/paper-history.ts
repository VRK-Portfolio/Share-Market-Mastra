import { PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount } from "./paper-trading.ts";

type PaperFill = PaperAccount["fills"][number];
export type PaperCompletedTrade = Pick<PaperFill, "symbol" | "exchange" | "product"> & {
  id: string; entrySide: PaperFill["side"]; quantity: number; entryValue: number; exitValue: number;
  realized: number; openedAt: number; closedAt: number;
};
type Cycle = Omit<PaperCompletedTrade, "closedAt"> & { remaining: number; basis: number };
export type PaperHistoryRow = { fill: PaperFill; role: "ENTRY" | "EXIT"; entryPrice: number };

function checkHistory(condition: boolean): asserts condition {
  if (!condition) throw new PaperTradingError("Saved paper history cannot be reconciled. Refresh your paper account; the success rate is unavailable.");
}

export function paperTradeHistory(account: PaperAccount) {
  const active = new Map<string, Cycle>();
  const completed: PaperCompletedTrade[] = [];
  const rows: PaperHistoryRow[] = [];
  // Replay persisted append order, including fills that share a timestamp.
  for (const fill of account.fills) {
    const key = positionKey(fill);
    const value = fill.price * fill.quantity;
    checkHistory(Number.isSafeInteger(value) && value > 0);
    let cycle = active.get(key);
    if (!cycle) {
      checkHistory(fill.realized === 0 && (fill.product !== "CNC" || fill.side === "BUY"));
      cycle = {
        id: fill.id, symbol: fill.symbol, exchange: fill.exchange, product: fill.product,
        entrySide: fill.side, quantity: 0, remaining: 0, basis: 0,
        entryValue: 0, exitValue: 0, realized: 0, openedAt: fill.at,
      };
      active.set(key, cycle);
    }
    if (fill.side === cycle.entrySide) {
      checkHistory(fill.realized === 0);
      cycle.quantity += fill.quantity;
      cycle.remaining += fill.quantity;
      cycle.basis += value;
      cycle.entryValue += value;
      rows.push({ fill, role: "ENTRY", entryPrice: fill.price });
    } else {
      checkHistory(fill.quantity <= cycle.remaining);
      const releasedBasis = value - (cycle.entrySide === "BUY" ? 1 : -1) * fill.realized;
      checkHistory(Number.isSafeInteger(releasedBasis) && releasedBasis > 0 && releasedBasis <= cycle.basis);
      cycle.remaining -= fill.quantity;
      cycle.basis -= releasedBasis;
      cycle.exitValue += value;
      cycle.realized += fill.realized;
      rows.push({ fill, role: "EXIT", entryPrice: releasedBasis / fill.quantity });
    }
    checkHistory([cycle.quantity, cycle.remaining, cycle.basis, cycle.entryValue, cycle.exitValue, cycle.realized].every(Number.isSafeInteger));
    if (!cycle.remaining) {
      checkHistory(cycle.basis === 0);
      completed.push({
        id: cycle.id, symbol: cycle.symbol, exchange: cycle.exchange, product: cycle.product,
        entrySide: cycle.entrySide, quantity: cycle.quantity, entryValue: cycle.entryValue,
        exitValue: cycle.exitValue, realized: cycle.realized, openedAt: cycle.openedAt, closedAt: fill.at,
      });
      active.delete(key);
    }
  }
  checkHistory(active.size === account.positions.length);
  for (const position of account.positions) {
    const cycle = active.get(positionKey(position));
    checkHistory(!!cycle && cycle.remaining * (cycle.entrySide === "BUY" ? 1 : -1) === position.quantity && cycle.basis === position.basis);
  }
  const realized = completed.reduce((sum, trade) => sum + trade.realized, 0);
  const partialRealized = [...active.values()].reduce((sum, cycle) => sum + cycle.realized, 0);
  checkHistory(Number.isSafeInteger(realized) && Number.isSafeInteger(partialRealized) && realized + partialRealized === account.realized);
  const wins = completed.filter((trade) => trade.realized > 0).length;
  const losses = completed.filter((trade) => trade.realized < 0).length;
  const breakEven = completed.length - wins - losses;
  return {
    rows, completed, wins, losses, breakEven, realized, partialRealized,
    successRate: completed.length ? wins / completed.length * 100 : null,
  };
}
