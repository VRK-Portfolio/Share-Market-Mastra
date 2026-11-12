import { holdingsResponseSchema, positionsResponseSchema } from "./portfolio-schemas.ts";
import { growwErrorResponse, growwJson, requireGrowwSession } from "./client.ts";
import { sessionResponseHeaders } from "./session.ts";

export async function fetchPortfolio(request: Request, resource: "holdings" | "positions") {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;

  const url = new URL(`https://api.groww.in/v1/${resource}/user`);
  if (resource === "positions") {
    const segment = new URL(request.url).searchParams.get("segment");
    if (segment !== null) {
      if (segment !== "CASH" && segment !== "FNO") {
        return Response.json(
          { error: "The positions segment must be CASH or FNO, or omitted for all segments." },
          { status: 400, headers: sessionResponseHeaders },
        );
      }
      url.searchParams.set("segment", segment);
    }
  }

  try {
    const data = await growwJson(url, token, resource, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
    const schema = resource === "holdings" ? holdingsResponseSchema : positionsResponseSchema;
    const result = schema.safeParse(data);
    if (!result.success) {
      console.error(`Groww returned an unsuccessful or invalid ${resource} response.`);
      return Response.json(
        { error: `Groww returned an unsuccessful or invalid ${resource} response. Please try again.` },
        { status: 502, headers: sessionResponseHeaders },
      );
    }
    return Response.json(result.data, { headers: sessionResponseHeaders });
  } catch (error) {
    return growwErrorResponse(error, `Unable to fetch Groww ${resource}. Please try again.`);
  }
}
