"use client";

import Link from "next/link";
import { Icon } from "./icons";
import { GrowwConnection } from "./groww-connection";

export function Header({ connected, onConnectionChange }: {
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
}) {
  function toggleTheme() {
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try { localStorage.setItem("terminal-theme", next); } catch {
      // The selected theme still works when browser storage is disabled.
    }
  }

  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-5 px-5 py-5 sm:px-8 lg:px-10">
        <Link href="/" className="flex items-center gap-3" aria-label="TradeTerminal home">
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent/12 text-accent"><Icon name="bolt" className="size-6" /></span>
          <span className="text-xl font-bold tracking-tight sm:text-2xl">Trade<span className="text-accent">Terminal</span></span>
          <span className="ml-1 hidden rounded border border-accent/25 bg-accent/8 px-2 py-1 font-mono text-[10px] tracking-wider text-accent lg:block">MARKET WORKSPACE</span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-5">
          <GrowwConnection connected={connected} onConnectionChange={onConnectionChange} />
          <span className="hidden items-center gap-2 text-xs text-muted sm:flex">
            <span className={`size-2 rounded-full ${connected ? "bg-positive" : "bg-warning"}`} />
            {connected ? "Groww snapshots" : "Not connected"}
          </span>
          <button type="button" className="icon-button" onClick={toggleTheme} aria-label="Toggle light/dark theme">
            <Icon name="sun" className="hidden size-[18px] dark:block" />
            <Icon name="moon" className="size-[18px] dark:hidden" />
          </button>
        </div>
      </div>
    </header>
  );
}
