"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "./icons";

async function sessionRequest(method: "GET" | "POST" | "DELETE", accessToken?: string) {
  const response = await fetch(method === "GET" ? "/api/groww/session/status" : "/api/groww/session", {
    method,
    cache: "no-store",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify({ accessToken }) : undefined,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `Groww session request failed (${response.status}).`;
    throw new Error(message);
  }
  if (!data || typeof data !== "object" || !("connected" in data) || typeof data.connected !== "boolean") {
    throw new Error("Unexpected Groww session response.");
  }
  return data.connected;
}

export function GrowwConnection({ connected, onConnectionChange }: {
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const result = await sessionRequest("GET");
        if (active) {
          onConnectionChange(result);
          setError("");
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Unable to check Groww connection.");
      } finally {
        if (active) setChecking(false);
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [onConnectionChange]);

  function close() {
    dialog.current?.close();
    setAccessToken("");
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      onConnectionChange(await sessionRequest("POST", accessToken.trim()));
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to connect to Groww.");
    } finally {
      setAccessToken("");
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      onConnectionChange(await sessionRequest("DELETE"));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to disconnect from Groww.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {connected && <span role="status" className="text-xs font-medium text-positive">Groww connected</span>}
        <button
          type="button"
          className="secondary-button text-xs"
          disabled={checking || busy}
          onClick={connected ? disconnect : () => { setError(""); setModalOpen(true); dialog.current?.showModal(); }}
        >
          <Icon name={connected ? "logout" : "link"} className="size-4" />
          {checking ? "Checking Groww..." : busy ? "Please wait..." : connected ? "Disconnect" : "Connect Groww"}
        </button>
      </div>
      {error && !modalOpen && <p role="alert" className="max-w-72 text-xs text-negative">{error}</p>}
      <dialog
        ref={dialog}
        aria-labelledby="groww-title"
        aria-describedby="groww-description"
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-line bg-panel p-6 text-foreground shadow-xl backdrop:bg-black/50"
        onCancel={(event) => { if (busy) event.preventDefault(); }}
        onClose={() => { setAccessToken(""); setModalOpen(false); }}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="groww-title" className="text-lg font-semibold">Connect to Groww</h2>
          <button type="button" className="icon-button" aria-label="Close Groww connection" disabled={busy} onClick={close}>
            <Icon name="close" className="size-4" />
          </button>
        </div>
        <p id="groww-description" className="mb-5 text-sm leading-6 text-muted">
          Paste your generated Groww access token. We verify it with Groww and keep it in an encrypted, HttpOnly cookie until you disconnect or close your browser. Your portfolio will load, and you can search symbols for actual quotes and charts.
        </p>
        <form onSubmit={connect} className="space-y-4">
          <div>
            <label htmlFor="groww-access-token" className="field-label mb-2">Access token</label>
            <input
              id="groww-access-token"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
              maxLength={3000}
              value={accessToken}
              disabled={busy}
              onChange={(event) => setAccessToken(event.target.value)}
              className="field w-full"
              placeholder="Paste access token (without Bearer)"
            />
          </div>
          {error && <p role="alert" className="text-sm text-negative">{error}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" className="secondary-button text-sm" disabled={busy} onClick={close}>Cancel</button>
            <button type="submit" className="primary-button text-sm" disabled={busy || !accessToken.trim()}>
              {busy ? "Connecting..." : "Connect"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
