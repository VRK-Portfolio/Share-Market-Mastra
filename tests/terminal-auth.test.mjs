import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { Collection, MongoClient, MongoServerError } from "mongodb";
import { NextRequest } from "next/server.js";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as logout } from "../src/app/api/auth/logout/route.ts";
import { GET as status } from "../src/app/api/auth/session/route.ts";
import { hashTerminalPassword, verifyTerminalPassword } from "../src/lib/auth/password.ts";
import { terminalAuthStore, terminalCookieName, terminalSession } from "../src/lib/auth/session.ts";
import { closePaperDatabase } from "../src/lib/paper/database.ts";
import { proxy } from "../src/proxy.ts";
import { isSameOrigin } from "../src/lib/groww/session.ts";

const names = ["TERMINAL_ADMIN_USERNAME", "TERMINAL_ADMIN_PASSWORD_HASH", "TERMINAL_SESSION_SECRET", "MONGODB_URI", "MONGODB_DB", "NODE_ENV"];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const username = "private-test-admin";
const password = "strong-test-password";
let records;
let now;
beforeEach(async (t) => {
  records = new Map();
  now = Date.parse("2026-11-17T12:00:00+05:30");
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "error", () => {});
  process.env.TERMINAL_ADMIN_USERNAME = username;
  process.env.TERMINAL_ADMIN_PASSWORD_HASH = await hashTerminalPassword(password);
  process.env.TERMINAL_SESSION_SECRET = randomBytes(48).toString("hex");
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DB = "terminal_auth_tests";
  process.env.NODE_ENV = "production";
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(Collection.prototype, "createIndex", async () => "expiresAt_1");
  t.mock.method(Collection.prototype, "updateOne", async function (filter, update, options = {}) {
    const key = `${this.collectionName}:${filter._id}`;
    const current = records.get(key);
    if (current && current.attempts < filter.attempts.$lt) {
      current.attempts += update.$inc.attempts;
      return { matchedCount: 1 };
    }
    if (!options.upsert) return { matchedCount: 0 };
    if (current) throw new MongoServerError({ code: 11000, message: "Duplicate key" });
    records.set(key, { _id: filter._id, attempts: update.$inc.attempts, ...update.$setOnInsert });
    return { matchedCount: 0, upsertedCount: 1 };
  });
  t.mock.method(Collection.prototype, "insertOne", async function (record) {
    records.set(`${this.collectionName}:${record._id}`, structuredClone(record));
    return { acknowledged: true };
  });
  t.mock.method(Collection.prototype, "findOne", async function (filter) {
    const record = records.get(`${this.collectionName}:${filter._id}`);
    return record && record.version === filter.version && record.expiresAt > filter.expiresAt.$gt ? structuredClone(record) : null;
  });
  t.mock.method(Collection.prototype, "deleteOne", async function (filter) {
    return { deletedCount: Number(records.delete(`${this.collectionName}:${filter._id}`)) };
  });
});
afterEach(async () => {
  await closePaperDatabase();
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
function request(path, body, cookie, headers = {}) {
  return new Request(`https://terminal.example${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {
      ...(cookie ? { cookie } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function signIn() {
  const response = await login(request("/api/auth/login", { username, password }));
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${terminalCookieName}=`)).split(";")[0];
}

test("login verifies salted scrypt credentials, issues a secure opaque cookie and stores only a session-token hash", async () => {
  const response = await login(request("/api/auth/login", { username, password }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find((item) => item.startsWith(`${terminalCookieName}=`));
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.ok(cookies.some((item) => item.startsWith("groww-session=") && /Max-Age=0/.test(item)));
  const record = [...records.entries()].find(([key]) => key.startsWith("terminal_sessions:"))[1];
  assert.notEqual(record._id, cookie.split(";")[0].split("=")[1]);
  assert.ok(!JSON.stringify(record).includes(password));
  assert.ok(!JSON.stringify(await response.json()).includes(cookie.split("=")[1]));
  assert.ok(await terminalSession(request("/", undefined, cookie.split(";")[0])));
});

test("generic failures do not reveal username validity and five attempts per window are enforced before password work", async () => {
  for (const credentials of [
    { username, password: "wrong" }, { username: "not-an-admin", password },
    { username, password: "wrong" }, { username, password: "wrong" }, { username, password: "wrong" },
  ]) {
    const response = await login(request("/api/auth/login", credentials));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Invalid username or password.");
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const blocked = await login(request("/api/auth/login", { username, password }));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  now += 900_000;
  assert.equal((await login(request("/api/auth/login", { username, password }))).status, 200);
});

test("concurrent login attempts cannot bypass the persistent global limit", async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => login(request("/api/auth/login", { username, password: "incorrect" }))));
  assert.equal(responses.filter((response) => response.status === 401).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
});

test("missing, tampered, expired and revoked sessions fail closed independently of TTL cleanup", async () => {
  assert.equal(await terminalSession(request("/")), null);
  assert.equal(await terminalSession(request("/", undefined, "terminal-session=forged")), null);
  const cookie = await signIn();
  assert.equal((await status(request("/api/auth/session", undefined, cookie))).status, 200);
  now += 8 * 3_600_000 + 1;
  assert.equal((await status(request("/api/auth/session", undefined, cookie))).status, 401);
  now -= 8 * 3_600_000 + 1;
  assert.equal((await logout(request("/api/auth/logout", {}, cookie))).status, 200);
  assert.equal(await terminalSession(request("/", undefined, cookie)), null);
});

test("rotating password hash or terminal secret invalidates prior sessions", async () => {
  const cookie = await signIn();
  process.env.TERMINAL_ADMIN_PASSWORD_HASH = await hashTerminalPassword("replacement-password");
  assert.equal(await terminalSession(request("/", undefined, cookie)), null);
  process.env.TERMINAL_ADMIN_PASSWORD_HASH = await hashTerminalPassword(password);
  const next = await signIn();
  process.env.TERMINAL_SESSION_SECRET = randomBytes(48).toString("hex");
  assert.equal(await terminalSession(request("/", undefined, next)), null);
});

test("cross-origin and malformed login/logout requests do not create or revoke sessions", async () => {
  const blocked = await login(request("/api/auth/login", { username, password }, undefined, { origin: "https://other.example" }));
  assert.equal(blocked.status, 403);
  assert.equal((await login(request("/api/auth/login", { username, password, role: "admin" }))).status, 400);
  assert.equal((await login(new Request("https://terminal.example/api/auth/login", { method: "POST", body: "bad json" }))).status, 400);
  const cookie = await signIn();
  assert.equal((await logout(request("/api/auth/logout", {}, cookie, { origin: "https://other.example" }))).status, 403);
  assert.ok(await terminalSession(request("/", undefined, cookie)));
});

test("same-origin browser requests use the actual Host when Next reports an internal hostname, without trusting arbitrary forwarding headers", () => {
  const internal = (origin, extra = {}) => new Request("http://localhost:3107/api/auth/login", {
    headers: { origin, host: "127.0.0.1:3107", ...extra },
  });
  assert.equal(isSameOrigin(internal("http://127.0.0.1:3107")), true);
  assert.equal(isSameOrigin(internal("http://localhost:3107")), false);
  assert.equal(isSameOrigin(internal("https://127.0.0.1:3107")), false);
  assert.equal(isSameOrigin(internal("http://attacker.example", { "x-forwarded-host": "attacker.example" })), false);
  assert.equal(isSameOrigin(internal("null")), false);
  assert.equal(isSameOrigin(internal("not-a-url")), false);
});

test("proxy redirects page requests and denies all data APIs until administrator authentication", async () => {
  const redirect = await proxy(new NextRequest("https://terminal.example/"));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "https://terminal.example/login");
  for (const path of [
    "/api/groww/session", "/api/groww/analysis", "/api/groww/orders", "/api/groww/paper",
    "/api/groww/sentiment", "/api/groww/stream", "/api/auth/session",
  ]) {
    const response = await proxy(new NextRequest(`https://terminal.example${path}`));
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).terminalAuthRequired, true);
  }
  for (const path of ["/login", "/api/auth/login", "/api/auth/logout"]) {
    assert.equal((await proxy(new NextRequest(`https://terminal.example${path}`))).headers.get("x-middleware-next"), "1");
  }
  const cookie = await signIn();
  const authenticated = await proxy(new NextRequest("https://terminal.example/", { headers: { cookie } }));
  assert.equal(authenticated.headers.get("x-middleware-next"), "1");
  assert.match(authenticated.headers.get("cache-control"), /no-store/);
});

test("MongoDB/configuration failures never bypass authentication or leak credentials", async (t) => {
  t.mock.method(terminalAuthStore, "reserveAttempt", async () => { throw new Error("private-db-password"); });
  const response = await login(request("/api/auth/login", { username, password }));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-db-password"));
  delete process.env.TERMINAL_SESSION_SECRET;
  assert.equal((await login(request("/api/auth/login", { username, password }))).status, 503);
  const cookie = `terminal-session=${"a".repeat(64)}`;
  assert.equal((await proxy(new NextRequest("https://terminal.example/", { headers: { cookie } }))).status, 503);
});

test("password hashes are salted, malformed hashes are rejected, and plaintext is not embedded", async () => {
  const a = await hashTerminalPassword(password);
  const b = await hashTerminalPassword(password);
  assert.notEqual(a, b);
  assert.ok(!a.includes(password));
  assert.equal(await verifyTerminalPassword(password, a), true);
  assert.equal(await verifyTerminalPassword("incorrect", a), false);
  await assert.rejects(() => verifyTerminalPassword(password, "broken"));
});
