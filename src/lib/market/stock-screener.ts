import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";
import { marketAnalysisSchema } from "../groww/market-schemas.ts";
import { closedSessionCandles } from "./closed-candles.ts";
import { calculateIndicators } from "./indicators.ts";
import { intradayEntryCutoff, regularMarketSession } from "./market-session.ts";
import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import type { TechnicalVerdict } from "./technical-verdict.ts";
import { applyLiveTick } from "../groww/live-schemas.ts";
import { freshLivePrice } from "./live-prices.ts";
import type { ObservedPrice } from "./live-prices.ts";
import type { MarketAnalysis } from "./types.ts";

export type ScreenerMode = "MIS" | "CNC";
export const screenerIntervals = { MIS: "15minute", CNC: "1day" } as const;
export const stockAnalysisLinkSchema = z.object({ symbol: stockSymbolSchema, mode: z.enum(["MIS", "CNC"]).default("MIS") });
export type StockAnalysisLink = z.infer<typeof stockAnalysisLinkSchema>;
export type StockScreenResult = { data: MarketAnalysis; error?: never; fromCache?: boolean; refreshError?: string }
  | { error: string; data?: never; refreshError?: never };

export class StockScanError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number;
  constructor(message: string, status: number, retryAfterSeconds = 0) {
    super(message); this.status = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function loadStockScreen(symbol: string, mode: ScreenerMode, signal: AbortSignal): Promise<MarketAnalysis> {
  const interval = screenerIntervals[mode];
  const query = new URLSearchParams({ symbol, exchange: "NSE", segment: "CASH", interval });
  const response = await fetch(`/api/groww/analysis?${query}`, { cache: "no-store", signal });
  const body: unknown = await response.json();
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const seconds = response.status === 429 ? retry && /^\d+$/.test(retry) ? Math.max(30, Math.min(86400, Number(retry))) : 60 : 0;
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Stock analysis failed (${response.status}).`;
    throw new StockScanError(message, response.status, seconds);
  }
  return prepareStockScreen(body, symbol, mode, Date.now());
}

export function prepareStockScreen(body: unknown, symbol: string, mode: ScreenerMode, now: number): MarketAnalysis {
  const parsed = marketAnalysisSchema.safeParse(body);
  if (!parsed.success) throw new Error("Stock analysis returned invalid quote, candle or indicator data. Retry the scan.");
  const data = parsed.data;
  if (data.symbol !== symbol || data.exchange !== "NSE" || data.segment !== "CASH" || data.instrument || data.interval !== screenerIntervals[mode]) {
    throw new Error("Stock analysis returned a different symbol, exchange, segment or timeframe. Retry this scan.");
  }
  if (Date.parse(data.fetchedAt) > now + 5000) throw new Error("Stock history has a future snapshot timestamp.");
  if (data.quote.lastTradeTime !== null && data.quote.lastTradeTime > now + 5000) throw new Error("Stock history has a future quote timestamp.");
  const candles = closedSessionCandles(data.candles, screenerIntervals[mode], Math.min(now, Date.parse(data.fetchedAt)));
  if (candles.some((candle, index) => index > 0 && candle.time <= candles[index - 1].time)) {
    throw new Error("Stock history has duplicate or unordered closed candles.");
  }
  if (candles.some(bar => [bar.open, bar.high, bar.low, bar.close].some(price => price <= 0))) {
    throw new Error("Closed candles contain non-positive OHLC prices; no stock verdict can be confirmed.");
  }
  return { ...data, candles, technical: calculateIndicators(candles) };
}

export function stockScreenVerdict(data: MarketAnalysis, mode: ScreenerMode, now: number) {
  const verdict = calculateTechnicalVerdict(data, mode, now);
  const blockers: string[] = [];
  if (data.segment !== "CASH" || data.exchange !== "NSE" || data.interval !== screenerIntervals[mode]) {
    blockers.push("NSE CASH data and the mode-specific candle interval are required.");
  }
  if (data.omittedCandles) blockers.push("Missing OHLC candles prevent a confirmed screener verdict.");
  if (mode === "MIS" && (regularMarketSession(now).phase !== "open" || now >= intradayEntryCutoff(now))) {
    blockers.push("Intraday setups require an open weekday session before 15:20 IST.");
  }
  if (!blockers.length) return verdict;
  return holdScreenVerdict(verdict, blockers);
}

function holdScreenVerdict(verdict: TechnicalVerdict, blockers: string[]): TechnicalVerdict {
  return { ...verdict, decision: "HOLD", dataReady: false, exitOnly: false,
    entryPrice: null, stopLoss: null, targetPrices: [], riskPerUnit: null, riskRewardRatio: null,
    summary: "HOLD: screener data or session checks did not pass.", reasons: [...blockers, ...verdict.reasons] };
}

export function requiredScreenerClose(mode: ScreenerMode, now: number) {
  const session = regularMarketSession(now);
  if (session.phase !== "weekend") {
    if (mode === "CNC" && now >= session.closesAt) return session.closesAt;
    if (mode === "MIS" && now >= session.opensAt + 900_000) {
      return Math.min(session.closesAt, session.opensAt + Math.floor((now - session.opensAt) / 900_000) * 900_000);
    }
  }
  let previous = regularMarketSession(session.opensAt - 86_400_000);
  while (previous.phase === "weekend") previous = regularMarketSession(previous.opensAt - 86_400_000);
  return previous.closesAt;
}

export function screenerHistoryReady(data: MarketAnalysis, mode: ScreenerMode, now: number) {
  const fetchedAt = Date.parse(data.fetchedAt ?? "");
  const last = data.candles.at(-1);
  if (!last || !Number.isFinite(fetchedAt) || fetchedAt > now + 5000 || data.omittedCandles || data.candles.length < 50 ||
    data.segment !== "CASH" || data.exchange !== "NSE" || data.interval !== screenerIntervals[mode]) return false;
  const closedThrough = mode === "MIS" ? last.time * 1000 + 900_000 : regularMarketSession(last.time * 1000).closesAt;
  const required = requiredScreenerClose(mode, now);
  return fetchedAt >= required && closedThrough >= required && closedThrough <= now;
}

export function liveStockScreen(data: MarketAnalysis, mode: ScreenerMode, tick: ObservedPrice | undefined, now: number) {
  const live = freshLivePrice(tick, now) && tick.symbol === data.symbol && tick.exchange === data.exchange &&
    tick.segment === "CASH" && tick.tradeTime >= (data.quote.lastTradeTime ?? 0);
  const display = live ? applyLiveTick(data, tick) : data;
  const historyReady = screenerHistoryReady(data, mode, now);
  const verdict = stockScreenVerdict(display, mode, now);
  const blockers: string[] = [];
  if (!historyReady) blockers.push("The latest completed candle baseline is missing or outdated. History must refresh before confirmation.");
  if (!live) blockers.push("A fresh matching Groww live price is required. Cached/snapshot prices are indicative only.");
  return { data: display, live, historyReady, verdict: blockers.length ? holdScreenVerdict(verdict, blockers) : verdict };
}
