import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { DELETE, GET, POST } from "../src/app/api/groww/session/route.ts";
import { GET as status } from "../src/app/api/groww/session/status/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
const token = "test-access-token";
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

function connect(body = { accessToken: token }, origin = "http://localhost") {
  return new Request("http://localhost/api/groww/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function withCookie(cookie, url = "http://localhost/api/groww/session/status") {
  return new Request(url, { headers: { Cookie: cookie.split(";")[0] } });
}

test("verifies token with Groww before setting an encrypted browser-session cookie", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ status: "SUCCESS", payload: {} }));
  const response = await POST(connect());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { connected: true });
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Strict"));
  assert.ok(!cookie.includes("Max-Age"));
  assert.ok(!cookie.includes("Expires"));
  assert.ok(!cookie.includes(token));
  assert.equal(response.headers.get("cache-control"), "no-store");
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.equal(url, "https://api.groww.in/v1/user/detail");
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  assert.equal(options.headers["X-API-VERSION"], "1.0");
  const check = await status(withCookie(cookie));
  assert.deepEqual(await check.json(), { connected: true });
});

test("order details can use the saved session without a UI authorization header", async (t) => {
  const cookie = sessionCookie(token);
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ status: "SUCCESS" }));
  const response = await GET(withCookie(cookie, "http://localhost/api/groww/session?groww_order_id=ORDER123&segment=CASH"));
  assert.equal(response.status, 200);
  assert.equal(upstream.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${token}`);
});

test("missing and tampered cookies are disconnected and cannot fetch orders", async () => {
  const cookie = sessionCookie(token);
  const [name, value] = cookie.split(";")[0].split("=");
  const tampered = `${name}=${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  for (const invalid of ["unrelated=123", `${name}=invalid`, tampered]) {
    const response = await status(withCookie(invalid));
    assert.deepEqual(await response.json(), { connected: false });
    assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
    const order = await GET(withCookie(invalid, "http://localhost/api/groww/session?groww_order_id=ORDER123&segment=CASH"));
    assert.equal(order.status, 401);
  }
});

test("disconnect clears the browser cookie", async () => {
  const response = await DELETE(new Request("http://localhost/api/groww/session", { method: "DELETE", headers: { Origin: "http://localhost" } }));
  assert.deepEqual(await response.json(), { connected: false });
  assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
});

test("invalid inputs and cross-origin mutations never call Groww", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  for (const body of [null, {}, { accessToken: "" }, { accessToken: 123 }, { accessToken: "Bearer token" }, { accessToken: "a".repeat(3001) }]) {
    assert.equal((await POST(connect(body))).status, 400);
  }
  assert.equal((await POST(connect(undefined, "https://other.example"))).status, 403);
  assert.equal((await DELETE(new Request("http://localhost/api/groww/session", { method: "DELETE", headers: { Origin: "https://other.example" } }))).status, 403);
  const malformed = new Request("http://localhost/api/groww/session", { method: "POST", body: "{" });
  assert.equal((await POST(malformed)).status, 400);
  assert.equal(upstream.mock.callCount(), 0);
});

test("rejected tokens and unsuccessful Groww responses never create sessions", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch");
  for (const code of [401, 403, 429, 500]) {
    upstream.mock.mockImplementation(async () => Response.json({ status: "FAILURE" }, { status: code }));
    const response = await POST(connect());
    assert.equal(response.status, code === 401 || code === 403 ? code : 502);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.ok((await response.json()).error);
  }
  upstream.mock.mockImplementation(async () => Response.json({ status: "FAILURE" }));
  assert.equal((await POST(connect())).status, 502);
});

test("network and invalid JSON failures are explicit and do not log the token", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const upstream = t.mock.method(globalThis, "fetch");
  for (const implementation of [
    async () => { throw new Error(token); },
    async () => new Response("Not JSON"),
  ]) {
    upstream.mock.mockImplementation(implementation);
    const response = await POST(connect());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.ok((await response.json()).error);
  }
  assert.ok(!JSON.stringify(log.mock.calls).includes(token));
});

test("missing secret fails explicitly instead of creating an insecure session", async (t) => {
  t.mock.method(console, "error", () => {});
  delete process.env.GROWW_SESSION_SECRET;
  const response = await POST(connect());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match((await response.json()).error, /GROWW_SESSION_SECRET/);
});

test("Groww unauthorized response clears a saved session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "FAILURE" }, { status: 401 }));
  const response = await GET(withCookie(sessionCookie(token), "http://localhost/api/groww/session?groww_order_id=ORDER123&segment=CASH"));
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
});
