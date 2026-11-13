"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { indicatorDetails } from "../../lib/market/indicator-details";
import type { IndicatorValues } from "../../lib/market/indicator-details";
import type { IndicatorName } from "../../lib/market/technical-verdict";

export function InfoTooltip({ label, value, description }: {
  label: string; value: string; description: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  function clearClose() {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function show() { clearClose(); setOpen(true); }
  function hide() {
    clearClose();
    if (!pinned) closeTimer.current = setTimeout(() => setOpen(false), 150);
  }
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    function close() { setOpen(false); setPinned(false); }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !button.current?.contains(event.target) && !tooltip.current?.contains(event.target)) close();
    }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const anchor = button.current;
      const panel = tooltip.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8))}px`;
      panel.style.top = `${Math.max(8, rect.bottom + size.height + 8 > window.innerHeight
        ? rect.top - size.height - 8 : rect.bottom + 8)}px`;
      panel.style.visibility = "visible";
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, label, value, description]);

  return <>
    <button ref={button} type="button" aria-label={`Info about ${label}`} aria-describedby={open ? id : undefined}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onPointerEnter={show} onPointerLeave={hide} onFocus={show}
      onBlur={() => { clearClose(); setOpen(false); setPinned(false); }}
      onClick={() => { clearClose(); setPinned(!pinned); setOpen(!pinned); }}>
      <span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded-full border border-current font-mono text-[10px] font-semibold">i</span>
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip"
      className="invisible fixed left-0 top-0 z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-panel p-4 text-xs text-foreground shadow-xl"
      onPointerEnter={show} onPointerLeave={hide}>
      <p className="font-semibold">{label}</p>
      <p className="mt-2 text-muted">Unrounded supplied value</p>
      <p className="mt-1 break-words font-mono">{value}</p>
      <p className="mt-3">{description}</p>
    </div>, document.body)}
  </>;
}

export function IndicatorInfo({ name, values }: { name: IndicatorName; values: IndicatorValues | null }) {
  return <InfoTooltip {...indicatorDetails(name, values)} />;
}
