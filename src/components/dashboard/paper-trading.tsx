"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { freshPaperPrice, paperPositionMark, paperProductSummary, paperQuoteError, positionKey } from "../../lib/market/paper-trading";
import type { PaperQuote } from "../../lib/market/paper-trading";
import { activePaperOrder } from "../../lib/market/paper-order-schemas";
import { nextPaperProcessing } from "../../lib/market/paper-orders";
import { paperRiskReport } from "../../lib/market/paper-risk";
import { usePaperTrading } from "./use-paper-trading";
import { usePaperPrices } from "./use-paper-prices";
import { PaperOrderForm } from "./paper-order-form";
import { PaperOrderHistory } from "./paper-order-history";
import type { PaperSelection } from "./paper-order-form";
import { money } from "./format";
import { Icon } from "./icons";
import { paperPriceKey, paperSegment } from "../../lib/market/paper-instruments";
import { regularMarketSession } from "../../lib/market/market-session";

const sections = [
  ["trade", "Trade"], ["positions", "Positions"], ["orders", "Orders"], ["history", "History"], ["account", "Account"],
] as const;
type PaperView = typeof sections[number][0];

export function PaperTrading({ connected, onSessionExpired, segment = "CASH" }: {
  connected: boolean; onSessionExpired: () => void; segment?: "CASH" | "FNO";
}) {
  const popupId = useId();
  const titleId = useId();
  const popup = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const minimize = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PaperView>("trade");
  const paper = usePaperTrading(connected, onSessionExpired);
  const [selection, setSelection] = useState<PaperSelection>({ symbol: "", exchange: "NSE", product: "MIS",
    ...(segment === "FNO" ? { segment: "FNO" } : {}) });
  const account = paper.account;
  const activeOrders = account?.orders.filter(activePaperOrder) ?? [];
  const positions = account?.positions.filter(position => paperSegment(position) === segment) ?? [];
  const visibleOrders = activeOrders.filter(order => paperSegment(order) === segment);
  const completedOrders = account?.orders.filter(order => !activePaperOrder(order) && paperSegment(order) === segment) ?? [];
  const live = usePaperPrices([...(account?.positions ?? []), ...activeOrders, ...(selection.symbol ? [selection] : [])], connected, onSessionExpired);
  const [formError, setFormError] = useState("");
  const [now, setNow] = useState<number | null>(null);
  const [automation, setAutomation] = useState(true);
  const [automationOwner, setAutomationOwner] = useState(false);
  const automationLock = useRef(false);
  const [paused, setPaused] = useState(false);
  const lastAttempt = useRef("");
  useEffect(() => {
    if (!connected || !navigator.locks) return;
    const controller = new AbortController();
    let active = true;
    let release: (() => void) | undefined;
    void navigator.locks.request("trade-terminal-paper-automation", { signal: controller.signal }, async () => {
      if (!active) return;
      automationLock.current = true;
      setAutomationOwner(true);
      await new Promise<void>((resolve) => { release = resolve; });
    }).catch(() => { /* An aborted queued lock is expected when leaving this page. */ });
    return () => {
      active = false; automationLock.current = false; setAutomationOwner(false);
      controller.abort(); release?.();
    };
  }, [connected]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const selectedTick = live.prices[paperPriceKey(selection)];
  const quote: PaperQuote | null = now !== null && freshPaperPrice(selectedTick, now)
    ? { ...selection, segment, price: selectedTick.price, tradeTime: selectedTick.tradeTime, quoteProof: selectedTick.paperQuoteProof } : null;
  const unavailable = now === null ? "Checking market session..." : paperQuoteError(quote, now);
  const marks = positions.map((position) => now === null ? null
    : paperPositionMark(position, live.prices[paperPriceKey(position)], now));
  const markedCount = marks.filter((mark) => mark !== null).length;
  const totalPnl = markedCount === positions.length
    ? marks.reduce((sum, mark) => sum + (mark?.pnl ?? 0), 0) : null;
  const risk = account && now !== null ? paperRiskReport(account, live.prices, now) : null;
  const needsAttention = !!(paper.error || live.error || paused || risk?.unprotected || risk?.dailyLocked);
  const launcherStatus = !connected ? "Offline" : needsAttention ? "Review" : !automation || !automationOwner ? "Paused"
    : activeOrders.length ? `${activeOrders.length} active` : "Virtual";
  function showView(next: PaperView) {
    setView(next);
    content.current?.scrollTo({ top: 0 });
  }
  function minimizePopup() {
    popup.current?.close();
    setOpen(false);
    launcher.current?.focus();
  }
  function togglePopup() {
    if (popup.current?.open) { minimizePopup(); return; }
    // Non-modal so the market workspace remains usable beside the trading popup.
    popup.current?.show();
    setOpen(true);
    minimize.current?.focus();
  }
  const submit = paper.submit;
  useEffect(() => {
    if (!connected || !automation || !automationOwner || !automationLock.current || paused || !account || !paper.canTrade || paper.busy || now === null) return;
    const instruction = nextPaperProcessing(account, live.prices, now);
    if (!instruction) return;
    const attempt = JSON.stringify([instruction, account.orders.filter(activePaperOrder).map((item) => [item.id, item.status]),
      account.positions.map((item) => [positionKey(item), item.quantity, item.openedAt])]);
    if (lastAttempt.current === attempt) return;
    const timer = setTimeout(() => {
      lastAttempt.current = attempt;
      void submit(instruction).then((success) => { if (!success) setPaused(true); });
    }, 0);
    return () => clearTimeout(timer);
  }, [connected, automation, automationOwner, paused, account, paper.canTrade, paper.busy, now, live.prices, submit]);
  function trade(side: "BUY" | "SELL", units: number, quote: PaperQuote | null) {
    if (!quote || paper.busy || !paper.canTrade || !account) return;
    setFormError("");
    const priceError = paperQuoteError(quote);
    if (priceError) { setFormError(priceError); return; }
    if (!Number.isSafeInteger(units) || units < 1) {
      setFormError("Enter a positive whole-share quantity within the supported integer range.");
      document.getElementById("paper-quantity")?.focus();
      return;
    }
    if (!window.confirm(`PAPER ONLY: ${side} ${units} ${quote.symbol} (${quote.exchange}, ${quote.product})?\nDisplayed price ${money(quote.price)} is indicative. Remaining protection is retained/resized where valid. Estimated fees 0.10% and adverse slippage 0.05% apply to this fill. No real order.`)) return;
    void submit({ type: "TRADE", symbol: quote.symbol, exchange: quote.exchange, product: quote.product,
      ...(quote.segment === "FNO" ? { segment: "FNO" } : {}),
      side, quantity: units, ...(quote.quoteProof ? { quoteProof: quote.quoteProof } : {}) });
  }
  return <>
    <button ref={launcher} type="button" className="paper-trading-launcher"
      aria-label={open ? "Minimize paper trading" : "Open paper trading"} aria-haspopup="dialog"
      aria-controls={popupId} aria-expanded={open} onClick={togglePopup}>
      <Icon name="chart" className="size-5" />
      <span className="hidden sm:inline">Paper trading</span><span className="sm:hidden">Paper</span>
      <span className="hidden rounded-full bg-white/15 px-2 py-1 text-[10px] sm:inline">{launcherStatus}</span>
      {needsAttention && <span aria-hidden="true" className="absolute right-0 top-0 size-2.5 rounded-full bg-warning ring-2 ring-panel sm:hidden" />}
    </button>
    {!open && needsAttention && <p role="status" className="sr-only">Paper trading needs attention. Open paper trading to review.</p>}
    <dialog ref={popup} id={popupId} aria-labelledby={titleId} className="paper-trading-popup"
      onClose={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); minimizePopup(); }
      }}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-inset px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent"><Icon name="chart" className="size-5" /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold">Paper trading · {segment === "FNO" ? "F&O" : "Stocks"}</h2>
            <p className="mt-1 text-[11px] text-muted">Shared practice balance. {segment} orders shown.</p>
          </div>
        </div>
        <button ref={minimize} type="button" className="icon-button shrink-0" aria-label="Minimize paper trading" onClick={minimizePopup}>
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="shrink-0 px-4 pb-3 pt-4">
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div className="paper-balance-card border-accent/20 bg-accent/5">
            <dt className="text-muted">Available cash</dt>
            <dd className="mt-2 break-all font-mono text-lg font-semibold">{account ? money(account.cash / 100) : "--"}</dd>
            <dd className="mt-1 text-[10px] text-muted">Shared across stocks and F&amp;O</dd>
          </div>
          <div className="paper-balance-card">
            <dt className="text-muted">Open P&amp;L</dt>
            <dd className={`mt-2 break-all font-mono text-lg font-semibold ${!account || totalPnl === null ? "text-muted" : totalPnl >= 0 ? "text-positive" : "text-negative"}`}>
              {!account ? "--" : totalPnl === null ? "Awaiting prices" : money(totalPnl / 100)}
            </dd>
            <dd className="mt-1 text-[10px] text-muted">{markedCount}/{positions.length} {segment} positions with fresh prices</dd>
          </div>
        </dl>
        <button type="button" className="mt-3 flex items-center gap-2 text-[11px] text-muted" onClick={() => showView("account")}>
          <span aria-hidden="true" className={`size-1.5 rounded-full ${connected && automation && automationOwner && !needsAttention ? "bg-positive" : "bg-warning"}`} />
          {!connected ? "Connect Groww to start" : needsAttention ? "Account needs attention" : automation && automationOwner ? "Browser-only automation active" : "Automation inactive in this tab"}
          <span className="underline underline-offset-2">Manage</span>
        </button>
        <p className="mt-2 text-[11px] text-warning">Browser-only exits stop when closed, offline or suspended. {risk ? `${risk.unprotected} unprotected positions.` : "Protection status unavailable."} {risk?.dailyLocked && "Daily entry lock active."}</p>
        <Link href="/risk" className="mt-2 inline-block text-[11px] text-accent underline">Open risk &amp; performance</Link>
      </div>
      <div role="tablist" aria-label="Paper trading sections" className="paper-navigation"
        onKeyDown={(event) => {
          const index = sections.findIndex(([id]) => id === view);
          const next = event.key === "ArrowRight" ? (index + 1) % sections.length
            : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length
              : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          showView(sections[next][0]);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>
        {sections.map(([id, label]) => {
          const count = id === "positions" ? positions.length : id === "orders" ? visibleOrders.length : 0;
          return <button key={id} id={`${popupId}-${id}-tab`} type="button" role="tab"
            aria-selected={view === id} aria-controls={`${popupId}-${id}-panel`} tabIndex={view === id ? 0 : -1}
            className="paper-navigation-tab" onClick={() => showView(id)}>
            {label}{!!count && <span className="paper-count">{count}</span>}
          </button>;
        })}
      </div>
      <section ref={content} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Paper trading">
    {(paper.error || formError || live.error || paper.message) && <div className="space-y-2 px-4 pt-3 text-xs">
      {paper.error && <p role="alert" className="paper-notice text-negative">{paper.error}</p>}
      {formError && <p role="alert" className="paper-notice text-negative">{formError}</p>}
      {live.error && <p role="alert" className="paper-notice text-negative">{live.error}</p>}
      {paper.message && <p role="status" className="paper-notice text-positive">{paper.message}</p>}
    </div>}
    <div role="tabpanel" id={`${popupId}-trade-panel`} aria-labelledby={`${popupId}-trade-tab`} hidden={view !== "trade"} tabIndex={0} className="paper-view">
    <PaperOrderForm selection={selection} onSelection={setSelection} quote={quote} unavailable={unavailable}
      account={account} prices={live.prices} now={now}
      disabled={!connected || paper.busy || !paper.canTrade || !account} submit={submit} onSessionExpired={onSessionExpired} />
    </div>
    <div role="tabpanel" id={`${popupId}-account-panel`} aria-labelledby={`${popupId}-account-tab`} hidden={view !== "account"} tabIndex={0} className="paper-view space-y-4">
    <div><h3 className="text-sm font-semibold">Account &amp; settings</h3><p className="mt-1 text-xs text-muted">Your balance, automation and simulation rules.</p></div>
    {account && <dl className="paper-metrics rounded-xl border border-line p-3 text-xs">
      <div><dt>Starting balance</dt><dd>{money(account.initialBalance / 100)}</dd></div>
      <div><dt>Available cash</dt><dd>{money(account.cash / 100)}</dd></div>
      <div><dt>Held for positions</dt><dd>{money(account.positions.reduce((sum, position) => sum + position.margin, 0) / 100)}</dd></div>
      <div><dt>Held for pending orders</dt><dd>{money(activeOrders.reduce((sum, order) => sum + order.reservedCash, 0) / 100)}</dd></div>
      <div><dt>Realized P&amp;L</dt><dd className={account.realized < 0 ? "text-negative" : "text-positive"}>{money(account.realized / 100)}</dd></div>
    </dl>}
    <div className="rounded-xl border border-line p-3 text-xs">
    <label className="flex items-start gap-3 font-medium"><input className="mt-0.5 size-4 accent-accent" type="checkbox" checked={automation} onChange={(event) => setAutomation(event.target.checked)} />
      Run automatic paper orders while this terminal is open and connected</label>
    <p className="mt-2 leading-relaxed text-muted">Limit, GTT, target/stop and MIS square-off run only with a fresh price while this terminal is open and connected. Minimizing this popup keeps them running.</p>
    {!automationOwner && connected && <p role="status" className="mt-2 text-warning">Automation is inactive in this tab: another workspace tab holds the browser lock, or browser coordination is unavailable. The risk page never executes orders. Only one workspace tab may automate.</p>}
    {(!automation || paused) && <p role="status" className="mt-2 text-xs text-warning">Automatic paper execution is paused.{paused && " A request failed; review the synchronized account and order statuses before resuming."}</p>}
    {paused && <button type="button" className="mt-2 text-xs text-accent underline" disabled={paper.busy} onClick={() => {
      lastAttempt.current = ""; setPaused(false); void paper.refresh();
    }}>Resume automatic paper orders</button>}
    </div>
    <div className="rounded-xl bg-inset p-3 text-xs">
    <h4 className="font-medium">Account connection</h4>
    <p className="mt-2 text-xs text-muted">{!connected ? "Connect Groww to access your private MongoDB paper account."
      : paper.syncedAt ? `Last saved account sync: ${new Date(paper.syncedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Trades and history are saved in MongoDB. Live prices stream separately; there is no account polling.`
        : "Loading your MongoDB paper account..."}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {connected && <button type="button" className="secondary-button text-xs" disabled={paper.busy} onClick={() => { void paper.refresh(); }}>Refresh paper account</button>}
      {connected && <button type="button" className="secondary-button text-xs" onClick={live.reconnect}>Reconnect paper prices</button>}
    </div>
    </div>
    <details className="workspace-details text-xs">
      <summary>Simulation rules &amp; limitations</summary>
      <p className="mt-3 leading-relaxed text-muted">CASH MIS uses 5x leverage; CNC uses full cash. F&amp;O futures use full notional and bought options use full premium, including MIS; SELL options only closes owned units. Whole contract lots and ticks are required. Estimated fees 0.10% and adverse slippage 0.05% apply per fill. No queue, liquidity, margin-call or expiry-settlement simulation. MIS and expiry-day F&amp;O square-off starts at 15:20 IST using fresh prices.</p>
      <p className="mt-2 leading-relaxed text-muted">No execution while closed, disconnected or without fresh ticks. GTT is saved, not an always-running broker order. Missed intraday square-off waits for the next fresh regular-session price. A short gap may need extra collateral. Trigger prices are not guaranteed fill prices.</p>
    </details>
    <div className="rounded-xl border border-negative/20 p-3 text-xs">
      <h4 className="font-medium">Start over</h4>
      <p className="mt-1 text-muted">Permanently clears all paper positions, orders and history on every device.</p>
      <button type="button" className="secondary-button mt-3 text-xs text-negative" disabled={paper.busy || !paper.canTrade} onClick={() => {
        if (window.confirm("Reset your MongoDB paper account to INR 1,00,000 on all devices? All paper positions, pending orders and trade history will be deleted.")) void submit({ type: "RESET", confirmed: true });
      }}>Reset paper account</button>
    </div>
    </div>
    <div role="tabpanel" id={`${popupId}-positions-panel`} aria-labelledby={`${popupId}-positions-tab`} hidden={view !== "positions"} tabIndex={0} className="paper-view">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold">Open positions</h3><p className="mt-1 text-xs text-muted">What you hold and how it is performing right now.</p></div>
      <span className="paper-count">{positions.length}</span>
    </div>
    <div className="mt-4 space-y-3">
      {positions.map((position, index) => {
        const tick = live.prices[paperPriceKey(position)];
        const mark = marks[index];
        const closeQuote: PaperQuote | null = mark && tick ? {
          symbol: position.symbol, exchange: position.exchange, segment, product: position.product, instrument: position.instrument,
          price: tick.price, tradeTime: tick.tradeTime, quoteProof: tick.paperQuoteProof,
        } : null;
        const closeError = closeQuote && now !== null ? paperQuoteError(closeQuote, now) : "Waiting for a fresh live price.";
        return <article key={positionKey(position)} className="paper-position-card" aria-label={`${position.symbol} ${position.product} position`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="break-words text-sm font-semibold">{position.symbol} <span className="paper-tag">{position.product}</span></h4>
              <p className="mt-1 text-xs text-muted">{position.quantity > 0 ? "Long" : "Short"} · {Math.abs(position.quantity)} {segment === "FNO" ? "units" : "shares"} · {position.exchange}</p>
              {position.instrument && <p className="mt-1 text-xs text-muted">{position.instrument.instrumentType} · {Math.abs(position.quantity) / position.instrument.lotSize} lots · Expiry {position.instrument.expiry}</p>}
            </div>
            <div className="text-right">
              <p className={`font-mono text-base font-semibold ${!mark ? "text-muted" : mark.pnl >= 0 ? "text-positive" : "text-negative"}`}>{mark ? money(mark.pnl / 100) : "--"}</p>
              <p className="mt-1 text-[10px] text-muted">{mark ? `${mark.pnl > 0 ? "Open profit" : mark.pnl < 0 ? "Open loss" : "Break-even"} (${mark.pnlPercent.toFixed(2)}%)` : "Waiting for a fresh price"}</p>
            </div>
          </div>
          <dl className="paper-metrics mt-4 grid-cols-2 rounded-lg bg-inset p-3 text-xs">
            <div><dt>Average entry / {segment === "FNO" ? "unit" : "share"}</dt><dd>{money(position.basis / Math.abs(position.quantity) / 100)}</dd></div>
            <div><dt>Live price / {segment === "FNO" ? "unit" : "share"}</dt><dd>{mark ? money(mark.price) : "Unavailable / stale"}</dd></div>
          </dl>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted">Position value &amp; margin</summary>
            <dl className="paper-metrics mt-3">
              <div><dt>{position.quantity > 0 ? "Buy value" : "Sell entry value"}</dt><dd>{money(position.basis / 100)}</dd></div>
              <div><dt>Current notional</dt><dd>{mark ? money(mark.value / 100) : "Unavailable"}</dd></div>
              <div><dt>Reserved collateral</dt><dd>{money(position.margin / 100)} ({(position.basis / position.margin).toFixed(2)}x)</dd></div>
            </dl>
          </details>
          <button type="button" className="secondary-button mt-4 w-full justify-center text-xs" disabled={paper.busy || !paper.canTrade || !closeQuote || !!closeError}
            onClick={() => trade(position.quantity > 0 ? "SELL" : "BUY", Math.abs(position.quantity), closeQuote)}>Close paper position</button>
          {closeError && <p className="mt-2 text-xs text-warning">{closeError}</p>}
          {position.instrument && now !== null && position.instrument.expiry < regularMarketSession(now).date &&
            <p role="alert" className="mt-2 text-xs text-warning">Expired, unresolved paper position. No settlement, exercise or delivery price is fabricated; this position remains visible in your account.</p>}
        </article>;
      })}
    </div>
    {!account ? <p className="paper-empty-state text-xs text-muted">{connected ? "Your positions will appear when the account loads." : "Connect Groww to see your paper positions."}</p>
      : !positions.length && <div className="paper-empty-state"><Icon name="chart" className="mx-auto size-7 text-accent" /><h4>No open positions</h4><p>Your {segment === "FNO" ? "contracts" : "stocks"} and live profit or loss will appear here after an order fills.</p><button type="button" className="secondary-button mt-4 text-xs" onClick={() => showView("trade")}>Place your first paper order</button></div>}
    <p className="mt-4 text-[11px] leading-relaxed text-muted">To protect a position, choose Target + stop-loss exit in Trade. SELL exits a long; BUY covers a short.</p>
    <details className="workspace-details mt-4 text-xs">
    <summary>Intraday &amp; carry-forward breakdown</summary>
    {account && now !== null && <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {(["MIS", segment === "FNO" ? "NRML" : "CNC"] as const).map((product) => {
        const summary = paperProductSummary(account, product, live.prices, now, segment);
        return <section key={product} className="min-w-0 rounded-lg border border-line p-3 text-xs"
          aria-label={product === "MIS" ? "Intraday paper summary" : "Carry-forward paper summary"}>
          <h3 className="font-semibold">{product === "MIS" ? "Intraday (MIS)" : `Carry-forward (${product})`}</h3>
          <p className="mt-1 text-muted">{summary.positions} positions · {summary.freshPrices}/{summary.positions} fresh prices</p>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <div><dt className="text-muted">Entry value</dt><dd>{money(summary.entryValue / 100)}</dd></div>
            <div><dt className="text-muted">Reserved collateral</dt><dd>{money(summary.margin / 100)}</dd></div>
            <div><dt className="text-muted">Live market value</dt><dd>{summary.value === null ? "Waiting for fresh prices" : money(summary.value / 100)}</dd></div>
            <div><dt className="text-muted">Live unrealized P&amp;L</dt><dd className={summary.pnl === null ? "text-muted" : summary.pnl >= 0 ? "text-positive" : "text-negative"}>
              {summary.pnl === null ? "Waiting for fresh prices" : money(summary.pnl / 100)}</dd></div>
            <div><dt className="text-muted">Realized P&amp;L</dt><dd>{money(summary.realized / 100)}</dd></div>
          </dl>
        </section>;
      })}
    </div>}
    </details>
    </div>
    <div role="tabpanel" id={`${popupId}-orders-panel`} aria-labelledby={`${popupId}-orders-tab`} hidden={view !== "orders"} tabIndex={0} className="paper-view">
      <h3 className="text-sm font-semibold">Waiting for a price trigger</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">Pending entries hold cash at their limit. Target and stop-loss are linked: the first trigger closes the position.</p>
      {(!automation || !automationOwner || paused || !connected) && <p role="status" className="paper-notice mt-3 text-xs text-warning">Automatic execution is {!connected ? "offline" : "inactive in this tab"}. Orders need a connected, active automation-owner workspace tab.</p>}
      {visibleOrders.map((order) => <article key={order.id} className="paper-position-card mt-3 text-xs" aria-label={`${order.symbol} ${order.kind} order`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h4 className="font-semibold">{order.symbol} <span className="paper-tag">{order.product}</span></h4><p className="mt-1 text-muted">{order.side} {order.quantity} {segment === "FNO" ? "units" : "shares"} · {order.exchange} · {order.kind}</p></div>
          <span className="paper-tag text-warning">{order.status.toLowerCase().replaceAll("_", " ")}</span>
        </div>
        <dl className="paper-metrics mt-3">
          {!!order.limitPrice && <div><dt>Limit price</dt><dd>{money(order.limitPrice / 100)}</dd></div>}
          {!!order.triggerPrice && <div><dt>Trigger {order.triggerDirection === "UP" ? "at or above" : "at or below"}</dt><dd>{money(order.triggerPrice / 100)}</dd></div>}
          {!!order.targetPrice && <div><dt>Target / stop-loss</dt><dd>{money(order.targetPrice / 100)} / {money((order.stopPrice ?? 0) / 100)}</dd></div>}
          <div><dt>Cash reserved</dt><dd>{money(order.reservedCash / 100)}</dd></div>
        </dl>
        <p className="mt-3 text-[11px] text-muted">{order.expiresAt ? `Expires ${new Date(order.expiresAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : "Saved until filled or cancelled"}</p>
        {order.reason && <p className="mt-2">{order.reason}</p>}
        <button type="button" className="secondary-button mt-3 text-xs" disabled={paper.busy || !paper.canTrade}
          onClick={() => { void submit({ type: "CANCEL", orderId: order.id }); }}>Cancel {order.kind} order</button>
      </article>)}
      {!account ? <p className="paper-empty-state text-xs text-muted">{connected ? "Your orders will appear when the account loads." : "Connect Groww to see your paper orders."}</p>
        : !visibleOrders.length && <div className="paper-empty-state"><Icon name="shield" className="mx-auto size-7 text-accent" /><h4>No waiting orders</h4><p>Limit orders, GTT triggers and target/stop exits appear here until they fill or are cancelled.</p><button type="button" className="secondary-button mt-4 text-xs" onClick={() => showView("trade")}>Create a paper order</button></div>}
      <p className="mt-4 text-[11px] leading-relaxed text-muted">Orders execute only while the terminal is open, connected and receiving fresh prices. A trigger is not a guaranteed fill price.</p>
    </div>
    <div role="tabpanel" id={`${popupId}-history-panel`} aria-labelledby={`${popupId}-history-tab`} hidden={view !== "history"} tabIndex={0} className="paper-view">
      {account ? <PaperOrderHistory account={account} segment={segment} /> : <p className="paper-empty-state text-xs text-muted">{connected ? "Your saved history will appear when the account loads." : "Connect Groww to see your private paper history."}</p>}
      <details className="workspace-details mt-4"><summary>Other order activity ({completedOrders.length})</summary>
        <p className="mt-2 text-xs text-muted">Completed, cancelled, expired and rejected instructions. Only actual fills affect trade performance.</p>
        {completedOrders.toReversed().map((order) =>
          <p key={order.id} className={`mt-3 rounded-lg bg-inset p-3 text-xs ${order.status === "REJECTED" ? "text-negative" : "text-muted"}`}>
            {order.side} {order.quantity} {order.symbol} · {order.exchange} · {order.product} · {order.kind} · {order.status}
            {order.limitPrice ? ` · Limit ${money(order.limitPrice / 100)}` : ""}
            {order.fillPrice ? ` · Filled ${money(order.fillPrice / 100)}` : ""}: {order.reason}
          </p>)}
      </details>
    </div>
      </section>
    </dialog>
  </>;
}
