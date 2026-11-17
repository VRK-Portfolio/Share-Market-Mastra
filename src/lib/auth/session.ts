import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { paperDatabase } from "../paper/database.ts";
import { passwordHashPattern } from "./password.ts";

export const terminalCookieName = "terminal-session";
export const terminalSessionMs = 8 * 60 * 60_000;
export const authResponseHeaders = { "Cache-Control": "no-store, private" };
type SessionRecord = { _id: string; version: string; expiresAt: Date };
type AttemptRecord = { _id: string; attempts: number; expiresAt: Date };

export function terminalConfiguration() {
  const username = process.env.TERMINAL_ADMIN_USERNAME?.trim();
  const passwordHash = process.env.TERMINAL_ADMIN_PASSWORD_HASH?.trim();
  const secret = process.env.TERMINAL_SESSION_SECRET;
  if (!username || username.length > 100 || !passwordHash || !passwordHashPattern.test(passwordHash) || !secret || secret.length < 32) {
    throw new Error("Terminal administrator login is not configured.");
  }
  const version = createHmac("sha256", secret).update(`${username}\0${passwordHash}`).digest("hex");
  return { username, passwordHash, version };
}
export function sameUsername(actual: string, expected: string) {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}
function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function cookieToken(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${terminalCookieName}=`))?.slice(terminalCookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function terminalCookie(token: string, clear = false) {
  return `${terminalCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : terminalSessionMs / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export const terminalAuthStore = {
  async reserveAttempt(version: string, now: number) {
    const windowMs = 15 * 60_000;
    const window = Math.floor(now / windowMs);
    const collection = (await paperDatabase()).collection<AttemptRecord>("terminal_login_attempts");
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const filter = { _id: `${version}:${window}`, attempts: { $lt: 5 } };
    const update = { $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } };
    try {
      await collection.updateOne(filter, update, { upsert: true, maxTimeMS: 8000 });
      return true;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== 11000) throw error;
      const result = await collection.updateOne(filter, update, { maxTimeMS: 8000 });
      return result.matchedCount === 1;
    }
  },
  async create(version: string, now: number) {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(now + terminalSessionMs);
    const collection = (await paperDatabase()).collection<SessionRecord>("terminal_sessions");
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.insertOne({ _id: tokenHash(token), version, expiresAt });
    return { token, expiresAt };
  },
  async find(token: string, version: string, now: number) {
    const collection = (await paperDatabase()).collection<SessionRecord>("terminal_sessions");
    const record = await collection.findOne({ _id: tokenHash(token), version, expiresAt: { $gt: new Date(now) } }, { maxTimeMS: 8000 });
    return record ? { expiresAt: record.expiresAt.toISOString() } : null;
  },
  async remove(token: string) {
    await (await paperDatabase()).collection<SessionRecord>("terminal_sessions").deleteOne({ _id: tokenHash(token) });
  },
};
export async function terminalSession(request: Request) {
  const token = cookieToken(request);
  if (!token) return null;
  return terminalAuthStore.find(token, terminalConfiguration().version, Date.now());
}
export async function revokeTerminalSession(request: Request) {
  const token = cookieToken(request);
  if (token) await terminalAuthStore.remove(token);
}
export function authFailure() {
  console.error("Terminal authentication is unavailable. Check administrator configuration and MongoDB connectivity.");
  return Response.json({ error: "Terminal login is unavailable. Check server administrator configuration and MongoDB connectivity." }, {
    status: 503, headers: authResponseHeaders,
  });
}
