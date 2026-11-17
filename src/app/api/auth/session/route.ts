import { authFailure, authResponseHeaders, terminalSession } from "../../../../lib/auth/session.ts";

export async function GET(request: Request) {
  if (!request.headers.get("cookie")) {
    return Response.json({ authenticated: false }, { status: 401, headers: authResponseHeaders });
  }
  try {
    const session = await terminalSession(request);
    return Response.json(session ? { authenticated: true, ...session } : { authenticated: false }, {
      status: session ? 200 : 401, headers: authResponseHeaders,
    });
  } catch { return authFailure(); }
}
