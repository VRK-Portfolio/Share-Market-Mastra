
A component-based Next.js stock dashboard with Groww portfolio snapshots, actual
quotes and historical charts, inspired by the
[reference dashboard](https://sites.google.com/view/stock-analysis-dashboard/).

## Run

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Connect Groww with a generated access token to load your
portfolio and search actual stock data. A server-side session secret and the
appropriate Groww Trading API / market-data permissions are required.

## Features

- Responsive Tailwind CSS layout with persistent light/dark themes.
- Debounced exact-symbol search for NSE/BSE CASH stocks.
- Actual Groww quotes and 15m/1h/1D historical candles, with volume, hover OHLC
  and overlay toggles.
- MIS/CNC display presets for technical indicator cards.
- Button-triggered Mastra / Google Gemini technical recommendations, target and
  stop-loss scenarios, per-indicator evidence, support/resistance and advisory delivery GTT triggers.
- Reviewed PAPER or LIVE Groww DAY orders for CASH and F&O, with explicit confirmation.
- Groww connection to view real holdings and positions, with manual
  refresh and an all/CASH/FNO positions filter.
- `technicalindicators` calculates VWAP, RSI, ATR, EMAs and MACD from returned
  Groww candles. SuperTrend uses its ATR implementation.

**No sample-price fallback or automatic order placement.** Real orders require
an explicit order review and confirmation. Groww streams LTP; other market data is
fetched on search, interval/exchange changes and manual refresh. Prices may reflect
the last trading session when markets are closed. This is not investment advice.

## Components and data

- `src/components/dashboard/`: header/theme control, stock overview, indicator
  cards, candlestick chart, market context and dashboard composition.
- `src/lib/groww/market-schemas.ts`: quote/candle normalization and validation.
- `src/app/api/groww/analysis/route.ts`: authenticated live quote/history analysis.
- `src/lib/market/sample-data.ts`: deterministic test fixtures, not dashboard data.
- `src/lib/market/indicators.ts`: indicator calculations.
- `src/app/page.tsx`: renders the dashboard without embedded market data.

## Groww connection and APIs

### Connect from the header

1. Generate a random secret using `openssl rand -hex 32`, then set
   `GROWW_SESSION_SECRET` in `.env.local` (at least 32 characters). See
   [.env.example](./.env.example). Restart the app after configuring it.
2. Click **Connect Groww** in the header, paste the generated access token
   without the `Bearer` prefix, and click **Connect**.
3. The server verifies the token using Groww's read-only
   `GET /v1/user/detail` endpoint before creating the session. Holdings and
   positions load automatically once connected, including on page reload.

The token is encrypted using AES-256-GCM in an HttpOnly, SameSite=Strict cookie
(Secure in production). It is never stored in localStorage or returned to client
JavaScript. The cookie has no persistent expiration and normally lasts until the
browser closes; browsers that restore sessions may also restore session cookies.
Use **Disconnect** to explicitly clear it. Groww may expire or revoke the token
earlier; reconnect with a fresh token when requests return 401. All app instances
must share the same secret; changing it invalidates existing cookies.

Session endpoints:

- `POST /api/groww/session`: JSON `{ "accessToken": "..." }`; validates and saves
  the token, returning `{ "connected": true }` without exposing profile data.
- `GET /api/groww/session/status`: checks the saved cookie and returns
  `{ "connected": boolean }` (it does not revalidate the token with Groww).
- `DELETE /api/groww/session`: clears the cookie. This does not revoke the token
  on Groww.

### Fetch order details

`GET /api/groww/session?groww_order_id=ORDER_ID&segment=CASH` proxies Groww's
order-detail endpoint. Both query parameters are required. Requests use the saved
session automatically. An explicit `Authorization` Bearer header remains supported
and takes precedence over the cookie. Never put tokens in URLs.

```ts
const response = await fetch(
  `/api/groww/session?${new URLSearchParams({ groww_order_id: orderId, segment })}`,
);
const data = await response.json();
if (!response.ok) {
  throw new Error(`Order details request failed (${response.status})`);
}
```

The route returns Groww's JSON body and HTTP status, disables caching, and uses a
15-second upstream timeout. Missing credentials return 401, invalid or missing
parameters return 400, and connection failures or invalid upstream JSON return
502. A Groww 401 clears the saved cookie when using session authentication.
Connecting does not fetch or place orders.

### Actual stock search and analysis

After connecting, type an exact exchange trading symbol (for example `RELIANCE`,
`TCS` or `M&M`) into **Stock symbol**. The app waits 500 ms after typing before
requesting data. Choose NSE or BSE and a 15m, 1h or 1D candle interval. Company-name
autocomplete is not implemented. F&O uses the contract search described below.

`GET /api/groww/analysis?symbol=RELIANCE&exchange=NSE&interval=15minute` uses the
saved session to call the official:

- `GET /v1/live-data/quote` with `trading_symbol`, exchange and `segment=CASH`.
- `GET /v1/historical/candles` with the documented `groww_symbol` format
  (`NSE-RELIANCE`), `candle_interval`, exchange, CASH segment and epoch-second
  start/end times. It does not use the deprecated historical candle-range API.

The lookbacks are 14 calendar days for 15m, 45 days for 1h, and 179 days for daily
candles, within Groww's per-request limits. Historical timestamps without a timezone
are interpreted as IST; candles are sorted and validated before indicators are
calculated. The quote's last-trade timestamp is in milliseconds. An empty candle
list leaves the chart empty and indicators unavailable; insufficient history
shows `--`. Missing quote volume or trade time is displayed as unavailable.
Groww candles with explicit null OHLC prices are omitted, not replaced with zero
or previous prices. The response's `omittedCandles` count is shown in the dashboard;
chart and indicators use only complete candles. If every candle is incomplete,
the quote remains available while the chart and indicators stay unavailable.
Malformed numbers, timestamps, price ranges and invalid volumes still fail validation.

Quote and history requests run together with a shared 15-second deadline. Errors
are surfaced explicitly; an invalid symbol, denied subscription or API failure
never substitutes sample prices. Old-symbol results are cleared immediately on
selection changes, and requests are canceled when superseded or disconnected.
Use **Refresh market data** for another snapshot. The response includes the quote,
candles, calculated indicators, selected symbol/exchange/interval and `fetchedAt`.

See the official [live data](https://groww.in/trade-api/docs/curl/live-data) and
[historical candles](https://groww.in/trade-api/docs/curl/backtesting#get-historical-candle-data)
documentation.

#### Troubleshooting quote HTTP 403

A verified account session does not prove that the token can access quote or
historical market-data APIs. Groww must authorize those requests. For rejected
requests, the app displays the upstream error code and message (for example
`GA005`, documented as "User not authorised to perform this operation"), with
credentials redacted. It does not expose error metadata or raw HTML responses.

Check the reason shown by Groww, confirm that your
[Trading API subscription](https://groww.in/user/profile/trading-apis) is active,
then generate a fresh access token and reconnect. Groww documents that access
tokens expire daily at 6:00 AM. If the subscription and token are valid but the
request is still denied, contact Groww with the displayed error code and the
`/v1/live-data/quote` endpoint, never your token. A 403 keeps the account session;
only a 401 clears it. The app cannot grant or bypass upstream permissions.

#### Troubleshooting analysis HTTP 502

The JSON error includes `failureType` to distinguish timeouts, invalid upstream
JSON, unsuccessful upstream envelopes, and schema validation. Validation errors
identify the `stage` (`quote`, `candles` or `analysis`) and field paths in
`validationErrors`; response values and credentials are never included. These
details also appear in the dashboard error message. A schema failure is not
necessarily a subscription problem. Share only the error response, never the
session cookie or token, when reporting a failure.

### Futures and options

Choose **Futures / options** in **Market segment**. Search an underlying or
contract, filter FUT/CE/PE, expiry and strike, then select an exact contract.
Search uses Groww's public
[instrument CSV](https://groww.in/trade-api/docs/curl/instruments), cached on the
server for one hour. Results are paginated (30 per page), filtered by exchange,
and exclude contracts expired before the current IST date. Search does not
prove broker trading eligibility. Missing/broken catalogs return explicit errors,
not stale results.

`GET /api/groww/instruments?q=NIFTY&exchange=NSE&type=CE&expiry=2026-11-23&strike=25000&page=1`
requires a session. Filters other than `q` are optional; `type` defaults to `ALL`.
Responses include exact trading/Groww symbols, underlying, FUT/CE/PE, expiry,
strike, lot size and tick size, plus total/page/hasMore.

`GET /api/groww/analysis?symbol=<exact-trading-symbol>&segment=FNO&exchange=NSE&interval=15minute`
verifies the contract against the catalog, uses `segment=FNO` for both quote and
history, and uses the **exact catalog Groww symbol** for historical candles.
It never synthesizes a CASH symbol, rolls futures, mixes expiries/strikes or
substitutes underlying prices. Unknown/expired contracts return 404.
Omitting `segment` preserves CASH behavior.

VWAP, SuperTrend, RSI, ATR, EMA20/50 and MACD use the selected contract's complete
OHLCV candles. The chart, quote and indicators are contract prices or option
premiums per unit, not underlying prices. Groww quote OI, OI day change and raw
IV are displayed when supplied; candle OI is retained when available. Missing
values remain unavailable. IV units are not inferred or converted, and Greeks
are not fetched or estimated. New contracts may have insufficient indicator history.

F&O modes are **MIS** (intraday) and **NRML** (overnight); CNC is CASH-only.
Gemini receives the verified contract metadata and reported OI/IV along with
the contract's technical data, and considers expiry, leverage, liquidity,
time-decay and settlement risks. Targets refer to the contract/premium.
Futures SELL may describe a conditional short subject to margin/eligibility.
Options SELL means exit/avoid, never an uncovered option-writing setup.
All F&O GTT suggestions are disabled; analysis itself places no orders.
The separate order-review action is described below; it does not execute GTT.

### Gemini stock analysis

Set `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`) in `.env.local` and restart
the app. The registered `stockAnalysisAgent` uses `google/gemini-3.8-flash` through
Mastra's model router; no extra provider package is needed.

After stock data loads, click **Analyze with Gemini** to request a recommendation.
Loading data, streaming ticks, refresh and mode changes never call the model.
Click the same button again to reassess newer data. Old results are removed and requests canceled when the selection changes
or Groww disconnects. Model failures do not hide market data.

`POST /api/groww/recommendation` accepts JSON
`{ "symbol": "KALYANKJIL", "exchange": "NSE", "interval": "15minute", "mode": "MIS" }`.
It requires a Groww session, rejects cross-origin requests, and refetches validated
quote/history analysis on the server instead of trusting client-supplied prices.
Only the public quote, latest 120 complete candles, current indicator values and
coverage/timestamps are sent to Google. Indicators use all complete candles.
Tokens, cookies, holdings and positions are never included in the model prompt.
Each button-triggered call may incur Google API charges. Streaming ticks do not
change an existing report; its reference price and timestamp remain visible.
There is no persistent conversation memory.

Structured output includes BUY/SELL/HOLD, subjective confidence (not a profit
probability), conditional entry/targets/stop-loss, support/resistance, evidence,
risks, invalidation and optional GTT trigger suggestions. The response identifies
the stock, mode, model, snapshot/reference price, coverage and server-calculated
first-target reward/risk ratio. This snapshot may be newer than the chart snapshot.
Gemini must assess VWAP, RSI, ATR, EMA20, EMA50, MACD and SuperTrend individually,
using their actual values to explain momentum, trend, volatility and signal
confluence/conflicts. The dashboard shows these explanations alongside a
server-derived `indicatorSnapshot`, not model-invented values. Missing indicators
must be labeled UNAVAILABLE; inconsistent evidence is rejected. When every
indicator is missing, no actionable trade prediction is accepted.
Invalid directional levels are rejected rather than displayed. Generation uses
one model step, no provider retries and a 45-second Mastra execution budget.

MIS recommendations are intraday-only; a SELL scenario requires broker shorting
eligibility. CNC SELL means exit if already held or avoid buying, **not** a naked
delivery short. HOLD and CNC SELL have no new entry or GTT plan. GTT suggestions
are delivery BUY triggers only, not submitted or linked orders. Confirm broker
support, order limits, quantity, validity and exit protection separately.
There are no news/fundamental inputs, personal risk assessments or guaranteed
targets. Insufficient/conflicting/stale evidence should result in HOLD.

Missing Google credentials return 503, generation/invalid output errors return
502, and model timeouts return 504. Groww failures retain their original status;
an upstream 401 clears the session. API/provider error bodies and credentials
are never returned or logged by the recommendation route.

### Order review: paper trading and real orders

After a BUY/SELL prediction, click **Review order / paper trade**. HOLD does not
offer an actionable order. The default is **PAPER** and **LIMIT**. Choose PAPER
or LIVE, MARKET or LIMIT, and edit quantity and limit price. F&O quantity is
specified in units (a multiple of the verified lot size), not a number of lots.
Click **Get order review**; this fetches a new quote and verifies catalog metadata,
product, quantity and tick size without submitting anything.

The review shows side, symbol, exchange, segment, MIS/CNC/NRML product, quantity,
price, estimated value, expiry and a unique reference. Estimated value excludes
fees/slippage and is **not margin required**. Reviews expire after two minutes.
Save the reference, acknowledge the risk statement, then click **Confirm paper
trade** or **Confirm real order**. The server uses the reviewed immutable order,
not new prices/quantities supplied with the confirmation, and revalidates it.
The agent has no order tools and never executes orders.

- `POST /api/groww/orders` for review:
  `{ "symbol":"RELIANCE", "exchange":"NSE", "segment":"CASH", "product":"MIS",
  "side":"BUY", "quantity":1, "orderType":"LIMIT", "limitPrice":100,
  "execution":"PAPER" }`.
- `POST /api/groww/orders` for confirmation:
  `{ "reference":"<review reference>", "confirmed":true }`.
- `GET /api/groww/orders?reference=<review reference>` checks status for that
  authenticated session. Real status uses Groww's order-reference endpoint.

Real orders use Groww's `POST /v1/order/create`, Bearer authentication and API
version 1.0. Only a single DAY MARKET/LIMIT order is submitted. Targets,
stop-loss and GTT are **not protective orders**, not linked and not submitted.
Manage real exits/cancellations and check actual fills in Groww. MARKET prices
are not guaranteed; they require a quote whose last-trade timestamp is less than
60 seconds old. Indices and expired/unknown contracts cannot be ordered.
Quantity must be a positive integer up to 1,000,000 units and respect lot/tick sizes.
Broker funds, margin, exchange hours, order limits and eligibility still apply.

CASH CNC SELL and option SELL are exit-only: real orders recheck long holdings/
positions for the selected product. Broker reservations and concurrent orders
outside this app can still affect sellable inventory; verify existing pending
orders and broker eligibility yourself. No uncovered option-writing workflow
is offered.

Paper MARKET fills are simulated at the newly fetched REST quote, without fees,
slippage, exchange matching or liquidity modelling. Paper LIMIT orders are
recorded as pending, **never automatically filled**. This is a simple order
simulation, not a full paper portfolio: no paper holdings ledger, exit inventory,
background fill engine, P&L or cancellation engine is maintained. Paper CNC/option
SELL is therefore unavailable. Paper submission never calls Groww's create-order API.

The server keeps a private durable order journal in the ignored `.groww-orders`
directory at the application root. Records are bound to the current Groww
token via a keyed hash; tokens are not written to the journal. An exclusive
filesystem claim permits one submission attempt per reference even across
concurrent requests/restarts. Timeouts, malformed responses and disconnected
clients must be treated as **unknown outcomes**, not safe-to-retry failures.
Use **Check order status** or Groww itself; never create a duplicate to work around
an unknown outcome. HTTP acknowledgement alone does not prove a fill.
Order-related HTTP 401 responses are checked against `GET /v1/user/detail`
before declaring the account session expired. If Groww confirms the account
token is valid, the app retains the cookie and returns a local HTTP 403 with
the safely redacted order-access reason. An inconclusive verification returns
502 and retains the session; only a confirmed account 401 clears it.
This applies to order review, confirmation validation, submission and status.
The UI shows these errors in the order dialog instead of removing the dashboard.
No order is automatically retried or resubmitted. Retained authentication does
not grant order permissions: check the provider's error, Trading API subscription
and order eligibility with Groww. Order requests allow up to 45 seconds for
validation, submission and the bounded authentication check.
Each mounted review supports only one confirmation attempt.
After a paper result, an unsubmitted result or a terminal broker status, **Start
new order review** prepares a separate order without calling Gemini again.
Pending/unknown real orders must be reconciled before this action is available.

**Hosting:** mount `.groww-orders` on a private persistent volume with atomic
exclusive-create semantics. All app instances serving this session must share
the same directory and secret; ephemeral/serverless or independent local volumes
do not provide durable deduplication. Do not delete attempt files while orders
may be pending, publish the journal, or commit it. After token renewal, use Groww
to reconcile references from the previous session. Retain the reference even if
you close the dialog, change stocks, refresh or disconnect.

### True streaming prices

Install Python 3.9+ (Python 3.13 tested) and run:

```sh
npm run setup:groww-feed
```

The pinned official Groww Python SDK lives in the ignored `.groww-venv`.
The server launches `python3` with that environment's `bin` directory first on
its isolated PATH. Setup and hosting require a POSIX environment (macOS/Linux).
Optionally set `GROWW_FEED_PYTHON` to an absolute executable path with the SDK
installed, and restart the server.

After an authenticated stock or F&O contract snapshot loads,
`GET /api/groww/stream?symbol=RELIANCE&exchange=NSE&segment=CASH`
opens an SSE connection. The server resolves the exact `exchange_token` from
Groww's catalog, including the index-specific topic for CASH indices.
An isolated Python worker uses the official SDK socket authentication, topic helpers
and protobuf decoder with native NATS websocket transport. JWT/NKEY credentials
stay in memory rather than the SDK's shared credential files. Access tokens go
through worker stdin, never arguments, inherited secret environment or browser events.
Only prices, trade timestamps and sanitized connection/error messages are forwarded.

This requires an active Groww Trading API subscription with feed permissions.
LTP and day change derived from the snapshot previous close update on ticks.
Day OHLC, volume, OI/IV, historical candles and indicators remain **snapshots**:
use **Refresh market data** to update them. Missing previous close makes derived
change unavailable. No candles or volume are invented from price ticks.
Freshness uses trade timestamps, not heartbeat traffic. After 60 seconds without
a fresh trade the dashboard labels the price stale/last-known, including when
markets are closed. Feed errors remain visible; **Reconnect feed** explicitly
retries. There is no silent polling fallback or automatic reconnection loop.

Initial 401 responses clear the session; 403 preserves it. Missing worker setup
returns 503, connection startup is bounded to 25 seconds, and worker errors
are sanitized. Streams and workers close when the selection changes, the browser
disconnects or Groww disconnects. Interval/mode changes do not create extra feeds.

**Deployment:** use a persistent Node.js host with Python, installed SDK dependencies
and `scripts/groww/feed.py` available at the application root. Short-lived serverless
functions and static hosting are unsuitable. Include the worker and virtual environment
explicitly in containers/standalone deployments, and disable proxy buffering for SSE.
Each active browser subscription uses its own worker and counts against Groww feed limits.
Turbopack may warn about the dynamic host-executable path; the Python environment
is intentionally excluded from Next.js tracing and must be installed on the host.

### Holdings and positions

The dashboard uses the encrypted session cookie to call these authenticated,
read-only routes. The access token stays on the server:

- `GET /api/groww/holdings` proxies Groww's `GET /v1/holdings/user`. It displays
  stock symbols, ISINs, quantities and average buy prices.
- `GET /api/groww/positions` proxies Groww's `GET /v1/positions/user`. It displays
  symbols/contracts, exchange, segment (when supplied by Groww), product, net
  quantity, net average price and realised P&L. Short and closed positions remain
  in the list. Add `?segment=CASH` or `?segment=FNO` to filter; omitting it retrieves
  all segments.

Both use Groww's `Accept: application/json`, Bearer authorization and
`X-API-VERSION: 1.0` headers with a 15-second timeout and no caching.
Response bodies follow `{ status: "SUCCESS", payload: { holdings: [...] } }` or
`{ status: "SUCCESS", payload: { positions: [...] } }`. Only fields used by the
tables are returned. Invalid or unsuccessful upstream JSON returns 502, not an
empty portfolio. Other Groww HTTP failures keep their error status.

Holdings and positions load independently, so one can remain visible if the other
fails. Use **Refresh portfolio** to retry or update both snapshots. No portfolio
polling or unrealised P&L is added. Empty accounts show explicit empty states.
Disconnecting clears the displayed portfolio and cancels pending requests. A
Groww 401 clears the cookie, removes both lists and prompts you to reconnect.

Endpoint schemas follow the official
[Groww portfolio API documentation](https://groww.in/trade-api/docs/curl/portfolio).

Session setup returns 503 when the session secret is missing, 400 for malformed
input, and 401/403 when Groww rejects the token. Cross-origin session mutations are
rejected. All session and order-detail responses disable caching.
