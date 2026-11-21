import { paperAccountSchema, PaperTradingError, positionKey } from "./paper-trading.ts";
import type { PaperAccount } from "./paper-trading.ts";
import { paperSegment } from "./paper-instruments.ts";
import { regularMarketSession } from "./market-session.ts";

type PaperFill = PaperAccount["fills"][number];
export type PaperCompletedTrade = Pick<PaperFill, "symbol" | "exchange" | "product" | "segment" | "instrument"> & {
  id: string; entrySide: PaperFill["side"]; quantity: number; entryValue: number; exitValue: number;
  realized: number; openedAt: number; closedAt: number; fees: number;
  costModel: "LEGACY" | "ESTIMATED_V1" | "INDIA_FLAT20_V2" | "MIXED";
  outcomeReason: string;
};
type Cycle = Omit<PaperCompletedTrade, "closedAt" | "outcomeReason"> & {
  remaining: number; basis: number; exitReasons: PaperFill["reason"][];
};
export type PaperHistoryRow = { fill: PaperFill; role: "ENTRY" | "EXIT"; entryPrice: number };

const rupees = (paise: number) => `Rs${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const exitLabels = {
  MARKET: "market exit", LIMIT: "limit exit", GTT: "GTT exit",
  TARGET: "target hit", STOP_LOSS: "stop-loss triggered", SQUARE_OFF: "automatic square-off",
} satisfies Record<NonNullable<PaperFill["reason"]>, string>;

function outcomeReason(cycle: Cycle) {
  const gross = cycle.realized + cycle.fees;
  const movement = gross === 0 ? "Average exit matched entry"
    : cycle.entrySide === "BUY" ? `Sold ${gross > 0 ? "above" : "below"} entry`
      : `Bought back ${gross > 0 ? "below" : "above"} entry`;
  const prices = `${rupees(cycle.entryValue / cycle.quantity)} -> ${rupees(cycle.exitValue / cycle.quantity)}`;
  const exits = cycle.exitReasons.map(reason => reason === undefined ? "exit trigger not recorded" : exitLabels[reason]).join(", ");
  const fees = cycle.fees === 0 ? ""
    : gross > 0 && cycle.realized <= 0
      ? ` Fees of ${rupees(cycle.fees)} ${cycle.realized < 0 ? "exceeded" : "used up"} the price gain.`
      : gross === 0 ? ` Fees of ${rupees(cycle.fees)} caused the net loss.`
        : ` Fees ${gross > 0 ? "reduced the gain" : "added to the loss"} by ${rupees(cycle.fees)}.`;
  return `${movement} (${prices}). Exits: ${exits}.${fees}`;
}

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
    const costModel = fill.costModel ?? "LEGACY";
    checkHistory(Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(fees) && fees >= 0 &&
      (costModel !== "LEGACY" || fees === 0));
    let cycle = active.get(key);
    if (!cycle) {
      checkHistory(fill.realized === -fees && (fill.product !== "CNC" || fill.side === "BUY"));
      cycle = {
        id: fill.id, symbol: fill.symbol, exchange: fill.exchange, product: fill.product,
        ...(fill.segment === "FNO" ? { segment: "FNO", instrument: fill.instrument } : {}),
        entrySide: fill.side, quantity: 0, remaining: 0, basis: 0,
        entryValue: 0, exitValue: 0, realized: 0, openedAt: fill.at, fees: 0, costModel, exitReasons: [],
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
      if (!cycle.exitReasons.includes(fill.reason)) cycle.exitReasons.push(fill.reason);
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
        fees: cycle.fees, costModel: cycle.costModel, outcomeReason: outcomeReason(cycle),
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
  const scopedRows = rows.filter(row => !segment || paperSegment(row.fill) === segment);
  const daily = new Map<string, { date: string; profit: number; loss: number; netRealized: number; fees: number; fills: number }>();
  for (const { fill } of scopedRows) {
    const date = regularMarketSession(fill.at).date;
    const day = daily.get(date) ?? { date, profit: 0, loss: 0, netRealized: 0, fees: 0, fills: 0 };
    day.profit += Math.max(0, fill.realized);
    day.loss += Math.max(0, -fill.realized);
    day.netRealized += fill.realized;
    day.fees += fill.fees ?? 0;
    day.fills++;
    checkHistory([day.profit, day.loss, day.netRealized, day.fees, day.fills].every(Number.isSafeInteger));
    daily.set(date, day);
  }
  return {
    rows: scopedRows, completed: scoped, wins, losses, breakEven,
    daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)),
    realized: scoped.reduce((sum, trade) => sum + trade.realized, 0),
    partialRealized: [...active.values()].filter(cycle => !segment || paperSegment(cycle) === segment).reduce((sum, cycle) => sum + cycle.realized, 0),
    successRate: scoped.length ? wins / scoped.length * 100 : null,
  };
}
