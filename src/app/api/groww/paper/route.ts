import { growwErrorResponse, growwJson, GrowwHttpError, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getOrderInstrument } from "../../../../lib/groww/instruments.ts";
import { growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { fillPaperOrder, newPaperAccount, paperCommandSchema, PaperTradingError, positionKey } from "../../../../lib/market/paper-trading.ts";
import { cancelPaperOrder, checkPaperEntryProtection, placePaperOrder, processPaperOrders, protectPaperPosition } from "../../../../lib/market/paper-orders.ts";
import { paperAccountIdentity } from "../../../../lib/paper/identity.ts";
import { commandAlreadyApplied, PaperConflictError, paperSnapshot, paperStore } from "../../../../lib/paper/store.ts";
import { verifyExecutionQuote } from "../../../../lib/paper/execution-quote.ts";

export const maxDuration = 60;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: sessionResponseHeaders });
function failure(error: unknown, mutation: boolean) {
  if (error instanceof PaperTradingError) return reply({ error: error.message }, 400);
  if (error instanceof PaperConflictError) return reply({ error: error.message }, 409);
  if (error instanceof GrowwHttpError) return growwErrorResponse(error, "Unable to verify the paper account or execution quote.");
  console.error(mutation ? "MongoDB paper mutation failed; the outcome must be refreshed before another submission." : "MongoDB paper account could not be loaded.");
  return reply({ error: mutation
    ? "Paper update could not be confirmed. Refresh the account and check its trade history before another submission; do not blindly repeat the trade."
    : "Unable to load the MongoDB paper account. Check server MongoDB configuration, network access and Groww user verification." }, 503);
}
export async function GET(request: Request) {
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  try {
    const owner = await paperAccountIdentity(token, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
    return reply(paperSnapshot(await paperStore.load(owner)));
  } catch (error) { return failure(error, false); }
}
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return reply({ error: "Cross-origin paper trading is not allowed." }, 403);
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  let body: unknown;
  try { body = await request.json(); } catch { return reply({ error: "Send valid JSON paper instructions." }, 400); }
  const parsed = paperCommandSchema.safeParse(body);
  if (!parsed.success) return reply({ error: "Send valid paper instructions, quantity, account revision and operation ID. Client prices or account balances are not accepted." }, 400);
  const command = parsed.data;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  try {
    const owner = await paperAccountIdentity(token, signal);
    if (command.accountId !== owner) return reply({ error: "Your Groww account changed. Reload the paper account before trading." }, 409);
    const current = await paperStore.load(owner);
    if (commandAlreadyApplied(current, command)) return reply(paperSnapshot(current));
    if (current.revision !== command.expectedRevision) throw new PaperConflictError("The paper account changed. Refresh and review the current account before trading.");
    let account = current.account;
    if (command.type === "RESET") account = newPaperAccount();
    else if (command.type === "CANCEL") account = cancelPaperOrder(account, command.orderId);
    else if (command.type === "PLACE") {
      const instrument = await getOrderInstrument(command.order.symbol, command.order.exchange, "CASH", signal);
      if (!instrument || instrument.instrumentType !== "EQ") return reply({ error: "Select a verified CASH equity for paper orders." }, 400);
      account = placePaperOrder(account, command.order, Date.now(), command.operationId);
    } else if (command.type === "PROCESS" && !command.quoteProof) {
      account = processPaperOrders(account, null);
    } else {
      const instrument = await getOrderInstrument(command.symbol, command.exchange, "CASH", signal);
      if (!instrument || instrument.instrumentType !== "EQ") return reply({ error: "Select a verified CASH equity for paper trading." }, 400);
      let execution: { price: number; tradeTime: number | null };
      if (command.quoteProof) {
        try {
          const quote = verifyExecutionQuote(token, command.quoteProof);
          if (quote.symbol !== command.symbol || quote.exchange !== command.exchange) {
            return reply({ error: "The verified live price belongs to another instrument. Wait for this stock's live tick." }, 400);
          }
          execution = quote;
        } catch (error) {
          return reply({ error: error instanceof Error ? error.message : "The live paper price could not be verified." }, 400);
        }
      } else {
        const url = new URL("https://api.groww.in/v1/live-data/quote");
        url.search = new URLSearchParams({ trading_symbol: command.symbol, exchange: command.exchange, segment: "CASH" }).toString();
        const quote = growwQuoteSchema.parse(await growwJson(url, token, "paper execution quote", signal));
        execution = { price: quote.price, tradeTime: quote.lastTradeTime };
      }
      if (command.type === "PROCESS") {
        account = processPaperOrders(account, {
          symbol: command.symbol, exchange: command.exchange, segment: "CASH", product: "MIS", ...execution,
        });
      } else {
        const existing = account.positions.find((item) => positionKey(item) === positionKey(command));
        if (command.protection && existing && Math.sign(existing.quantity) !== (command.side === "BUY" ? 1 : -1)) {
          throw new PaperTradingError("Attach target/stop protection to an entry, not a closing trade.");
        }
        if (command.protection) checkPaperEntryProtection(command.protection, command.side, execution.price);
        account = fillPaperOrder(current.account, {
          symbol: command.symbol, exchange: command.exchange, product: command.product, segment: "CASH",
          ...execution,
        }, command.side, command.quantity, Date.now(), command.operationId);
        if (command.protection) account = protectPaperPosition(account, command, command.protection);
      }
    }
    return reply(paperSnapshot(await paperStore.save(current, command, account)));
  } catch (error) { return failure(error, true); }
}
