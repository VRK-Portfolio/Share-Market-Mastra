"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function TerminalSessionControls({ expiresAt }: { expiresAt: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error("Session verification is unavailable. Retry or reload before continuing.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Session verification failed.");
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => window.location.replace("/login"), Math.max(0, Date.parse(expiresAt) - Date.now()));
    const check = () => { if (!document.hidden) void checkSession(); };
    const poll = setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => { clearTimeout(timer); clearInterval(poll); window.removeEventListener("focus", check); };
  }, [expiresAt, checkSession]);
  return <div className="max-w-60 text-xs">
    <button type="button" className="secondary-button whitespace-nowrap text-xs" disabled={busy} onClick={async () => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError("");
      try {
        const response = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error("Sign out could not be confirmed. Retry; the session has not been cleared locally.");
        window.location.replace("/login");
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to sign out.");
      } finally { pending.current = false; setBusy(false); }
    }}>{busy ? "Signing out..." : "Sign out"}</button>
    {error && <p role="alert" className="mt-2 break-words text-negative">{error}</p>}
  </div>;
}
