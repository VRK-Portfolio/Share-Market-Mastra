import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getFeedInstrument } from "../../../../lib/groww/instruments.ts";
import { marketRequestSchema } from "../../../../lib/groww/market-schemas.ts";
import { feedSelectionsSchema } from "../../../../lib/groww/live-schemas.ts";
import type { FeedInstrument } from "../../../../lib/groww/live-schemas.ts";
import { clearSessionCookie, isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { GrowwFeedError, startGrowwFeed } from "../../../../lib/groww/stream.ts";

export async function GET(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin feed requests are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const batch = params.get("instruments");
  let selections: Pick<FeedInstrument, "symbol" | "exchange" | "segment">[];
  if (batch !== null) {
    let input: unknown;
    try { input = JSON.parse(batch); }
    catch { return Response.json({ error: "Send valid JSON stock selections." }, { status: 400, headers: sessionResponseHeaders }); }
    const parsed = feedSelectionsSchema.safeParse(input);
    if (!parsed.success) return Response.json({ error: "Choose between 1 and 50 valid CASH/FNO instruments per price stream." }, { status: 400, headers: sessionResponseHeaders });
    selections = [...new Map(parsed.data.map((item) => [`${item.exchange}:${item.segment}:${item.symbol}`, item])).values()];
  } else {
    const selection = marketRequestSchema.safeParse({
      symbol: params.get("symbol"), exchange: params.get("exchange") ?? undefined, segment: params.get("segment") ?? undefined,
    });
    if (!selection.success) return Response.json({ error: "Choose a valid trading symbol, exchange and CASH/FNO segment." }, { status: 400, headers: sessionResponseHeaders });
    selections = [selection.data];
  }
  try {
    const resolved = await Promise.all(selections.map(({ symbol, exchange, segment }) => getFeedInstrument(symbol, exchange, segment, request.signal)));
    const instruments = resolved.filter((item) => item !== null);
    if (instruments.length !== selections.length || batch !== null && instruments.some((item) => item.segment === "CASH" && item.instrumentType !== "EQ")) {
      return Response.json({ error: "An instrument is missing, expired or not a supported CASH equity/FNO contract for a multi-stock stream." }, { status: 404, headers: sessionResponseHeaders });
    }
    const stream = await startGrowwFeed(token, batch !== null ? instruments : instruments[0], request.signal);
    return new Response(stream, {
      headers: { ...sessionResponseHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    const failure = error instanceof GrowwFeedError ? error : new GrowwFeedError(502);
    console.error("Unable to start Groww streaming.", { status: failure.status, ...failure.diagnostic });
    return Response.json({ error: failure.message, ...failure.diagnostic }, {
      status: failure.status,
      headers: failure.status === 401 ? { ...sessionResponseHeaders, "Set-Cookie": clearSessionCookie() } : sessionResponseHeaders,
    });
  }
}
