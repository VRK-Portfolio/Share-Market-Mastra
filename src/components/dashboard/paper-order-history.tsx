"use client";

import { memo, useMemo, useState } from "react";
import { paperTradeHistory } from "../../lib/market/paper-history";
import { PaperTradingError } from "../../lib/market/paper-trading";
import type { PaperAccount } from "../../lib/market/paper-trading";
import { money } from "./format";
import { PaperChargeBreakdown } from "./paper-charge-breakdown";

const time = (at: number) => `${new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;
const outcome = (pnl: number) => pnl > 0 ? "Profit" : pnl < 0 ? "Loss" : "Break-even";
const pnlColor = (pnl: number) => pnl > 0 ? "text-positive" : pnl < 0 ? "text-negative" : "text-muted";
const shortTime = (at: number) => new Date(at).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});

export const PaperOrderHistory = memo(function PaperOrderHistory({ account, segment }: { account: PaperAccount; segment?: "CASH" | "FNO" }) {
  const [view, setView] = useState<"completed" | "fills">("completed");
  const [search, setSearch] = useState("");
  const result = useMemo(() => {
    try { return { history: paperTradeHistory(account, segment), error: null }; }
    catch (error) {
      if (!(error instanceof PaperTradingError)) throw error;
      return { history: null, error: error.message };
    }
  }, [account, segment]);
  const history = result.history;
  const query = search.trim().toUpperCase();
  const matches = (item: { symbol: string; exchange: string; product: string }) =>
    `${item.symbol} ${item.exchange} ${item.product}`.includes(query);
  const completed = history?.completed.filter(matches).toReversed() ?? [];
  const rows = history?.rows.filter(({ fill }) => matches(fill)).toReversed() ?? [];
  return <section className="text-xs" aria-label="Paper order history and success rate">
    <h3 className="text-sm font-semibold">History &amp; performance</h3>
    <p className="mt-1 text-muted">Your saved {segment === "FNO" ? "F&O" : segment === "CASH" ? "stock" : ""} trades, their results and what you can learn.</p>
    {!history ? <p role="alert" className="mt-2 text-negative">{result.error}</p> : <>
      <div className="mt-4 rounded-xl border border-line p-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-muted">Historical success</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-accent" aria-label="Historical paper success rate">
              {history.successRate === null ? "--" : history.successRate.toFixed(1)}<span className="ml-1 text-xs font-normal text-muted">/ 100</span>
            </p>
            <p className="mt-1 text-[10px] text-muted">{history.completed.length} fully closed trades</p>
          </div>
          <div className="min-w-0">
            <p className="text-muted">Completed-trade P&amp;L</p>
            <p className={`mt-2 break-all font-mono text-lg font-semibold ${pnlColor(history.realized)}`}>{money(history.realized / 100)}</p>
            <p className="mt-1 text-[10px] text-muted">After combining partial exits</p>
          </div>
        </div>
        <div aria-hidden="true" className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-line">
          {history.completed.length > 0 && <>
            <span className="bg-positive" style={{ width: `${history.wins / history.completed.length * 100}%` }} />
            <span className="bg-negative" style={{ width: `${history.losses / history.completed.length * 100}%` }} />
            <span className="bg-muted" style={{ width: `${history.breakEven / history.completed.length * 100}%` }} />
          </>}
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2">
          <div className="flex flex-wrap gap-x-1.5"><dt className="text-muted">Wins</dt><dd className="font-mono font-semibold text-positive">{history.wins}</dd></div>
          <div className="flex flex-wrap gap-x-1.5"><dt className="text-muted">Losses</dt><dd className="font-mono font-semibold text-negative">{history.losses}</dd></div>
          <div className="flex flex-wrap gap-x-1.5"><dt className="text-muted">Break-even</dt><dd className="font-mono font-semibold">{history.breakEven}</dd></div>
        </dl>
      </div>
      <p className="mt-2 text-muted">Saved results include modeled fees only where recorded; legacy fills remain cost-free. Mixed cycles combine different schedules and may include cost-free fills. <a href="/risk" className="text-accent underline">Compare cost cohorts &amp; net expectancy</a>.</p>
      {history.partialRealized !== 0 && <p className="mt-2 text-muted">Open-cycle realized P&amp;L (partial exits and entry fees): {money(history.partialRealized / 100)}. Not scored yet.</p>}
      <details className="mt-3 text-[11px] text-muted">
        <summary className="cursor-pointer">How the score works (not a forecast)</summary>
        <p className="mt-2 leading-relaxed">{history.successRate === null ? "No fully closed trades yet. " : ""}
        Wins / all fully closed trades x 100. Partial exits are combined until the position is flat; break-even trades count in the total, not as wins.
        Open positions and unfilled/cancelled orders do not count. All {segment ?? "account"} trades, exchanges and products since the last account reset are included.
        This is observed paper performance, not a future success probability. New modeled fills include estimated fees and slippage; legacy history is unchanged. Win rate alone does not measure expectancy.</p>
      </details>
      <section className="mt-4 rounded-xl border border-line p-3" aria-label="Daily paper profit and loss">
        <h4 className="text-sm font-semibold">Date-wise profit &amp; loss</h4>
        <p className="mt-1 text-[11px] text-muted">IST fill dates, newest first. Positive and negative net fill results include recorded fees, entry costs and partial exits. Open unrealized P&amp;L is excluded. Covers all {segment === "FNO" ? "F&O" : segment === "CASH" ? "stock" : "account"} fills, regardless of the search below.</p>
        {history.daily.length ? <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <caption className="sr-only">Realized paper profit and loss by IST execution date</caption>
            <thead className="text-muted">
              <tr>
                <th scope="col" className="pb-2 pr-3 font-medium">Date (IST)</th>
                <th scope="col" className="pb-2 px-2 text-right font-medium">Profit</th>
                <th scope="col" className="pb-2 px-2 text-right font-medium">Loss</th>
                <th scope="col" className="pb-2 pl-2 text-right font-medium">Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {history.daily.map(day => <tr key={day.date} className="border-t border-line">
                <th scope="row" className="whitespace-nowrap py-2 pr-3 font-normal">
                  <time dateTime={day.date}>{new Date(`${day.date}T00:00:00+05:30`).toLocaleDateString("en-IN", {
                    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
                  })}</time>
                  <span className="mt-1 block text-[10px] text-muted">{day.fills} {day.fills === 1 ? "fill" : "fills"}</span>
                </th>
                <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-positive">{money(day.profit / 100)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-negative">{money(day.loss / 100)}</td>
                <td className={`whitespace-nowrap py-2 pl-2 text-right font-mono font-semibold ${pnlColor(day.netRealized)}`}>{money(day.netRealized / 100)}</td>
              </tr>)}
            </tbody>
          </table>
        </div> : <p className="mt-3 text-muted">No executed fills yet. Daily results appear after your first paper fill.</p>}
      </section>
      <label className="mt-4 block text-[11px] text-muted">Find a trade
        <input type="search" className="field mt-1 w-full" aria-label="Search paper history" placeholder={`Search symbol, exchange or MIS / ${segment === "FNO" ? "NRML" : "CNC"}`}
          value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div role="group" aria-label="History view" className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-inset p-1">
        <button type="button" className="paper-history-switch" aria-pressed={view === "completed"} onClick={() => setView("completed")}>Closed trades ({history.completed.length})</button>
        <button type="button" className="paper-history-switch" aria-pressed={view === "fills"} onClick={() => setView("fills")}>All fills ({history.rows.length})</button>
      </div>
      <div hidden={view !== "completed"}>
        <p className="mt-3 text-[11px] text-muted">One card per fully closed position. Reasons use saved fill prices, exit triggers and fees, not a verified cause of market moves. Select a card for the full breakdown.{query && ` ${completed.length} matching trades; score above still covers all trades.`}</p>
        <ol className="mt-3 space-y-2" aria-label="Completed paper positions">
          {completed.map((trade) => <li key={trade.id}>
            <details className="paper-history-entry group">
            <summary>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 break-words font-semibold">{trade.symbol}</span>
                <span className={`font-mono font-medium ${pnlColor(trade.realized)}`}>{outcome(trade.realized)}: {money(trade.realized / 100)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                <span className="paper-tag">{trade.product}</span><span>{trade.quantity} {trade.segment === "FNO" ? `units / ${trade.quantity / trade.instrument!.lotSize} lots` : "shares"} · {trade.entrySide === "BUY" ? "Long" : "Short"} · {trade.exchange}</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted"><span className="font-semibold text-foreground">Why {outcome(trade.realized).toLowerCase()}: </span>{trade.outcomeReason}</p>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted">
                <span>{shortTime(trade.closedAt)} IST</span><span className="text-accent">Details <span aria-hidden="true" className="group-open:hidden">+</span><span aria-hidden="true" className="hidden group-open:inline">-</span></span>
              </div>
            </summary>
            <p className="mt-3 border-t border-line pt-3 text-muted">{trade.entrySide === "BUY" ? "Long: BUY then SELL" : "Short: SELL then BUY"}</p>
            <dl className="paper-metrics mt-3">
              <div><dt className="text-muted">Total {trade.segment === "FNO" ? "units" : "shares"} entered / exited</dt><dd>{trade.quantity} / {trade.quantity}</dd></div>
              <div><dt className="text-muted">Average entry price</dt><dd>{money(trade.entryValue / trade.quantity / 100)}</dd></div>
              <div><dt className="text-muted">Average exit price</dt><dd>{money(trade.exitValue / trade.quantity / 100)}</dd></div>
              <div><dt className="text-muted">Full entry value</dt><dd>{money(trade.entryValue / 100)}</dd></div>
              <div><dt className="text-muted">Full exit value</dt><dd>{money(trade.exitValue / 100)}</dd></div>
              <div><dt className="text-muted">Gross P&amp;L before charges</dt><dd>{money((trade.realized + trade.fees) / 100)}</dd></div>
              <div><dt className="text-muted">Net result after charges</dt><dd className={pnlColor(trade.realized)}>{outcome(trade.realized)}: {money(trade.realized / 100)}</dd></div>
              <div><dt className="text-muted">Saved fees</dt><dd>{money(trade.fees / 100)}</dd></div>
              <div><dt className="text-muted">Cost model</dt><dd>{trade.costModel === "LEGACY" ? "Legacy · cost-free" : trade.costModel === "MIXED" ? "Mixed · different cost models" : trade.costModel === "INDIA_FLAT20_V2" ? "India V2 · flat Rs20 + taxes" : "Estimated V1 · fees + slippage"}</dd></div>
            </dl>
            <p className="mt-2 break-words text-muted">Opened {time(trade.openedAt)}. Closed {time(trade.closedAt)}.</p>
            </details>
          </li>)}
        </ol>
        {!completed.length && <div className="paper-empty-state"><h4>{query ? "No matching closed trades" : "Your track record starts here"}</h4><p>{query ? "Try another stock, exchange or product." : "Fully close a position to see its final result. Partial exits stay together as one trade."}</p></div>}
      </div>
      <div hidden={view !== "fills"}>
        <p className="mt-3 text-[11px] text-muted">Every executed BUY and SELL, newest first.{query && ` ${rows.length} matching fills.`}</p>
        <ol className="mt-3 space-y-2" aria-label="Paper order fills">
          {rows.map(({ fill, role, entryPrice }) => <li key={fill.id}>
            <details className="paper-history-entry group">
            <summary>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 break-words font-semibold">{fill.symbol}</span>
                <span className={`font-medium ${role === "EXIT" ? pnlColor(fill.realized) : "text-muted"}`}>{role === "EXIT" ? `${outcome(fill.realized)}: ${money(fill.realized / 100)}` : "Position entry"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                <span className={`paper-tag ${fill.side === "BUY" ? "text-positive" : "text-negative"}`}>{fill.side}</span>
                <span>{fill.quantity} {fill.segment === "FNO" ? "units" : "shares"} at {money(fill.price / 100)}</span><span>{fill.product} · {fill.exchange}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted">
                <span>{shortTime(fill.at)} IST</span><span className="text-accent">Details <span aria-hidden="true" className="group-open:hidden">+</span><span aria-hidden="true" className="hidden group-open:inline">-</span></span>
              </div>
            </summary>
            <p className="mt-3 border-t border-line pt-3 text-muted">{role === "ENTRY" ? "Position entry" : "Position exit"} / {fill.reason ?? "MARKET"}</p>
            <dl className="paper-metrics mt-3">
              <div><dt className="text-muted">Number of {fill.segment === "FNO" ? "units" : "shares"}</dt><dd>{fill.quantity}</dd></div>
              <div><dt className="text-muted">Fill price / {fill.segment === "FNO" ? "unit" : "share"}</dt><dd>{money(fill.price / 100)}</dd></div>
              <div><dt className="text-muted">Entry cost / {fill.segment === "FNO" ? "unit" : "share"}</dt><dd>{money(entryPrice / 100)}</dd></div>
              <div><dt className="text-muted">Order value</dt><dd>{money(fill.price * fill.quantity / 100)}</dd></div>
              <div><dt className="text-muted">Realized result</dt><dd className={role === "EXIT" ? pnlColor(fill.realized) : "text-muted"}>
                {role === "EXIT" || fill.realized !== 0 ? `${outcome(fill.realized)}: ${money(fill.realized / 100)}` : "Not realized (entry)"}</dd></div>
              <div><dt className="text-muted">Saved fees</dt><dd>{money((fill.fees ?? 0) / 100)}</dd></div>
              <div><dt className="text-muted">Cost model</dt><dd>{fill.costModel === "INDIA_FLAT20_V2" ? "India V2 · flat Rs20 + taxes" : fill.costModel === "ESTIMATED_V1" ? "Estimated V1 · fees + slippage" : "Legacy · cost-free"}</dd></div>
            </dl>
            {fill.charges && <PaperChargeBreakdown charges={fill.charges} />}
            <p className="mt-2 break-words text-muted">{time(fill.at)}</p>
            <p className="mt-2 text-muted">Entry cost uses the saved cost basis, not a leveraged discount.</p>
            </details>
          </li>)}
        </ol>
        {!rows.length && <div className="paper-empty-state"><h4>{query ? "No matching fills" : "No executed orders yet"}</h4><p>{query ? "Try another stock, exchange or product." : "Your BUY and SELL details will be saved here after an order fills."}</p></div>}
      </div>
    </>}
  </section>;
});
