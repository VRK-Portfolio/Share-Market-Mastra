export const intervals = ["15minute", "1hour", "1day"] as const;
export type Interval = (typeof intervals)[number];
export type AnalysisMode = "MIS" | "CNC" | "NRML";
export type MarketSegment = "CASH" | "FNO";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number | null;
}

export interface Quote {
  price: number;
  change: number | null;
  changePercent: number | null;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number | null;
  lastTradeTime: number | null;
  openInterest?: number | null;
  oiDayChange?: number | null;
  impliedVolatility?: number | null;
}

export interface Overlay {
  time: number;
  value: number;
}

export interface TechnicalAnalysis {
  vwap: number | null;
  rsi: number | null;
  atr: number | null;
  ema20: number | null;
  ema50: number | null;
  macd: { value: number; signal: number; histogram: number } | null;
  supertrend: { value: number; direction: "bullish" | "bearish" } | null;
  overlays: { vwap: Overlay[]; ema20: Overlay[]; supertrend: Overlay[] };
}

export interface MarketAnalysis {
  segment?: MarketSegment;
  instrument?: import("../groww/instrument-schemas.ts").FnoInstrument;
  fetchedAt?: string;
  symbol: string;
  exchange: "NSE" | "BSE";
  interval: Interval;
  quote: Quote;
  candles: Candle[];
  omittedCandles?: number;
  technical: TechnicalAnalysis;
}
