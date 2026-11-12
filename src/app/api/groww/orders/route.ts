import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { orderSelectionSchema, orderPreviewSchema } from "../../../../lib/groww/order-schemas.ts";
import { loadPreview } from "../../../../lib/groww/order-store.ts";
import { confirmOrderSchema, orderStatus, orderErrorResponse, OrderValidationError, prepareOrder, submitOrder } from "../../../../lib/groww/orders.ts";

function crossOrigin(request: Request) {
  return !isSameOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site";
}

export async function POST(request: Request) {
  if (crossOrigin(request)) return Response.json({ error: "Cross-origin orders are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new OrderValidationError("Send an application/json order review or confirmation.");
    }
    const body: unknown = await request.json();
    const confirm = confirmOrderSchema.safeParse(body);
    if (confirm.success) {
      const preview = await loadPreview(token, confirm.data.reference);
      if (!preview) return Response.json({ error: "Order review was not found for this session." }, { status: 404, headers: sessionResponseHeaders });
      return await submitOrder(token, preview);
    }
    const selection = orderSelectionSchema.safeParse(body);
    if (!selection.success) throw new OrderValidationError("Choose valid quantity, price, MARKET/LIMIT type, CASH/FNO product and PAPER/LIVE execution.");
    return Response.json(await prepareOrder(token, selection.data, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])), { headers: sessionResponseHeaders });
  } catch (error) {
    console.error("Unable to review or submit an order.");
    if (error instanceof OrderValidationError || error instanceof SyntaxError) return Response.json({
      error: error instanceof OrderValidationError ? error.message : "Send valid JSON. No order was submitted.",
    }, { status: 400, headers: sessionResponseHeaders });
    return orderErrorResponse(error, token, "Order processing could not complete. If you already confirmed, check Groww by reference before doing anything else.");
  }
}

export async function GET(request: Request) {
  if (crossOrigin(request)) return Response.json({ error: "Cross-origin order status requests are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  const token = requireGrowwSession(request);
  if (token instanceof Response) return token;
  const reference = orderPreviewSchema.shape.reference.safeParse(new URL(request.url).searchParams.get("reference"));
  if (!reference.success) return Response.json({ error: "Provide the reviewed order reference." }, { status: 400, headers: sessionResponseHeaders });
  try {
    const preview = await loadPreview(token, reference.data);
    if (!preview) return Response.json({ error: "Order review was not found for this session." }, { status: 404, headers: sessionResponseHeaders });
    return Response.json(await orderStatus(token, preview, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])), { headers: sessionResponseHeaders });
  } catch (error) {
    return orderErrorResponse(error, token, "Order status could not be verified. Do not resubmit; check the reference in Groww.");
  }
}
