import { z } from "zod";
import { GrowwHttpError, growwErrorResponse, growwJson, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { currentIstDate, getFnoInstruments, getOptionGuideUnderlyings } from "../../../../lib/groww/instruments.ts";
import { stockSymbolSchema } from "../../../../lib/groww/instrument-schemas.ts";
import { benchmarkSnapshotSchema } from "../../../../lib/groww/benchmark-schemas.ts";
import { fnoGuideSchema, optionIndexListSchema } from "../../../../lib/groww/fno-guide-schemas.ts";
import type { OptionTrend } from "../../../../lib/groww/fno-guide-schemas.ts";
import { growwCandleHistorySchema, growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { historicalRequests } from "../../../../lib/groww/historical-requests.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { nearbyOptionContracts, optionIndexTrend } from "../../../../lib/market/option-guide.ts";

export const maxDuration = 60;
const querySchema = z.object({
  exchange: z.enum(["NSE", "BSE"]).default("NSE"), underlying: stockSymbolSchema.optional(),
  expiry: z.iso.date().optional(), type: z.enum(["CE", "PE"]).default("CE"),
  strike: z.coerce.number().finite().positive().optional(),
});

export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    exchange: params.get("exchange") ?? undefined, underlying: params.get("underlying") || undefined,
    expiry: params.get("expiry") || undefined, type: params.get("type") ?? undefined,
    strike: params.get("strike") || undefined,
  });
  if (!parsed.success) return Response.json({ error: "Select a valid underlying stock/index, expiry, strike and CE/PE side." }, { status: 400, headers: sessionResponseHeaders });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);
  try {
    const { exchange, underlying, expiry, type, strike } = parsed.data;
    const [catalog, indices] = await Promise.all([getFnoInstruments(signal), getOptionGuideUnderlyings(exchange, signal)]);
    const options = catalog.filter(item => item.exchange === exchange && item.expiry >= currentIstDate() && item.instrumentType !== "FUT");
    if (!underlying) return Response.json(optionIndexListSchema.parse({ indices }), { headers: sessionResponseHeaders });
    const selection = indices.find(item => item.underlying === underlying);
    if (!selection) return Response.json({ error: "No unique verified spot stock/index and listed options match this underlying. Use exact contract search instead." }, { status: 404, headers: sessionResponseHeaders });
    const matches = options.filter(item => item.underlying === underlying && item.instrumentType === type);
    const expiries = [...new Set(matches.map(item => item.expiry))].sort();
    const selectedExpiry = expiry ?? expiries[0];
    if (!selectedExpiry || !expiries.includes(selectedExpiry)) return Response.json({ error: "No listed contracts match this expiry and CE/PE side." }, { status: 404, headers: sessionResponseHeaders });
    const contracts = matches.filter(item => item.expiry === selectedExpiry);
    if (strike !== undefined && !contracts.some(item => item.strikePrice === strike)) {
      return Response.json({ error: "This strike is not listed for the selected underlying, expiry and CE/PE side." }, { status: 404, headers: sessionResponseHeaders });
    }
    const quoteUrl = new URL("https://api.groww.in/v1/live-data/quote");
    quoteUrl.search = new URLSearchParams({ exchange, segment: "CASH", trading_symbol: selection.index.tradingSymbol }).toString();
    const quote = growwQuoteSchema.parse(await growwJson(quoteUrl, token, "option underlying quote", signal));
    const fetchedAt = new Date(Date.now()).toISOString();
    const spot = benchmarkSnapshotSchema.parse({
      symbol: selection.index.tradingSymbol, exchange, name: selection.index.name,
      price: quote.price, previousClose: quote.previousClose, lastTradeTime: quote.lastTradeTime, fetchedAt,
    });
    let trend: OptionTrend;
    try {
      const historySignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const end = Math.floor(Date.now() / 1000);
      const url = new URL("https://api.groww.in/v1/historical/candles");
      url.search = new URLSearchParams({ exchange, segment: "CASH", groww_symbol: selection.index.growwSymbol,
        start_time: String(end - 14 * 86400), end_time: String(end), candle_interval: "15minute" }).toString();
      const history = growwCandleHistorySchema.parse(await historicalRequests.run(token, historySignal,
        () => growwJson(url, token, "option underlying candles", historySignal)));
      trend = optionIndexTrend({ ...history, segment: "CASH", symbol: spot.symbol, exchange, interval: "15minute",
        fetchedAt, quote }, Date.now());
    } catch (error) {
      if (error instanceof GrowwHttpError && error.status === 401) throw error;
      console.error("Option underlying trend is unavailable; spot-based selection remains indicative.");
      trend = { bias: "NEUTRAL", closedThrough: null, reasons: [],
        error: "Underlying candle evidence could not be loaded or validated. WAIT; refresh to retry." };
    }
    return Response.json(fnoGuideSchema.parse({
      ...selection, expiry: selectedExpiry, expiries, type, spot, trend,
      ...nearbyOptionContracts(contracts, spot.price, strike),
    }), { headers: sessionResponseHeaders });
  } catch (error) {
    return growwErrorResponse(error, "Unable to load verified stock/index option selection. Retry or use exact contract search.");
  }
}
