import { growwErrorResponse, growwJson, GrowwHttpError, requireGrowwSession } from "../../../../lib/groww/client.ts";
import { getFnoInstruments, getOrderInstrument } from "../../../../lib/groww/instruments.ts";
import { growwFnoQuoteSchema, growwQuoteSchema } from "../../../../lib/groww/market-schemas.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { fillPaperOrder, newPaperAccount, paperCommandSchema, PaperTradingError, positionKey } from "../../../../lib/market/paper-trading.ts";
import type { PaperLivePrice } from "../../../../lib/market/paper-trading.ts";
import { cancelPaperOrder, paperOrderPriceReady, paperSquareOffDue, placePaperOrder, processPaperOrders } from "../../../../lib/market/paper-orders.ts";
import { activePaperOrder } from "../../../../lib/market/paper-order-schemas.ts";
import { assertPaperEntryRisk, paperRiskReport } from "../../../../lib/market/paper-risk.ts";
import type { PaperRiskPrices } from "../../../../lib/market/paper-risk.ts";
import { regularMarketSession } from "../../../../lib/market/market-session.ts";
import { paperRiskMarket } from "../../../../lib/paper/risk-market.ts";
import { paperSignalChecks } from "../../../../lib/paper/strict-signals.ts";
import { paperAccountIdentity } from "../../../../lib/paper/identity.ts";
import { commandAlreadyApplied, PaperConflictError, paperSnapshot, paperStore } from "../../../../lib/paper/store.ts";
import { verifyExecutionQuote } from "../../../../lib/paper/execution-quote.ts";
import { paperPriceKey, paperSegment, paperUnderlying } from "../../../../lib/market/paper-instruments.ts";

