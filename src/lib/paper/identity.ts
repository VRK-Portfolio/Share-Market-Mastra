import { createHash } from "node:crypto";
import { z } from "zod";
import { growwJson } from "../groww/client.ts";

const profileSchema = z.object({
  status: z.literal("SUCCESS"),
  payload: z.object({ vendor_user_id: z.string().trim().min(1).max(200) }),
});
const owners = new Map<string, { accountId: string; expiresAt: number }>();

export async function paperAccountIdentity(token: string, signal: AbortSignal) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const cached = owners.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.accountId;
  const raw = await growwJson(new URL("https://api.groww.in/v1/user/detail"), token, "paper account identity", signal);
  const profile = profileSchema.parse(raw);
  const accountId = createHash("sha256").update(`groww-paper:v1:${profile.payload.vendor_user_id}`).digest("hex");
  if (owners.size >= 200) {
    for (const [key, owner] of owners) if (owner.expiresAt <= Date.now()) owners.delete(key);
    if (owners.size >= 200) owners.delete(owners.keys().next().value!);
  }
  owners.set(tokenHash, { accountId, expiresAt: Date.now() + 30_000 });
  return accountId;
}
