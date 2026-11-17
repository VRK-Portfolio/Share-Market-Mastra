import { z } from "zod";
import { isSameOrigin, clearSessionCookie } from "../../../../lib/groww/session.ts";
import { verifyTerminalPassword } from "../../../../lib/auth/password.ts";
import {
  authFailure, authResponseHeaders, sameUsername, terminalAuthStore, terminalConfiguration, terminalCookie,
} from "../../../../lib/auth/session.ts";

export const maxDuration = 30;
const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(100), password: z.string().min(1).max(256),
}).strict();
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin login is not allowed." }, { status: 403, headers: authResponseHeaders });
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Send valid login details." }, { status: 400, headers: authResponseHeaders });
  }
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Enter a username and password." }, { status: 400, headers: authResponseHeaders });
  try {
    const configuration = terminalConfiguration();
    const now = Date.now();
    if (!await terminalAuthStore.reserveAttempt(configuration.version, now)) {
      const retryAfter = Math.max(1, Math.ceil((900_000 - now % 900_000) / 1000));
      return Response.json({ error: "Too many terminal login attempts. Wait for the 15-minute window to reset." }, {
        status: 429, headers: { ...authResponseHeaders, "Retry-After": String(retryAfter) },
      });
    }
    const passwordMatches = await verifyTerminalPassword(parsed.data.password, configuration.passwordHash);
    if (!sameUsername(parsed.data.username, configuration.username) || !passwordMatches) {
      return Response.json({ error: "Invalid username or password." }, { status: 401, headers: authResponseHeaders });
    }
    const session = await terminalAuthStore.create(configuration.version, Date.now());
    const headers = new Headers(authResponseHeaders);
    headers.append("Set-Cookie", terminalCookie(session.token));
    headers.append("Set-Cookie", clearSessionCookie());
    return Response.json({ authenticated: true, expiresAt: session.expiresAt.toISOString() }, { headers });
  } catch { return authFailure(); }
}
