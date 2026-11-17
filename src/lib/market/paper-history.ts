import { paperAccountSchema, PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount } from "./paper-trading.ts";
import { paperSegment } from "./paper-instruments.ts";

type PaperFill = PaperAccount["fills"][number];
export type PaperCompletedTrade = Pick<PaperFill, "symbol" | "exchange" | "product" | "segment" | "instrument"> & {
  id: string; entrySide: PaperFill["side"]; quantity: number; entryValue: number; exitValue: number;
  realized: number; openedAt: number; closedAt: number; fees: number;
  costModel: "LEGACY" | "ESTIMATED_V1" | "MIXED";
};
type Cycle = Omit<PaperCompletedTrade, "closedAt"> & { remaining: number; basis: number };
export type PaperHistoryRow = { fill: PaperFill; role: "ENTRY" | "EXIT"; entryPrice: number };

function checkHistory(condition: boolean): asserts condition {
  if (!condition) throw new PaperTradingError("Saved paper history cannot be reconciled. Refresh your paper account; the success rate is unavailable.");
}

export function paperTradeHistory(account: PaperAccount, segment?: "CASH" | "FNO") {
  checkHistory(paperAccountSchema.safeParse(account).success);
  const active = new Map<string, Cycle>();
  const completed: PaperCompletedTrade[] = [];
  const rows: PaperHistoryRow[] = [];
  // Replay persisted append order, including fills that share a timestamp.
  for (const fill of account.fills) {
    const key = positionKey(fill);
    const value = fill.price * fill.quantity;
    const fees = fill.fees ?? 0;
    const costModel = fill.costModel === "ESTIMATED_V1" ? "ESTIMATED_V1" : "LEGACY";
    checkHistory(Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(fees) && fees >= 0 &&
      (costModel !== "LEGACY" || fees === 0));
    let cycle = active.get(key);
    if (!cycle) {
      checkHistory(fill.realized === -fees && (fill.product !== "CNC" || fill.side === "BUY"));
      cycle = {
        id: fill.id, symbol: fill.symbol, exchange: fill.exchange, product: fill.product,
        ...(fill.segment === "FNO" ? { segment: "FNO", instrument: fill.instrument } : {}),
        entrySide: fill.side, quantity: 0, remaining: 0, basis: 0,
        entryValue: 0, exitValue: 0, realized: 0, openedAt: fill.at, fees: 0, costModel,
      };
      active.set(key, cycle);
    }
    if (cycle.costModel !== costModel) cycle.costModel = "MIXED";
    cycle.fees += fees;
    if (fill.side === cycle.entrySide) {
      checkHistory(fill.realized === -fees);
      cycle.quantity += fill.quantity;
      cycle.remaining += fill.quantity;
      cycle.basis += value;
      cycle.entryValue += value;
      cycle.realized += fill.realized;
      rows.push({ fill, role: "ENTRY", entryPrice: fill.price });
    } else {
      checkHistory(fill.quantity <= cycle.remaining);
      const releasedBasis = value - (cycle.entrySide === "BUY" ? 1 : -1) * (fill.realized + fees);
      checkHistory(Number.isSafeInteger(releasedBasis) && releasedBasis > 0 &&
        releasedBasis === Math.round(cycle.basis * (fill.quantity / cycle.remaining)));
      cycle.remaining -= fill.quantity;
      cycle.basis -= releasedBasis;
      cycle.exitValue += value;
      cycle.realized += fill.realized;
      rows.push({ fill, role: "EXIT", entryPrice: releasedBasis / fill.quantity });
    }
    checkHistory([cycle.quantity, cycle.remaining, cycle.basis, cycle.entryValue, cycle.exitValue, cycle.realized, cycle.fees].every(Number.isSafeInteger));
    if (!cycle.remaining) {
      checkHistory(cycle.basis === 0);
      completed.push({
        id: cycle.id, symbol: cycle.symbol, exchange: cycle.exchange, product: cycle.product,
        ...(cycle.segment === "FNO" ? { segment: "FNO", instrument: cycle.instrument } : {}),
        entrySide: cycle.entrySide, quantity: cycle.quantity, entryValue: cycle.entryValue,
        exitValue: cycle.exitValue, realized: cycle.realized, openedAt: cycle.openedAt, closedAt: fill.at,
        fees: cycle.fees, costModel: cycle.costModel,
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
  const scoped = completed.filter(trade => !segment || paperSegment(trade) === segment);
  const wins = scoped.filter((trade) => trade.realized > 0).length;
  const losses = scoped.filter((trade) => trade.realized < 0).length;
  const breakEven = scoped.length - wins - losses;
  return {
    rows: rows.filter(row => !segment || paperSegment(row.fill) === segment), completed: scoped, wins, losses, breakEven,
    realized: scoped.reduce((sum, trade) => sum + trade.realized, 0),
    partialRealized: [...active.values()].filter(cycle => !segment || paperSegment(cycle) === segment).reduce((sum, cycle) => sum + cycle.realized, 0),
    successRate: scoped.length ? wins / scoped.length * 100 : null,
  };
}
