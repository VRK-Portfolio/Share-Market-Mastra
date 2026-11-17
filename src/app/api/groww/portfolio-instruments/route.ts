import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getPortfolioInstruments, InstrumentCatalogError } from "../../../../lib/groww/instruments.ts";
import { portfolioInstrumentSelectionsSchema } from "../../../../lib/groww/portfolio-instrument-schemas.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin portfolio lookups are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  let input: unknown;
  try { input = await request.json(); }
  catch { return Response.json({ error: "Send valid JSON portfolio selections." }, { status: 400, headers: sessionResponseHeaders }); }
  const parsed = portfolioInstrumentSelectionsSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: "Choose between 1 and 50 valid portfolio selections." }, { status: 400, headers: sessionResponseHeaders });
  try {
    const data = await getPortfolioInstruments(parsed.data, request.signal);
    return Response.json(data, { headers: sessionResponseHeaders });
  } catch (error) {
    console.error("Unable to resolve portfolio price instruments.", error instanceof InstrumentCatalogError
      ? { stage: error.stage, failureType: error.failureType } : { failureType: "instrument-resolution" });
    return Response.json({ error: error instanceof InstrumentCatalogError ? error.message : "Unable to resolve portfolio price instruments. Retry live prices." },
      { status: 502, headers: sessionResponseHeaders });
  }
}
