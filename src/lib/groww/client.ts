import {
  clearSessionCookie,
  sessionConfigurationError,
  sessionResponseHeaders,
  sessionToken,
} from "./session.ts";

export class GrowwHttpError extends Error {
  readonly status: number;
  readonly details: {
    code?: string;
    message?: string;
    resource?: string;
    type?: "http" | "invalid-json" | "upstream-failure";
  };

  constructor(status: number, message: string, details: GrowwHttpError["details"] = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function extractFailureDetails(body: unknown, token: string) {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const error = body.error;
  const rawMessage = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error ? error.message : undefined;
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_-]{1,64}$/i.test(rawCode) && !rawCode.includes(token)
    ? rawCode : undefined;
  const message = typeof rawMessage === "string"
    ? rawMessage.split(token).join("[redacted]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 500)
    : undefined;
  return { code, message };
}

export async function growwFailureDetails(response: Response, token: string): Promise<{ code?: string; message?: string }> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return {};
  try {
    return extractFailureDetails(await response.json(), token);
  } catch {
    return { message: "Groww's error details could not be read." };
  }
}

export function requireGrowwSession(request: Request): string | Response {
  try {
    const token = sessionToken(request);
    if (token) return token;
    return growwErrorResponse(new GrowwHttpError(401, ""), "");
  } catch {
    return sessionConfigurationError();
  }
}

export async function growwJson(url: URL, token: string, resource: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-API-VERSION": "1.0",
    },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const details = await growwFailureDetails(response, token);
    const reason = [details.code, details.message].filter(Boolean).join(": ");
    const hint = response.status === 403
      ? "Groww denied access. Check your active Trading API subscription and the permissions of this access token."
        + (resource === "quote" || resource === "historical candles"
          ? " A successful account connection does not confirm market-data access." : "")
      : "Check the symbol, exchange and API permissions, then try again.";
    throw new GrowwHttpError(
      response.status,
      `Groww could not load ${resource} (HTTP ${response.status}). ${reason ? `${reason}. ` : ""}${hint}`,
      { ...details, resource, type: "http" },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GrowwHttpError(502, `Groww returned invalid JSON for ${resource}. Please retry.`, {
      resource, type: "invalid-json",
    });
  }
  if (body && typeof body === "object" && "status" in body && body.status === "FAILURE") {
    const details = extractFailureDetails(body, token);
    const reason = [details.code, details.message].filter(Boolean).join(": ");
    throw new GrowwHttpError(502, `Groww returned a failed ${resource} response${reason ? `: ${reason}` : "."}`, {
      ...details, resource, type: "upstream-failure",
    });
  }
  return body;
}

export function growwErrorResponse(error: unknown, message: string) {
  const status = error instanceof GrowwHttpError ? error.status : 502;
  const unauthorized = status === 401;
  const timeout = error instanceof DOMException && error.name === "TimeoutError";
  if (status >= 500) console.error(message);
  return Response.json(
    { error: unauthorized
      ? "Your Groww session has expired or is missing. Connect to Groww again."
      : error instanceof GrowwHttpError ? error.message
      : timeout ? "The Groww request timed out. Please retry." : message,
      failureType: error instanceof GrowwHttpError ? error.details.type ?? "http" : timeout ? "timeout" : "request-failed",
      ...(error instanceof GrowwHttpError && error.details.resource ? { stage: error.details.resource } : {}),
      ...(error instanceof GrowwHttpError && error.details.code ? { upstreamCode: error.details.code } : {}),
      ...(error instanceof GrowwHttpError && error.details.message ? { upstreamMessage: error.details.message } : {}),
    },
    { status, headers: unauthorized
      ? { ...sessionResponseHeaders, "Set-Cookie": clearSessionCookie() }
      : sessionResponseHeaders },
  );
}
