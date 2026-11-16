import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { GrowwHttpError } from "./client.ts";

type Queue = { tail: Promise<void>; nextAt: number; limitedUntil: number; pending: number };

export class HistoricalRequestQueue {
  private readonly queues = new Map<string, Queue>();

  async run<T>(token: string, signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const now = performance.now();
    for (const [key, queue] of this.queues) {
      if (!queue.pending && queue.nextAt <= now) this.queues.delete(key);
    }
    const key = createHash("sha256").update(token).digest("hex");
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), nextAt: 0, limitedUntil: 0, pending: 0 };
    this.queues.set(key, queue);
    queue.pending++;
    const job = queue.tail.then(async () => {
      try {
        signal.throwIfAborted();
        if (queue.limitedUntil > performance.now()) {
          const retryAfterSeconds = Math.ceil((queue.limitedUntil - performance.now()) / 1000);
          throw new GrowwHttpError(429,
            `Groww's historical-candle rate limit is cooling down. Wait ${retryAfterSeconds} seconds before retrying.`,
            { resource: "historical candles", type: "http", retryAfterSeconds });
        }
        while (queue.nextAt > performance.now()) {
          await sleep(queue.nextAt - performance.now(), undefined, { signal });
        }
        signal.throwIfAborted();
        queue.nextAt = performance.now() + 1000;
        try {
          const response = request();
          queue.nextAt = performance.now() + 1000;
          return await response;
        } catch (error) {
          if (error instanceof GrowwHttpError && error.status === 429) {
            queue.limitedUntil = performance.now() + (error.details.retryAfterSeconds ?? 60) * 1000;
            queue.nextAt = queue.limitedUntil;
          }
          throw error;
        }
      } finally {
        queue.pending--;
      }
    });
    // A failed/canceled request must not poison subsequent queue entries.
    queue.tail = job.then(() => {}, () => {});
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([job, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export const historicalRequests = new HistoricalRequestQueue();
