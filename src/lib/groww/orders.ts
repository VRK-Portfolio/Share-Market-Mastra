import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getOrderInstrument } from "./instruments.ts";
import { GrowwHttpError, growwErrorResponse, growwFailureDetails, growwJson } from "./client.ts";
import { growwFnoQuoteSchema, growwQuoteSchema } from "./market-schemas.ts";
import { holdingsResponseSchema, positionsResponseSchema } from "./portfolio-schemas.ts";
import { clearSessionCookie, sessionResponseHeaders } from "./session.ts";
import { orderPreviewSchema, onTickSize, parseBrokerOrder } from "./order-schemas.ts";
import type { OrderPreview, OrderResult, OrderSelection } from "./order-schemas.ts";
import { claimOrder, loadResult, storePreview, storeResult, wasAttempted } from "./order-store.ts";

export class OrderValidationError extends Error {}

async function verifyRejectedSession(token: string, resource: string, details: { code?: string; message?: string }) {
  let expired = false;
  let valid = false;
  try {
    const account = await growwJson(new URL("https://api.groww.in/v1/user/detail"), token, "account verification", AbortSignal.timeout(10_000));
    z.object({ status: z.literal("SUCCESS") }).parse(account);
    valid = true;
  } catch (error) {
    expired = error instanceof GrowwHttpError && error.status === 401;
    if (!expired) console.error("Groww order authentication could not be revalidated; retaining the session.");
  }
  const reason = [details.code, details.message].filter(Boolean).join(": ").slice(0, 200);
  return Response.json({
    error: expired ? "Groww confirmed that your access token is invalid or expired. Reconnect, then check the order reference in Groww before reviewing another order."
      : valid ? `Groww denied ${resource}, but confirmed your account token is valid. ${reason ? `${reason}. ` : ""}Check Groww's reported reason, Trading API subscription and order permissions. Your app session has been retained; no automatic order retry was made.`
      : `Groww rejected ${resource}, and account authentication could not be verified. ${reason ? `${reason}. ` : ""}Your session has been retained. Check the order reference in Groww; do not resubmit.`,
    sessionExpired: expired, stage: resource, upstreamStatus: 401,
    ...(details.code ? { upstreamCode: details.code } : {}),
    ...(details.message ? { upstreamMessage: details.message } : {}),
  }, { status: expired ? 401 : valid ? 403 : 502,
    headers: expired ? { ...sessionResponseHeaders, "Set-Cookie": clearSessionCookie() } : sessionResponseHeaders });
}

export async function orderErrorResponse(error: unknown, token: string, message: string) {
  return error instanceof GrowwHttpError && error.status === 401
    ? verifyRejectedSession(token, error.details.resource ?? "order access", error.details)
    : growwErrorResponse(error, message);
}

async function verifyOrder(token: string, order: OrderSelection, signal: AbortSignal) {
  const instrument = await getOrderInstrument(order.symbol, order.exchange, order.segment, signal);
  if (!instrument) throw new OrderValidationError("Choose a tradable equity or an active F&O contract. Indices cannot be ordered.");
  if (order.quantity % instrument.lotSize !== 0) throw new OrderValidationError(`Quantity must be a multiple of the instrument lot size (${instrument.lotSize}).`);
  if (order.limitPrice !== null && !onTickSize(order.limitPrice, instrument.tickSize)) {
    throw new OrderValidationError(`Limit price must be a multiple of tick size ${instrument.tickSize}.`);
  }
  const url = new URL("https://api.groww.in/v1/live-data/quote");
  url.search = new URLSearchParams({ trading_symbol: order.symbol, exchange: order.exchange, segment: order.segment }).toString();
  const quote = (order.segment === "FNO" ? growwFnoQuoteSchema : growwQuoteSchema).parse(await growwJson(url, token, "quote", signal));
  if (quote.price <= 0) throw new OrderValidationError("An actual positive quote is required before reviewing an order.");
  if (order.orderType === "MARKET" && (quote.lastTradeTime === null || Date.now() - quote.lastTradeTime > 60_000 ||
    quote.lastTradeTime > Date.now() + 5000)) {
    throw new OrderValidationError("MARKET orders require a trade quote less than 60 seconds old. Refresh during the trading session or review a LIMIT order.");
  }
  const exitOnly = order.side === "SELL" && (order.product === "CNC" || instrument.instrumentType === "CE" || instrument.instrumentType === "PE");
  if (exitOnly) {
    if (order.execution === "PAPER") throw new OrderValidationError("Paper delivery/option exits are unavailable because no paper holdings ledger is maintained. No uncovered option writing is supported.");
    let available: number;
    if (order.product === "CNC") {
      const holdings = holdingsResponseSchema.parse(await growwJson(new URL("https://api.groww.in/v1/holdings/user"), token, "holdings", signal));
      available = Math.max(0, holdings.payload.holdings.filter((item) => item.trading_symbol === order.symbol)
        .reduce((sum, item) => sum + item.quantity, 0));
    } else {
      const positions = positionsResponseSchema.parse(await growwJson(new URL("https://api.groww.in/v1/positions/user"), token, "positions", signal));
      available = Math.max(0, positions.payload.positions.filter((item) => item.trading_symbol === order.symbol && item.exchange === order.exchange &&
        item.segment === order.segment && item.product === order.product)
        .reduce((sum, item) => sum + item.quantity, 0));
    }
    if (order.quantity > available) throw new OrderValidationError("SELL/exit quantity exceeds your verified long holdings/positions for this product. Uncovered delivery/option shorts are not supported.");
  }
  return { instrument, quote };
}

