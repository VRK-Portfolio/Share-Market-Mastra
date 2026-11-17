"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { paperSnapshotSchema } from "../../lib/market/paper-trading";
import type { PaperInstruction, PaperSnapshot } from "../../lib/market/paper-trading";

class PaperRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function paperResponse(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) throw new PaperRequestError(body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error : "The paper account request failed.", response.status);
  return paperSnapshotSchema.parse(body);
}

export function usePaperTrading(connected: boolean, onSessionExpired: () => void) {
  const [snapshot, setSnapshot] = useState<PaperSnapshot | null>(null);
  const latest = useRef<PaperSnapshot | null>(null);
  const [syncError, setSyncError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [canTrade, setCanTrade] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!connected || pending.current || document.hidden) return;
    const requestGeneration = ++generation.current;
    setCanTrade(false);
    try {
      const response = await fetch("/api/groww/paper", {
        cache: "no-store", signal: AbortSignal.timeout(25_000),
      });
      if (!mounted.current || requestGeneration !== generation.current) return;
      if (response.status === 401) { onSessionExpired(); return; }
      const next = await paperResponse(response);
      if (!mounted.current || requestGeneration !== generation.current) return;
      latest.current = next;
      setSnapshot(next); setSyncError(""); setCanTrade(true);
    } catch (error) {
      if (!mounted.current || requestGeneration !== generation.current) return;
      setCanTrade(false);
      setSyncError(error instanceof Error ? error.message : "MongoDB paper account sync failed.");
    }
  }, [connected, onSessionExpired]);

  useEffect(() => {
    mounted.current = true;
    const requestState = generation;
    const timer = setTimeout(() => { void refresh(); }, 0);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      mounted.current = false; requestState.current++;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);

  const submit = useCallback(async (instruction: PaperInstruction): Promise<boolean> => {
    if (pending.current || !latest.current || !connected) return false;
    pending.current = true;
    generation.current++;
    setBusy(true); setCanTrade(false); setMessage(""); setActionError("");
    const current = latest.current;
    let refreshNeeded = true;
    try {
      const command = {
        operationId: crypto.randomUUID(), expectedRevision: current.revision, accountId: current.accountId,
        ...instruction,
      };
      const response = await fetch("/api/groww/paper", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(55_000),
      });
      if (!mounted.current) return false;
      if (response.status === 401) { refreshNeeded = false; onSessionExpired(); return false; }
      const next = await paperResponse(response);
      if (!mounted.current) return false;
      if (next.accountId !== current.accountId) throw new Error("Paper account identity changed. Reload before submitting again.");
      const fill = next.account.fills.find((item) => item.id === command.operationId);
      if (instruction.type === "TRADE" && !fill) throw new Error("The confirmed paper fill was not found. Check account history before another submission.");
      latest.current = next;
      setSnapshot(next); setCanTrade(true); setSyncError("");
      refreshNeeded = false;
      setMessage(fill
        ? `Paper ${fill.side} filled: ${fill.quantity} ${fill.symbol} at INR ${(fill.price / 100).toFixed(2)}. Saved to MongoDB; no real order was sent.`
        : instruction.type === "RESET" ? "Paper account reset to INR 1,00,000 in MongoDB."
        : instruction.type === "PLACE" ? "Paper order saved. Automatic execution requires this terminal to remain open and connected."
        : instruction.type === "CANCEL" ? "Paper order cancelled; any reserved cash was released."
        : "Paper automation processed the verified price. Review order statuses and fills below.");
      return true;
    } catch (error) {
      if (mounted.current) {
        const rejected = error instanceof PaperRequestError && error.status >= 400 && error.status < 500 && error.status !== 408;
        setActionError(`${error instanceof Error ? error.message : "Paper update could not be confirmed."}${rejected ? ""
          : " Check the synchronized balance and history before another submission."}`);
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); if (refreshNeeded) void refresh(); }
    }
  }, [connected, onSessionExpired, refresh]);
  return {
    account: snapshot?.account ?? null, syncedAt: snapshot?.syncedAt ?? null,
    error: syncError || actionError, message, busy, canTrade, submit, refresh,
  };
}
