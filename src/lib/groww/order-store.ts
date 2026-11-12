import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { orderPreviewSchema, orderResultSchema } from "./order-schemas.ts";
import type { OrderPreview, OrderResult } from "./order-schemas.ts";

const storedPreviewSchema = z.object({ owner: z.string(), preview: orderPreviewSchema });
const referenceSchema = orderPreviewSchema.shape.reference;
function directory() { return join(process.cwd(), ".groww-orders"); }
function file(reference: string, suffix: string) { return join(process.cwd(), ".groww-orders", `${referenceSchema.parse(reference)}.${suffix}`); }
function owner(token: string) {
  const secret = process.env.GROWW_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Order storage needs a session secret.");
  return createHmac("sha256", secret).update(token).digest("hex");
}
function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function syncDirectory() {
  const handle = await fs.open(directory(), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function storePreview(token: string, preview: OrderPreview) {
  const root = directory();
  const target = file(preview.reference, "json");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(target, JSON.stringify({ owner: owner(token), preview }), { flag: "wx", mode: 0o600, flush: true });
  await syncDirectory();
}
export async function loadPreview(token: string, reference: string) {
  let text: string;
  const target = file(reference, "json");
  try { text = await fs.readFile(target, "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  const record = storedPreviewSchema.parse(JSON.parse(text));
  return record.owner === owner(token) ? record.preview : null;
}
export async function claimOrder(reference: string) {
  const target = file(reference, "attempt");
  try {
    const handle = await fs.open(target, "wx", 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory();
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}
export async function wasAttempted(reference: string) {
  const target = file(reference, "attempt");
  try { await fs.readFile(target); return true; }
  catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
}
export async function storeResult(result: OrderResult) {
  const target = file(result.reference, "result");
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(orderResultSchema.parse(result)), { mode: 0o600, flush: true });
  await fs.rename(temp, target);
  await syncDirectory();
}
export async function loadResult(reference: string) {
  const target = file(reference, "result");
  try { return orderResultSchema.parse(JSON.parse(await fs.readFile(target, "utf8"))); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
}
