import childProcess from "node:child_process";
import { delimiter, resolve } from "node:path";
import { workerMessageSchema } from "./live-schemas.ts";
import type { FeedInstrument } from "./live-schemas.ts";

export class GrowwFeedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? "Your Groww session expired. Connect again."
      : status === 403 ? "Groww denied streaming access. Check your Trading API feed permissions."
      : status === 429 ? "Groww's streaming connection limit was reached. Retry later."
      : status === 503 ? "Groww streaming is not configured. Run npm run setup:groww-feed."
      : status === 504 ? "The Groww streaming connection timed out. Reconnect the feed."
      : "The Groww price stream failed. Reconnect the feed; snapshot data remains available.");
    this.status = status;
  }
}

export function startGrowwFeed(token: string, instrument: FeedInstrument, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const python = process.env.GROWW_FEED_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const virtualEnvBin = resolve(".groww-venv", process.platform === "win32" ? "Scripts" : "bin");
  if (signal.aborted) return Promise.reject(new GrowwFeedError(499));
  return new Promise((resolveStream, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let ready = false;
    let finished = false;
    let buffer = "";
    let worker: ReturnType<typeof childProcess.spawn>;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const encoder = new TextEncoder();
    const identity = { symbol: instrument.symbol, exchange: instrument.exchange, segment: instrument.segment };
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { finish(undefined, true); },
    });

    function send(message: object) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
    }
    function finish(error?: GrowwFeedError, canceled = false) {
      if (finished) return;
      finished = true;
      clearTimeout(startup);
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      if (error && error.status !== 499) console.error("Groww streaming stopped.", { status: error.status });
      if (!ready) reject(error ?? new GrowwFeedError(499));
      else if (error && error.status !== 499 && !canceled) send({ ...identity, type: "error", code: error.status, error: error.message });
      if (!canceled) controller.close();
      if (worker && worker.exitCode === null) {
        worker.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (worker.exitCode === null) worker.kill("SIGKILL");
        }, 3000);
        killTimer.unref();
      }
    }
    function abort() { finish(new GrowwFeedError(499)); }
    const startup = setTimeout(() => finish(new GrowwFeedError(504)), 25_000);
    startup.unref();
    signal.addEventListener("abort", abort, { once: true });
    try {
      worker = childProcess.spawn(python, ["-u", resolve("scripts/groww/feed.py")], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: `${virtualEnvBin}${delimiter}${process.env.PATH ?? ""}`, NODE_ENV: process.env.NODE_ENV, PYTHONUNBUFFERED: "1" },
      });
      worker.once("error", () => finish(new GrowwFeedError(503)));
      worker.once("close", () => {
        if (killTimer) clearTimeout(killTimer);
        if (!finished) finish(new GrowwFeedError(502));
      });
      worker.stdin?.on("error", () => finish(new GrowwFeedError(502)));
      worker.stdout?.setEncoding("utf8");
      worker.stdout?.on("data", (chunk: string) => {
        if (finished) return;
        buffer += chunk;
        if (buffer.length > 65_536) { finish(new GrowwFeedError(502)); return; }
        let boundary = buffer.indexOf("\n");
        while (boundary !== -1 && !finished) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          try {
            const message = workerMessageSchema.parse(JSON.parse(line));
            if (message.type === "error") { finish(new GrowwFeedError(message.code)); return; }
            if (message.type === "connected") {
              if (!ready) {
                ready = true;
                clearTimeout(startup);
                send({ ...identity, type: "connected" });
                resolveStream(stream);
                heartbeat = setInterval(() => {
                  if (!finished) {
                    if ((controller.desiredSize ?? 0) <= -32) finish(new GrowwFeedError(502));
                    else controller.enqueue(encoder.encode(": keepalive\n\n"));
                  }
                }, 15_000);
                heartbeat.unref();
              }
            } else if (ready) {
              if ((controller.desiredSize ?? 0) <= -32) { finish(new GrowwFeedError(502)); return; }
              send({ ...identity, ...message, receivedAt: new Date().toISOString() });
            }
          } catch {
            finish(new GrowwFeedError(502));
          }
          boundary = buffer.indexOf("\n");
        }
      });
      worker.stdin?.end(JSON.stringify({ accessToken: token, ...instrument }) + "\n");
    } catch {
      finish(new GrowwFeedError(503));
    }
  });
}
