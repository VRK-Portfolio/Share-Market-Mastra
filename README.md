
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

Development disables Turbopack's persistent filesystem cache so saved module
exports cannot outlive changes to shared validation schemas. Production build
caching is unchanged. If an already-running dev server reports an undefined
schema export such as `cashInstrumentSearchSchema.safeParse`, restart
`npm run dev` and reload the page to discard the old in-memory module graph.

## Features

- Responsive Tailwind CSS layout with persistent light/dark themes.
- Debounced stock-name/symbol dropdown search for NSE/BSE CASH stocks.
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

After connecting, type at least two company-name or symbol characters (for example
`Reliance`, `TCS` or `Mahindra`) into **Stock name or symbol**. A dropdown searches
Groww's actual instrument catalog after 400 ms, showing the company name, exact
symbol and selected exchange. Click a match or use the arrow keys and Enter;
Escape dismisses the dropdown. Quote/history requests start only after selecting
a stock, not for partial symbols or company names. Choose NSE or BSE and a 15m,
1h or 1D candle interval. F&O retains its separate contract search.

`GET /api/groww/instruments?segment=CASH&q=Reliance&exchange=NSE` searches equity
records by case-insensitive name/symbol, excludes index and derivative records,
ranks exact/prefix matches first and returns up to 30 matches per page. Broad
dropdown searches prompt you to type more characters. The authenticated endpoint
uses the existing one-hour public-catalog cache without sending your token to
the catalog host; missing names remain unavailable rather than being invented.
The catalog can exceed 20 MB: its shared download/body-read timeout is 45 seconds,
with a 60-second route execution budget on hosts that support it. Download timeouts
return HTTP 504, and network, upstream HTTP or invalid-catalog failures return 502
with safe `stage`, `failureType` and optional `upstreamStatus` diagnostics. These
catalog errors retain your session and never substitute empty/sample results.

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

### Technical verdict (no LLM)

Before the optional Gemini report, the dashboard calculates a deterministic
BUY/SELL/HOLD verdict from the existing TypeScript indicators. This requires
no Google key, model call or model tokens. It also supports the existing explicitly
confirmed order/paper-trade review without first calling Gemini.

The conservative rules require all of:

- BUY: price above EMA20 and EMA50, EMA20 above EMA50, RSI **55-70** inclusive,
  MACD line above signal with positive histogram, and bullish SuperTrend with
  price above its trend line. MIS also requires price above session VWAP.
- SELL: the inverse EMA, MACD and SuperTrend conditions, RSI **30-45** inclusive,
  and price below VWAP for MIS. CNC and CE/PE SELL remain **exit/avoid only**,
  with no new short entry, targets or stop. FUT SELL may suggest a short.
- Neutral/conflicting signals, missing required indicators, fewer than 50
  complete candles, nonpositive ATR/price, expired/mismatched contracts or
  invalid timestamps produce HOLD with explicit reasons and no trade levels.
  ATR measures volatility, not direction; RSI extremes alone never imply reversal.
- MIS requires a quote trade within **60 seconds**, quote/candles from the
  current IST calendar date, and candle/snapshot age within **two intervals**.
  CNC/NRML allow quote/candle/snapshot ages up to **three calendar days** to
  accommodate weekends; this is a freshness policy, not a trading-calendar model.
  Times more than five seconds ahead of the evaluation clock are rejected.

Entry is the current reference price rounded to tick size. Risk distance is
**at least 1.5xATR**, rounded outward; targets are **2R and 3R** from rounded entry.
Reward/risk is calculated from the rounded first target and stop, not a profit
probability. F&O uses verified contract tick size; CASH suggestions use paise
precision and the order review still checks actual exchange tick size. Plans
whose positive, directional levels cannot be represented safely become HOLD.
Recent 20-candle low/high are shown as observed context, not guaranteed support
or target forecasts.

Streaming can change the reference-price comparisons and scenario levels;
indicators remain explicitly labeled REST snapshots and need a market refresh.
Freshness is reevaluated every five seconds even if no ticks arrive. Opening order
review captures its analysis side/price so later ticks cannot silently change the
reviewed instruction. No order, GTT, stop or target is placed automatically.

