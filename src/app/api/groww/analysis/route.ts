import { growwErrorResponse, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { marketRequestSchema } from "../../../../lib/groww/market-schemas.ts";
import { loadMarketAnalysis, MarketValidationError } from "../../../../lib/groww/analysis.ts";
import { currentIstDate, getFnoInstruments } from "../../../../lib/groww/instruments.ts";
import type { FnoInstrument } from "../../../../lib/groww/instrument-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import type { ZodError } from "zod";

function invalidResponse(stage: "quote" | "candles" | "analysis", error: ZodError) {
  const validationErrors = error.issues.slice(0, 10).map((issue) => ({
    field: issue.path.join(".") || "response",
    code: issue.code,
    message: issue.message.slice(0, 200),
  }));
  console.error(`Invalid Groww ${stage} response fields:`, validationErrors.map(({ field, code }) => ({ field, code })));
  return Response.json({
    error: `Groww returned invalid ${stage} data: ${validationErrors.map(({ field, message }) => `${field}: ${message}`).join("; ")}`,
    failureType: "validation",
    stage,
    validationErrors,
  }, { status: 502, headers: sessionResponseHeaders });
}

export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const result = marketRequestSchema.safeParse({
    symbol: params.get("symbol"),
    exchange: params.get("exchange") ?? undefined,
    interval: params.get("interval") ?? undefined,
    segment: params.get("segment") ?? undefined,
  });
  if (!result.success) {
    return Response.json(
      { error: "Enter a valid stock symbol, NSE/BSE exchange and 15minute, 1hour or 1day interval." },
      { status: 400, headers: sessionResponseHeaders },
    );
  }
  const { symbol, exchange, segment } = result.data;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(15_000)]);

  try {
    let instrument: FnoInstrument | undefined;
    if (segment === "FNO") {
      try {
        instrument = (await getFnoInstruments(signal)).find((item) =>
          item.exchange === exchange && item.tradingSymbol === symbol && item.expiry >= currentIstDate());
      } catch {
        controller.abort();
        console.error("Unable to load or validate the Groww F&O instrument catalog for analysis.");
        return Response.json({
          error: "Unable to verify the Groww F&O contract catalog. Retry contract search and analysis.",
          failureType: "instrument-catalog", stage: "instruments",
        }, { status: 502, headers: sessionResponseHeaders });
      }
    }
    if (segment === "FNO" && !instrument) return Response.json({
      error: "This F&O contract is missing or expired. Select an available contract from the Groww contract search.",
    }, { status: 404, headers: sessionResponseHeaders });
    const analysis = await loadMarketAnalysis(token, result.data, signal, instrument);
    return Response.json(analysis, { headers: sessionResponseHeaders });
  } catch (error) {
    controller.abort();
    if (error instanceof MarketValidationError) return invalidResponse(error.stage, error.validation);
    return growwErrorResponse(error, "Unable to load valid Groww quote and candle data. Verify the trading symbol, exchange and market-data subscription, then retry.");
  }
}