export async function prepareOrder(token: string, order: OrderSelection, signal: AbortSignal) {
  const { instrument, quote } = await verifyOrder(token, order, signal);
  const preview = orderPreviewSchema.parse({
    reference: randomBytes(10).toString("hex"), order, instrument,
    quotePrice: quote.price, quoteTime: quote.lastTradeTime,
    estimatedValue: (order.limitPrice ?? quote.price) * order.quantity,
    preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  await storePreview(token, preview);
  return preview;
}

function unknownResult(preview: OrderPreview): OrderResult {
  return { reference: preview.reference, execution: preview.order.execution, state: "UNKNOWN",
    message: "Submission outcome is unknown or still processing. Do not create another order. Check status using this reference or check Groww before taking any further action." };
}
function brokerResult(preview: OrderPreview, body: unknown, token: string): OrderResult {
  const broker = parseBrokerOrder(body);
  if (broker.order_reference_id && broker.order_reference_id !== preview.reference) throw new Error("Broker reference mismatch.");
  if (broker.groww_order_id.includes(token)) throw new Error("Unsafe broker response.");
  return { reference: preview.reference, execution: "LIVE", state: "BROKER_REPORTED",
    brokerOrderId: broker.groww_order_id, brokerStatus: broker.order_status,
    message: `Groww reported ${broker.order_status}. Acceptance is not proof of execution. Check fills and manage exits in Groww; no target, stop-loss or GTT order was submitted.` };
}
async function saveResult(result: OrderResult) {
  try { await storeResult(result); }
  catch {
    console.error("Order outcome could not be saved.", { reference: result.reference });
    // Keep the permanent attempt claim so a lost response cannot submit twice.
    throw new Error("Order outcome persistence failed. Check Groww by reference; never resubmit.");
  }
}

export async function submitOrder(token: string, preview: OrderPreview): Promise<Response> {
  const existing = await loadResult(preview.reference);
  if (existing) return Response.json(existing, { headers: sessionResponseHeaders });
  if (!await claimOrder(preview.reference)) return Response.json(unknownResult(preview), { status: 409, headers: sessionResponseHeaders });
  let dispatched = false;
  try {
    if (Date.parse(preview.expiresAt) <= Date.now()) throw new OrderValidationError("The order review expired. Review current prices and confirm a new order.");
    const { instrument, quote } = await verifyOrder(token, preview.order, AbortSignal.timeout(15_000));
    if (JSON.stringify(instrument) !== JSON.stringify(preview.instrument)) throw new OrderValidationError("Instrument lot/tick/expiry metadata changed. Review a new order.");
    const order = preview.order;
    if (order.execution === "PAPER") {
      const result: OrderResult = {
        reference: preview.reference, execution: "PAPER", state: order.orderType === "MARKET" ? "PAPER_FILLED" : "PAPER_PENDING",
        ...(order.orderType === "MARKET" ? { simulatedPrice: quote.price } : {}),
        message: order.orderType === "MARKET" ? "Paper fill simulated at the latest REST quote, without fees, slippage or liquidity modelling. No real order was sent."
          : "Paper LIMIT order recorded only, not filled. There is no background fill engine or paper holdings ledger. No real order was sent.",
      };
      await saveResult(result);
      return Response.json(result, { headers: sessionResponseHeaders });
    }
    dispatched = true;
    const response = await fetch("https://api.groww.in/v1/order/create", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", "Content-Type": "application/json",
        Authorization: `Bearer ${token}`, "X-API-VERSION": "1.0" },
      body: JSON.stringify({ trading_symbol: order.symbol, quantity: order.quantity, validity: "DAY",
        exchange: order.exchange, segment: order.segment, product: order.product,
        order_type: order.orderType, transaction_type: order.side, order_reference_id: preview.reference,
        ...(order.limitPrice !== null ? { price: order.limitPrice } : {}),
      }),
    });
    if (!response.ok) {
      console.error("Groww order submission returned a non-success HTTP status.", { reference: preview.reference, status: response.status });
      const result = unknownResult(preview);
      const details = await growwFailureDetails(response, token);
      const authFailure = response.status === 401 ? await verifyRejectedSession(token, "order submission", details) : null;
      const authBody = authFailure ? z.object({
        error: z.string(), sessionExpired: z.boolean(), stage: z.string(), upstreamStatus: z.literal(401),
      }).parse(await authFailure.clone().json()) : null;
      if (response.status === 401 || response.status === 403) {
        result.state = "NOT_SUBMITTED";
        const reason = [details.code, details.message].filter(Boolean).join(": ").slice(0, 200);
        result.message = authBody?.error ?? `Groww denied order permissions. ${reason ? `${reason}. ` : ""}No automatic retry was made; check your Trading API subscription.`;
      }
      await saveResult(result);
      return Response.json({ ...result, ...(authBody ? {
        sessionExpired: authBody.sessionExpired, stage: authBody.stage, upstreamStatus: authBody.upstreamStatus,
      } : {}),
        ...(details.code ? { upstreamCode: details.code } : {}),
        ...(details.message ? { upstreamMessage: details.message } : {}),
      }, { status: authFailure?.status ?? (response.status === 403 ? 403 : 502),
        headers: authFailure?.headers ?? sessionResponseHeaders });
    }
    const result = brokerResult(preview, await response.json(), token);
    await saveResult(result);
    return Response.json(result, { headers: sessionResponseHeaders });
  } catch (error) {
    console.error("Order processing failed.", { reference: preview.reference, dispatched });
    const result = dispatched ? unknownResult(preview) : {
      reference: preview.reference, execution: preview.order.execution, state: "NOT_SUBMITTED" as const,
      message: error instanceof OrderValidationError ? error.message : "Order validation failed. No order was sent. Refresh and check your session, quote and portfolio permissions.",
    };
    const failure = dispatched ? null : await orderErrorResponse(error, token, result.message);
    if (failure) {
      const body: unknown = await failure.clone().json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && !(error instanceof OrderValidationError)) {
        result.message = body.error;
      }
    }
    await saveResult(result);
    return Response.json(result, { status: error instanceof OrderValidationError ? 400 : failure?.status ?? 502,
      headers: failure?.headers ?? sessionResponseHeaders });
  }
}

export async function orderStatus(token: string, preview: OrderPreview, signal: AbortSignal) {
  if (!await wasAttempted(preview.reference)) return { reference: preview.reference, execution: preview.order.execution,
    state: "NOT_SUBMITTED" as const, message: "This order was reviewed but has not been submitted." };
  if (preview.order.execution === "PAPER") return await loadResult(preview.reference) ?? unknownResult(preview);
  const url = new URL(`https://api.groww.in/v1/order/status/reference/${preview.reference}`);
  url.searchParams.set("segment", preview.order.segment);
  const result = brokerResult(preview, await growwJson(url, token, "order status", signal), token);
  await saveResult(result);
  return result;
}

export const confirmOrderSchema = z.object({ reference: orderPreviewSchema.shape.reference, confirmed: z.literal(true) }).strict();
