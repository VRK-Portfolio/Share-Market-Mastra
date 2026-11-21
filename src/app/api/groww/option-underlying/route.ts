import { z } from "zod";
import { growwErrorResponse, growwJson, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { currentIstDate, getFnoInstruments, getOptionUnderlyingInstrument } from "../../../../lib/groww/instruments.ts";
import { stockSymbolSchema } from "../../../../lib/groww/instrument-schemas.ts";
import { growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { optionUnderlyingSnapshotSchema } from "../../../../lib/groww/option-analytics-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";

export const maxDuration = 60;
const requestSchema = z.object({ symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]).default("NSE") });

export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const parsed = requestSchema.safeParse({ symbol: params.get("symbol"), exchange: params.get("exchange") ?? undefined });
  if (!parsed.success) return Response.json({ error: "Select an exact option contract and valid exchange." },
    { status: 400, headers: sessionResponseHeaders });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  try {
    const contract = (await getFnoInstruments(signal)).find(item => item.tradingSymbol === parsed.data.symbol &&
      item.exchange === parsed.data.exchange && item.instrumentType !== "FUT" && item.expiry >= currentIstDate());
    if (!contract) return Response.json({ error: "The option is missing, expired or is a future. Choose an available CE/PE contract." },
      { status: 404, headers: sessionResponseHeaders });
    const underlying = await getOptionUnderlyingInstrument(contract, signal);
    if (!underlying) return Response.json({ error: "No unique verified CASH stock/index matches the option underlying. Greeks are unavailable; no spot symbol is guessed." },
      { status: 404, headers: sessionResponseHeaders });
    const url = new URL("https://api.groww.in/v1/live-data/quote");
    url.search = new URLSearchParams({ exchange: underlying.exchange, segment: "CASH", trading_symbol: underlying.tradingSymbol }).toString();
    const quote = growwQuoteSchema.parse(await growwJson(url, token, "option analytics underlying quote", signal));
    return Response.json(optionUnderlyingSnapshotSchema.parse({
      contract, underlying, quote: {
        symbol: underlying.tradingSymbol, exchange: underlying.exchange, name: underlying.name,
        price: quote.price, previousClose: quote.previousClose, lastTradeTime: quote.lastTradeTime, fetchedAt: new Date().toISOString(),
      },
    }), { headers: sessionResponseHeaders });
  } catch (error) {
    return growwErrorResponse(error, "Unable to load or validate the option underlying. Retry; model analytics are unavailable.");
  }
}
