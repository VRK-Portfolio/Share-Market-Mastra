import { growwErrorResponse, growwJson, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { growwCandleHistorySchema, growwFnoCandleHistorySchema, growwQuoteSchema, growwFnoQuoteSchema, marketAnalysisSchema, marketRequestSchema } from "../../../../lib/groww/market-schemas.ts";
import { currentIstDate, getFnoInstruments } from "../../../../lib/groww/instruments.ts";
import type { FnoInstrument } from "../../../../lib/groww/instrument-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { calculateIndicators } from "../../../../lib/market/indicators.ts";
import type { ZodError } from "zod";

const lookbackDays = { "15minute": 14, "1hour": 45, "1day": 179 };

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
  const { symbol, exchange, interval, segment } = result.data;
  const quoteUrl = new URL("https://api.groww.in/v1/live-data/quote");
  quoteUrl.search = new URLSearchParams({ exchange, segment, trading_symbol: symbol }).toString();
  const end = Math.floor(Date.now() / 1000);
  const candlesUrl = new URL("https://api.groww.in/v1/historical/candles");
  candlesUrl.search = new URLSearchParams({
    exchange, segment, groww_symbol: `${exchange}-${symbol}`,
    start_time: String(end - lookbackDays[interval] * 86400),
    end_time: String(end), candle_interval: interval,
  }).toString();
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
    if (instrument) candlesUrl.searchParams.set("groww_symbol", instrument.growwSymbol);
    const [rawQuote, rawCandles] = await Promise.all([
      growwJson(quoteUrl, token, "quote", signal),
      growwJson(candlesUrl, token, "historical candles", signal),
    ]);
    const quote = (segment === "FNO" ? growwFnoQuoteSchema : growwQuoteSchema).safeParse(rawQuote);
    if (!quote.success) return invalidResponse("quote", quote.error);
    const history = (segment === "FNO" ? growwFnoCandleHistorySchema : growwCandleHistorySchema).safeParse(rawCandles);
    if (!history.success) return invalidResponse("candles", history.error);
    const analysis = marketAnalysisSchema.safeParse({
      symbol, exchange, interval, segment, instrument, fetchedAt: new Date().toISOString(),
      quote: quote.data, ...history.data, technical: calculateIndicators(history.data.candles),
    });
    if (!analysis.success) return invalidResponse("analysis", analysis.error);
    return Response.json(analysis.data, { headers: sessionResponseHeaders });
  } catch (error) {
    controller.abort();
    return growwErrorResponse(error, "Unable to load valid Groww quote and candle data. Verify the trading symbol, exchange and market-data subscription, then retry.");
  }
}
