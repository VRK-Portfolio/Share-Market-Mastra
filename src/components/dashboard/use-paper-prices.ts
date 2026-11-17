"use client";

import { useInstrumentPrices } from "./use-instrument-prices";
import { paperPriceKey, paperSegment } from "../../lib/market/paper-instruments";

export function usePaperPrices(positions: { symbol: string; exchange: "NSE" | "BSE"; segment?: "CASH" | "FNO" }[], connected: boolean, onSessionExpired: () => void) {
  const live = useInstrumentPrices(positions.map(item => ({ symbol: item.symbol, exchange: item.exchange, segment: paperSegment(item) })), connected, onSessionExpired);
  return { ...live, prices: Object.fromEntries(Object.values(live.prices).map(tick => [paperPriceKey(tick), tick])) };
}
