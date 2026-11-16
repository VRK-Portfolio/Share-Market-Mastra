import { GrowwHttpError, growwErrorResponse, growwJson, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { currentIstDate } from "../../../../lib/groww/instruments.ts";
import { growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { marketMoversResponseSchema, marketMoversUniverse, rankMarketMovers } from "../../../../lib/market/market-movers.ts";
import type { Quote } from "../../../../lib/market/types.ts";

export const maxDuration = 60;

export async function GET(request: Request) {
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  const token = session;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(45_000)]);
  const quotes: { symbol: string; quote: Quote }[] = [];
  const warnings: { symbol: string; error: string }[] = [];
  let next = 0;
  async function load() {
    while (next < marketMoversUniverse.length) {
      signal.throwIfAborted();
      const symbol = marketMoversUniverse[next++];
      try {
        const url = new URL("https://api.groww.in/v1/live-data/quote");
        url.search = new URLSearchParams({ exchange: "NSE", segment: "CASH", trading_symbol: symbol }).toString();
        const body = await growwJson(url, token, "quote",
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        const parsed = growwQuoteSchema.safeParse(body);
        if (!parsed.success) throw new GrowwHttpError(502, `Groww returned invalid quote data for ${symbol}.`);
        quotes.push({ symbol, quote: parsed.data });
      } catch (error) {
        if (signal.aborted || error instanceof GrowwHttpError && [401, 403, 429].includes(error.status)) throw error;
        const response = growwErrorResponse(error, `Unable to load ${symbol}'s day change.`);
        const body: { error: string } = await response.json();
        warnings.push({ symbol, error: body.error });
      }
    }
  }
  try {
    await Promise.all([load(), load()]);
    if (!quotes.length) return Response.json({
      error: "No stock quotes could be loaded. Check Groww market-data access and retry.", warnings,
    }, { status: 502, headers: sessionResponseHeaders });
    const ranked = rankMarketMovers(quotes);
    const result = marketMoversResponseSchema.parse({
      ...ranked, date: currentIstDate(), fetchedAt: new Date().toISOString(), universe: marketMoversUniverse,
      warnings: [...warnings, ...ranked.warnings],
    });
    return Response.json(result, { headers: sessionResponseHeaders });
  } catch (error) {
    controller.abort();
    return growwErrorResponse(error, "Unable to load today's gainers and losers. Please retry.");
  }
}
