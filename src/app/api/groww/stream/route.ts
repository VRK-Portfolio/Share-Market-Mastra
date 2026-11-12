import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getFeedInstrument } from "../../../../lib/groww/instruments.ts";
import { marketRequestSchema } from "../../../../lib/groww/market-schemas.ts";
import { clearSessionCookie, isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { GrowwFeedError, startGrowwFeed } from "../../../../lib/groww/stream.ts";

export async function GET(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin feed requests are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const params = new URL(request.url).searchParams;
  const selection = marketRequestSchema.safeParse({
    symbol: params.get("symbol"), exchange: params.get("exchange") ?? undefined, segment: params.get("segment") ?? undefined,
  });
  if (!selection.success) return Response.json({ error: "Choose a valid trading symbol, exchange and CASH/FNO segment." }, { status: 400, headers: sessionResponseHeaders });
  try {
    const { symbol, exchange, segment } = selection.data;
    const instrument = await getFeedInstrument(symbol, exchange, segment, request.signal);
    if (!instrument) return Response.json({ error: "This instrument is missing or expired. Choose an available stock or F&O contract." }, { status: 404, headers: sessionResponseHeaders });
    const stream = await startGrowwFeed(token, instrument, request.signal);
    return new Response(stream, {
      headers: { ...sessionResponseHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    const failure = error instanceof GrowwFeedError ? error : new GrowwFeedError(502);
    console.error("Unable to start Groww streaming.", { status: failure.status });
    return Response.json({ error: failure.message }, {
      status: failure.status,
      headers: failure.status === 401 ? { ...sessionResponseHeaders, "Set-Cookie": clearSessionCookie() } : sessionResponseHeaders,
    });
  }
}
