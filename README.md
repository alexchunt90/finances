# Finances

A local, single-user budgeting and mortgage app. Goal: **save more each pay period.**

Same shape as `refi_calc` — no dependencies, no build step, all arithmetic in the
browser — so the two can merge later.

```bash
node server.js
```

Then open http://127.0.0.1:4174. It also listens on every interface, so it is
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

## Running on a server

`STATE_DIR` points at the writable state — `config.json` plus `data/`. It
defaults to the project directory, so a checkout needs no configuration. In a
container it must be a **mounted directory, not a mounted file**: saves write a
temp file and rename over the target, and rename fails against a bind-mounted
file.

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

## Files

| | |
|---|---|
| `config.json` | Pay schedule, income, expenses, accounts, buckets, waterfall, rules |
| `data/periods.json` | Every period; the open one holds the live draft |
| `public/paydates.js` | Federal holidays and the 10th/25th rule |
| `public/model.js` | All arithmetic, no DOM |
| `public/app.js` | Views and charts |

Writes go through a temp file and a rename, and periods are upserted by id, so a
bug in the open period cannot take closed history with it. Closed periods refuse
to be overwritten.

`config.json` and each period carry a `version` that increments on every write.
A client echoes back the version it loaded; if the file has moved on since, the
server returns **409** with the current state rather than letting a stale tab
overwrite whoever wrote first. The browser reports the conflict, reloads from
disk, and tells you the unsaved edit was dropped — losing one edit is better than
silently losing someone else's. This is what makes it safe to open the app on
more than one device.

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
