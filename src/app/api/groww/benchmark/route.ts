import { z } from "zod";
import { growwErrorResponse, growwJson, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getIndexInstruments } from "../../../../lib/groww/instruments.ts";
import { stockSymbolSchema } from "../../../../lib/groww/instrument-schemas.ts";
import { benchmarkSnapshotSchema } from "../../../../lib/groww/benchmark-schemas.ts";
import { growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";

export const maxDuration = 60;
const requestSchema = z.object({
  symbol: stockSymbolSchema.optional(), exchange: z.enum(["NSE", "BSE"]).default("NSE"),
});

export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const parsed = requestSchema.safeParse({
    symbol: params.get("symbol") ?? undefined, exchange: params.get("exchange") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "Select a valid index symbol and exchange." }, {
    status: 400, headers: sessionResponseHeaders,
  });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);
  try {
    const { symbol, exchange } = parsed.data;
    const indices = await getIndexInstruments(exchange, signal);
    if (!symbol) return Response.json({ indices }, { headers: sessionResponseHeaders });
    const index = indices.find((item) => item.tradingSymbol === symbol);
    if (!index) return Response.json({ error: "This symbol is not a verified index in Groww's instrument catalogue." }, {
      status: 404, headers: sessionResponseHeaders,
    });
    const url = new URL("https://api.groww.in/v1/live-data/quote");
    url.search = new URLSearchParams({ exchange, segment: "CASH", trading_symbol: symbol }).toString();
    const raw = await growwJson(url, token, "sector benchmark quote", signal);
    const receivedAt = new Date(Date.now()).toISOString();
    const quote = growwQuoteSchema.parse(raw);
    const snapshot = benchmarkSnapshotSchema.parse({
      symbol, exchange, name: index.name, price: quote.price, previousClose: quote.previousClose,
      lastTradeTime: quote.lastTradeTime, fetchedAt: receivedAt,
    });
    return Response.json(snapshot, { headers: sessionResponseHeaders });
  } catch (error) {
    return growwErrorResponse(error, "Unable to load or validate the sector-index benchmark. Retry index selection or refresh.");
  }
}
