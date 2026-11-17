"use client";

import { useInstrumentPrices } from "./use-instrument-prices";

export function usePaperPrices(positions: { symbol: string; exchange: "NSE" | "BSE" }[], connected: boolean, onSessionExpired: () => void) {
  const live = useInstrumentPrices(positions.map(({ symbol, exchange }) => ({ symbol, exchange, segment: "CASH" })), connected, onSessionExpired);
  return { ...live, prices: Object.fromEntries(Object.values(live.prices).map(tick => [`${tick.exchange}:${tick.symbol}`, tick])) };
}
