"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { activePaperOrder } from "../../lib/market/paper-order-schemas";
import { paperRiskReport } from "../../lib/market/paper-risk";
import { paperPerformance } from "../../lib/market/paper-performance";
import { Header } from "./header";
import { money } from "./format";
import { usePaperTrading } from "./use-paper-trading";
import { usePaperPrices } from "./use-paper-prices";

const cash = (paise: number | null | undefined) => paise == null ? "Unavailable" : money(paise / 100);
const score = (value: number | null) => value === null ? "--" : `${value.toFixed(1)} / 100`;

export function PaperRiskPerformance({ terminalExpiresAt }: { terminalExpiresAt: string }) {
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const onConnectionChange = useCallback((value: boolean) => {
    setConnected(value);
    if (value) setExpired(false);
  }, []);
  const onSessionExpired = useCallback(() => { setConnected(false); setExpired(true); }, []);
  const paper = usePaperTrading(connected, onSessionExpired);
  const account = connected ? paper.account : null;
  const pending = account?.orders.filter(activePaperOrder) ?? [];
  const live = usePaperPrices([...(account?.positions ?? []), ...pending], connected, onSessionExpired);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const risk = account && now !== null ? paperRiskReport(account, live.prices, now) : null;
  const result = useMemo(() => {
    if (!account) return { performance: null, error: "" };
    try { return { performance: paperPerformance(account), error: "" }; }
    catch (error) {
      return { performance: null, error: error instanceof Error ? error.message : "Paper performance could not be reconciled." };
    }
  }, [account]);
  const performance = result.performance;
  return <div className="min-h-screen bg-background">
    <Header connected={connected} onConnectionChange={onConnectionChange} terminalExpiresAt={terminalExpiresAt} />
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Paper risk &amp; performance</h1>
          <p className="mt-2 text-sm text-muted">Read-only paper account review. No orders, broker portfolio requests or automation run on this page.</p></div>
        <Link href="/" className="secondary-button text-xs">Back to trading workspace</Link>
      </div>
      <section className="panel border-warning/30 p-4 text-sm" aria-label="Browser protection warning">
        <h2 className="font-semibold text-warning">Browser-only protection — not an always-on broker risk system</h2>
        <p className="mt-2 leading-relaxed text-muted">Saved target/stop exits, pending entries and MIS square-off require an open, connected automation-owner trading workspace tab with fresh prices. Closing that tab, going offline, browser suspension or a failed request can leave positions unprotected. This read-only page never takes over automation. Gaps and slippage can exceed planned loss.</p>
      </section>
      {expired && <p role="alert" className="text-sm text-negative">Groww session expired. Reconnect in the header.</p>}
      {(paper.error || live.error || result.error) && <p role="alert" className="text-sm text-negative">{paper.error || live.error || result.error}</p>}
      {!connected ? <section className="panel p-6"><h2 className="font-semibold">Connect Groww to review your private paper account</h2><p className="mt-2 text-sm text-muted">Use the connection control in the header. No sample equity or performance is shown.</p></section>
        : !account ? <p role="status" className="text-sm text-muted">Loading saved paper account...</p> : <>
        <section className="panel p-5" aria-label="Live paper risk">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Live marked equity &amp; entry limits</h2>
            <button type="button" className="secondary-button text-xs" disabled={paper.busy} onClick={() => { void paper.refresh(); }}>Refresh paper account</button>
          </div>
          <p className="mt-2 text-xs text-muted">Account refreshes manually and on focus only; prices stream independently. Last account sync: {paper.syncedAt ? `${new Date(paper.syncedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : "pending"}. Missing or stale marks block new entries.</p>
          <dl className="paper-metrics mt-5 grid-cols-2 gap-5 md:grid-cols-4">
            <div><dt>Live paper equity</dt><dd>{cash(risk?.equity)}</dd></div>
            <div><dt>Per-trade loss budget · 0.5%</dt><dd>{cash(risk?.equity == null ? null : risk.equity * 0.005)}</dd></div>
            <div><dt>Combined open + pending risk</dt><dd>{cash(risk?.openRisk)}</dd></div>
            <div><dt>Open-risk limit · 2%</dt><dd>{cash(risk?.equity == null ? null : risk.equity * 0.02)}</dd></div>
            <div><dt>Daily consumed loss budget</dt><dd>{cash(risk?.dailyLoss)}</dd></div>
            <div><dt>Daily loss limit · 1.5%</dt><dd>{cash(risk?.dailyLimit)}</dd></div>
            <div><dt>Per-stock gross limit · 20%</dt><dd>{cash(risk?.equity == null ? null : risk.equity * 0.20)}</dd></div>
            <div><dt>Unprotected positions</dt><dd className={risk?.unprotected ? "text-warning" : ""}>{risk?.unprotected ?? "--"}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-muted">{risk?.freshPrices ?? 0}/{risk?.positions ?? account.positions.length} positions with fresh marks. Pending planned risk: {cash(risk?.pendingRisk)}. Limits use gross exposure, not the leveraged cash margin.</p>
          <p className="mt-3 text-xs leading-relaxed text-muted">Conservative daily budget, not close-to-close return: today&apos;s negative net fill outcomes plus current unrealized losses, including carried positions. Profits do not replenish it. The limit is 1.5% of start-of-day book equity (initial balance + realized P&amp;L before today). Once detected by the server, a halt stays locked for that IST date. Missing marks make the displayed consumed budget incomplete and block entries.</p>
          <p className={`mt-3 text-sm font-medium ${risk?.dailyLocked ? "text-negative" : "text-muted"}`}>{risk?.dailyLocked ? "Daily entry lock active; closing/reducing remains allowed." : "No daily lock reported in this account snapshot; server revalidates every entry."}</p>
          {!!risk?.blockers.length && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-warning">{risk.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        </section>
        {performance && <section className="panel p-5" aria-label="Observed paper performance">
          <h2 className="font-semibold">Observed trade performance · not a forecast</h2>
          <p className="mt-2 text-xs text-muted">A trade is one position cycle from flat to flat, combining adds and partial closes. Net results include saved entry and exit fees; slippage is embedded in modeled fill prices. Open cycles are not scored.</p>
          <dl className="paper-metrics mt-5 grid-cols-2 gap-5 md:grid-cols-4">
            <div><dt>Historical win score</dt><dd>{score(performance.score)}</dd></div>
            <div><dt>Closed-trade sample</dt><dd>{performance.sampleSize}</dd></div>
            <div><dt>Net expectancy / closed trade</dt><dd>{cash(performance.expectancy)}</dd></div>
            <div><dt>Profit factor</dt><dd>{performance.profitFactor === null ? "Undefined (no losses)" : performance.profitFactor.toFixed(2)}</dd></div>
            <div><dt>Average net winner</dt><dd>{cash(performance.averageWinner)}</dd></div>
            <div><dt>Average net loser</dt><dd>{cash(performance.averageLoser)}</dd></div>
            <div><dt>Net closed-trade P&amp;L</dt><dd>{cash(performance.netRealized)}</dd></div>
            <div><dt>Open-cycle realized P&amp;L / fees</dt><dd>{cash(performance.partialRealized)}</dd></div>
            <div><dt>Realized-equity max drawdown</dt><dd>{cash(performance.maxDrawdown)} ({performance.maxDrawdownPercent.toFixed(2)}%)</dd></div>
            <div><dt>Saved estimated fees · all fills</dt><dd>{cash(performance.fees)}</dd></div>
          </dl>
          <p role="status" className="mt-4 text-xs text-warning">{performance.insufficientEvidence ? "Insufficient evidence: fewer than 30 closed cycles. " : "At least 30 closed cycles, but no statistical or forward validation. "}Sample threshold is descriptive, not a significance test. Score = net winning cycles / all closed cycles × 100, including break-even in the denominator. A high win rate can still have negative expectancy.</p>
          <p className="mt-3 text-xs leading-relaxed text-muted">Realized-equity drawdown follows initial balance + cumulative net fill P&amp;L in saved fill order, including entry fees and partial exits. It is not marked-to-market, intratrade or intraday drawdown; it can understate actual risk. There is no out-of-sample, forward-tested or live success claim.</p>
          <h3 className="mt-5 text-sm font-semibold">Cost cohorts — do not mistake legacy results for net modeled returns</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Closed trades separated by saved fill cost model</caption>
              <thead className="text-muted"><tr><th className="p-2">Cost basis</th><th className="p-2">Cycles</th><th className="p-2">Win score</th><th className="p-2">Expectancy</th><th className="p-2">Net P&amp;L</th></tr></thead>
              <tbody>{([
                ["Legacy · no modeled costs", performance.cohorts.legacy],
                ["Estimated V1 · all fills modeled", performance.cohorts.modeled],
                ["Mixed · legacy + modeled fills", performance.cohorts.mixed],
              ] as const).map(([label, cohort]) => <tr key={label} className="border-t border-line"><th scope="row" className="p-2 font-normal">{label}</th><td className="p-2">{cohort.sampleSize}</td><td className="p-2">{score(cohort.score)}</td><td className="p-2">{cash(cohort.expectancy)}</td><td className="p-2">{cash(cohort.netRealized)}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">{performance.legacyFills} legacy cost-free fills; {performance.modeledFills} Estimated V1 fills. Future paper fills estimate fees of 0.10% of turnover and adverse slippage of 0.05% on each fill, on both entry and exit. Old history is never backfilled with hypothetical charges. Mixed cycles retain their original legacy portions, so their results are only partially cost-modeled. These are estimates, not actual broker charges.</p>
        </section>}
      </>}
      <section className="panel p-5 text-xs leading-relaxed text-muted">
        <h2 className="text-sm font-semibold text-foreground">Entry policy &amp; missing context</h2>
        <p className="mt-2">Stocks and F&amp;O share this balance and all risk limits. New entries require stop + target, closed-candle technical agreement and fresh market depth. CASH MIS also requires timing and opening-range/volume checks; CASH-only confluence is not used for F&amp;O. Futures reserve full notional and bought options full premium, even for MIS; option sells are exit-only. Reducing/closing orders bypass entry approval. Existing protection is retained/resized after quantity changes.</p>
        <p className="mt-2">Sector, news and market-breadth integrations are not present; these contexts are unknown, not positive confirmations. Technical checks cannot guarantee profitability. Live broker execution is unchanged by paper risk and cost safeguards.</p>
      </section>
    </main>
  </div>;
}
