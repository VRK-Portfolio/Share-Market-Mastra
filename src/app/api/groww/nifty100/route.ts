import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getNifty100 } from "../../../../lib/groww/nifty100.ts";
import { sessionResponseHeaders } from "../../../../lib/groww/session.ts";

export const maxDuration = 30;

export async function GET(request: Request) {
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  try {
    return Response.json(await getNifty100(request.signal), { headers: sessionResponseHeaders });
  } catch {
    console.error("The official NIFTY 100 constituent list could not be loaded or validated.");
    return Response.json({
      error: "Unable to load and verify the official 100-stock NIFTY 100 list. Retry; no partial, stale or substitute universe is being scanned.",
    }, { status: 502, headers: sessionResponseHeaders });
  }
}