Each indicator has an **i** button in the indicator panel, technical verdict and
Gemini input-evidence cards. Hover or keyboard focus opens a tooltip; clicking
pins it for touch users. Escape, blur or an outside click dismisses it. Tooltips
show the **unrounded supplied values** (including all three MACD fields and
SuperTrend line/direction), periods, units and interpretation rules. They do not
invent an ideal indicator value or estimate missing data. F&O OI/change/IV cards
also explain the provider-reported values without guessing IV units.

### Next 15-30 minute scenarios (no LLM)

The technical-verdict section also shows conditional 15- and 30-minute price
ranges. A separate validated **15-minute analysis snapshot** is fetched alongside
hourly/daily chart data; when the chart is already 15-minute, its snapshot is
reused with no duplicate request. Refresh updates both snapshots. Selection changes
abort outstanding requests; errors/mismatched responses are visible and never
fall back to a different symbol, contract or higher-timeframe ATR.

These are transparent **heuristic continuation scenarios**, not calibrated
prediction/confidence intervals, guaranteed future prices or the 2R/3R targets:

- Bullish indicator agreement: price - 0.5xATR to price + ATR at 15 minutes.
- Bearish agreement: price - ATR to price + 0.5xATR.
- Neutral/conflicting direction with otherwise valid data: price +/-ATR.
- At 30 minutes, distances scale by sqrt(2). This is a modeling assumption, not
  a statistically validated forecast. Ranges can be exceeded in either direction.
- Bounds round outward to contract tick size (CASH uses paise precision).
  Nonpositive/unrepresentable bounds show unavailable rather than fabricated prices.

All scenarios require the stricter MIS data-quality/freshness checks, regardless
of the selected trade product. They are limited to regular weekday NSE/BSE hours
(09:15-15:30 IST); each horizon becomes unavailable if it crosses session close.
This is not a holiday/special-session calendar model. F&O estimates are selected
contract prices/premiums, not forecasts of the underlying or option-writing advice.
The reference quote can stream, but 15-minute ATR/indicators remain labeled
snapshots. No polling, Gemini calls, orders or protective exits are triggered.

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
Only the public quote, verified contract metadata, precomputed indicator values,
code-derived signals, rule-based verdict/levels and coverage/timestamps are sent
to Google. **No raw candle arrays or chart overlays** are sent. Indicators still
use all complete candles; `candleSampleCount` is now zero.
Tokens, cookies, holdings and positions are never included in the model prompt.
Each button-triggered call may incur Google API charges. Streaming ticks do not
change an existing report; its reference price and timestamp remain visible.
There is no persistent conversation memory.

### Trade cost / shares / GTT calculator

The bottom of each technical result and completed Gemini report has **Calculate
cost / shares / GTT**. It opens an accessible dialog prefilled from that specific
result, capturing prices on open so streaming cannot overwrite your edits.
Calculation is entirely local: budgets, quantities and fees are not sent to
Google, Groww or the order journal, and no order/GTT is submitted.

- Manual quantity or full-notional budget sizing; budget sizing finds the maximum
  whole shares/contract lots affordable **including entry charges**, capped at
  1,000,000 units. F&O uses verified lot/tick metadata.
- Editable execution price, target, stop and eligible entry trigger, with buttons
  for the result's alternative targets. Missing HOLD/exit-only trade levels
  are not invented; reference price may be used only for explicit cost illustration.
- Shows quantity/lots, turnover, entry fees/cash-flow estimate, unused budget,
  gross/net target and stop P/L, fee-adjusted reward/risk and approximate break-even.
  Fees are itemized by entry, target exit and stop exit: brokerage, STT,
  exchange, IPFT, SEBI, stamp duty, DP and GST.
- A prominent **Overall estimated profit / loss** summary shows the net target
  and stop outcomes for the entire selected quantity, with gross P/L and total
  round-trip fees/taxes underneath. Profit/loss colors follow the net result,
  including a target that loses money after charges. These are alternative exit
  scenarios, never added together; unavailable levels/acquisition costs are not
  presented as zero profit. They are not guaranteed outcomes or maximum losses.
- Futures turnover is **not** reported as a cash debit or margin requirement.
  MIS/F&O budget sizing assumes full notional/premium, not leveraged buying power,
  SPAN/exposure margin or available funds. CNC/options SELL is owned-inventory
  exit-only, with no invented acquisition cost, P/L or new short/GTT plan.
