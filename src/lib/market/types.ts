export const intervals = ["15minute", "1hour", "1day"] as const;
export type Interval = (typeof intervals)[number];
export type AnalysisMode = "MIS" | "CNC";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  lastTradeTime: number | null;
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
  symbol: string;
  exchange: "NSE" | "BSE";
  interval: Interval;
  quote: Quote;
  candles: Candle[];
  technical: TechnicalAnalysis;
}
