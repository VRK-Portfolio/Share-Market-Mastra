import { loadMarketAnalysis } from "../groww/analysis.ts";
import { calculateEntryTiming } from "../market/entry-timing.ts";
import { calculateIndicators } from "../market/indicators.ts";
import { intradayEntryCutoff, regularMarketSession } from "../market/market-session.ts";
import { PaperTradingError } from "../market/paper-trading.ts";
import { assessMarketDepth, calculatePriceActionConfluence } from "../market/price-action-confluence.ts";
import { calculateTechnicalVerdict } from "../market/technical-verdict.ts";
import { paperSegment } from "../market/paper-instruments.ts";
import { getFnoInstruments } from "../groww/instruments.ts";

type Selection = { symbol: string; exchange: "NSE" | "BSE"; product: "MIS" | "CNC" | "NRML"; segment?: "CASH" | "FNO" };

export const paperSignalChecks = {
  async approve(
    token: string, selection: Selection, side: "BUY" | "SELL", signal: AbortSignal, now = Date.now(),
  ): Promise<void> {
    const deny = (reasons: string[]): never => {
      throw new PaperTradingError(`Strict PAPER entry denied: ${[...new Set(reasons)].join(" ")}`);
    };
    const session = regularMarketSession(now);
    if (session.phase !== "open") deny(["Regular weekday trading session required (09:15–15:30 IST)."]);
    if (selection.product === "MIS" && now >= intradayEntryCutoff(now)) {
      deny(["New intraday entries stop at 15:20 IST."]);
    }
    if (selection.product === "CNC" && side !== "BUY") deny(["CNC supports new BUY entries only."]);
    const interval = selection.product === "MIS" ? "15minute" : "1day";
    const requestStartedAt = Date.now();
    let loaded: Awaited<ReturnType<typeof loadMarketAnalysis>>;
    try {
      const contract = paperSegment(selection) === "FNO" ? (await getFnoInstruments(signal))
        .find(item => item.tradingSymbol === selection.symbol && item.exchange === selection.exchange) : undefined;
      if (paperSegment(selection) === "FNO" && !contract) deny(["The exact F&O contract could not be verified."]);
      loaded = await loadMarketAnalysis(token, {
        symbol: selection.symbol, exchange: selection.exchange, segment: paperSegment(selection), interval,
      }, signal, contract);
    } catch {
      return deny(["Authoritative quote, candle or depth evidence could not be loaded or validated. Refresh market data."]);
    }
    now += Math.max(0, Date.now() - requestStartedAt);
    if (regularMarketSession(now).phase !== "open") deny(["Entry evidence completed outside the regular trading session."]);
    if (loaded.omittedCandles) deny(["Missing OHLC candles prevent strict entry approval."]);
    const snapshotAt = Date.parse(loaded.fetchedAt ?? "");
    if (!Number.isFinite(snapshotAt) || snapshotAt > now + 5_000) {
      deny(["A valid market snapshot timestamp is required."]);
    }
    if (loaded.candles.some((bar) => !Number.isFinite(bar.time) || bar.time <= 0 ||
      bar.time * 1000 > 8_640_000_000_000_000 - 86_400_000)) {
      deny(["Candle timestamps are invalid; closed-session evidence cannot be verified."]);
    }
    const candles = loaded.candles.filter((bar) => {
      const start = bar.time * 1000;
      const barSession = regularMarketSession(start);
      if (interval === "1day") {
        return barSession.phase !== "weekend" && barSession.date < session.date &&
          barSession.closesAt <= Math.min(now, snapshotAt);
      }
      return barSession.phase === "open" && (start - barSession.opensAt) % 900_000 === 0 &&
        start + 900_000 <= Math.min(now, snapshotAt, barSession.closesAt);
    });
    const reasons: string[] = [];
    if (candles.length < 50) {
      reasons.push("At least 50 CLOSED regular-session candles are required; forming, future and off-session bars do not count.");
    }
    if (candles.some((bar) => [bar.open, bar.high, bar.low, bar.close].some((price) => price <= 0))) {
      deny(["Closed candles must contain positive OHLC prices; missing trading evidence is not estimated."]);
    }
    const analysis = { ...loaded, candles, technical: calculateIndicators(candles) };
    const verdict = calculateTechnicalVerdict(analysis, selection.product, now);
    const timing = calculateEntryTiming(analysis, verdict, now);
    const depth = assessMarketDepth(analysis.quote, now);
    if (!verdict.dataReady || verdict.exitOnly || verdict.decision !== side) {
      reasons.push(`Technical rules do not approve ${side}: ${verdict.summary}`, ...verdict.reasons);
    }
    if (paperSegment(selection) === "CASH" && (timing.status !== "CONDITIONS_MET" || timing.side !== side)) {
      reasons.push(`Entry timing does not approve ${side}.`, ...timing.reasons);
    }
    if (paperSegment(selection) === "FNO" && (analysis.quote.lastTradeTime === null ||
      analysis.quote.lastTradeTime > now + 5000 || now - analysis.quote.lastTradeTime > 60_000 ||
      regularMarketSession(analysis.quote.lastTradeTime).date !== session.date)) reasons.push("F&O entry requires a same-day trade no older than 60 seconds.");
    if (selection.product === "MIS" && now >= intradayEntryCutoff(now)) reasons.push("New intraday entries stop at 15:20 IST.");
    if (!depth.available) {
      reasons.push(`Required five-level depth evidence missing: ${depth.reason}`);
    } else {
      if (depth.spreadPercent > 0.2) reasons.push("Depth spread exceeds the 0.2% maximum.");
      if (depth.pressure !== "NEUTRAL" && depth.pressure !== (side === "BUY" ? "BULLISH" : "BEARISH")) {
        reasons.push("Top-five resting-book pressure opposes the requested entry.");
      }
    }
    if (selection.product === "MIS" && paperSegment(selection) === "CASH") {
      const confluence = calculatePriceActionConfluence(analysis, "MIS", null, now, null);
      if (confluence.action !== `CONDITIONAL ${side}`) {
        reasons.push(`Required closed-candle 30m ORB / same-slot volume evidence does not approve ${side}.`,
          ...confluence.reasons);
        if (confluence.volume.ratio === null) reasons.push(confluence.volume.reason);
      }
    }
    if (signal.aborted) reasons.push("Market evidence request was aborted.");
    if (reasons.length) deny(reasons);
  },
};
