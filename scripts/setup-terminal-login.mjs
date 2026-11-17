import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashTerminalPassword } from "../src/lib/auth/password.ts";

async function credentials() {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error("Setup input is too large.");
    }
    return JSON.parse(input);
  }
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const username = await prompt.question("Administrator username: ");
    process.stdout.write("Administrator password (hidden): ");
    muted = true;
    const password = await prompt.question("");
    muted = false;
    process.stdout.write("\n");
    return { username, password };
  } finally { prompt.close(); }
}
try {
  const input = await credentials();
  if (!input || typeof input.username !== "string" || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(input.username.trim()) ||
    typeof input.password !== "string" || input.password.length < 5 || input.password.length > 256) {
    throw new Error("Enter a valid username and a password of 5-256 characters; at least 12 is recommended.");
  }
  let previous;
  try { previous = await readFile(".env", "utf8"); } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    previous = "";
  }
  const values = new Map([
    ["TERMINAL_ADMIN_USERNAME", input.username.trim()],
    ["TERMINAL_ADMIN_PASSWORD_HASH", await hashTerminalPassword(input.password)],
    ["TERMINAL_SESSION_SECRET", randomBytes(48).toString("hex")],
  ]);
  const seen = new Set();
  const lines = previous.split(/\r?\n/).flatMap((line) => {
    const key = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    if (!values.has(key)) return [line];
    if (seen.has(key)) return [];
    seen.add(key);
    return [`${key}=${values.get(key)}`];
  });
  for (const [key, value] of values) if (!seen.has(key)) lines.push(`${key}=${value}`);
  await writeFile(".env", `${lines.join("\n").trimEnd()}\n`, { mode: 0o600 });
  await chmod(".env", 0o600);
  console.log("Terminal administrator configured in .env with a salted password hash and new session secret. Existing sessions are invalidated. Restart the app.");
  if (input.password.length < 12) console.warn("Warning: this password is weak. Use at least 12 characters before exposing the terminal publicly.");
} catch {
  console.error("Terminal login setup failed. Existing credentials were not printed. Check setup input and .env permissions.");
  process.exitCode = 1;
}
