import {
  clearSessionCookie,
  isSameOrigin,
  sessionConfigurationError,
  sessionCookie,
  sessionToken,
} from "../../../../lib/groww/session.ts";

const responseHeaders = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("groww_order_id")?.trim();
  const segment = searchParams.get("segment")?.trim();
  let authorization = request.headers.get("authorization");
  if (!authorization) {
    try {
      const token = sessionToken(request);
      if (token) authorization = `Bearer ${token}`;
    } catch {
      return sessionConfigurationError();
    }
  }

  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    return Response.json(
      { error: "A Bearer access token is required in the Authorization header." },
      { status: 401, headers: responseHeaders },
    );
  }

  if (!orderId || orderId === "." || orderId === ".." || !segment) {
    return Response.json(
      { error: "A valid groww_order_id and segment are required." },
      { status: 400, headers: responseHeaders },
    );
  }

  const url = new URL(
    `https://api.groww.in/v1/order/detail/${encodeURIComponent(orderId)}`,
  );
  url.searchParams.set("segment", segment);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "X-API-VERSION": "1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json();
    console.log(data);
    const headers: Record<string, string> = { ...responseHeaders };
    if (response.status === 401 && !request.headers.has("authorization")) {
      headers["Set-Cookie"] = clearSessionCookie();
    }
    return Response.json(data, {
      status: response.status,
      headers,
    });
  } catch {
    console.error("Failed to fetch Groww order details.");
    return Response.json(
      { error: "Unable to fetch Groww order details." },
      { status: 502, headers: responseHeaders },
    );
  }

}
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403, headers: responseHeaders });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "A JSON request body is required." }, { status: 400, headers: responseHeaders });
  }
  const accessToken = body && typeof body === "object" && "accessToken" in body
    ? body.accessToken
    : undefined;
  if (typeof accessToken !== "string" || !/^[\x21-\x7E]{1,3000}$/.test(accessToken)) {
    return Response.json({ error: "Enter a valid access token (without the Bearer prefix)." }, { status: 400, headers: responseHeaders });
  }

  let cookie: string;
  try {
    cookie = sessionCookie(accessToken);
  } catch {
    return sessionConfigurationError();
  }

  try {
    const response = await fetch("https://api.groww.in/v1/user/detail", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-API-VERSION": "1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      return Response.json(
        { error: status === 502 ? "Groww could not verify the token. Please try again." : "Groww rejected the access token. Generate a valid token and try again." },
        { status, headers: responseHeaders },
      );
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("status" in data) || data.status !== "SUCCESS") {
      return Response.json({ error: "Groww did not confirm the connection." }, { status: 502, headers: responseHeaders });
    }
    return Response.json({ connected: true }, { headers: { ...responseHeaders, "Set-Cookie": cookie } });
  } catch {
    console.error("Groww session verification failed.");
    return Response.json({ error: "Unable to connect to Groww. Please try again." }, { status: 502, headers: responseHeaders });
  }
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403, headers: responseHeaders });
  }
  return Response.json({ connected: false }, { headers: { ...responseHeaders, "Set-Cookie": clearSessionCookie() } });
}