async function paperInstrument(symbol: string, exchange: "NSE" | "BSE", segment: "CASH" | "FNO", signal: AbortSignal) {
  const instrument = await getOrderInstrument(symbol, exchange, segment, signal);
  if (!instrument || segment === "CASH" && instrument.instrumentType !== "EQ") {
    throw new PaperTradingError("Select a verified CASH equity or unexpired F&O contract.");
  }
  const contract = segment === "FNO" ? (await getFnoInstruments(signal))
    .find(item => item.tradingSymbol === symbol && item.exchange === exchange) : undefined;
  if (segment === "FNO" && !contract) throw new PaperTradingError("The exact F&O contract could not be verified.");
  return { ...instrument, contract };
}

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
    let riskPrices: PaperRiskPrices = {};
    const now = Date.now();
    const date = regularMarketSession(now).date;
    if (command.type === "RESET") {
      if (account.riskHaltDate === date || regularMarketSession(now).phase === "open" &&
        account.fills.some(fill => regularMarketSession(fill.at).date === date)) {
        throw new PaperTradingError("Reset cannot bypass today's paper risk budget. Reset outside the regular session after the daily halt has ended.");
      }
      account = newPaperAccount();
    }
    else if (command.type === "CANCEL") account = cancelPaperOrder(account, command.orderId);
    else if (command.type === "PLACE") {
      const instrument = await paperInstrument(command.order.symbol, command.order.exchange, paperSegment(command.order), signal);
      const next = placePaperOrder(account, command.order, now, command.operationId, { costAware: true, instrument: instrument.contract });
      const placed = next.orders.find(order => order.id === command.operationId)!;
      if (placed.intent === "OPEN") {
        riskPrices = await paperRiskMarket.load(token, account, signal);
        const report = paperRiskReport(account, riskPrices, Date.now());
        if (report.dailyLocked && account.riskHaltDate !== date) await paperStore.lockRisk(current, date);
        assertPaperEntryRisk(account, next, {
          symbol: placed.symbol, side: placed.side, quantity: placed.quantity, price: placed.limitPrice! / 100,
          stop: placed.protection!.stopPrice / 100, underlying: paperUnderlying(placed), tickSize: placed.instrument?.tickSize,
        }, riskPrices, Date.now());
      }
      account = next;
    } else if (command.type === "PROCESS" && !command.quoteProof) {
      account = processPaperOrders(account, null);
    } else {
      const segment = paperSegment(command);
      const instrument = await paperInstrument(command.symbol, command.exchange, segment, signal);
      let execution: { price: number; tradeTime: number | null };
      if (command.quoteProof) {
        try {
          const quote = verifyExecutionQuote(token, command.quoteProof);
          if (quote.symbol !== command.symbol || quote.exchange !== command.exchange || quote.segment !== segment) {
            return reply({ error: "The verified live price belongs to another instrument. Wait for this stock's live tick." }, 400);
          }
          execution = quote;
        } catch (error) {
          return reply({ error: error instanceof Error ? error.message : "The live paper price could not be verified." }, 400);
        }
      } else {
        const url = new URL("https://api.groww.in/v1/live-data/quote");
        url.search = new URLSearchParams({ trading_symbol: command.symbol, exchange: command.exchange, segment }).toString();
        const quote = (segment === "FNO" ? growwFnoQuoteSchema : growwQuoteSchema).parse(await growwJson(url, token, "paper execution quote", signal));
        execution = { price: quote.price, tradeTime: quote.lastTradeTime };
      }
      const observedAt = Date.now();
      const seed: PaperLivePrice = {
        symbol: command.symbol, exchange: command.exchange, segment, price: execution.price,
        tradeTime: execution.tradeTime ?? 0, receivedAt: new Date(observedAt).toISOString(), observedAt,
      };
      if (command.type === "PROCESS") {
        const dueExit = account.positions.some(position => paperPriceKey(position) === paperPriceKey(seed) &&
          paperSquareOffDue(position, observedAt)) || account.orders.some(order => activePaperOrder(order) && order.intent === "CLOSE" &&
            paperPriceKey(order) === paperPriceKey(seed) && paperOrderPriceReady(order, execution.price));
        riskPrices = dueExit ? { [paperPriceKey(seed)]: seed } : await paperRiskMarket.load(token, account, signal, seed);
        const approvals = new Map<string, string | null>();
        for (const order of account.orders.filter(order => !dueExit && activePaperOrder(order) && order.intent === "OPEN" &&
          paperPriceKey(order) === paperPriceKey(seed))) {
          const key = `${order.product}:${order.side}`;
          if (approvals.has(key)) continue;
          try {
            await paperSignalChecks.approve(token, order, order.side, signal);
            approvals.set(key, null);
          } catch (error) {
            console.error("Strict paper entry approval failed; any triggered entry will be rejected.");
            approvals.set(key, error instanceof Error ? error.message : "Strict strategy evidence could not be verified.");
          }
        }
        account = processPaperOrders(account, {
          symbol: command.symbol, exchange: command.exchange, segment, instrument: instrument.contract, product: "MIS", ...execution,
        }, Date.now(), {
          costAware: true, tickSize: instrument.tickSize, deferEntries: dueExit,
          approveEntry(before, after, order, price) {
            const denial = approvals.get(`${order.product}:${order.side}`);
            if (denial !== null) throw new PaperTradingError(denial ?? "Strict entry evidence was not checked.");
            assertPaperEntryRisk(before, after, {
              symbol: order.symbol, side: order.side, quantity: order.quantity, price,
              stop: order.protection!.stopPrice / 100, underlying: paperUnderlying(order), tickSize: order.instrument?.tickSize,
            }, riskPrices, Date.now());
          },
        });
      } else {
        const existing = account.positions.find((item) => positionKey(item) === positionKey(command));
        if (command.protection && existing && Math.sign(existing.quantity) !== (command.side === "BUY" ? 1 : -1)) {
          throw new PaperTradingError("Attach target/stop protection to an entry, not a closing trade.");
        }
        const closing = !!existing && Math.sign(existing.quantity) !== (command.side === "BUY" ? 1 : -1);
        account = fillPaperOrder(current.account, {
          symbol: command.symbol, exchange: command.exchange, product: command.product, segment, instrument: instrument.contract,
          ...execution,
        }, command.side, command.quantity, Date.now(), command.operationId, "MARKET", {
          costAware: true, tickSize: instrument.tickSize, protection: command.protection,
        });
        if (!closing) {
          riskPrices = await paperRiskMarket.load(token, current.account, signal, seed);
          const report = paperRiskReport(current.account, riskPrices, Date.now());
          if (report.dailyLocked && current.account.riskHaltDate !== date) await paperStore.lockRisk(current, date);
          assertPaperEntryRisk(current.account, account, {
            symbol: command.symbol, side: command.side, quantity: command.quantity,
            price: account.fills.at(-1)!.price / 100, stop: command.protection!.stopPrice,
            underlying: instrument.contract?.underlying, tickSize: instrument.tickSize,
          }, riskPrices, Date.now());
          await paperSignalChecks.approve(token, command, command.side, signal);
        } else riskPrices = { [paperPriceKey(seed)]: seed };
      }
    }
    if (paperRiskReport(account, riskPrices, Date.now()).dailyLocked) account = { ...account, riskHaltDate: date };
    return reply(paperSnapshot(await paperStore.save(current, command, account)));
  } catch (error) { return failure(error, true); }
}
