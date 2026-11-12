import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GET as holdings } from "../src/app/api/groww/holdings/route.ts";
import { GET as positions } from "../src/app/api/groww/positions/route.ts";
import { sessionCookie } from "../src/lib/groww/session.ts";

const originalSecret = process.env.GROWW_SESSION_SECRET;
const token = "test-portfolio-access-token";
beforeEach(() => {
  process.env.GROWW_SESSION_SECRET = randomBytes(32).toString("hex");
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.GROWW_SESSION_SECRET;
  else process.env.GROWW_SESSION_SECRET = originalSecret;
});

const holding = { isin: "TESTISIN123", trading_symbol: "TESTEQ", quantity: 12, average_price: 123.45 };
const position = {
  trading_symbol: "TESTEQ",
  exchange: "NSE",
  product: "MIS",
  quantity: -3,
  net_price: 120.5,
  realised_pnl: -25.75,
};

function request(resource, query = "", cookie = sessionCookie(token)) {
  return new Request(`http://localhost/api/groww/${resource}${query}`, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
  });
}

for (const [resource, GET, item] of [["holdings", holdings, holding], ["positions", positions, position]]) {
  test(`${resource} uses the encrypted session and official endpoint/headers without caching`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
      status: "SUCCESS", payload: { [resource]: [item] },
    }));
    const response = await GET(request(resource));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "SUCCESS", payload: { [resource]: [item] } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const [url, options] = upstream.mock.calls[0].arguments;
    assert.equal(url.href, `https://api.groww.in/v1/${resource}/user`);
    assert.deepEqual(options.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-API-VERSION": "1.0",
    });
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
  });

  test(`${resource} rejects missing or tampered sessions without calling Groww`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
    for (const cookie of ["", "groww-session=invalid"]) {
      const response = await GET(request(resource, "", cookie));
      assert.equal(response.status, 401);
      assert.ok((await response.json()).error);
      assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
    }
    assert.equal(upstream.mock.callCount(), 0);
  });

  test(`${resource} accepts a genuine empty list, not a missing or malformed list`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
      status: "SUCCESS", payload: { [resource]: [] },
    }));
    const empty = await GET(request(resource));
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).payload[resource], []);
    t.mock.method(console, "error", () => {});
    for (const data of [
      { status: "SUCCESS", payload: {} },
      { status: "SUCCESS", payload: { [resource]: null } },
      { status: "SUCCESS", payload: { [resource]: [{}] } },
      { status: "SUCCESS", payload: { [resource]: [{ ...item, quantity: "12" }] } },
      { status: "FAILURE", payload: { [resource]: [] } },
    ]) {
      upstream.mock.mockImplementation(async () => Response.json(data));
      const invalid = await GET(request(resource));
      assert.equal(invalid.status, 502);
      assert.ok((await invalid.json()).error);
    }
  });

  test(`${resource} clears expired sessions even when Groww sends a non-JSON 401`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
    const response = await GET(request(resource));
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
    assert.ok((await response.json()).error);
  });

  test(`${resource} preserves permission, rate-limit and server failures without pretending the list is empty`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch");
    for (const status of [403, 429, 500, 503]) {
      upstream.mock.mockImplementation(async () => new Response("Unavailable", { status }));
      const response = await GET(request(resource));
      assert.equal(response.status, status);
      assert.ok((await response.json()).error);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  test(`${resource} returns explicit gateway errors without logging credentials or portfolio data`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const upstream = t.mock.method(globalThis, "fetch");
    for (const implementation of [
      async () => { throw new TypeError(token); },
      async () => { throw new DOMException("Timed out", "TimeoutError"); },
      async () => new Response("<html>Unavailable</html>"),
    ]) {
      upstream.mock.mockImplementation(implementation);
      const response = await GET(request(resource));
      assert.equal(response.status, 502);
      assert.ok((await response.json()).error);
    }
    assert.equal(log.mock.callCount(), 3);
    assert.ok(!JSON.stringify(log.mock.calls).includes(token));
    assert.ok(!JSON.stringify(log.mock.calls).includes(item.trading_symbol));
  });
}

test("positions forwards the optional CASH/FNO segment filter", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
    status: "SUCCESS", payload: { positions: [{ ...position, segment: "CASH" }] },
  }));
  for (const segment of ["CASH", "FNO"]) {
    const response = await positions(request("positions", `?segment=${segment}`));
    assert.equal(response.status, 200);
    assert.equal(upstream.mock.calls.at(-1).arguments[0].href, `https://api.groww.in/v1/positions/user?segment=${segment}`);
  }
});

test("positions rejects invalid segment filters before calling Groww", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  for (const segment of ["", "MCX", "cash", "CASH%26extra=value"]) {
    const response = await positions(request("positions", `?segment=${segment}`));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("portfolio reports missing server configuration explicitly", async (t) => {
  const cookie = sessionCookie(token);
  delete process.env.GROWW_SESSION_SECRET;
  t.mock.method(console, "error", () => {});
  const response = await holdings(request("holdings", "", cookie));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GROWW_SESSION_SECRET/);
});

test("positions preserves short and closed positions and zero prices/P&L", async (t) => {
  const rows = [position, { ...position, product: "CNC", quantity: 0, net_price: 0, realised_pnl: 0 }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "SUCCESS", payload: { positions: rows } }));
  const response = await positions(request("positions"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).payload.positions, rows);
});
