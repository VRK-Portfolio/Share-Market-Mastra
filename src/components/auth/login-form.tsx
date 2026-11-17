"use client";

import { useRef, useState } from "react";

export function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  return <main className="flex min-h-screen items-center justify-center px-4 py-10">
    <section className="panel w-full max-w-sm p-6 sm:p-8" aria-labelledby="login-title">
      <p className="text-sm font-bold tracking-tight">Trade<span className="text-accent">Terminal</span></p>
      <h1 id="login-title" className="mt-5 text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted">Private terminal access. Connect your Groww account after signing in.</p>
      <form className="mt-6 space-y-4" onSubmit={async (event) => {
        event.preventDefault();
        if (pending.current) return;
        const form = event.currentTarget;
        const fields = new FormData(form);
        pending.current = true; setBusy(true); setError("");
        try {
          const response = await fetch("/api/auth/login", {
            method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: fields.get("username"), password: fields.get("password") }),
            signal: AbortSignal.timeout(30_000),
          });
          const body: unknown = await response.json();
          if (!response.ok || !body || typeof body !== "object" || !("authenticated" in body) || body.authenticated !== true) {
            throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Unable to sign in.");
          }
          form.reset();
          window.location.replace("/");
        } catch (error) {
          setError(error instanceof Error ? error.message : "Unable to sign in. Retry when the server is available.");
        } finally { pending.current = false; setBusy(false); }
      }}>
        <label className="field-label block">Username
          <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={100} className="field mt-2 w-full" disabled={busy} />
        </label>
        <label className="field-label block">Password
          <input name="password" type="password" autoComplete="current-password" required maxLength={256} className="field mt-2 w-full" disabled={busy} />
        </label>
        {error && <p role="alert" className="break-words text-sm text-negative">{error}</p>}
        <button type="submit" className="secondary-button w-full justify-center" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      </form>
      <p className="mt-5 text-xs text-muted">No public registration. Sessions expire after eight hours.</p>
    </section>
  </main>;
}
