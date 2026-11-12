import { clearSessionCookie, sessionConfigurationError, sessionResponseHeaders, sessionToken } from "../../../../../lib/groww/session.ts";

export async function GET(request: Request) {
  try {
    const connected = Boolean(sessionToken(request));
    return Response.json(
      { connected },
      { headers: connected ? sessionResponseHeaders : { ...sessionResponseHeaders, "Set-Cookie": clearSessionCookie() } },
    );
  } catch {
    return sessionConfigurationError();
  }
}
