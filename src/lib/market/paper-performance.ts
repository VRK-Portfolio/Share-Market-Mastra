import { paperTradeHistory } from "./paper-history.ts";
import type { PaperCompletedTrade } from "./paper-history.ts";
import type { PaperAccount } from "./paper-trading.ts";

function tradeMetrics(trades: PaperCompletedTrade[]) {
  const winners = trades.filter((trade) => trade.realized > 0);
  const losers = trades.filter((trade) => trade.realized < 0);
  const profit = winners.reduce((sum, trade) => sum + trade.realized, 0);
  const loss = losers.reduce((sum, trade) => sum + trade.realized, 0);
  const sampleSize = trades.length;
  return {
    sampleSize, wins: winners.length, losses: losers.length,
    breakEven: sampleSize - winners.length - losers.length,
    netRealized: profit + loss,
    expectancy: sampleSize ? (profit + loss) / sampleSize : null,
    averageWinner: winners.length ? profit / winners.length : null,
    averageLoser: losers.length ? loss / losers.length : null,
    profitFactor: losers.length ? profit / -loss : null,
    score: sampleSize ? winners.length / sampleSize * 100 : null,
    // Thirty closed cycles is a descriptive minimum, not a significance test.
    insufficientEvidence: sampleSize < 30,
  };
}

export function paperPerformance(account: PaperAccount) {
  const history = paperTradeHistory(account);
  let equity: number = account.initialBalance;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const fill of account.fills) {
    equity += fill.realized;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? drawdown / peak * 100 : 0);
  }
  return {
    ...tradeMetrics(history.completed),
    partialRealized: history.partialRealized,
    realizedEquity: equity, maxDrawdown, maxDrawdownPercent,
    fees: account.fills.reduce((sum, fill) => sum + (fill.fees ?? 0), 0),
    modeledFills: account.fills.filter((fill) => fill.costModel === "ESTIMATED_V1").length,
    legacyFills: account.fills.filter((fill) => fill.costModel !== "ESTIMATED_V1").length,
    cohorts: {
      legacy: tradeMetrics(history.completed.filter((trade) => trade.costModel === "LEGACY")),
      modeled: tradeMetrics(history.completed.filter((trade) => trade.costModel === "ESTIMATED_V1")),
      mixed: tradeMetrics(history.completed.filter((trade) => trade.costModel === "MIXED")),
    },
  };
}
