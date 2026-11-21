import { growwErrorResponse, requireGrowwSession } from "../../../../../lib/groww/client.ts";
import { loadPaperEntryQuality } from "../../../../../lib/groww/paper-entry-quality.ts";
import { sessionResponseHeaders } from "../../../../../lib/groww/session.ts";
import { paperEntryContext, paperEntryRequestSchema } from "../../../../../lib/market/paper-entry-quality.ts";
import { positionKey } from "../../../../../lib/market/paper-trading.ts";
import { paperAccountIdentity } from "../../../../../lib/paper/identity.ts";
import { paperStore } from "../../../../../lib/paper/store.ts";

export const maxDuration = 45;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: sessionResponseHeaders });

export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const parsed = paperEntryRequestSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return reply({ error: "Select a valid open paper position and its opening fill." }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]);
  try {
    const owner = await paperAccountIdentity(token, signal);
    const { account } = await paperStore.load(owner);
    const position = account.positions.find(item => positionKey(item) === positionKey(parsed.data));
    if (!position) return reply({ error: "This position is no longer open. Refresh the paper account." }, 409);
    const { entry } = paperEntryContext(account, position);
    if (entry.id !== parsed.data.entryId) {
      return reply({ error: "The opening trade has changed. Refresh the paper account before checking entry quality." }, 409);
    }
    return reply(await loadPaperEntryQuality(token, entry, signal));
  } catch (error) {
    return growwErrorResponse(error, "Unable to assess this entry from historical data. Check account and market-data access, then retry.");
  }
}
