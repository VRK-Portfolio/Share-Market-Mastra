"use client";

import { useState } from "react";
import type { Candle, Interval, MarketAnalysis, Overlay } from "../../lib/market/types";
import { decimal, money, timeLabel } from "./format";

const intervalOptions: { value: Interval; label: string }[] = [
  { value: "15minute", label: "15m" }, { value: "1hour", label: "1h" }, { value: "1day", label: "1D" },
];
const overlayColors = { vwap: "#f5b942", ema20: "#9b8cff", supertrend: "#27c89c" };

export function PriceChart({ data, interval, onInterval }: {
  data: MarketAnalysis | null; interval: Interval; onInterval: (interval: Interval) => void;
}) {
  const [overlays, setOverlays] = useState({ vwap: true, ema20: true, supertrend: false });
  const [hovered, setHovered] = useState<Candle | null>(null);
  const candles = data?.candles.slice(-80) ?? [];
  const selected = candles.find((candle) => candle.time === hovered?.time) ?? candles.at(-1);
  const width = 1100, height = 340, left = 14, right = 95, top = 20, bottom = 35;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const displayedOverlays = data ? Object.entries(overlays)
    .filter(([, enabled]) => enabled)
    .flatMap(([key]) => data.technical.overlays[key as keyof typeof overlays].filter((point) => point.time >= (candles[0]?.time ?? 0))) : [];
  const low = candles.length ? Math.min(...candles.map((candle) => candle.low), ...displayedOverlays.map((point) => point.value)) : 0;
  const high = candles.length ? Math.max(...candles.map((candle) => candle.high), ...displayedOverlays.map((point) => point.value)) : 1;
  const padding = Math.max((high - low) * 0.12, high * 0.001, 0.01);
  const min = low - padding, max = high + padding;
  const y = (price: number) => top + (max - price) / (max - min) * chartHeight;
  const step = chartWidth / Math.max(candles.length, 1);
  const x = (index: number) => left + step * (index + 0.5);
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);

  function overlayPath(points: Overlay[], breakSessions = false) {
    let previousTime = 0;
    return candles.map((candle, index) => {
      const point = points.find((item) => item.time === candle.time);
      if (!point) { previousTime = 0; return ""; }
      const sameSession = new Date((previousTime + 19800) * 1000).toISOString().slice(0, 10) === new Date((point.time + 19800) * 1000).toISOString().slice(0, 10);
      const command = !previousTime || (breakSessions && !sameSession) ? "M" : "L";
      previousTime = point.time;
      return `${command}${x(index)},${y(point.value)}`;
    }).join(" ");
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="chart-title">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 pt-6 sm:px-7">
        <div><h2 id="chart-title" className="text-sm font-semibold">{data?.symbol ?? "Stock"} <span className="px-1 text-muted">/</span> Candlesticks &amp; overlays</h2><p className="mt-1 text-[11px] text-muted">{data ? `${data.exchange} · INR · Last ${candles.length} candles` : "Price action, volume and technical context"}</p></div>
        <div className="flex gap-1 rounded-lg border border-line bg-inset p-1" aria-label="Candle interval">
          {intervalOptions.map((option) => <button key={option.value} type="button" onClick={() => { setHovered(null); onInterval(option.value); }} aria-pressed={option.value === interval} className={`rounded-md px-4 py-1.5 font-mono text-xs transition-colors ${option.value === interval ? "bg-accent text-white shadow-sm" : "text-muted hover:text-foreground"}`}>{option.label}</button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 text-[11px] sm:px-7">
        <div className="flex flex-wrap gap-4">{(Object.keys(overlays) as (keyof typeof overlays)[]).map((key) => <label key={key} className="flex cursor-pointer items-center gap-2 text-muted"><input type="checkbox" className="size-3 accent-accent" checked={overlays[key]} onChange={() => setOverlays((current) => ({ ...current, [key]: !current[key] }))} /><span className="h-0.5 w-3" style={{ backgroundColor: overlayColors[key] }} />{key === "vwap" ? "VWAP" : key === "ema20" ? "EMA 20" : "SuperTrend"}</label>)}</div>
        <p className="flex flex-wrap gap-3 font-mono text-muted">{selected ? <><span>O <b className="text-foreground">{decimal(selected.open)}</b></span><span>H <b className="text-foreground">{decimal(selected.high)}</b></span><span>L <b className="text-foreground">{decimal(selected.low)}</b></span><span>C <b className="text-foreground">{decimal(selected.close)}</b></span></> : "OHLC -- / -- / -- / --"}</p>
      </div>
      <div className="relative mx-3 mb-2 min-h-[300px] sm:mx-5">
        {!candles.length && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">No historical candles loaded.</p>}
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[320px] w-full sm:h-auto" role="img" aria-label={data ? `${data.symbol} candlestick chart, ${candles.length} candles. Last close ${money(candles.at(-1)?.close)}.` : "No market data loaded"} onMouseLeave={() => setHovered(null)}>
          {[0, 1, 2, 3, 4].map((line) => <g key={line}><line x1={left} x2={width - right} y1={top + chartHeight * line / 4} y2={top + chartHeight * line / 4} stroke="var(--line)" strokeDasharray="3 5" /><text x={width - right + 14} y={top + chartHeight * line / 4 + 4} fill="var(--muted)" fontSize="10" fontFamily="monospace">{candles.length ? decimal(max - (max - min) * line / 4) : "--"}</text></g>)}
          {candles.map((candle, index) => {
            const color = candle.close >= candle.open ? "var(--positive)" : "var(--negative)";
            return <g key={candle.time}><rect x={x(index) - step * 0.28} y={height - bottom - candle.volume / maxVolume * 46} width={step * 0.56} height={candle.volume / maxVolume * 46} fill={color} opacity="0.13" /><line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} stroke={color} /><rect x={x(index) - step * 0.28} y={Math.min(y(candle.open), y(candle.close))} width={step * 0.56} height={Math.max(Math.abs(y(candle.open) - y(candle.close)), 1.2)} fill={color} /><rect x={left + index * step} y={top} width={step} height={chartHeight} fill="transparent" onMouseEnter={() => setHovered(candle)}><title>{`${timeLabel(candle.time, true)} ${timeLabel(candle.time)} IST · Open ${money(candle.open)} · High ${money(candle.high)} · Low ${money(candle.low)} · Close ${money(candle.close)} · Volume ${candle.volume}`}</title></rect></g>;
          })}
          {data && (Object.keys(overlays) as (keyof typeof overlays)[]).filter((key) => overlays[key]).map((key) => <path key={key} d={overlayPath(data.technical.overlays[key], key === "vwap")} fill="none" stroke={overlayColors[key]} strokeWidth="1.7" pointerEvents="none" />)}
          {candles.filter((_, index) => index % Math.max(1, Math.floor(candles.length / 6)) === 0).map((candle) => <text key={candle.time} x={x(candles.indexOf(candle))} y={height - 10} textAnchor="middle" fill="var(--muted)" fontSize="10" fontFamily="monospace">{timeLabel(candle.time, interval === "1day")}</text>)}
          {hovered && candles.includes(hovered) && <line x1={x(candles.indexOf(hovered))} x2={x(candles.indexOf(hovered))} y1={top} y2={height - bottom} stroke="var(--muted)" strokeDasharray="3 3" pointerEvents="none" />}
        </svg>
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t border-line px-5 py-3 text-[10px] text-muted sm:px-7"><span>Volume shown below price · All times IST</span><span>Groww historical candles · Snapshot, not streaming</span></div>
    </section>
  );
}
