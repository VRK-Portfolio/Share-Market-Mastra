
A component-based Next.js stock dashboard with Groww portfolio snapshots, actual
quotes and historical charts, inspired by the
[reference dashboard](https://sites.google.com/view/stock-analysis-dashboard/).

## Run

```sh
npm ci
npm run setup:terminal-login
npm run dev
```

Open http://localhost:3000 and sign in with the administrator credentials set
above. Connect Groww with a generated access token to load your
portfolio and search actual stock data. A server-side session secret and the
appropriate Groww Trading API / market-data permissions are required.

For Docker-based development with Python streaming dependencies and hot reload,
create `.env.production` as described in [Persistent Docker deployment](#persistent-docker-deployment-true-streaming),
then run `npm run docker:dev`. Open http://localhost:3000. Stop it with Ctrl+C or
`npm run docker:dev:stop`. The development override bind-mounts the source while
keeping Linux dependencies and Next.js build output in container-only volumes.
It uses a separate Compose project and order-data volume from production.
Do not run development and production containers on port 3000 at the same time.
Rerun `npm run docker:dev` after dependency changes to rebuild and renew dependency
volumes. Both Docker modes read runtime configuration from `.env.production`;
development explicitly sets `NODE_ENV=development` for hot reload and local HTTP.

On Vercel, use `npm run vercel-build` as the Build Command (the normal
`npm run build` also works). Vercel cannot execute these Docker scripts or run this
app's Python streaming worker; use the persistent Docker deployment for true
streaming. No Docker command should be placed in Vercel's Build Command.

Development disables Turbopack's persistent filesystem cache so saved module
exports cannot outlive changes to shared validation schemas. Production build
caching is unchanged. If an already-running dev server reports an undefined
schema export such as `cashInstrumentSearchSchema.safeParse`, restart
`npm run dev` and reload the page to discard the old in-memory module graph.

## Features

- Private administrator login before the terminal or data APIs can be accessed,
  with MongoDB-backed revocable sessions and persistent login throttling.
- Responsive Tailwind CSS layout with persistent light/dark themes.
- Debounced stock-name/symbol dropdown search for NSE/BSE CASH stocks.
- Actual Groww quotes and 15m/1h/1D historical candles, with volume, hover OHLC
  and overlay toggles.
- MIS/CNC display presets for technical indicator cards.
- On-request company-headline sentiment from GNews, classified with Gemini and
  combined with the price-action confluence verdict using a fresh opposing-news veto.
- Button-triggered Mastra / Google Gemini technical recommendations, target and
  stop-loss scenarios, per-indicator evidence, support/resistance and advisory delivery GTT triggers.
- Reviewed PAPER or LIVE Groww DAY orders for CASH and F&O, with explicit confirmation.
- Separate MongoDB-backed INR 1,00,000 paper account per verified Groww user with manual CASH fills,
  MIS long/short positions, CNC holdings, realized/unrealized P&L and trade history.
- Groww connection to view real holdings and positions, with manual
  refresh and an all/CASH/FNO positions filter.
- `technicalindicators` calculates VWAP, RSI, ATR, EMAs and MACD from returned
  Groww candles. SuperTrend uses its ATR implementation.

**No sample-price fallback or automatic order placement.** Real orders require
an explicit order review and confirmation. Groww streams LTP; other market data is
fetched on search, interval/exchange changes and manual refresh. Selected F&O
contracts also refresh snapshots automatically about every 30 seconds by default.
Prices may reflect
the last trading session when markets are closed. This is not investment advice.

## Private terminal login

Run `npm run setup:terminal-login` locally. It prompts for an administrator
username and a hidden password, then updates only these values in the ignored
`.env`:

```dotenv
TERMINAL_ADMIN_USERNAME=<administrator username>
TERMINAL_ADMIN_PASSWORD_HASH=<generated salted scrypt hash>
TERMINAL_SESSION_SECRET=<generated random secret>
```

The password is not saved in plaintext. Prefer at least 12 unique characters;
the setup accepts a minimum of five characters, but short passwords remain
unsafe even with hashing and throttling. Do not pass passwords as command-line
arguments, commit the configuration or use `NEXT_PUBLIC_*` variables. Configure
`MONGODB_URI` and `MONGODB_DB` as described below; MongoDB is required for login,
not only paper trading. Its database user needs permission to create the
authentication collections and TTL indexes.

Copy these three administrator settings and MongoDB settings into the server
environment on Render/Vercel (or `.env.production` for Docker), then restart or
redeploy. Use HTTPS in production; production cookies are Secure, HttpOnly and
SameSite=Strict. Running setup again rotates the hash and secret and invalidates
existing administrator sessions. All instances must share the same settings.
There is no public registration or password-reset endpoint: rerun setup locally
and redeploy the new settings to change/recover administrator access.

Unauthenticated page requests redirect to `/login`; data APIs return 401 before
reaching Groww, trading or paper-account handlers. Only the login/logout endpoints,
login page and framework/static assets are public. The root page independently
verifies authentication before rendering the terminal. It waits for a live request
with Next.js `connection()` before checking time-dependent session expiry, keeping
that check out of prerendering and runtime prefetches. Terminal responses are
not publicly cached. A valid Groww cookie alone cannot unlock the terminal.

Successful login creates a random opaque, eight-hour cookie; MongoDB stores only
its SHA-256 token hash, expiry and a credential-version marker. Expired sessions
are rejected immediately, independently of TTL cleanup. **Sign out** revokes the
server record and clears both the terminal and Groww cookies. Logging in also
clears any previous Groww connection so broker access must be explicitly connected
again. The terminal checks session validity on focus and every 30 seconds; APIs
enforce it on every request.

Login allows at most **five attempts per fixed 15-minute window**, shared across
instances and callers for this private administrator (including successful
attempts). Excess requests return 429 with Retry-After. A wrong username and
wrong password produce the same error. Limits are intentionally global rather
than trusting client-controlled forwarding headers; repeated requests can
temporarily lock out the administrator, so use an upstream firewall for public
exposure. Authentication configuration or database failure denies access with an
explicit error rather than disabling login protection.

Authentication uses `terminal_sessions` and `terminal_login_attempts` collections
in the configured application database, separate from paper ledgers. Existing
Groww connection, trading eligibility and per-Groww-user paper-account rules remain
unchanged after administrator login. For external health probes, use the public
`/login` page; `/` is now protected.

## Company news sentiment

Set `GNEWS_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`) in the
server environment, then restart/redeploy. Do not put keys in `NEXT_PUBLIC_*`
variables or the browser. Obtain a GNews plan/licence appropriate for your use:
[GNews search API](https://docs.gnews.io/endpoints/search-endpoint).
GNews Free currently delays articles by 12 hours; paid real-time access is
necessary for this feature's six-hour intraday recency gate.

Select a CASH equity, expand **Company news sentiment** inside **Price action &
confluence**, and click **Fetch / refresh news sentiment**. The authenticated,
same-origin `POST /api/groww/sentiment` endpoint verifies the stock's company name
against the Groww catalogue before searching English headlines from India-based
sources over the last 72 hours. Only valid dated, deduplicated headlines are
considered, capped at eight from the provider's ten newest matches. This is
limited coverage, not an exhaustive news scan or social-media sentiment.

A registered Mastra agent classifies each supplied headline's company relevance
and positive/negative/neutral tone. Only public stock identity and headline
metadata are sent to Gemini, not credentials, holdings, orders, prices or article
contents. Code validates the returned IDs, preserves original dated source links,
and computes the balance; model-generated sources or aggregate directions are
not trusted. Two relevant headlines are required; a positive-minus-negative
balance of at least +25% / at most -25% gives BULLISH / BEARISH, otherwise NEUTRAL.
This is a heuristic headline balance, not a success probability.

For intraday confluence, the receipt must be at most 15 minutes old and at least
one relevant headline must have been published within six hours. Fresh opposing
sentiment blocks an otherwise eligible setup with WAIT. Aligned or neutral news
cannot create a setup, bypass structural/volume checks or change existing trend,
timing, paper-trading or real-order rules. Requested sentiment holds WAIT while
loading. Missing, stale, thin or failed coverage is explicitly unavailable and
the existing missing-context conditional behavior remains in effect.

No automatic news/model polling occurs, including after a market-data refresh.
Quota, configuration and classification failures are displayed without using
stale results as fresh confirmation. News may already be priced in; syndicated
reports are correlated, and a headline alone is not a verified fact or full-article
analysis. No sentiment-strategy success rate has been measured.

## MongoDB paper accounts

Set these **server-only** environment variables (never `NEXT_PUBLIC_*`):

```dotenv
MONGODB_URI=<your MongoDB connection string>
MONGODB_DB=stock_terminal_paper
```

Use an Atlas database user restricted to this application database and allow
your application's outbound network access. Keep credentials out of Git and
rotate any credential exposed in chat or logs. For local setup, save the variables
in the ignored `.env`, then run `npm run setup:paper-db`. This creates the
`paper_accounts` collection in the requested database, pings it and leaves user
records empty. The runtime can also create the collection on first account access.
On Render/Vercel, configure the same variables in the deployment's environment
and redeploy; no database URL is sent to browsers. MongoDB errors do not fall back
to a browser or shared account. Existing server-side Groww session configuration
is still required.

The **Paper trading** panel starts each new account with INR 1,00,000 virtual cash.
Open it from the fixed **Paper trading** button at the bottom-right of the workspace.
The chatbot-style popup separates **Trade**, **Positions**, **Orders**, **History**
and **Account** into focused tabs. Available cash and live open P&L stay visible
above the tabs. Trade contains the order form; Positions shows entry/live prices
and profit/loss with expandable margin details; Orders shows waiting triggers.
Account holds synchronization, automation, simulation rules and the confirmed
reset action. Use Left/Right arrows or Home/End to navigate the tabs with a keyboard.
The popup scrolls independently and the workspace remains interactive.
Use its close button, the launcher again, or Escape
inside the popup to minimize it. Draft form inputs, live subscriptions and enabled
automation stay active while minimized or switching tabs; neither pauses automation.
The launcher flags paused automation or errors for review. Closing the terminal
still stops automatic execution as described below.
Connect Groww and use the panel's own stock picker, exchange and MIS/CNC selector
to stream a specific stock independently of the analysis panel. Enter a quantity,
choose an order type and confirm **Paper BUY** or **Paper SELL**. These actions never call the broker order
endpoint and work independently of advisory verdicts. The authenticated server
verifies CASH equity metadata and uses a server-signed live tick when available,
otherwise fetching a new Groww REST quote. Live proofs bind the price, trade time,
symbol and exchange to the authenticated Groww token using the server session
secret; browser-edited prices or proofs cannot authorize a fill. This avoids
rejecting a fresh streaming price just because the separate REST snapshot lags.
Live proofs expire after 60 seconds and never extend the trade timestamp's age.
Without a proof, stale or missing REST timestamps still block execution.
User-entered limit, trigger, target and stop prices are instructions, never execution
prices. Client-authored execution prices, balances and fill timestamps are not accepted. The displayed price
is indicative and the final simulated execution can differ. Quotes must be
same-day and at most 60 seconds old, rounded to paise, during weekday
09:15-15:30 IST sessions. Fresh quotes are still required on exchange holidays;
no holiday calendar is inferred.

The paper form leaves target/stop inputs empty and shows suggested prices below
each field, 5% either side of the
reference: BUY/long uses target +5%, stop -5%; permitted short SELL reverses them.
Market entries use the fresh live price; Limit/GTT use the entered limit.
Existing-position exit brackets use the fresh live price and the position's
long/short direction. Values round to paise for CASH or the contract's tick for
F&O; unavailable references or rounding that cannot produce distinct positive
levels leave suggestions unavailable with an explanation. Type each price or
click its adjacent **Use** button to copy that suggestion into its input.
Both typed and copied prices remain fixed when the reference changes, scoped
to the instrument, product, direction and entry/exit context. Clearing a field
leaves it empty. Protection direction must match the intended Paper BUY/SELL
action; no values are populated automatically on submission. Confirmation
shows the entered target/stop. These are optional suggestions, not recommended risk levels;
server-side price, funding, contract and short-selling checks remain enforced.
Entry target/stop protection is optional: clear **Attach target + stop-loss**
to submit without new protection. Existing linked exits are retained/resized.
Risk budgets, daily loss and indicator/depth/timing agreement are informational
only, not entry requirements. The form shows open-position stop risk, pending-entry risk, the 2% combined guideline
and remaining budget. Risk-sizing buttons use the smaller of that remaining
budget and the 0.5% per-trade allowance, including estimated costs and whole
contract lots; market-entry estimates include adverse entry slippage. When
adding to a market position, sizing first accounts for replacing protection on
the existing units. Suggestions remain estimates, not execution approval:
execution prices, supplied protection, funds and contract rules are rechecked
server-side. An exhausted or unavailable risk allowance produces no sizing
suggestion, but does not prevent a manually entered quantity from being submitted.
Cash available and leveraged margin are not risk budget.
Submission progress, validation/server rejections, cancellation and confirmed
results appear in the sticky action bar beside Paper BUY/SELL, not only above
the scrollable form. Disabled actions explain missing connection, account
synchronization or live prices. A rejected or unconfirmed order never shows a
successful fill; inspect the displayed reason instead of repeatedly submitting.

For CASH stocks, MIS permits longs and collateral-backed shorts; CNC permits buys and exits
against this paper account's holdings only. New CASH MIS longs and shorts reserve 20%
of entry notional (fixed simulated 5x leverage); CNC purchases reserve 100%.
The market price does not change between products on the same exchange.
The form compares full entry value, intraday margin and carry-forward cost before
submission. This fixed paper margin is not verified broker/stock eligibility.
Entry basis and reserved collateral are stored separately: P&L uses the full
quantity and actual entry price, never a discounted share price. Opposite trades reduce a position and realize
P&L; close a position before reversing it. New portfolio fills apply estimated
fees and adverse slippage as described below; existing fills are not rewritten.
There is no liquidity modelling, maintenance-margin check or margin-call liquidation. Leverage magnifies
losses as well as gains relative to reserved cash. New MIS entries stop at **15:20 IST**. With automatic execution enabled,
MIS positions square off at the first fresh regular-session price at/after 15:20.
If the terminal was closed, disconnected or lacked fresh prices, overdue MIS
positions remain visible and close at the next available fresh regular-session
price after resuming; a past 15:20 price is never invented. Short losses can leave virtual cash negative; closure is still
allowed. Open positions show saved quantity, average entry price, buy/sell entry
value, live price, current notional and directional unrealized P&L in INR and percent.
Intraday and carry-forward summaries independently show live value, unrealized and
realized P&L, and actual reserved collateral. A stale price in one product does not
hide fresh P&L in the other. MIS/CNC for the same exchange/stock share one live price.
The ledger conserves cash plus position collateral plus pending reservations
against starting cash plus realized P&L. Partial exits release proportional
collateral, with conservative paise rounding and all remaining collateral returned
on the final exit. Existing positions retain their saved entry basis, collateral
and cash balances; new MIS additions reserve 20%, so a mixed legacy/new position
can have effective CASH leverage below 5x. F&O funding is fully reserved as
described below. Version-1 records load without a reset and
acquire explicit collateral fields; subsequent mutations persist version 2.

### Paper order history and historical success rate

The popup's **History** tab derives its history from the
authenticated account's existing MongoDB fill records; it makes no additional
history requests and does not poll. A compact performance card shows the overall
score and completed-trade P&L; its expandable explanation documents the methodology.
**Date-wise profit & loss** shows each IST execution date, newest first, with
positive net fill results, losses and net realized P&L. Recorded entry fees and
partial exits count on their fill dates, even while a position remains open;
open unrealized P&L is excluded. Losses are displayed as positive amounts and
net P&L is profit minus loss. Dates with no fills are omitted. The breakdown
respects the stock/F&O workspace and is not affected by the history search.
Switch between **Closed trades** and **All fills**, search by symbol, exchange or
MIS/CNC, and expand any card for its full details. Search filters only the list,
not the overall score. **Other order activity** lists completed/cancelled/expired/
rejected instructions separately from executed fills.
**All fills** lists every BUY/SELL with stock/contract,
exchange, MIS/CNC/NRML product, quantity, actual fill price, entry cost per unit, full
order value, realized profit/loss or break-even result, execution reason and IST
timestamp. An opening BUY or short SELL is an entry, not a break-even result.
Exit entry-cost prices use the released ledger cost basis, including paise rounding.

**Completed positions** groups additions and partial exits from the first entry
until that exchange/stock/product position returns to zero. It shows total shares
entered/exited, average entry/exit prices, full entry/exit values, final P&L and
opening/closing times. A later re-entry starts a new trade; simultaneous MIS/CNC
and NSE/BSE positions are independent. Shorts use SELL entry and BUY exit.
Each closed-trade card shows a concise **Why profit / loss / break-even** explanation:
average execution-price movement in the trade's direction, all recorded exit triggers
(including partial exits), and the effect of saved fees. Fee-driven losses are called
out even when prices moved favourably. Missing legacy exit triggers are identified
as unrecorded. Reasons are derived from persisted fills on every load, including
existing history; they do not infer news, indicator signals or why the market moved.

The overall historical score out of 100 is
`winning fully closed positions / all fully closed positions * 100`.
Partial exits count only after the remaining position is closed, using the
combined result of all exits. Break-even trades are included in the denominator
but are not wins. Open positions, pending/cancelled/rejected instructions and live
unrealized marks do not affect the score. Wins, losses, break-even count and
completed-trade P&L are shown separately; realized partial exits on still-open
positions remain outside that completed-trade total. No completed trades means
the score is unavailable, not zero. The popup includes trades in its page's
segment; `/risk` includes the shared account. A reset also clears these statistics.
Existing history needs no data migration or reset.

This is descriptive simulator performance, not a calibrated probability of future
profit. Modeled fills include estimated costs; legacy cost-free history remains
clearly labeled, with mixed histories identified separately. If saved fills cannot be
reconciled with current positions/P&L, the UI reports an error instead of showing
a misleading score or resetting history.

### Conditional orders and browser-only execution

Each **Positions** card includes a live, rule-based exit suggestion: consider exiting
when the saved target/stop is reached or MIS/expiry-day square-off is due; otherwise
hold only within the saved exit plan. Missing or partial protection prompts a review.
Stale/offline prices and closed sessions withhold live exit guidance; expired contracts
are marked for review, not given a fabricated exit price. Suggestions refresh with
existing live prices and the session clock, without extra polling or new automatic
orders. They are not trend forecasts. Open P&L excludes fees; a target hit does not
guarantee a net profit after costs and slippage.

Open **Positions** also offers **Check entry with history**. This on-demand,
authenticated check loads 14 calendar days of 15-minute candles and 90 calendar
days of daily candles, anchored to the persisted **first opening fill** of the
current position cycle. Additions/partial exits do not rewrite that entry price;
later additions and the current averaged basis are explicitly not graded. The
server resolves the owner's position and rejects stale opening-fill IDs; it never
accepts a client-supplied entry price or timestamp.

Entry quality is **Favourable**, **Mixed**, **Risky** or **Not enough data**, not a
promise that an entry was correct. Only candles closed by the entry timestamp
contribute: entry-day daily candles and unfinished 15-minute bars are excluded,
even when the check runs much later. Both timeframes show EMA20/EMA50, RSI14,
ATR14, the prior 20-bar low/high as support/resistance references, and the last
five completed candles with OHLC and IST timestamps. Opposing trend, RSI above
70 for longs/below 30 for shorts, an entry over 2 ATR beyond EMA20 in the trade
direction, or entry within 0.5 ATR of the relevant range edge flags risk.
Favourable requires aligned trend/momentum without these warnings on both
timeframes. Missing/invalid/stale history or fewer than 50 completed bars on
either timeframe withholds a complete verdict. Latest-candle checks use weekdays,
not a verified holiday calendar. F&O uses the saved exact contract's history,
which may be too short; an option premium trend is not an underlying-market view.
Provider-adjusted/revised history may differ from data actually published then;
this is an as-of-candle reconstruction, not an archived point-in-time feed.
Checks use the existing historical-request queue, do not poll, and never place
or change orders. Use exit suggestions separately for the current position.
If only one timeframe passes, its result is shown prominently as **partial**,
not as a full entry verdict. MIS prioritizes the 15-minute view; CNC/NRML
prioritize daily context. A secondary-only view explicitly leaves the main
timeframe unverified. Missing-history messages include the actual/required
candle counts or the missing-OHLC/stale-close reason, with expected and received
close times in the evidence. Unfinished candles are removed before counting
missing OHLC, so an incomplete entry-day daily bar or current 15-minute bar
cannot invalidate otherwise complete pre-entry history. This does not lower
the 50-candle requirement or substitute a different instrument.

The paper order-type menu follows the holding period: Intraday (MIS) offers Market
and Limit; Carry-forward (CNC) also offers GTT. Target + stop-loss exits remain
available for both. Switching from CNC GTT to MIS resets the order type to Market.

- **Market:** immediate simulated fill at a verified live price.
- **Limit (day):** BUY only at/below the limit; SELL only at/above it. MIS limits
  expire at 15:20 IST; CNC day limits expire at 15:30 IST.
- **GTT trigger + limit:** CNC only; an at/above or at/below trigger activates
  a persistent limit order. Reaching the trigger does not guarantee a fill.
  The triggered limit remains active across sessions until filled or cancelled.
  GTT placement/cancellation does not require a live execution price.
- **Target + stop-loss exit:** protects existing paper holdings. SELL exits a
  long; BUY covers a short. A long's stop must be below its target, and the reverse
  applies to shorts. The first matching condition completes the single linked
  exit, so the other cannot also execute. The actual observed price is used:
  a gap through a stop may fill worse than its stop price.
- **Attach target + stop-loss to entry:** creates linked protection for the
  resulting whole position after a Market, Limit or GTT entry fills. Entry
  protection is optional for new opening entries; when supplied, it must straddle the
  entry/limit price and actual execution price. Existing linked protection is
  retained and resized on additions and partial exits, then cancelled when flat.
  Oversized separate closing instructions are cancelled rather than reversing a position.

New pending opening orders reserve 20% (CASH MIS) or 100% (CNC and all F&O) of quantity times limit price plus estimated entry fees, separately
from position collateral. Cancellation, expiry or rejection releases that reserve;
fills release it before charging margin for the actual fill notional, returning unused cash.
A short selling above its limit can require extra collateral and is explicitly
rejected if unavailable. Pending closing orders cannot create/reverse positions
if holdings change. Both target/stop legs are represented by one persisted order.
Statuses and fill reasons distinguish LIMIT, GTT, TARGET, STOP_LOSS and SQUARE_OFF.
Legacy accounts acquire an empty order list without resetting balances/history.
Existing pending reservations retain their saved amount until fill, cancellation
or expiry; a new MIS fill then reserves the current 20% margin.

**Automatic orders run only while this terminal is open, enabled and connected.**
They are not real broker GTT orders and no background server worker runs after
the terminal closes. Browser throttling or network outages can delay execution.
Reconnection checks current observed prices, not missed historical crossings.
The client evaluates ticks locally and submits a signed-price processing command
only for a matching trigger, order expiry or MIS square-off; unchanged ticks do
not poll the paper-account API. Daily loss guidance does not generate processing
requests or persisted entry locks. The server independently rechecks execution rules.
Concurrent tabs use the same revision/idempotency checks, preventing double fills.
An exclusive browser automation lock also prevents competing tabs from driving
the same account while the active owner holds it.
An automatic request failure pauses that tab's automation until the user reviews
the refreshed account and selects **Resume automatic paper orders**.

### Paper risk safeguards and performance

The authenticated **Risk & Performance** page at `/risk` summarizes account risk,
protection, costs and completed-trade performance without account polling.
This guidance applies to the MongoDB paper portfolio, not real Groww orders or
the separate legacy order-ticket simulator.

#### Page-aware F&O paper trading

The Paper trading popup on `/` selects CASH stocks; on `/fno` it selects verified
futures/options contracts. Positions, active orders and history/success scores
are filtered to the current page's segment. **Both segments share the existing
INR 1,00,000 balance and advisory account-risk figures**; Account and `/risk`
show account-wide figures. Reset clears both segments.

F&O supports MIS and NRML, Market/Limit orders and linked target/stop exits, not
GTT. Futures may be long or short; options may only be bought and sold to close
owned units. Uncovered option writing and reversal through zero are rejected.
Selecting a contract or holding period on the F&O trading page prefills the
paper ticket with that exact contract, exchange and MIS/NRML product. Opening
the popup restores the current page selection; paper-only edits do not change
the page analysis. A different contract/product resets the F&O entry form to
one whole lot and clears old order prices; no contract is guessed if none is
selected on the page.

The paper action guide separates direction from execution: buying CE expresses
a bullish view; buying PE expresses a bearish view. Both open via BUY, while
SELL only reduces/closes owned options in the selected exchange and product.
Action buttons say **BUY to open/add CE/PE** or **SELL to close CE/PE**; unavailable
option sells explain the missing holding instead of suggesting option writing.
Futures distinguish opening/adding longs/shorts from closing the opposite
position. Target/stop brackets identify the exit side. Option profit depends on
premium movement after costs; index direction alone is insufficient because
time decay and volatility matter. Existing analysis stays separate: labels are
not entry recommendations, and no side or order is executed automatically.

Quantity is contract units in exact lot-size multiples; prices must respect the
contract tick. Saved records include exact contract metadata and expiry.
**All futures entries reserve 100% of notional and option buys reserve 100% of
premium, plus fees, even for MIS.** This is conservative paper funding, not actual
broker margin; many futures lots will be unaffordable with the starting balance
regardless of the advisory 20% concentration guideline. No extra leverage is implied.

Existing position cost basis, cash, cost history and legacy CASH records are
preserved. New risk concentration groups CASH and contracts by the same
underlying, adding gross cash/futures notional and option premium exposure (not
delta-adjusted exposure). No share-price substitution or second lot multiplication
is used in contract P&L.

F&O fills recheck fresh same-day contract quotes on the server. Technical
agreement, depth and timing remain informational rather than entry requirements;
submitting an order does not fetch historical/depth strategy approval.
CASH-only timing/ORB confluence is not presented as F&O confirmation.
F&O prices use the contract's FNO feed and segment-bound signed proofs.
The single browser automation owner streams and processes **both segments** even
when the popup shows only one; it does not poll the account each second.
MIS and expiry-day F&O positions are scheduled for observed-price square-off at
15:20 IST while running. Missed expiry leaves an explicitly visible unresolved
position: there is no invented settlement price, exercise, assignment or physical
delivery simulation. No fills are permitted after expiry.

- Optional new-entry risk guidance, including estimated entry/stop-exit costs,
  uses **0.5% of equity**. Combined protected open and pending-entry guidance
  uses **2%**. Neither figure blocks submission.
- Gross exposure in one stock/underlying, including pending entries across products and
  exchanges, has an advisory **20% of equity** reference, not 20% of leveraged margin.
- Missing/stale account marks and unprotected exposure make risk estimates
  incomplete, but do not block entries. The instrument being filled still
  requires its own fresh verified execution price.
- A **1.5% daily loss budget** uses start-of-IST-day book equity (initial balance
  plus earlier realized outcomes). Losses are today's negative net fill outcomes
  plus current unrealized losses, including carried positions. Profits do not
  replenish that budget; this is deliberately conservative, not close-to-close
  daily return. Reaching it is informational: no new daily halt is persisted
  or enforced, and older saved halt dates do not block entries or confirmed resets.
- A sizing suggestion uses the stop, per-entry budget and stock cap; it is not
  approval. Users can enter a different quantity, including when a guideline
  has no remaining allowance.

Technical indicators, completed-candle agreement, depth/spread, timing and
opening-range/volume analysis remain visible guidance, not paper-entry gates.
Neither manual fills nor triggered Limit/GTT entries request strategy approval.
Market hours, the operational 15:20 MIS entry/square-off cutoff, fresh verified
fill prices, funds, contract lots/ticks/expiry, valid supplied protection,
ownership and idempotency remain enforced. CNC SELL and option SELL remain
exit-only. Due protective exits and square-offs take priority; unrelated entries
wait for another tick. Supplied target/stop exits still execute normally.

New portfolio fills use `INDIA_FLAT20_V2`: **flat Rs20 brokerage per executed BUY
and per executed SELL** (Rs40 brokerage per round trip), plus itemized estimated
STT, exchange transaction charges, IPF/IPFT, SEBI turnover fees, buy-side stamp
duty, GST and delivery-sell DP charges. The shared trade calculator supplies the
statutory schedule; its normal Groww brokerage is overridden only for paper fills.
Rates reviewed 18 November 2026 include the April 2026 STT changes: futures
SELL 0.05%, options SELL 0.15% of premium. CASH delivery STT is 0.1% each side;
intraday STT is 0.025% on SELL. GST is 18% of brokerage, exchange/IPF, SEBI and DP
fees, not of STT/stamp duty. STT rounds to whole rupees per fill; other items to
paise. Delivery-sell DP is modeled per fill at Rs20 before GST, or Rs3.50 when
sell turnover is below Rs100.

NSE uses the March 2026 transaction/IPFT split. BSE uses standard-group transaction
rates and modeled IPF of Rs0.01 per lakh gross turnover
([BSE IPF](https://www.bseindia.com/static/investors/claim-against-defaulter));
security-group/contract-specific rates and actual contract-note aggregation can
differ. See [Groww charges](https://groww.in/pricing),
[NSE transaction/IPFT circular](https://nsearchives.nseindia.com/content/circulars/FA73061.pdf)
and [NSE STT circular](https://nsearchives.nseindia.com/content/circulars/FATAX73524.pdf).
Income/capital-gains tax, interest, penalties, exercise and physical settlement
are not simulated.

The order ticket previews a BUY/SELL-specific charge breakdown and entry funds
including charges. Saved fills persist their breakdown; history shows gross and
net completed P&L, and the risk page totals saved V2 charge components separately
from older, unitemized fees. Pending entries reserve margin plus estimated charges;
placing/cancelling unfilled orders or setting protection does not debit brokerage.
Risk sizing uses the full quantity's fixed and variable charges, not one-share
fees multiplied by quantity.

Fills retain **0.05% adverse slippage per side**, rounded in the adverse direction
to the instrument tick. Limit prices are respected. Entry fees reduce
cash and net realized P&L immediately; closing fills realize gross P&L less exit
fees. Basis excludes fees, and completed-cycle P&L includes all entry/exit fees.
Existing `ESTIMATED_V1` (0.10% turnover fee) and legacy cost-free fills retain
their original amounts; no historical fills are recalculated. Separate V1, V2,
legacy and mixed-cycle cohorts avoid silently mixing fee policies.
These are illustrative estimates, not Groww's actual tariff or a liquidity model.
The historical backtest's separate fixed 0.2% round-trip model is unchanged and
is not directly comparable to this forward paper simulation.

Performance includes net expectancy, average winner/loser, profit factor and
realized-equity drawdown, plus legacy/modeled cohorts and a limited-sample warning.
Drawdown follows fill-by-fill realized equity, including entry fees and partial
exits; it is not an intraday marked-to-market drawdown or out-of-sample validation.

The page and paper popup prominently identify stale/offline and unprotected
states. Browser-only execution cannot protect positions or observe transient
loss-budget breaches while closed/disconnected. Stops can gap. Official holiday
calendars, mandatory sector/news/breadth checks and executed-order-flow evidence
are not integrated. Real broker execution is unchanged and does not gain native
protective exits from this work. None of these safeguards guarantees against loss.

Account ownership uses a SHA-256 namespaced identifier derived from Groww's
server-verified `vendor_user_id`, not the access token or a browser-supplied user
ID. The raw profile ID and access token are not stored in MongoDB. Renewing a token
for the same Groww user restores the same account across devices. A missing
verified identifier fails explicitly. Profile checks are cached server-side by
token hash for at most 30 seconds; expired/denied sessions stop synchronization.

Positions, conditional orders, reservations, realized P&L and fill history are saved together atomically in one
user document with majority write concern. Revision-based compare-and-swap
prevents cross-client lost updates and overspending. Operation IDs are recorded
with request fingerprints (last 200 retained) for idempotent acknowledgments;
revision checks prevent older evicted operations from being executed again.
Conflicting updates require an account refresh and a new manual review, not
automatic trade retries. An uncertain update reports an error: check refreshed
history before another submission. Account documents are capped at 8 MB; reaching
the limit requires an explicit reset rather than silently discarding history.

The authenticated `/api/groww/paper` endpoint loads on entry, tab focus and manual
refresh, not on a repeating timer. Successful trade/reset responses already
contain the updated account; failed actions refresh it before another submission.
Changes made on another device appear on focus or **Refresh paper account**;
there is no background account polling or MongoDB change stream.
The selected paper stock, active orders and all open positions share a multiplexed Groww SSE price stream
(one broker connection per batch of at most 50 distinct exchange/symbol pairs).
MIS and CNC positions in the same stock share its price subscription. P&L updates
in the browser on ordinary ticks without reading or writing MongoDB. Triggered
order transitions are persisted atomically. Stale, missing or
disconnected prices are explicitly unavailable and excluded from the total;
the total is shown only when every open position has a fresh price.
**Reconnect paper prices** restarts failed price streams. Positions can be closed from
their cards without selecting the stock in the analysis panel; normal session,
quote freshness, signed-price and server ledger checks still apply.
**Reset paper account** clears only the signed-in user's MongoDB positions/orders/history
on all devices and restores the starting balance. Browser-only records from the
previous implementation are neither imported nor deleted; clearing browser data
does not delete the MongoDB account. This ledger remains separate from real
holdings and the older order-review PAPER simulation receipts.

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

**Historical win rate** below the indicators replays the selected stock/contract's
loaded Groww history and reports separate BUY/SELL percentages, net winning/closed
trade counts and approximate 95% Wilson intervals. It is not a probability that
today's call will succeed, an out-of-sample validation, or a change to live trading
rules. Zero wins is 0%; no completed trades produces no percentage. Samples below
30 trades are explicitly labeled limited; correlated outcomes can make statistical
intervals optimistic.

The backtest recomputes the existing strict indicators from closed-candle prefixes,
with 50 warm-up candles, enters at the next open, and uses the shared tick-rounded
1.5xATR stop and 2R target. One position is tested at a time. Opening stop gaps fill
at the open; target gaps are capped at the target. Otherwise a bar touching both
stop and target counts as stop-first. MIS exits at the 15:30 IST session close;
CNC/NRML exits after five observed trading sessions, or contract expiry if earlier.
A win means a positive return
after the explicitly estimated **0.2% total round-trip costs**, split across entry
and exit, including timed exits. This estimate covers fees, taxes and slippage;
it does not reproduce broker charges, margin, liquidity or actual execution.
Delivery and options SELL remain exit-only, not short-entry backtests.

Unfinished trades are excluded, not forced closed at the history boundary.
Incomplete/current candles, missing OHLC/session bars and insufficient warm-up
history cannot manufacture outcomes. Missing volume prevents intraday VWAP
confirmation but preserves price-only carry-forward calculations. Intraday tests
require intraday candles. Only the already-loaded history is used (currently
14/45/179 calendar days for 15m/1h/1D); no extra Groww calls, orders or model calls
are triggered. Refresh market data to update the historical snapshot.

Intraday backtests exclude and report candles whose starts fall outside
09:15 inclusive to 15:30 exclusive IST, including special evening sessions,
rather than rejecting otherwise usable regular-session history. Filtering happens
before warm-up and signal calculations; timestamps are never shifted and missing
bars are never filled. The chart and live indicator history remain unchanged.
Daily candles are not filtered by their intraday start clock. Missing bars or
session boundaries within the retained intraday history still prevent testing,
because stop/target outcomes could have occurred during the unobserved period.

The **15-30m scenarios** disclosure still shows current heuristic price ranges.
The terminal no longer offers saved-scenario controls, monitoring or notifications.
Previously saved browser records are not deleted, but are no longer loaded or
processed. Scenario ranges are not calibrated forecasts or guaranteed prices.

The decision-focused workspace keeps stock/mode selection, LTP, day change and
trade/snapshot times above the analysis. Desktop puts price action and compact
indicator cards beside the setup decision, agreement checks, reference risk plan
and entry timing. Mobile puts the decision first, then the chart.
Indicator snapshot combines all seven indicator values, rule signals and evidence
explanations in one set of cards, with the selected mode's indicators first.
Rules, freshness and risk notes are expandable inside that same panel; there is
no separate full-evidence section in the setup decision. Price-relative evidence
uses the same live quote as the decision while candle values remain snapshots.

The trend-rule CASH decision shows **WAIT** when entry timing is not cleared even if
the underlying rule signal is BUY/SELL; the original signal remains labeled
separately. Exit-only CASH/option signals show **EXIT / AVOID**, never a new short
entry. A reference plan can remain visible while waiting but is explicitly labeled
not cleared for entry. This presentation does not change order eligibility or rules.

Timing guides, all rejection reasons, indicator rules/risk notes, historical win rates,
15-30 minute scenarios, AI second opinions and order/calculator tools are
collapsed by default. Session context remains expandable; the broker portfolio
is available from the fixed bottom bar.
Native disclosures preserve mounted content; expanding
them does not itself call a model or submit an order. Feed/snapshot failures and
data-quality summaries stay visible. A skip link and keyboard-visible disclosure
focus support navigation without a mouse. Conditional setups are not guaranteed
correct trading decisions.

The separate **Price action & confluence** card adds a CASH/MIS advisory verdict:
**CONDITIONAL BUY**, **CONDITIONAL SELL**, or **WAIT**. It does not replace the
trend-rule decision, authorize orders, or change broker/timing checks. Its inputs
are the already-loaded dedicated 15-minute candles, quote and optional benchmark:

- The 30-minute ORB uses exactly the two closed 09:15 and 09:30 IST candles.
  A subsequent closed candle must confirm a new breakout/breakdown; a forming
  candle or LTP crossing alone cannot confirm one.
- Structural bands use ORB boundaries, the previous complete session, prior
  intraday extremes, and two-left/two-right swing pivots confirmed before the
  signal candle. Proximity is +/-0.1% of reference price (minimum Rs 0.01).
  Rejection wicks, body engulfing and inside-bar breaks only qualify at these
  boundaries; inside-bar compression alone is not an entry. These are observed
  price bands, not proof of institutional supply/demand or order blocks.
- Volume confirmation requires at least 1.5x the mean of the same 15-minute slot
  in five prior observed sessions. Missing/zero baselines are unavailable, not
  replaced with fabricated volume. Low volume means unconfirmed, not a proven trap.
- Groww quote depth is optionally preserved with its actual server receipt time,
  before waiting for candle-history responses. Five non-empty levels on each side
  are required. REST depth becomes unavailable after 15 seconds; LTP ticks never
  refresh it. The advisory rejects a reported spread above 0.2% or opposing
  quantity imbalance of at least 20%. Resting orders can be cancelled/spoofed;
  they do not establish executed order flow or institutional commitment.
- Expand the benchmark selector, explicitly load the NSE index list and choose
  the appropriate sector index. The authenticated `/api/groww/benchmark` endpoint
  verifies `CASH/IDX` membership against Groww's catalogue before requesting a
  quote; arbitrary stock symbols are rejected. Day direction is compared only
  while the index quote/receipt is fresh within 60 seconds. Sector membership is
  user-selected, not auto-inferred; a broad index is only a market proxy, and
  direction alignment is not a measured correlation.

Known opposing benchmark/book evidence blocks a setup. Missing context is
explicitly labeled and leaves any otherwise qualified verdict conditional.
Market-wide advances/declines and executed order flow are not connected; the
eight tracked movers are **not** substituted for market breadth. These heuristic
thresholds have not been established as optimal or backtested for a success rate;
the existing trend-rule historical percentages do not apply to this strategy.
Depth adds no upstream requests beyond the existing quote; index-list and
benchmark requests happen only after explicit user actions. No orders/model
calls are made by this card. CNC/NRML/F&O are not modeled by the new strategy.

The visible **Next 15 minutes · historical evidence** section separates the
trend-rule decision from two descriptive studies. For an eligible MIS 15-minute
BUY/SELL plan, it reports how often historical same-side strict-rule plans reached
target 1 before their stop in the immediately following 15-minute candle. The
denominator includes stops and neither-hit timeouts, not just completed winners.
Known opening gaps are evaluated before intrabar touches; otherwise ambiguous
bars are stop-first. This measures target attainment, not after-cost profitability.
WAIT, exit-only and non-15-minute plans do not receive invented entry-success rates.

The RSI study reports overbought (RSI >= 70) to oversold (RSI <= 30), or the reverse,
at the next 15-minute close. These reversal thresholds are distinct from the
existing trend-entry rules and do not change them. Samples match the current
RSI zone; middle values use the same 10-point RSI band and have no extreme-reversal
success percentage. Percentages include counts and descriptive 95% Wilson
intervals; fewer than 30 observations are explicitly labeled unreliable, and
zero observations mean unavailable rather than 0% success.

With at least 30 same-RSI observations, the panel rebases their next-close returns
to the current quote and shows the median and historical 10th-90th percentile
price range. This is not a calibrated 80% forecast or a live probability. Trials
start at historical candle closes; their application mid-candle is an analogue
estimate, not a validated rolling-15-minute prediction. An unfinished snapshot RSI
is labeled provisional. Expand the study to see hypothetical next-candle prices
for RSI 70 and 30, solved from Wilder average gains/losses at the last closed
candle. These threshold prices are mathematical references, not price forecasts.

Both studies reuse the selected instrument's existing dedicated 15-minute history.
Only closed prefixes and completed same-session outcomes are counted; missing,
misaligned or omitted OHLC bars invalidate the study. A fresh same-day quote and
a full 15 minutes before regular session close are required. Historical features
are memoized per REST snapshot, not recomputed on each live tick. There are no
additional market-data/model calls or orders. Limited history, serial correlation,
changing regimes and absent out-of-sample calibration prevent treating these
figures as guaranteed success percentages.

The terminal does not display or automatically fetch a gainers/losers section.
`GET /api/groww/market-movers` and the legacy `GET /api/groww/top-picks`
technical-screening endpoint remain available for API consumers, but are not used
by the dashboard.

All historical-candle requests from screening and individual analysis share a
per-token server-process queue: only one is in flight, and starts are spaced at
least one second apart. This is a conservative app pacing policy, not a claimed
Groww historical-API limit. Queued work honors cancellation and existing timeouts.
An HTTP 429 retains the session and reports a rate-limit message and `Retry-After`
in seconds. The queue honors Groww's seconds/date header, or uses 60 seconds if
it is missing/invalid, before permitting another candle request. Refreshes during
the cooldown return HTTP 429 with the remaining seconds without hitting Groww;
they do not sit in the queue until the analysis timeout. Failed requests are
not automatically retried. Wait for the displayed cooldown before refreshing.
Separate server instances or other apps using the same account still consume
Groww's upstream limits; this in-memory queue does not coordinate those clients.

The legacy top-picks API returns at most three qualifying setups per mode ranked by approximate
reported-session traded value (LTP times reported volume), not predicted profit
or a whole-market ranking. Intraday uses 15-minute candles and the existing MIS
freshness/indicator-agreement rules, including VWAP; bullish BUY and conditional
bearish short SELL setups can qualify. Carry forward uses daily candles and CNC
rules, and lists only long BUY setups, never overnight cash shorts. Missing
quote volume, stale data, insufficient history or conflicting indicators exclude a
stock. No qualifying setups means an explicit empty state, not forced picks.
Incomplete current-session candle volume also prevents MIS VWAP confirmation;
CNC does not require VWAP. The response includes a **screenedStocks**
list with data-check status, directional signals and the exact rejection reasons
from the same rule evaluation used to select picks. These are scan-time diagnostics,
not additional recommendations. They require no extra upstream requests.
Closed markets can show last-session carry-forward setups within the existing
three-calendar-day freshness limit, with overnight gap risk.

Partial failures are listed by symbol; complete scan failure, denied access,
rate limits and expired sessions return explicit errors. The date and update
time are IST, and each pick includes its actual last-trade timestamp.
Gemini still requires its separate button click; no orders are placed by screening.

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
Explicit **null candle volume** is retained as unavailable, not converted to zero
and not a reason to discard valid OHLC prices. The chart and price-only RSI, ATR,
EMA, MACD and SuperTrend calculations retain these candles. The dashboard reports
the missing-volume count; the chart omits their volume bars and labels hover
volume unavailable. Session VWAP is unavailable from the first missing-volume
candle through that IST session's end, because partial-volume weighting would be
misleading; it resets and can recover in the next session with complete volume.
Earlier valid VWAP prefixes remain visible, and missing volume in an older session
does not invalidate today's complete-volume VWAP. `omittedCandles` continues to
count only rows with incomplete OHLC. Absent volume columns, malformed numbers,
timestamps, price ranges and negative volumes still fail validation.

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

### NIFTY 100 stock screener

Open **NIFTY 100 screener** from the stock-terminal header (`/screener`). The page
requires the private terminal login and Groww connection. Once connected, it
automatically loads the official NSE NIFTY 100 constituent CSV and scans every
stock for **MIS / 15-minute** and **CNC / daily** technical setups. Membership is
validated as exactly 100 distinct NSE equities with issuer/sector/ISIN metadata;
incomplete, duplicate, malformed or unavailable lists fail explicitly. The
official CSV is cached server-side for up to one hour, with its source and fetch
time displayed. Broker tokens are never sent to NSE for this public download.

Validated membership (up to one hour) and historical baselines persist in this
browser's IndexedDB. Reopening restores detailed cached analysis before loading
history; no credentials, account data, signed tick proofs or live ticks are
persisted. Schema/identity checks and closed-candle indicator recalculation run
when restoring. Invalid records are rejected with a warning; unavailable/full
storage is explicit and leaves this visit operating in memory.

The existing Groww WebSocket worker streams prices through the authenticated
terminal SSE bridge: 100 stocks use two subscriptions of at most 50 instruments.
Browser updates batch every 250ms. Matching fresh ticks update price-sensitive
verdict checks and ATR-based levels, without REST analysis/price polling or
changing historical timestamps, closed candles, RSI, MACD, ATR or other confirmed
indicator values. LTP ticks cannot manufacture OHLC or volume. Prices arriving
out of order or for other instruments are ignored/rejected; a failed group loses
its live approvals while the other can continue. Reconnect is explicit. The
existing Python/Groww feed runtime must be available on the deployment; a
serverless host without that runtime cannot provide this feed.

Only missing/outdated history uses the existing analysis endpoint, sequentially
paced by at least 1.1 seconds plus the server's per-token historical queue.
First-visit warmup can require 200 calls and several minutes. MIS baselines
expire at each completed regular-session 15m bar; CNC expires at session close.
The last completed candle must actually be present, not merely a new fetch
timestamp. There is no exchange-holiday calendar; missing expected weekday bars
fail closed. Each unavailable baseline is attempted at most once per boundary,
unless manually retried, avoiding loops if the provider's candles lag. History
refresh/retry controls keep good baselines and never clear the table.
Rate limits pause loading until cooldown expires; 403 or three consecutive
failures also pause it. Page close/navigation or Groww disconnect aborts network
work. No always-on worker, AI request or order is started. Separate tabs remain
subject to Groww's account limits.

Only completed regular-session 15m candles or daily candles whose IST session
has closed are used; indicators are recalculated after excluding forming bars.
EMA20/50 ordering, RSI, MACD and SuperTrend must agree; MIS also needs VWAP.
ATR sets conditional risk levels through the existing deterministic verdict
engine. Missing/omitted/stale evidence shows HOLD or an explicit unavailable
cell, never an invented BUY/SELL. Both modes require a fresh live tick (60 seconds)
and current history; cached/snapshot prices alone never approve an entry.
MIS also needs an open weekday session before 15:20 IST. CNC retains its
three-day candle/snapshot freshness limit. Freshness expires locally even when
no ticks arrive. CNC SELL is exit/avoid, not a short entry.

Results appear in a table with stock, sector, intraday and carry-forward
columns; the table scrolls horizontally on narrow screens. Search by
symbol/company/sector or filter either timeframe's verdict; expand a cell for
indicators, reasons, conditional entry/stop/targets and timestamps.
Open full intraday/carry analysis to refresh one stock with charts and the rest
of the existing analysis. These links initialize the stock terminal through
`/?symbol=RELIANCE&mode=MIS` or `mode=CNC` (daily interval). Screening is technical
only, not probability of profit or executable entry approval: depth/spread,
ORB/volume, news/sector context and all existing trade/risk checks still apply.

### Futures and options

#### Selected-option Greeks and expiry POP

Selecting a CE/PE contract shows **Option Greeks & expiry POP** above the existing
chart/technical indicators. Delta, gamma, theta, vega and rho are calculated locally
using European Black-Scholes-Merton, with per-unit and hypothetical lot-quantity
values. Theta is rupees per calendar day; vega/rho are rupees per +1 percentage
point volatility/interest rate. Delta is premium sensitivity per rupee of spot;
gamma is delta sensitivity per rupee. Futures show a not-applicable explanation,
not made-up option metrics.

The panel estimates annual IV from current option premium and verified underlying
spot using a bounded solver (0.01%-500%), or accepts an explicit percentage IV
override. Raw Groww IV remains a separately labelled snapshot: its units are not
assumed or converted. The editable 6% continuously compounded annual rate and 0%
continuous dividend yield are **illustrative model defaults**, not live RBI/broker
data. Expiry is the catalog date at regular exchange close, 15:30 IST; time is
calendar ACT/365. Special sessions, discrete dividends and volatility smiles are
not modeled.

**Gross expiry POP** is the risk-neutral lognormal probability that a hypothetical
new long option finishes beyond strike plus entry premium (CE), or strike minus
entry premium (PE). It is not delta, ITM probability, a technical win rate or a
real-world forecast. Breakeven and POP exclude **all brokerage, taxes, slippage,
financing, exercise and physical-settlement costs**; net-of-cost POP is not calculated.
They do not describe option writing or an existing position. Blank entry follows
current LTP; entering a premium locks this hypothetical cost. Lots here never
change the paper ticket or submit orders. Intrinsic/time value, moneyness, days
remaining, ITM probability, a model central 68% terminal range and gross expiry
scenarios provide context; they do not generate BUY/SELL instructions.

Authenticated `GET /api/groww/option-underlying?symbol=<exact-option-symbol>&exchange=NSE`
verifies the selected current CE/PE against the catalog and requests one matching
CASH IDX/EQ quote. Stock options use exact underlying symbols; MIDCPNIFTY and
NIFTYNXT50 share the verified aliases used by the near-spot guide. Missing,
ambiguous, expired or unresolvable identities show unavailable rather than a
guessed stock/index or a futures proxy. No option chain/history/LLM request is
made by this panel.

The existing option stream and an underlying-price stream update inputs; a
one-second clock updates time decay and freshness. Both prices must have a
same-IST-day trade no older than 60 seconds, no more than five seconds in the
future and no more than 30 seconds apart. No API is called per tick. Underlying
snapshots load with option snapshots or **Refresh underlying**; the usual F&O
snapshot refresh retains its hidden-tab/rate-limit handling. Missing/stale data,
invalid assumptions, expired options and unidentifiable IV show explicit errors,
not zero Greeks. OI, volume, raw broker IV and candle indicators remain snapshots.
The model ignores delivery funding/settlement liabilities; net paper results
remain in paper history.

#### Option-aware verdict

The option panel also shows a separate **Option-aware verdict** beside the
unchanged technical decision. For a new purchase it requires technical BUY,
fresh matching inputs, and a model premium within one contract tick of current
LTP. An inconsistent manual IV override shows HOLD rather than inventing an edge.
Edited historical entry cost and hypothetical lots do not influence this verdict.

The horizon is the remaining regular session for MIS (no new-entry guidance from
15:20 IST), or the next 24 calendar hours for NRML, capped at catalog expiry at
15:30 IST. Full BSM repricing evaluates separate favorable/adverse spot scenarios
`spot * exp(+/-IV * sqrt(horizon / 365 days))`, unchanged spot/IV time decay,
IV down one percentage point (floor 0.01%), and a one-percentage-point adverse
rate change (down for CE, up for PE). All rows include the selected elapsed time;
they are separate hypothetical stresses, not a combined shock or forecasts.
Delta/gamma, theta, vega and rho therefore affect the resulting scenario premiums.

**BUY CANDIDATE** requires favorable-spot premium to reach the existing technical
first target, while unchanged-spot/time, IV-down and adverse-rate premiums stay
strictly above the existing technical stop. Otherwise the separate verdict is
**HOLD**, with pass/fail reasons and scenario prices. The adverse-spot row exposes
stop risk without vetoing a trade simply because its planned stop could be hit.
No arbitrary raw Greek or expiry-POP threshold is used. Expiry POP is not a
holding-period win rate and does not override technical direction. These
scenario-feasibility rules are unbacktested, advisory and gross of all costs.

A fresh technical SELL is **SELL / EXIT OWNED OPTIONS ONLY** even when underlying
model inputs are unavailable: entry-risk filters never block exits or imply
uncovered writing. Expired contracts and stale option quotes cannot produce a
fresh option-aware verdict. CASH/futures, the existing technical/AI results and
reference levels, and paper-order permissions remain unchanged. Live inputs and
the local clock recalculate this verdict without extra API or LLM calls.

#### Verdict duration and restored observations

Both the **technical BUY/SELL/HOLD signal** and the separate **option-aware
verdict** show live observed-duration timers and their first-observed IST time.
The technical timer follows the raw signal, not the separate CASH entry-timing
WAIT/clearance label. Normal ticks and unchanged snapshots do not restart a
timer. A changed signal, instrument/exchange, product or candle interval starts
a new observation; the two verdicts have independent histories.

The browser stores the most recent observation for each verdict type in
`localStorage`, so a matching selection can restore its last state after reload.
Only actively observed, visible-page intervals are counted. Reloads, hidden
tabs, unavailable verdict data and observation heartbeats more than five
seconds apart create unmonitored gaps, not continuous holding time. A restored
matching state keeps its accumulated **observed** duration with a prominent
“not continuous”/gap explanation. A different state on return starts at its new
first observation and marks the exact transition time as unknown. Missing or
stale data pauses timing instead of treating an unavailable-data HOLD as a
confirmed market signal. Storage/validation failures are shown explicitly;
current-session timing remains available. No account data or credentials are
stored by these timers, and they make no API or order calls.

#### Contract selection and technical analysis

Open **Futures & options** in the header to visit the authenticated `/fno` page.
The main `/` workspace is for CASH stocks; the market-segment dropdown has been
removed. Both pages retain the shared Groww connection, portfolio bar and account
controls. Contract analysis, charts, technical/AI setups, cost calculations and
reviewed F&O order submission live on `/fno`. Its Paper trading popup supports
futures and bought options using the shared practice account. Use **Stocks** in
the header to return to the stock workspace.

Selecting a stock or contract updates the current URL with `symbol`, `exchange`
and `mode`, without reloading the workspace. Bookmark or copy that URL to restore
the selection after a reload: for example `/?symbol=M%26M&exchange=BSE&mode=CNC`
or `/fno?symbol=NIFTY26NOV25000PE&exchange=NSE&mode=NRML`. F&O links resolve exact
contract metadata from the current catalog after Groww connects; missing/expired
contracts show an error instead of selecting a different strike. Paper trading
receives the restored F&O selection as well. Editing/clearing a selection removes
the old selection from the URL; these links never submit orders.

Both the analysis picker and Paper trading picker offer **Find stock / index options
near spot**. Search the **Underlying stock or index** field and choose a verified
listed underlying, expiry and CE/PE side. The **Strike price** dropdown defaults
to the nearest listed strike to spot and includes every actual strike for that
expiry/side, not only the seven visible cards. Choose another strike to browse
contracts around it, then select an exact contract card explicitly. Seven nearby actual listed strikes are
computed from the full matching catalog, not the first search page. The nearest
strike is highlighted (lower strike wins equal-distance ties), with signed
strike-minus-spot distance, CE/PE-correct ITM/ATM/OTM and lot size. Nearest listed
does not necessarily mean exactly ATM. A custom strike reference never changes
which strike is nearest to spot; the nearest remains labelled in the dropdown
even if outside the current seven cards. Changing underlying/expiry/side clears
the strike reference and selected contract; switching CE/PE preserves the chosen
expiry. Changing the strike reference clears the selected contract too. Partial
search text does not request spot/history until an exact verified underlying is chosen.

The authenticated `GET /api/groww/fno-guide?exchange=NSE` lists supported stock/index
underlyings; add `underlying=NIFTY&type=CE&expiry=2026-11-19` for the spot snapshot,
available side-specific expiries, the complete `strikes` list and nearby contracts.
Add `strike=<listed-price>` to center the seven cards around a chosen strike;
unlisted strikes are rejected before fetching market data. The nearest listed expiry
is used if omitted. Spot quotes and 15m candles use verified CASH IDX/EQ catalog
identities, never an option premium. MIDCPNIFTY maps to the catalog's NIFTYMIDSELECT
index and NIFTYNXT50 to NIFTYJR; unavailable or ambiguous mappings stay in exact
contract search instead. Stocks match exact underlying symbols, never substring
matches. Existing `indices` / `index` response keys are retained for compatibility
and may now identify EQ stocks as well as IDX indices. Futures retain the existing search below.

**Find stock / index options near spot** opens an absolute-positioned, scrollable overlay
below its button without moving the selected-contract field. Click outside,
move focus outside the guide, or press Escape to dismiss it.

Underlying guidance requires agreement from EMA20/50 ordering, RSI, MACD and
SuperTrend using at least 50 complete regular-session 15m candles. Index
volume/VWAP are not invented. Bullish evidence favors examining CE, bearish PE;
the aligned side is only a **CONDITIONAL BUY** candidate, never entry approval.
Opposing/mixed/unavailable evidence shows WAIT, not a short option recommendation.
Guidance also requires a same-day quote and snapshot no older than 60 seconds,
a same-day candle close within 30 minutes and an open session before 15:20 IST.
It expires locally without polling; use Refresh for another snapshot. Outside
those conditions, nearby strikes remain indicative of the displayed last-known
index value only. Candle failures are explicit and leave direction at WAIT.
Confirm the selected option's own premium setup, spread, IV, theta and risk;
paper strategy/risk checks are informational, while execution-integrity checks
remain enforced. SELL remains exit-only for owned
options. This intraday side guide is not an overnight NRML signal.

The **Selected contract**
field is editable: type at least two underlying or contract characters to show
a matching-contract dropdown. Exact symbol/underlying matches rank first, followed
by prefix and substring matches. Searching NIFTY therefore shows NIFTY contracts
before BANKNIFTY. Filter FUT/CE/PE, expiry and strike in the dropdown,
then click an exact contract or use arrow keys and Enter; Escape dismisses the
list. Results show the exchange, type, expiry, strike and lot size, with pagination.
Editing the query or filters clears the previous selection and analysis; partial
text never triggers quote/history requests. Selecting a result fills the field
and loads the verified contract's analysis. Exchange changes reset the search.
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
values remain unavailable. Raw IV units are not inferred or converted; the
separate option panel estimates Greeks/IV from its disclosed model and verified
inputs. New contracts may have insufficient indicator history.

F&O modes are **MIS** (intraday) and **NRML** (overnight); CNC is CASH-only.
Gemini receives the verified contract metadata and reported OI/IV along with
the contract's technical data, and considers expiry, leverage, liquidity,
time-decay and settlement risks. Targets refer to the contract/premium.
Futures SELL may describe a conditional short subject to margin/eligibility.
Options SELL means exit/avoid, never an uncovered option-writing setup.
All F&O GTT suggestions are disabled; analysis itself places no orders.
The separate order-review action is described below; it does not execute GTT.

### Technical verdict (no LLM)

The dashboard retains the **strict confirmation** policy rather than forcing a
BUY/SELL for every stock. **Decision checks / Why HOLD?** shows whether data
quality and freshness passed, the required bullish/bearish agreement counts and
each directional check. EMA20/EMA50 is one combined trend check, including their
ordering; ATR is excluded from directional counts. MIS uses five checks (also
VWAP); CNC/NRML use four. Counts are not confidence or profit probabilities.

Mixed-signal HOLD reports the exact BUY and SELL blockers near the decision,
instead of the generic “indicator agreement and fresh data are required” message.
Data failures show their specific reasons. HOLD displays an explanation instead
of four empty trade-level cards; it still has no actionable entry, targets, stop
or reward/risk. Valid BUY/SELL setups and exit-only restrictions are unchanged.
This policy was retained to avoid unvalidated strategy changes and preserve
data-quality/risk safeguards, not because it is proven to maximize returns.

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
Selected F&O contracts have an **Auto-refresh F&O data (30s)** checkbox, enabled
by default. It reloads the selected quote/history and dedicated 15-minute forecast
snapshot after the previous refresh completes, never overlapping refresh cycles.
Day change, OI/IV and indicator cards receive the new validated snapshot while
the last good snapshot stays visible during loading or a failed refresh. Errors
and the last successful update time remain visible. HTTP 429 pauses the next cycle
for at least the reported cooldown (60 seconds if missing); hidden tabs pause
subsequent polling, not the initial selection or manual-refresh request. Switching
selections or disconnecting cancels pending work.
Disable the checkbox for manual-only snapshots. No Gemini or order calls are
triggered by automatic refresh. Indicators can remain unchanged if Groww returns
the same candles, especially for daily intervals, closed markets or illiquid
contracts; the app does not invent candle volume or recalculate from LTP alone.
Freshness is reevaluated every five seconds even if no ticks arrive. Opening order
review captures its analysis side/price so later ticks cannot silently change the
reviewed instruction. No order, GTT, stop or target is placed automatically.

Each indicator has an **i** button in the unified indicator snapshot and
Gemini input-evidence cards. Hover or keyboard focus opens a tooltip; clicking
pins it for touch users. Escape, blur or an outside click dismisses it. Tooltips
show **ideal ranges / decision references**, not the current supplied values:
RSI 55-70 bullish / 30-45 bearish (inclusive), price versus VWAP and EMA ordering,
MACD line/signal and histogram direction, SuperTrend agreement, and positive ATR
with a minimum 1.5xATR risk distance. Indicators without a universal ideal number
use relative conditions instead. Actual values remain on the cards, and reference
guidance is available even before data loads. F&O OI/change/IV tooltips explain
that there is no universal ideal threshold, without guessing IV units.
These references do not change the trading rules or guarantee outcomes.

### Stock entry timing (IST)

The CASH technical-verdict panel shows general timing guidance for both intraday
BUY/short SELL and carry-forward BUY, plus a live **conditions met / WAIT** status
for the selected stock and mode. It reuses the code-calculated verdict and its
five-second clock; no extra requests, model calls or orders are triggered.

The regular weekday schedule is 09:15 inclusive to 15:30 exclusive IST. Around
09:30 is a first-15-minute-candle review checkpoint, not a statistically proven
best entry time or a new signal gate. Intraday positions must allow time to exit
before the broker's own MIS cutoff, which may be earlier than exchange close.
For daily-close confirmation, review a completed 1D candle after 15:30 and
reassess in a later regular session rather than treating an after-close signal
as permission to enter immediately.

The timing overlay requires an actionable existing rule verdict with risk levels,
regular scheduled hours and a same-IST-date quote no older than 60 seconds
(at most five seconds ahead). Carry-forward timing additionally requires 1D
candles and BUY; it never offers a new overnight CASH short. This is stricter
than the base CNC freshness policy and does not change the underlying verdict
or order eligibility. Today's unfinished daily candle is explicitly labeled
**provisional**, not daily-close confirmation.

There is no universally ideal or guaranteed profitable clock time. The weekday
schedule is not a holiday/special-session calendar or proof the exchange is open.
Opening gaps, liquidity and broker permissions still need checking.

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
snapshots. Scenarios do not add their own polling; they reuse the F&O auto-refresh
cycle when enabled. No Gemini calls, orders or protective exits are triggered.

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

The separate legacy order-ticket Paper mode (not the MongoDB paper portfolio)
simulates MARKET fills at the newly fetched REST quote, without fees,
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
use **Refresh market data** or the enabled F&O auto-refresh cycle to update them.
Missing previous close makes derived
change unavailable. No candles or volume are invented from price ticks.
Freshness uses trade timestamps, not heartbeat traffic. After 60 seconds without
a fresh trade the dashboard labels the price stale/last-known, including when
markets are closed. Feed errors remain visible; **Reconnect feed** explicitly
retries. F&O snapshot polling is explicit and separately labeled; it does not
masquerade as streaming. There is no silent polling fallback or automatic
stream-reconnection loop.

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
The host-executable call opts out of Turbopack tracing: the container explicitly
installs the Python environment and copies the worker, rather than asking Next.js
to discover them. A non-container deployment must install/copy them itself.

#### Persistent Docker deployment (true streaming)

Vercel's Next.js functions are not the deployment target for this Python-worker
design. The `childProcess.spawn` tracing warning is a build warning, not proof of
a specific runtime failure; suppressing it alone does not install Python, ship the
SDK or remove function lifetime limits. Move the entire app to an always-on Linux
Docker host to preserve true streaming without a polling fallback.

The [Dockerfile](./Dockerfile) builds Next.js, installs the pinned Groww SDK in a
Python virtual environment, copies the worker and runs the app as a non-root user.
Its build context is allowlisted by [.dockerignore](./.dockerignore); environment
files, credentials, local virtual environments and order journals are not copied.
No runtime credentials are required during image build.

On the host, install Docker Engine with Compose, then create a fresh runtime
environment file (do not overwrite an existing one):

```sh
(umask 077; set -C; printf 'GROWW_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.production)
npm run docker:start
docker compose ps
npm run docker:logs
```

Available Docker scripts:

| Command | Purpose |
| --- | --- |
| `npm run docker:build` | Build the production image without starting it |
| `npm run docker:start` | Build and start production in the background |
| `npm run docker:stop` | Stop production without deleting order data |
| `npm run docker:logs` | Follow production logs (Ctrl+C exits logs only) |
| `npm run docker:dev` | Run local development with hot reload in the foreground |
| `npm run docker:dev:stop` | Stop the separate development project |

Keep the generated session secret stable across restarts. Add `GOOGLE_API_KEY`
to this file only if you use the optional Gemini analysis. Paste Groww access
tokens into the app's Connect Groww dialog; do not bake them into images.
The container sets `GROWW_FEED_PYTHON=/opt/groww-venv/bin/python`, so local
macOS/Windows executable paths must not be used in the runtime environment.

[compose.yaml](./compose.yaml) binds port 3000 to host loopback, restarts the
service after failure, reaps child workers and persists `.groww-orders` in a
named volume. Run one app instance with this local order journal; replicas need
shared durable order storage first. Do not remove the volume when redeploying.
On managed container platforms, mount persistent storage at `/app/.groww-orders`
writable by UID/GID 1000, and prevent scale-to-zero for the streaming service.

Put an HTTPS reverse proxy in front of the app. HTTPS is required for production
session cookies. For example, inside an nginx HTTPS server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

Allow outbound HTTPS/WSS to Groww and ensure any additional load balancer permits
long-lived SSE responses without buffering. After publishing the HTTPS domain,
connect Groww, select a stock during market hours and confirm fresh trade ticks.
Closed markets may correctly show last-known/stale prices. To update the app,
run `npm run docker:start`; open feeds disconnect during restart and
users can use **Reconnect feed** afterward. The image health check verifies HTTP
readiness at `/login` only, not database authentication, Groww permissions or
whether the market is trading.

### Holdings and positions

Use **Holdings & positions** in the fixed bottom bar. Hover to preview the stock
list, or click/tap to keep it open. Keyboard focus also opens it; Escape, the
close button, clicking outside or leaving keyboard focus dismisses the preview.
Moving the pointer into the preview keeps it open so you can scroll, filter and
refresh. Each holding shows purchase price per share, quantity and ISIN. Position
cards show long/short/closed status, exchange, segment, product, net quantity,
net average price and realised P&L. Live price, unrealized profit/loss (INR and
percent), entry value and current market value update for each open holding or
position. Shorts gain when the live price falls; closed positions retain their
realised result but do not subscribe to prices. These are broker records, not paper trades.
The popup summary shows overall, holdings and positions live P&L in INR and percent.
Overall adds holdings and the currently selected positions segment; percentages use
the combined absolute entry value rather than averaging stock returns. Realised
P&L and fees are excluded. Fresh-price coverage is shown, and incomplete totals
are unavailable rather than displaying a misleading partial profit/loss. Summary
updates reuse existing streamed prices without additional API requests.
The preview fits the viewport and scrolls independently; reopening it does not
refetch snapshots or reset the selected segment. On narrow screens the adjacent
paper-trading launcher uses a compact **Paper** label to avoid overlap.

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
cards are returned. Invalid or unsuccessful upstream JSON returns 502, not an
empty portfolio. Other Groww HTTP failures keep their error status.

Holdings and positions load independently, so one can remain visible if the other
fails. Use **Refresh portfolio** to retry or update quantities and entry prices.
There is no portfolio polling. Live marks use `(price - average entry) * signed
quantity`, without leverage/lot multiplication or fees; position marks use Groww's
`net_price` and remain separate from `realised_pnl`. A zero entry cost has no
percentage return. Account snapshots are not automatically reconciled with trades
made elsewhere; refresh after broker activity. Empty accounts show explicit empty states.
Disconnecting clears the displayed portfolio and cancels pending requests. A
Groww 401 clears the cookie, removes both lists and prompts you to reconnect.

Authenticated `POST /api/groww/portfolio-instruments` resolves up to 50 selections
against Groww's cached instrument catalog per request. Holdings use ISIN when
the catalog supplies it, prefer NSE and fall back to BSE; each card labels the
actual price source. Missing position segments are inferred only from a unique
catalog match, never assumed to be CASH. Ambiguous, unsupported or expired
instruments show an explicit valuation-unavailable message without blocking other
stocks. CASH/FNO selections share a deduplicated multiplexed price stream (up to
50 per connection). Paper trading reuses the same stream hook, retaining its
CASH-only execution rules. Quotes older than 60 seconds, malformed/future ticks,
identity mismatches and disconnected feeds cannot produce live P&L.
Use **Reconnect portfolio prices** to retry resolution and streaming. Hovering
or reopening the preview keeps existing subscriptions; disconnecting cancels them.

Endpoint schemas follow the official
[Groww portfolio API documentation](https://groww.in/trade-api/docs/curl/portfolio).

Session setup returns 503 when the session secret is missing, 400 for malformed
input, and 401/403 when Groww rejects the token. Cross-origin session mutations are
rejected. All session and order-detail responses disable caching.
