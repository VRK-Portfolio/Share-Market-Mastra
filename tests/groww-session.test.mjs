import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GET } from "../src/app/api/groww/session/route.ts";

function request(query = "groww_order_id=ORDER123&segment=CASH", token = "Bearer test-token") {
  return new Request(`http://localhost/api/groww/session?${query}`, {
    headers: token ? { Authorization: token } : {},
  });
}

test("forwards dynamic order, segment and token with the required Groww headers", async (t) => {
  const payload = { status: "SUCCESS", payload: { groww_order_id: "ORDER456" } };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(payload));

  const response = await GET(request("groww_order_id=ORDER456&segment=FNO", "Bearer dynamic-token"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const [url, options] = fetchMock.mock.calls[0].arguments;
  assert.equal(url.href, "https://api.groww.in/v1/order/detail/ORDER456?segment=FNO");
  assert.deepEqual(options.headers, {
    Accept: "application/json",
    Authorization: "Bearer dynamic-token",
    "X-API-VERSION": "1.0",
  });
  assert.equal(options.method, "GET");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
});

test("rejects missing or malformed authorization without calling Groww", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", mock.fn());
  for (const token of ["", "Basic test-token", "Bearer", "Bearer token extra"]) {
    const response = await GET(request(undefined, token));
    assert.equal(response.status, 401);
    assert.ok((await response.json()).error);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("rejects missing, blank or invalid parameters without calling Groww", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", mock.fn());
  for (const query of [
    "",
    "segment=CASH",
    "groww_order_id=ORDER123",
    "groww_order_id=%20&segment=CASH",
    "groww_order_id=ORDER123&segment=%20",
    "groww_order_id=..&segment=CASH",
    "groww_order_id=.&segment=CASH",
  ]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("encodes order IDs and segments rather than treating them as URL components", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await GET(request("groww_order_id=order%2F123%3Fother&segment=CASH%26extra%3Dvalue"));
  const [url] = fetchMock.mock.calls[0].arguments;
  assert.equal(url.pathname, "/v1/order/detail/order%2F123%3Fother");
  assert.equal(url.searchParams.get("segment"), "CASH&extra=value");
  assert.equal(url.searchParams.has("extra"), false);
});

test("preserves Groww error status and JSON body", async (t) => {
  const payload = { status: "FAILURE", error: { message: "Invalid token" } };
  t.mock.method(globalThis, "fetch", async () => Response.json(payload, { status: 403 }));
  const response = await GET(request());
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), payload);
});

test("returns an explicit gateway error for network, timeout and invalid JSON failures", async (t) => {
  const log = t.mock.method(console, "error", mock.fn());
  const fetchMock = t.mock.method(globalThis, "fetch");
  for (const implementation of [
    async () => { throw new TypeError("Network unavailable"); },
    async () => { throw new DOMException("Timed out", "TimeoutError"); },
    async () => new Response("Not JSON", { status: 502 }),
  ]) {
    fetchMock.mock.mockImplementation(implementation);
    const response = await GET(request());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Unable to fetch Groww order details." });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(log.mock.callCount(), 3);
});
