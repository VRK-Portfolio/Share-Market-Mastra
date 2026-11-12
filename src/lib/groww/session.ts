import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const cookieName = "groww-session";
export const sessionResponseHeaders = { "Cache-Control": "no-store" };

function sessionKey() {
  const secret = process.env.GROWW_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("GROWW_SESSION_SECRET must contain at least 32 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

export function sessionCookie(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!cookie) return null;

  const key = sessionKey();
  const value = cookie.slice(cookieName.length + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length <= 28) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    // An invalid or tampered cookie is not an authenticated session.
    return null;
  }
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function sessionConfigurationError() {
  console.error("Groww sessions require GROWW_SESSION_SECRET with at least 32 characters.");
  return Response.json(
    { error: "Groww sessions are not configured. Set GROWW_SESSION_SECRET on the server (at least 32 characters)." },
    { status: 503, headers: sessionResponseHeaders },
  );
}
