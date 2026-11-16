import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoricalRequestQueue } from "../src/lib/groww/historical-requests.ts";
import { GrowwHttpError, growwJson, growwErrorResponse } from "../src/lib/groww/client.ts";

test("concurrent scans and analysis share one paced historical queue per token", async () => {
  const queue = new HistoricalRequestQueue();
  const starts = [];
  let active = 0;
  let peak = 0;
  const request = async () => {
    starts.push(performance.now());
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return starts.length;
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await Promise.all([
    queue.run("shared-token", signal, request),
    queue.run("shared-token", signal, request),
    queue.run("shared-token", signal, request),
  ]), [1, 2, 3]);
  assert.equal(peak, 1);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.ok(starts[2] - starts[1] >= 1000);
});

test("canceled queued requests reject promptly, never fetch, and do not block other accounts", async () => {
  const queue = new HistoricalRequestQueue();
  const controller = new AbortController();
  let release;
  const first = queue.run("same", new AbortController().signal, () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  let called = false;
  const canceled = queue.run("same", controller.signal, async () => { called = true; });
  controller.abort(new DOMException("Canceled", "AbortError"));
  await assert.rejects(canceled, { name: "AbortError" });
  assert.equal(await queue.run("other", new AbortController().signal, async () => "independent"), "independent");
  release("first");
  assert.equal(await first, "first");
  assert.equal(called, false);
});

test("429 cooldown rejects refreshes without fetching or retrying, then permits recovery", async () => {
  const queue = new HistoricalRequestQueue();
  const signal = new AbortController().signal;
  let calls = 0;
  const start = performance.now();
  await assert.rejects(queue.run("limited", signal, async () => {
    calls++;
    throw new GrowwHttpError(429, "Rate limited", { retryAfterSeconds: 2 });
  }), { status: 429 });
  await assert.rejects(queue.run("limited", signal, async () => { calls++; }), (error) =>
    error.status === 429 && error.details.retryAfterSeconds === 2);
  assert.equal(calls, 1);
  assert.ok(performance.now() - start < 1000);
  await new Promise((resolve) => setTimeout(resolve, 2001));
  assert.equal(await queue.run("limited", signal, async () => { calls++; return "recovered"; }), "recovered");
  assert.equal(calls, 2);
  assert.ok(performance.now() - start >= 2000);
});

test("429 reports rate-limit guidance and Retry-After, retaining the session and upstream status", async (t) => {
  const signal = new AbortController().signal;
  const url = new URL("https://api.groww.in/v1/historical/candles");
  for (const [retryAfter, expected] of [["7", 7], ["invalid", 60], [null, 60],
    [new Date(Date.now() + 10_000).toUTCString(), 10]]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Too many requests" }, {
      status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
    }));
    try {
      await growwJson(url, "test-token", "historical candles", signal);
      assert.fail("Expected rate limit");
    } catch (error) {
      const response = growwErrorResponse(error, "Could not load candles");
      assert.equal(response.status, 429);
      assert.equal(response.headers.has("set-cookie"), false);
      const body = await response.json();
      assert.match(body.error, /rate limit/);
      assert.doesNotMatch(body.error, /API permissions/);
      assert.ok(Math.abs(body.retryAfterSeconds - expected) <= (retryAfter?.includes("GMT") ? 1 : 0));
      assert.equal(response.headers.get("Retry-After"), String(body.retryAfterSeconds));
    }
  }
});