- GTT is an **advisory preview only for CASH CNC BUY**, with quantity, entry
  trigger, planned execution/limit-cost assumption, target trigger and stop trigger.
  Verify broker eligibility, trigger direction, all exit limit prices, validity
  and separate protection. No linked exits/OCO, execution or GTT API is implemented.

Fee assumptions are displayed/editable and were checked on **13 November 2026**:

- [Groww brokerage](https://groww.in/help/stocks,-f&o,-ipo-&-mtf/searchable/how-much-is-the-brokerage):
  equity lower of Rs20/0.1%, with minimum lower of Rs5/2.5% of value; F&O Rs20
  per executed order. A flat per-order override is available.
- [NSE March 2026 circular](https://nsearchives.nseindia.com/content/circulars/FA73061.pdf):
  transaction percentages 0.0030699 CASH, 0.0018299 FUT and 0.0355299 options
  (premium turnover), with IPFT 0.0000001% each side. This avoids adding obsolete
  IPFT rates to the revised transaction rates.
- [NSE April 2026 STT circular](https://nsearchives.nseindia.com/content/circulars/FATAX73524.pdf):
  futures SELL 0.05% and options SELL 0.15%. Older Groww F&O pricing tables still
  show pre-April rates and are not used for these defaults.
- [Groww equity/DP/GST](https://groww.in/pricing): CASH CNC STT 0.1% each side;
  MIS 0.025% sell-only; buy-only stamp 0.015% CNC / 0.003% MIS.
  DP default Rs20 before GST for delivery sells of at least Rs100, Rs3.5 below
  Rs100 (depository-only); account-specific rates can be edited. Derivative buy
  stamp is 0.002% FUT / 0.003% options.
- GST 18% is applied to brokerage, exchange, IPFT, SEBI and DP, **not STT/stamp**.
  SEBI turnover is 0.0001% each side.
- BSE transaction defaults are group/contract-dependent (CASH 0.00375%, FUT 0%,
  options 0.0325% from Groww pricing). **BSE IPFT is unverified and requires an
  explicit confirmed input**; unknown fees are never silently assumed zero.

Amounts round to paise; STT rounds to whole rupees per estimated leg. Actual
client-day aggregation and contract-note rounding may differ. Break-even is
explicitly approximate, assuming exit fees at the entry price. Estimates assume
one full executed order per leg, normal resident brokerage and pre-expiry closing.
Personal income/capital-gains tax, slippage, spreads, impact, recurring API fees,
MTF/NRI/UPI-mandate schemes, interest, penalties, square-off fees, option exercise
and physical-settlement charges are excluded. Verify all rates against your broker.

### Gemini recommendation output and limitations

Structured output includes BUY/SELL/HOLD, subjective confidence (not a profit
probability), conditional entry/targets/stop-loss, support/resistance, evidence,
risks, invalidation and optional GTT trigger suggestions. The response identifies
the stock, mode, model, snapshot/reference price, coverage and server-calculated
first-target reward/risk ratio. This snapshot may be newer than the chart snapshot.
Gemini interprets the precomputed parameters and may explain disagreement with
the initial rules. It does **not** calculate indicator values or generate seven
repeated indicator explanations. The response retains `indicatorAssessments`
and `indicatorSnapshot`, but both are derived by application code and are labeled
as such in the report. Missing indicators are labeled UNAVAILABLE. When every
indicator is missing, no actionable trade prediction is accepted.
Invalid directional levels are rejected rather than displayed. Generation uses
one model step, no provider retries, a 45-second Mastra execution budget and a
**2,048-output-token cap** (previously 4,096). Compact input/output reduces token
usage, not the provider's per-token rate; optional Gemini calls still incur charges.

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

Startup JSON responses and SSE error events include safe `stage`, `failureType`
and, when available, `upstreamCode` diagnostics. Stages distinguish socket-token
creation, websocket connection, subscription, tick decoding and disconnection.
When troubleshooting, share only this error response, never request headers,
session cookies, access tokens or environment-file contents. Raw provider
messages and worker tracebacks are not forwarded.

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
