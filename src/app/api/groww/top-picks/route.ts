import { loadMarketAnalysis } from "../../../../lib/groww/analysis.ts";
import { GrowwHttpError, growwErrorResponse, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { currentIstDate } from "../../../../lib/groww/instruments.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { screenTopPicks, topPicksResponseSchema, topPicksUniverse } from "../../../../lib/market/top-picks.ts";
import type { MarketAnalysis } from "../../../../lib/market/types.ts";

export const maxDuration = 60;

export async function GET(request: Request) {
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  const token = session;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(45_000)]);
  const analyses: MarketAnalysis[] = [];
  const warnings: { symbol: string; error: string }[] = [];
  let next = 0;
  async function screen() {
    while (next < topPicksUniverse.length) {
      signal.throwIfAborted();
      const symbol = topPicksUniverse[next++];
      try {
        const snapshots: MarketAnalysis[] = [];
        for (const interval of ["15minute", "1day"] as const) {
          snapshots.push(await loadMarketAnalysis(token, {
            symbol, exchange: "NSE", segment: "CASH", interval,
          }, AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
        }
        analyses.push(...snapshots);
      } catch (error) {
        if (signal.aborted || error instanceof GrowwHttpError && [401, 403, 429].includes(error.status)) throw error;
        const response = growwErrorResponse(error, `Unable to screen ${symbol}: invalid or unavailable Groww market data.`);
        const body: { error: string } = await response.json();
        warnings.push({ symbol, error: body.error });
      }
    }
  }
  try {
    // Two workers bound upstream traffic to four simultaneous quote/history requests.
    await Promise.all([screen(), screen()]);
    if (!analyses.length) return Response.json({
      error: "No stocks could be screened. Check Groww market-data access and retry.", warnings,
    }, { status: 502, headers: sessionResponseHeaders });
    const now = Date.now();
    const intraday = screenTopPicks(analyses, "MIS", now);
    const carryForward = screenTopPicks(analyses, "CNC", now);
    const result = topPicksResponseSchema.parse({
      date: currentIstDate(), fetchedAt: new Date().toISOString(), universe: topPicksUniverse,
      intraday: intraday.picks, carryForward: carryForward.picks,
      screenedStocks: [...intraday.screenedStocks, ...carryForward.screenedStocks],
      screened: analyses.length / 2, warnings,
    });
    return Response.json(result, { headers: sessionResponseHeaders });
  } catch (error) {
    controller.abort();
    return growwErrorResponse(error, "Unable to screen today's top picks. Retry when Groww market data is available.");
  }
}
