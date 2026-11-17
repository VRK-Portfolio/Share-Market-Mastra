import { createHash } from "node:crypto";
import { BSON, MongoServerError } from "mongodb";
import { z } from "zod";
import { newPaperAccount, paperAccountSchema, paperSnapshotSchema } from "../market/paper-trading.ts";
import type { PaperAccount, PaperCommand } from "../market/paper-trading.ts";
import { paperDatabase } from "./database.ts";

const documentSchema = z.object({
  _id: paperSnapshotSchema.shape.accountId, revision: paperSnapshotSchema.shape.revision,
  account: paperAccountSchema,
  operations: z.array(z.object({ id: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })).max(200),
});
export type PaperDocument = z.infer<typeof documentSchema>;
export class PaperConflictError extends Error {}

export function paperSnapshot(document: PaperDocument) {
  return paperSnapshotSchema.parse({
    accountId: document._id, revision: document.revision, account: document.account, syncedAt: new Date().toISOString(),
  });
}
export function commandFingerprint(command: PaperCommand) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
export function commandAlreadyApplied(document: PaperDocument, command: PaperCommand) {
  const receipt = document.operations.find((item) => item.id === command.operationId);
  if (!receipt) return false;
  if (receipt.fingerprint !== commandFingerprint(command)) throw new PaperConflictError("This operation ID was already used for different instructions.");
  return true;
}
export const paperStore = {
  async load(accountId: string): Promise<PaperDocument> {
    const collection = (await paperDatabase()).collection<PaperDocument>("paper_accounts");
    try {
      await collection.updateOne({ _id: accountId }, { $setOnInsert: {
        revision: 0, account: newPaperAccount(), operations: [],
      } }, { upsert: true, maxTimeMS: 8000 });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    }
    return documentSchema.parse(await collection.findOne({ _id: accountId }, { maxTimeMS: 8000 }));
  },
  async save(previous: PaperDocument, command: PaperCommand, account: PaperAccount) {
    const next = documentSchema.parse({
      ...previous, revision: previous.revision + 1, account,
      operations: [...previous.operations, { id: command.operationId, fingerprint: commandFingerprint(command) }].slice(-200),
    });
    if (BSON.calculateObjectSize(next) > 8_000_000) {
      throw new PaperConflictError("Paper history has reached the account size limit. Reset the account explicitly before adding trades.");
    }
    const collection = (await paperDatabase()).collection<PaperDocument>("paper_accounts");
    const result = await collection.replaceOne({ _id: previous._id, revision: previous.revision }, next, { maxTimeMS: 8000 });
    if (result.matchedCount !== 1) {
      const current = await paperStore.load(previous._id);
      if (commandAlreadyApplied(current, command)) return current;
      throw new PaperConflictError("The paper account changed on another client. Refresh and review the new balance before submitting again.");
    }
    return next;
  },
  async lockRisk(previous: PaperDocument, date: string) {
    const next = documentSchema.parse({
      ...previous, revision: previous.revision + 1, account: { ...previous.account, riskHaltDate: date },
    });
    const collection = (await paperDatabase()).collection<PaperDocument>("paper_accounts");
    const result = await collection.replaceOne({ _id: previous._id, revision: previous.revision }, next, { maxTimeMS: 8000 });
    if (result.matchedCount !== 1) throw new PaperConflictError("The paper account changed while recording its risk halt. Refresh before continuing.");
    return next;
  },
};
