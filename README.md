# Finances

[![test](https://github.com/alexchunt90/finances/actions/workflows/test.yml/badge.svg)](https://github.com/alexchunt90/finances/actions/workflows/test.yml)

A local, single-user budgeting and mortgage app. Goal: **save more each pay period.**

Same shape as `refi_calc` — no dependencies, no build step, all arithmetic in the
browser — so the two can merge later.

```bash
node server.js
```

Then open http://127.0.0.1:4174. A fresh checkout carries no financial data at
all — the first run seeds `config.json` and `data/` from [`example/`](example/),
which is a made-up household with round numbers. Edit it, or replace it with
your own; either way it is git-ignored and stays on your machine. It also listens on every interface, so it is
reachable from a phone on the same network, or from anywhere over a Tailscale /
WireGuard link — the startup banner prints the addresses.

**There is no authentication.** Anyone who can reach the port can read and
rewrite every figure in the app. That is fine on a trusted home network or a
private mesh; it is not fine on shared wifi, and the app should never be exposed
directly to the internet. Set `HOST=127.0.0.1` in `.env` to restrict it to this
machine.

## The pay calendar

Paid on the 10th and 25th. When that falls on a weekend or federal holiday the
pay date walks back to the first business day at or before it, and the bank makes
the deposit available on the **first business day before that**.

Verified against a real deposit: Aug 10 2026 is a Monday and a valid pay date,
and the money landed Friday Aug 7 — not Sunday Aug 9. A "minus one calendar day"
rule gets this wrong.

Periods run deposit to deposit, which makes them **13 to 19 days long**, not
uniform halves of a month. That single fact drives most of the design.

## Two ideas the app is built on

**Fixed obligations divide by 24 flat; variable targets accrue per day.** Rent
does not care that a period ran 19 days, but groceries do. A flat per-period
grocery target would flag the 19-day period as an overspend and the 13-day one as
a triumph when nothing about the behavior changed — about a quarter of all
periods would give a misleading verdict.

**Contribution is the goal metric, not balance growth.** Balances move on
markets. Contributions move on decisions. A good month in the brokerage is not
evidence of discipline.

## The waterfall

Order money leaves take-home each period:

1. Committed bills
2. Variable targets (prorated by the period's real length)
3. **Sinking funds** — never reduced
4. Emergency fund
5. Buffer replenishment
6. Roth IRA
7. Brokerage

While the emergency fund is below target the app enters **recovery mode**: tiers
5–7 are halved and the freed money redirects to the emergency fund. Sinking funds
are exempt, because halving them leaves the annual bill unfunded when it lands,
which sends you straight back to the emergency fund you were refilling.

## Sinking funds

An annual bill is contributed to over 24 periods and then paid out of its own
fund. Paying it is a **transfer, not new spending** — otherwise the bill lands as
a catastrophic period you already accounted for twenty-four times. In the other
direction, the accumulating balance is a pre-paid bill and not net worth, so it
is excluded from *accessible savings*.

The Expenses view computes what your standing bank transfer should be and flags
drift from what you actually transfer.

## Accounts and buckets

**Accounts** are real and get a balance snapshot at each close. **Buckets** are
virtual allocations inside them (sinking funds, mortgage recast, travel, fun), so
you enter one balance for a savings account rather than five.

Two independent flags:

| | Volatile | Liquid |
|---|---|---|
| Emergency fund, buffer, long-term | no | yes |
| Brokerages | yes | yes |
| 401(k), Roth | yes | no |
| Private company equity | no | no |

Hence two headline numbers: **accessible savings** (liquid, less what sinking
funds have spoken for) and **total picture**.

## Period lifecycle

`open` → balances entered as they arrive → `closed`

Only one period is visible at a time. Spending entered after the next deposit but
before you close still lands on the open period, so proration uses the **actual**
span, not the scheduled one. Closing requires every balance, then snapshots them,
computes the reconciliation residual, archives the logs, and freezes totals.

## Editing

Committed bills, variable targets, and planned savings are all editable inline
in the Expenses view; changes save to `config.json` on change, debounced.

Two fields deliberately are not editable there. **Sinking funds** show the sum of
section 2's per-bill contributions, so an edit would be discarded on the next
render — change the bills instead. And savings inputs bind to the **configured**
figure, not the amount that actually moves this period: under recovery mode those
differ, and binding to the effective amount would silently halve what gets saved.
The table shows both, as "Planned" and "This period".

## Reconciliation

Balance change, minus expected flows (the standing transfers from the waterfall),
minus recorded flows. What remains is the residual.

On a **stable** account that residual is money that moved without being written
down — the honest answer to "did I actually save what I thought." On a
**volatile** account it is market movement and means nothing, so it is never
flagged.

Flow types: `contribution` (counts toward the goal), `windfall` (bonuses, flagged
so they don't flatter the savings rate), `withdrawal`, and `transfer` (links two
accounts, nets to zero).

## Theme

Backgrounds are black and near-black, body text white. One accent colour drives
headlines, chart series, and the primary button, and it comes from config:

```json
"theme": { "accent": "#D4AF37" }
```

Any hex works — the app derives a translucent wash and a dim variant from it at
load, and falls back to the gold default if the value is malformed.

`theme.coolPalette` and `theme.warmPalette` colour the composition chart: cool
shades stack from the bottom for illiquid accounts, warm shades above them for
liquid ones, each assigned in order. Add entries if you add accounts — the
palettes wrap rather than running out.

## Where the state lives

Four documents: `config.json`, and `periods.json`, `history.json` and
`amortization.json` under `data/`. None of them is in this repository — that is
what lets it be public.

By default they are files under `STATE_DIR`, which is the project directory. Set
`S3_BUCKET` and they move to a bucket instead, which is what lets several
instances — a server, a laptop, a second box — share one source of truth:

```bash
S3_BUCKET=my-finances
S3_PREFIX=finances
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Anything speaking the S3 API works. Set `S3_ENDPOINT` and requests go path-style
to that host instead of to AWS, which is what Cloudflare R2 and MinIO want.

### What the credentials need

[`deploy/iam-policy.json`](deploy/iam-policy.json) is the whole of it. It ships
with a placeholder bucket name, so substitute rather than passing the file
straight to `--policy-document` — an unsubstituted `YOUR-BUCKET` attaches
without complaint and then denies every call:

```bash
aws iam create-user --user-name finances-app
sed 's/YOUR-BUCKET/my-finances/g' deploy/iam-policy.json > /tmp/policy.json
aws iam put-user-policy --user-name finances-app \
  --policy-name finances-state --policy-document file:///tmp/policy.json
aws iam create-access-key --user-name finances-app
rm /tmp/policy.json
```

Note that only the object ARN carries the `/finances/*` suffix; the bucket ARN
must have no path at all. To check what actually landed:

```bash
aws iam get-user-policy --user-name finances-app --policy-name finances-state
```

The app only ever issues `GET` and `PUT`, so the `s3:ListBucket` in there looks
redundant. It is not. Without it S3 answers a `GET` for an object that simply is
not there with **403**, not 404 — and the empty-bucket case is exactly where
that bites, because the app reads the 403 as bad credentials and the seed that
should populate the bucket never runs.

Moving existing state into a bucket is a copy:

```bash
aws s3 cp config.json s3://my-finances/finances/config.json
aws s3 cp data s3://my-finances/finances/data --recursive
```

A bucket the app finds completely empty gets seeded from `example/` on first
start, so pointing at a new bucket gives you a working app rather than an error.
Copy your own state in first and the seed never fires.

**Keep the bucket private.** It holds every figure in the app and there is no
authentication in front of it, or in front of the app.

### Two instances, one bucket

`config.json` and each period carry a `version` that increments on every write,
and a client echoes back the version it loaded. That catches a **stale client** —
a tab that has been open since before someone else saved.

It does not catch two *servers*. Both could read v5, both write v6, and one
edit disappears with nothing to show for it. So every write is also conditional
on the stored copy not having moved since it was read: on S3 that is a
conditional `PUT` against the object's ETag, and on the filesystem it is a hash
check under a lock. An instance that loses the race re-reads and re-applies its
change to what is actually there now, up to eight times before giving up and
returning **409**.

The two failures are deliberately different. Two people saving different things
at the same moment is nobody's mistake and just works. A stale tab trying to
overwrite an edit it never saw is reported, the browser reloads, and it says the
unsaved edit was dropped — losing one edit beats silently losing someone else's.

## Running on a server

`STATE_DIR` points at the writable state — `config.json` plus `data/` — when it
is kept in files. It defaults to the project directory, so a checkout needs no
configuration. In a container it must be a **mounted directory, not a mounted
file**: saves write a temp file and rename over the target, and rename fails
against a bind-mounted file. Set `S3_BUCKET` and `STATE_DIR` is ignored
entirely; see [Where the state lives](#where-the-state-lives).

```bash
mkdir -p state/data
cp config.json state/
cp data/*.json state/data/
docker compose up -d --build
```

The compose file publishes on `127.0.0.1` only and expects `tailscale serve` or
a reverse proxy in front of it, so the port is never open on a public interface.

### Serving under a path prefix

Every asset and API reference is **relative** (`styles.css`, `api/state`), not
root-absolute, so the app works at `/` or under a prefix like `/finances`. Two
conditions have to hold:

1. The proxy **strips** the prefix — Caddy's `handle_path`, not `handle`. The
   server matches exact paths (`pathname === '/api/state'`) and joins the
   pathname onto `public/`, so it must receive unprefixed requests.
2. The prefix **redirects to a trailing slash**. Relative URLs resolve against
   the current directory: at `/finances/` they become `/finances/styles.css`, but
   at `/finances` they become `/styles.css` and miss the route entirely.

```caddyfile
redir /finances /finances/
handle_path /finances/* {
	reverse_proxy 127.0.0.1:4174
}
``` The container runs
as uid 1000, so `state/` must be writable by that uid:

```bash
sudo chown -R 1000:1000 state
```

Then on the host:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 4174
```

That publishes it at `https://<hostname>.<tailnet>.ts.net` with a real
certificate, reachable from any device on the tailnet and nowhere else. Never use
`tailscale funnel` here — that puts it on the public internet, and the app has no
login.

**Browser DNS-over-HTTPS breaks tailnet names.** MagicDNS lives in the system
resolver; a browser doing its own DoH bypasses it and never sees the tailnet.
In Chrome this shows up as `ERR_BLOCKED_BY_CLIENT` on subresources while the
page itself loads — which looks exactly like an ad blocker and is not. Turn off
Settings → Privacy → Security → **Use secure DNS** on any machine that reaches
the app by its `.ts.net` name.

## Linking to a section

Every section has a fragment, so a link can point at one directly:

```
https://<host>/finances/#log-spending
```

The fragment names the **section**, not the tab. Which tab it lives in is
looked up rather than spelled out, so a link never has to state both and can
never state them inconsistently — `#log-spending` opens the Budget tab and
scrolls there on its own. The `?view=` in the URL is filled in afterwards, so
what you copy out of the address bar carries both and still works if the
section moves to another tab later.

| Tab | Fragments |
|---|---|
| **Budget** | `#this-period` `#burndown` `#log-spending` `#surprise-bills` `#waterfall` `#pace` `#close-period` |
| **Expenses** | `#total-expenses` `#committed-bills` `#sinking-funds` `#spending-targets` `#planned-savings` `#pay-calendar` |
| **Assets** | `#what-you-have` `#long-term-progress` `#composition` `#events` `#accounts` `#contributions` `#reconciliation` |
| **Projections** | `#where-the-plan-lands` `#savings-trajectory` `#emergency-recovery` `#buffer-trajectory` `#mortgage-principal` `#projection-assumptions` |
| **Mortgage** | `#loan-details` `#payment-curves` `#cliffs` `#comparison` `#mortgage-assumptions` |
| **Investments** | `#tickers` `#performance` `#watchlist` |

Hovering a section heading reveals a `#` link to it; following that puts the
section's URL in the address bar, which is where it can be copied from.

The fragment is a `data-anchor` attribute on the section, deliberately **not**
its `id`. Ids here are wiring that CSS grid rules and render code reach for, and
renaming one should not quietly break a link written down months ago. To add a
section, give it `data-anchor="some-slug"` — the heading link and the routing
pick it up with no further wiring.

Two edges worth knowing. An unrecognised fragment is dropped rather than left on
display, the same way an unrecognised `?view=` falls back to the budget. And a
section that hides itself — the emergency block outside recovery, the cliffs
table when there are no cliffs — opens its tab but does not scroll, since there
is nothing there to scroll to.

## Investments

A watchlist, not a portfolio: prices for the things worth keeping an eye on,
with nothing about how many of them you own. Balances stay on the Assets tab,
entered at period close, and the two never mix.

The tab is three sections. **Tickers** is one card per symbol — price, the
change over the selected range, and a sparkline of it — grouped however the
watchlist groups them. **Performance** draws every symbol on one chart, each
rebased to zero at the start of the range, so an ETF at $770 and a coin at
$80,000 can share an axis; click a card, or a legend entry, to read one
symbol on its own in price terms. Drag across the chart to read it at a
moment: on one symbol that is its price and the time, labelled on the line;
on the comparison it is the same fraction of each line's window — a
different moment per symbol, which the legend spells out beside each figure.
Double-click, or *Back to latest*, lets go. **Watchlist** at the bottom is the config:
groups, with a name and a comma-separated list of symbols each, saved to
`config.json` like every other edit.

```json
"investments": {
  "refreshSeconds": 60,
  "groups": [
    { "name": "Index", "symbols": ["SPY", "VFIAX", "EEM"] },
    { "name": "Alternatives", "symbols": ["GLD", "BTC"] }
  ]
}
```

Symbols are Yahoo Finance tickers, which covers stocks, ETFs, mutual funds
and crypto in one namespace: `BRK-B`, `^GSPC`, `EURUSD=X`, `GC=F` all work.
One rule is applied on top. A bare crypto ticker — `BTC`, `ETH`, and the rest
of the majors — is read as the coin against the dollar, because on Yahoo
`BTC` itself is a Grayscale ETF and nobody typing it into a watchlist means
that. Write `BTC-USD` or `BTC-EUR` to say exactly what you want; write the
ETF's own name to reach it.

The ranges are 24h, 1W, 1M, 3M, 1Y, 3Y and 10Y. Two things about them are
worth knowing. **24h is the latest session** for anything exchange-traded:
on a Sunday that is Friday, and the change is against the previous close, the
way a ticker conventionally reads it. And on the comparison chart, each line
is drawn across **its own window** rather than a shared clock — a coin trades
through the weekend and an ETF does not, and on one clock the two would sit a
day apart with nothing between them. The single-symbol view has one window
and gets a real time axis.

The page polls while the tab is open and the window is visible, at
`refreshSeconds`; a tab left in the background stops, and fetches the moment
it is looked at again. A mutual fund prints once a day, so its 24h sparkline
is a single point and stays blank.

### Where the prices come from

The server reads Yahoo's chart endpoint, `query1.finance.yahoo.com/v8/finance/chart`,
which needs no key. It is unofficial — the same endpoint every free finance
library uses — so everything that could change about it lives in one file,
[`lib/quotes.js`](lib/quotes.js): the URL, the range table, and the mapping
from its response to the flat shape the page draws. The browser never talks
to Yahoo directly.

Answers are cached per symbol and range, for a TTL that grows with the range:
45 seconds for intraday, an hour for a decade. A page polling every minute
and a widget on a phone add up to one upstream call per symbol per TTL
between them, and a symbol Yahoo has never heard of is remembered as such,
so a typo does not hit upstream once a minute until it is fixed. When Yahoo
cannot be reached, the last good answer is served and marked `stale`, the
same way the widgets treat a lost tailnet.

```bash
curl -s 'http://127.0.0.1:4174/api/quotes?symbols=SPY,NVDA,BTC&range=1w'
```

`symbols` left out means the whole watchlist. Each quote carries `price`,
`change` and `changePct` against the previous close, `rangeChange` and
`rangeChangePct` over the window asked for, and `points` as `[t, v]` pairs
thinned to a drawing budget. A symbol that failed carries `error` and the
rest come back whole — a watchlist is not all-or-nothing.

## iPhone widgets

`scriptable/burndown-widget.js` draws the burndown on the home screen, in the
same colours as the page, and opens the budget view in Chrome when tapped. It
runs in [Scriptable](https://scriptable.app).

The phone does no arithmetic. `GET api/widget/burndown` runs the same
`model.js` the page runs and returns the finished chart as figures, so the
widget cannot drift from the chart it mirrors:

```bash
curl -s 'http://127.0.0.1:4174/api/widget/burndown?today=2026-08-29'
```

`series` is the stacking order, bottom-up, ending in the unplanned cushion, and
each point's `v` lines up with it index for index. Bands arrive clamped at
empty, exactly as the page clamps them — an overspent category has already
handed its overspend to the cushion, so drawing it negative would count the same
money twice. What the cushion is overdrawn by rides in `o`, to be drawn below
the axis, and `c` is that day's pace level — the whole period's money in equal
daily shares — which the widget draws as the same reference line the page
draws.

`today` is the **phone's** local date. The server is very likely on UTC, and a
UTC reading dates evening spending a day forward, which would step the widget's
notion of today a day ahead of the browser's. A missing or malformed value falls
back to the server's own date rather than returning an error to a home-screen
widget.

The endpoint is read-only and no more protected than the rest of the app —
everything in it is already readable at `/api/state`, and the whole thing is
reachable only from the tailnet. Its one write-adjacent case is a period that
has been closed without the page being loaded since: rather than create the next
period the way the browser does, it returns what the app *would* open, marked
`provisional`, and the widget says so.

To install: paste the script into a new Scriptable script named **Burndown**,
add a Scriptable widget to the home screen, and set *Script* to it and *When
Interacting* to *Run Script*. Set `BASE` at the top of the file to your own
`.ts.net` URL. The Tailscale app has to be connected for the widget to refresh;
when it is not, the widget shows the last good figures with a `stale` mark
rather than an error.

Medium is the size to use — it fits the full stack. Small drops to the total
alone, since nine bands in 155 points is a smear, and large adds a legend.

### Tickers

`scriptable/tickers-widget.js` puts a row of tickers on the home screen:
symbol, price, the change over a range, and a sparkline of it. The widget
**parameter** is the symbols to show, comma-separated, and takes an optional
range token:

```
SPY, NVDA, BTC, GLD
SPY, NVDA, BTC @1w
```

The token is one of `1d` (the default), `1w`, `1m`, `3m`, `1y`, `3y`, `10y`,
with or without the `@`. Left empty, the parameter means the watchlist
configured on the page. Two widgets with two parameters are two lists, each
with its own offline fallback.

Small holds three rows, medium five with sparklines, large eleven. Tapping
opens the Investments tab. It reads `api/widget/tickers`, which is
`api/quotes` with the points thinned further and the page's accent colour
attached, and which goes through the same cache — a widget refreshing on the
phone and a tab open on a laptop cost one upstream call between them.

```bash
curl -s 'http://127.0.0.1:4174/api/widget/tickers?symbols=SPY,BTC&range=1d'
```

Install it the same way as the others — a Scriptable script named
**Tickers**, `BASE` set to your own `.ts.net` URL — and set *Parameter* in the
widget's settings to the symbols.

## Tests

```bash
npm test
```

No install step — the suite runs on `node:test`, which ships with Node, so the
project still has no dependencies. Every test builds its own state in a
temporary directory from `example/`, and the server tests spawn the server with
`S3_BUCKET` explicitly emptied, so running them can never read or write real
state on a machine that is configured against a bucket.

The suite is mostly a record of things that have actually gone wrong:

| | |
|---|---|
| `test/paydates.test.js` | The 10th/25th rule, the holiday walk-back, and the deposit landing the business day *before* the pay date. Also that every day of a year falls in exactly one period — a gap loses a day's spending, an overlap files it twice |
| `test/model.test.js` | For nine shapes of period: bands plus cushion equals the total, no band goes negative, and **nothing in the projection increases** — a burndown that goes up is money appearing from nowhere. Plus that a surprise bill never borrows from the planned pool, and that the chart's total agrees with the period settlement |
| `test/store.test.js` | SigV4 against both of AWS's published vectors, and the conditional writes: create-once, refuse a stale token, and sixteen concurrent writers with nothing clobbered |
| `test/server.test.js` | Seeding an empty store, the 409 on a stale client, twelve simultaneous period writes all surviving, and that a request cannot climb out of `public/`. The quote routes run against a stub upstream started by the test, so the suite never depends on a market being open |
| `test/quotes.test.js` | That `BTC` means the coin and `BTC-USD` typed beside it is not a second card; that the 24h change is against the previous close and not the first intraday print; that one bad symbol does not take the watchlist down; and that the cache holds for the TTL, shares one in-flight request, and serves the last good answer marked stale when upstream is gone |

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs it on Node 18,
20 and 22 — the floor the tests claim and the version the container ships. A
second job checks what the tests cannot: that `config.json` and `data/` are
still untracked, that nothing resembling a credential or a tailnet hostname has
been committed, and that the example figures still read as made up.

## Files

| | |
|---|---|
| `config.json` | Pay schedule, income, expenses, accounts, buckets, waterfall, rules |
| `data/periods.json` | Every period; the open one holds the live draft |
| `public/paydates.js` | Federal holidays and the 10th/25th rule |
| `public/model.js` | All arithmetic, no DOM |
| `public/app.js` | Views and charts |
| `lib/store.js` | State on disk or in a bucket, and the conditional writes |
| `example/` | Stub data, seeded into an empty store on first run |
| `test/` | The suite, run by `npm test` |
| `deploy/iam-policy.json` | The least the app's S3 credentials can get away with |
| `scriptable/burndown-widget.js` | The iPhone home-screen widget |

Periods are upserted by id, so a bug in the open period cannot take closed
history with it, and closed periods refuse to be overwritten. What keeps two
writers from losing each other's edits is in
[Two instances, one bucket](#two-instances-one-bucket).

## Mortgage

The refinance calculator from `refi_calc`, ported in as a fourth tab. It answers
how far the principal has to come down before a new loan costs less each month,
given that the rate you are offered steps down at loan-to-value boundaries.

`config.mortgage` holds the loan, the refinance terms, the horizon, and the LTV
pricing tiers. All of it is editable in the Assumptions panel.

`config.sources` maps a dot path to a live provider — `fred` for the Freddie Mac
weekly 30-year average (needs `FRED_API_KEY` in `.env`), `http` for any JSON
endpoint, `file` for a JSON file another script keeps fresh.

Live lookups run the **first time the Mortgage tab is opened**, not on page load:
FRED sits behind an 8-second timeout and the other three tabs have no use for the
rate, so they render immediately. One attempt per session — a failure does not
retry on every render — and the Refresh sources button retries on demand.
Anything that fails falls back to the value in `config.json` and reports the
reason rather than breaking the page.

Note that a successful lookup writes the fetched value into the in-memory config,
so the next save persists it to `config.json`. The stored figure is therefore a
cache of the last rate fetched, not a number you set.

The calculator lives in `public/mortgage.js` as a single module. The standalone
version used bare globals — `state`, `fmt`, `$`, `el` — all of which the budget
app already owns, so everything is closed over and only `Mortgage.setConfig`,
`.wire` and `.render` are exposed.

## Historical data

`data/history.json` holds 228 balance snapshots from March 2016 to August 2026,
predating the app. It is read-only and drives the long-term progress chart.

The `Stock` column in the source blended both E*Trade accounts. It was split
using four stated robo balances — $5,500 at opening (Feb 2024, transferred in
from the self-managed account), $23,411.43 (Feb 2025), $33,551.72 (May 2025), and
today's 63.9% share — with linear interpolation between them. The self-managed
account is the remainder, so the pair always sums to the recorded figure exactly.
It therefore absorbs all of the blended column's volatility plus any
interpolation error: trust its trend, not its period-to-period moves.

`events` marks movements that change balances without being saving or spending —
equity vests, the home purchase, transfers between accounts. Without them the
June 2021 vest would read as a $170,538 contribution.

## Known gaps

- **The sinking fund account holds $0** against $192.30 it should already hold.
  The Expenses view shows the per-bill top-up needed to get back on schedule.
- **Trajectories and residuals need history.** The buffer projection runs on
  `rules.expectedOneOffPerPeriod` until about six closed periods exist.
- **Bucket balances are derived**, not snapshotted — opening allocation plus
  contributions since, less anything drawn against them.
- `sources` in `config.json` is the seam for pulling the mortgage recast target
  from refi_calc rather than retyping it.
