import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { currentIstDate, getFnoInstruments, InstrumentCatalogError, searchCashInstruments } from "../../../../lib/groww/instruments.ts";
import { cashInstrumentSearchSchema, instrumentSearchSchema } from "../../../../lib/groww/instrument-schemas.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";

export const maxDuration = 60;

function catalogErrorResponse(error: unknown, segment: "CASH" | "FNO") {
  const catalogError = error instanceof InstrumentCatalogError ? error : null;
  const status = catalogError?.failureType === "timeout" ? 504 : 502;
  const diagnostics = {
    stage: catalogError?.stage ?? "catalog search",
    failureType: catalogError?.failureType ?? "request-failed",
    ...(catalogError?.upstreamStatus !== undefined ? { upstreamStatus: catalogError.upstreamStatus } : {}),
  };
  console.error(`Unable to load the Groww ${segment} instrument catalog.`, diagnostics);
  return Response.json({
    error: catalogError?.message ?? "Unable to search Groww's instrument catalog. Retry the stock or contract search.",
    ...diagnostics,
  }, { status, headers: sessionResponseHeaders });
}

export async function GET(request: Request) {
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const segment = params.get("segment") ?? "FNO";
  if (segment === "CASH") {
    const parsed = cashInstrumentSearchSchema.safeParse({
      segment, q: params.get("q"), exchange: params.get("exchange") ?? undefined,
      page: params.get("page") ?? undefined,
    });
    if (!parsed.success) return Response.json({
      error: "Enter at least two stock-name or symbol characters and a valid exchange and page.",
    }, { status: 400, headers: sessionResponseHeaders });
    try {
      const { q, exchange, page } = parsed.data;
      const matches = await searchCashInstruments(q, exchange, request.signal);
      const pageSize = 30;
      return Response.json({
        segment, q, exchange, instruments: matches.slice((page - 1) * pageSize, page * pageSize),
        total: matches.length, page, pageSize, hasMore: page * pageSize < matches.length,
      }, { headers: sessionResponseHeaders });
    } catch (error) {
      return catalogErrorResponse(error, "CASH");
    }
  }
  const parsed = instrumentSearchSchema.safeParse({
    segment,
    q: params.get("q"), exchange: params.get("exchange") ?? undefined,
    type: params.get("type") ?? undefined, expiry: params.get("expiry") || undefined,
    strike: params.get("strike") || undefined, page: params.get("page") ?? undefined,
  });
  if (!parsed.success) return Response.json({
    error: "Enter at least two search characters and valid exchange, contract type, expiry, strike and page filters.",
  }, { status: 400, headers: sessionResponseHeaders });
  try {
    const { q, exchange, type, expiry, strike, page } = parsed.data;
    const today = currentIstDate();
    const matches = (await getFnoInstruments(request.signal)).filter((instrument) =>
      instrument.exchange === exchange && instrument.expiry >= today &&
      (type === "ALL" || instrument.instrumentType === type) &&
      (!expiry || instrument.expiry === expiry) &&
      (strike === undefined || instrument.strikePrice === strike) &&
      [instrument.underlying, instrument.tradingSymbol, instrument.growwSymbol.toUpperCase()].some((value) => value.includes(q)))
      .sort((a, b) => a.underlying.localeCompare(b.underlying) || a.expiry.localeCompare(b.expiry) ||
        a.instrumentType.localeCompare(b.instrumentType) || (a.strikePrice ?? 0) - (b.strikePrice ?? 0));
    const pageSize = 30;
    return Response.json({
      instruments: matches.slice((page - 1) * pageSize, page * pageSize),
      total: matches.length, page, pageSize, hasMore: page * pageSize < matches.length,
    }, { headers: sessionResponseHeaders });
  } catch (error) {
    return catalogErrorResponse(error, "FNO");
  }
}
