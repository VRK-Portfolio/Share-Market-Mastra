import { clearSessionCookie, isSameOrigin } from "../../../../lib/groww/session.ts";
import { authFailure, authResponseHeaders, revokeTerminalSession, terminalCookie } from "../../../../lib/auth/session.ts";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin logout is not allowed." }, { status: 403, headers: authResponseHeaders });
  try {
    await revokeTerminalSession(request);
    const headers = new Headers(authResponseHeaders);
    headers.append("Set-Cookie", terminalCookie("", true));
    headers.append("Set-Cookie", clearSessionCookie());
    return Response.json({ authenticated: false }, { headers });
  } catch { return authFailure(); }
}
