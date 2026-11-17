"use client";

import Link from "next/link";
import { Icon } from "./icons";
import { GrowwConnection } from "./groww-connection";
import { TerminalSessionControls } from "../auth/terminal-session-controls";

export function Header({ connected, onConnectionChange, terminalExpiresAt }: {
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
  terminalExpiresAt: string;
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
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <Link href="/" className="flex items-center gap-3" aria-label="TradeTerminal home">
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent/12 text-accent"><Icon name="bolt" className="size-6" /></span>
          <span className="text-xl font-bold tracking-tight sm:text-2xl">Trade<span className="text-accent">Terminal</span></span>
        </Link>
        <div className="flex flex-wrap items-center gap-3 sm:gap-5">
          <GrowwConnection connected={connected} onConnectionChange={onConnectionChange} />
          <button type="button" className="icon-button" onClick={toggleTheme} aria-label="Toggle light/dark theme">
            <Icon name="sun" className="hidden size-[18px] dark:block" />
            <Icon name="moon" className="size-[18px] dark:hidden" />
          </button>
          <TerminalSessionControls expiresAt={terminalExpiresAt} />
        </div>
      </div>
    </header>
  );
}
