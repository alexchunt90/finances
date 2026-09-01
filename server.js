'use strict';

/* ---------------------------------------------------------------------------
 * Finances — a local, single-user budgeting and mortgage app.
 *
 * Same shape as refi_calc: no dependencies, no build step, all arithmetic in
 * the browser. The server hands over stored state and writes it back.
 *
 * The one place it deliberately diverges is writes. refi_calc rewrites a single
 * settings blob; here, `data/periods.json` is history that only grows, so
 * writes go through a temp file and a rename, and a period is upserted by id
 * rather than the whole array being replaced. A bug in the open period can then
 * never take closed periods down with it.
 * ------------------------------------------------------------------------- */

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// The browser's arithmetic, reused verbatim. model.js reads `PayDates` off the
// global scope — in the browser both files are plain scripts sharing one — so
// it has to be planted there before model.js is loaded. Requiring the same
// files the page loads is the point: the widget must not drift from the chart
// it mirrors, and a second implementation would.
global.PayDates = require('./public/paydates.js');
const Model = require('./public/model.js');
const PayDates = global.PayDates;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_PATH = path.join(ROOT, '.env');

// --- .env -------------------------------------------------------------------
// Node 18 has no --env-file. A missing .env is fine; the real environment wins.

function loadEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv(ENV_PATH);

// Where the writable state lives. Defaults to the project directory, which is
// the layout when running from a checkout. Point STATE_DIR at a mounted volume
// to run in a container — note that writes go through a temp file and a rename,
// which fails against a bind-mounted *file*, so this must be a directory.
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : ROOT;
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const DATA_DIR = path.join(STATE_DIR, 'data');
const PERIODS_PATH = path.join(DATA_DIR, 'periods.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const AMORTIZATION_PATH = path.join(DATA_DIR, 'amortization.json');

const PORT = Number(process.env.PORT || 4174);

// Listens on every interface so the app is reachable from a phone on the same
// network, or over a Tailscale/WireGuard link. There is no authentication, so
// anyone who can reach the port can read and rewrite everything — set
// HOST=127.0.0.1 in .env to go back to this machine only.
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- storage ----------------------------------------------------------------

/**
 * Write via a sibling temp file and rename. On the same filesystem the rename
 * is atomic, so an interrupted save leaves the previous file intact rather than
 * a half-written one. Losing a period of history to a truncated write would be
 * unrecoverable by hand.
 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

const readConfig = () => readJson(CONFIG_PATH);
const readPeriods = () => readJson(PERIODS_PATH, []);
// Balance snapshots predating the app. Read-only; edited by hand or by import.
const readHistory = () => readJson(HISTORY_PATH, { snapshots: [], events: [] });
// The servicer's amortization schedule, converted from their PDF once. Read
// only — the schedule is a fact about the loan, not state the app edits.
const readAmortization = () => readJson(AMORTIZATION_PATH, { payments: [] });

// ---------------------------------------------------------------------------
// Outside parameter sources, carried over from refi_calc.
//
// Each entry in config.sources maps a dot path (e.g. "mortgage.refinance.baseRate")
// to a provider. Anything that throws is reported to the browser as a non-fatal
// problem and the value stored in config.json is used instead, so the app is
// always usable offline.
// ---------------------------------------------------------------------------

const providers = {
  // Freddie Mac weekly average 30-year fixed rate, via FRED.
  async fred(spec) {
    const key = process.env[spec.apiKeyEnv || 'FRED_API_KEY'];
    if (!key) throw new Error(`missing env var ${spec.apiKeyEnv || 'FRED_API_KEY'}`);
    const series = spec.series || 'MORTGAGE30US';
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(key)}` +
      `&file_type=json&sort_order=desc&limit=1`;
    const json = await getJson(url);
    const obs = json.observations && json.observations[0];
    if (!obs || obs.value === '.') throw new Error(`no observation for ${series}`);
    return { value: Number(obs.value), asOf: obs.date, label: `FRED ${series}` };
  },

  // Any JSON endpoint. `path` is a dot path into the response.
  async http(spec) {
    if (!spec.url) throw new Error('http source needs a url');
    const headers = spec.headersEnv && process.env[spec.headersEnv]
      ? JSON.parse(process.env[spec.headersEnv])
      : {};
    const json = await getJson(spec.url, headers);
    const value = Number(dig(json, spec.path));
    if (!Number.isFinite(value)) throw new Error(`no number at path "${spec.path}"`);
    return {
      value,
      asOf: spec.asOfPath ? dig(json, spec.asOfPath) : new Date().toISOString().slice(0, 10),
      label: spec.label || new URL(spec.url).hostname,
    };
  },

  // A local JSON file some other script keeps fresh.
  async file(spec) {
    const abs = path.resolve(ROOT, spec.file || spec.path_);
    const json = JSON.parse(await fsp.readFile(abs, 'utf8'));
    const value = Number(dig(json, spec.path));
    if (!Number.isFinite(value)) throw new Error(`no number at path "${spec.path}"`);
    const stat = await fsp.stat(abs);
    return {
      value,
      asOf: spec.asOfPath ? dig(json, spec.asOfPath) : stat.mtime.toISOString().slice(0, 10),
      label: spec.label || path.basename(abs),
    };
  },
};

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function dig(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const idx = Number(key);
    return Array.isArray(acc) && Number.isInteger(idx) ? acc[idx] : acc[key];
  }, obj);
}

function setPath(obj, dotPath, value) {
  const keys = dotPath.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => (acc[key] = acc[key] || {}), obj);
  target[last] = value;
}

// A source may need a spread applied — the national average plus whatever
// margin your lender actually quotes over it.
function applyAdjustment(value, spec) {
  let out = value;
  if (Number.isFinite(spec.multiply)) out *= spec.multiply;
  if (Number.isFinite(spec.add)) out += spec.add;
  return Math.round(out * 1e6) / 1e6;
}

/** Resolves every source into `config`, returning what came from where. */
async function resolveSources(config, live) {
  const meta = {};
  const problems = [];
  for (const [field, spec] of Object.entries(config.sources || {})) {
    const stored = dig(config, field);
    const fallback = { value: stored, label: 'saved in config.json', asOf: null, live: false };
    if (!live || !spec.provider || spec.provider === 'manual' || !providers[spec.provider]) {
      if (live && spec.provider && spec.provider !== 'manual' && !providers[spec.provider]) {
        problems.push(`${field}: unknown provider "${spec.provider}"`);
      }
      meta[field] = fallback;
      continue;
    }
    try {
      const result = await providers[spec.provider](spec);
      const value = applyAdjustment(result.value, spec);
      setPath(config, field, value);
      meta[field] = { value, label: result.label, asOf: result.asOf || null, live: true };
    } catch (err) {
      problems.push(`${field}: ${err.message}`);
      meta[field] = fallback;
    }
  }
  return { meta, problems };
}

// --- widget API -------------------------------------------------------------
//
// One read-only endpoint for the iPhone home-screen widget. The phone cannot
// run the page, so the server runs the same model.js the page runs and hands
// back the finished burndown — figures, not pixels, so the widget can draw at
// whatever size iOS gives it.
//
// It is deliberately no more protected than the rest: everything here is
// already readable at /api/state, and the whole app is reachable only from the
// tailnet. Putting a token on this route alone would buy nothing.

/** The open period, or a provisional one if the last close has not been followed
 *  by a page load yet. Never written — the browser owns period creation, and a
 *  widget refresh must not make history. */
function openPeriodFor(config, periods, todayISO) {
  const open = periods.find((p) => p.status !== 'closed');
  if (open) return { period: open, provisional: false };
  const sched = PayDates.periodContaining(todayISO);
  return {
    provisional: true,
    period: {
      id: sched.id,
      start: sched.start,
      scheduledEnd: sched.scheduledEnd,
      status: 'open',
      closedOn: null,
      takeHome: config.income.takeHomePerPeriod,
      spending: [], oneOffs: [], flows: [], balances: {},
    },
  };
}

/** Last closed snapshot, falling back to the opening balances in config —
 *  the same rule the page uses. */
function latestBalancesFor(config, periods) {
  const closed = periods
    .filter((p) => p.status === 'closed')
    .sort((a, b) => a.start.localeCompare(b.start));
  const last = closed[closed.length - 1];
  if (last && last.balances && Object.keys(last.balances).length) return last.balances;
  const out = {};
  for (const [k, v] of Object.entries(config.openingBalances || {})) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The burndown, flattened for a widget.
 *
 * `series` is the stacking order, bottom-up, ending in the unplanned cushion,
 * and each point's `v` lines up with it index for index. Bands are clamped at
 * empty exactly as the page clamps them — an overspent category has already
 * handed its overspend to the cushion, so drawing it negative would count the
 * same money twice. What the cushion is overdrawn by rides in `o` instead, to
 * be drawn below the axis. `c` is that day's pace level — the whole period's
 * money in equal daily shares — which the widget draws as the same reference
 * line the page draws.
 */
function widgetBurndown(config, periods, todayISO) {
  const { period, provisional } = openPeriodFor(config, periods, todayISO);
  const days = Model.periodDays(period, todayISO);
  const balances = latestBalancesFor(config, periods);
  const wf = Model.waterfall(config, { days: days.projected, balances });
  const bd = Model.burndown(config, period, wf, todayISO);

  const warm = config.theme?.warmPalette || ['#6E3410', '#AC601A', '#C67C1F', '#D4AF37', '#E4C86A'];
  const cool = (config.theme?.coolPalette || ['#2F6285'])[1] || '#2F6285';
  const series = bd.rows
    .map((r, i) => ({ id: r.id, name: r.name, color: warm[i % warm.length] }))
    .concat([{ id: '__unplanned', name: 'Unplanned', color: cool }]);

  // points[todayDay] is the state *after* today's logged spending — what is
  // left right now, not what was left this morning.
  const now = bd.points[Math.min(bd.todayDay, bd.points.length - 1)] || bd.points[0];
  for (const sr of series) {
    sr.left = sr.id === '__unplanned'
      ? Model.round2(Math.max(0, now.unplanned))
      : Model.round2(now.values[sr.id] || 0);
  }

  return {
    asOf: todayISO,
    generatedAt: new Date().toISOString(),
    // True when no open period is stored and this is what the app *would*
    // open. The widget says so rather than presenting a guess as a reading.
    provisional,
    period: {
      id: period.id,
      start: period.start,
      scheduledEnd: period.scheduledEnd,
      day: bd.todayDay,
      days: bd.n,
      remaining: days.remaining,
      late: days.late,
    },
    startTotal: bd.startTotal,
    leftNow: Model.round2(now.total),
    endTotal: bd.endTotal,
    endOverrun: bd.endOverrun,
    overrun: Model.round2(now.overrun),
    // What the days still to come can absorb. Zero once the stack is gone,
    // rather than a negative allowance nobody can spend to.
    perDay: Model.round2(Math.max(0, now.total) / Math.max(1, days.remaining)),
    runsOutDay: bd.runsOutDay,
    // A projection off two days of noise is not worth drawing conclusions
    // from; the widget dims its verdict when this is false.
    reliable: bd.reliable,
    accent: config.theme?.accent || '#D4AF37',
    series,
    points: bd.points.map((pt) => ({
      d: pt.day,
      p: pt.projected,
      v: series.map((sr) => (sr.id === '__unplanned'
        ? Model.round2(Math.max(0, pt.unplanned))
        : Model.round2(pt.values[sr.id] || 0))),
      o: pt.overrun,
      c: pt.pace,
    })),
  };
}

/**
 * The Assets tab's composition chart, as a payload a home-screen widget can
 * draw. Same shape as widgetBurndown: the server does the arithmetic so the
 * widget can never disagree with the page it mirrors.
 *
 * Snapshots are thinned to a drawing budget. A decade of them is more points
 * than a phone-sized chart can resolve, and shipping all of them over a
 * tailnet on every widget refresh costs more than it shows. The most recent
 * snapshot is always kept exactly — it is the one the headline figures quote.
 */
function widgetComposition(config, history, todayISO, maxPoints = 160) {
  const snaps = (history.snapshots || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const series = Model.compositionSeries(config);
  if (!snaps.length) {
    return { asOf: todayISO, generatedAt: new Date().toISOString(), empty: true, series: [], points: [] };
  }

  const stride = Math.max(1, Math.ceil(snaps.length / maxPoints));
  const kept = snaps.filter((_, i) => i % stride === 0);
  if (kept[kept.length - 1] !== snaps[snaps.length - 1]) kept.push(snaps[snaps.length - 1]);

  const latest = snaps[snaps.length - 1];
  const valueAt = (sn, id) => Model.round2(sn.balances[id] || 0);
  const groupTotal = (sn, group) =>
    Model.round2(series.filter((sr) => sr.group === group).reduce((a, sr) => a + valueAt(sn, sr.id), 0));
  const total = (sn) => Model.round2(series.reduce((a, sr) => a + valueAt(sn, sr.id), 0));

  // A year back, for the one line worth reading. Nearest snapshot on or before
  // the anniversary — the history is not evenly spaced, so an index offset
  // would mean different spans at different points in the file.
  const yearAgoISO = PayDates.iso(PayDates.parse(latest.date) - 365 * PayDates.DAY);
  let yearAgo = null;
  for (const sn of snaps) if (sn.date <= yearAgoISO) yearAgo = sn;

  for (const sr of series) sr.value = valueAt(latest, sr.id);

  return {
    asOf: todayISO,
    generatedAt: new Date().toISOString(),
    empty: false,
    accent: config.theme?.accent || '#D4AF37',
    latest: {
      date: latest.date,
      total: total(latest),
      liquid: groupTotal(latest, 'Liquid'),
      illiquid: groupTotal(latest, 'Illiquid'),
    },
    // Null when the history does not reach back a year yet, which the widget
    // says rather than quoting a change over an unknown span.
    yearAgo: yearAgo ? { date: yearAgo.date, total: total(yearAgo) } : null,
    span: { from: snaps[0].date, to: latest.date, snapshots: snaps.length, plotted: kept.length },
    series,
    points: kept.map((sn) => ({ t: sn.date, v: series.map((sr) => valueAt(sn, sr.id)) })),
  };
}

// --- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // Everything the browser needs to render, in one round trip.
    if (pathname === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      const [config, periods, history, amortization] = await Promise.all([
        readConfig(), readPeriods(), readHistory(), readAmortization(),
      ]);
      // Live lookups are opt-in so the ordinary page load never waits on a
      // network call; the Mortgage tab's refresh button asks for them.
      const live = url.searchParams.get('live') === '1';
      const { meta, problems } = await resolveSources(config, live);
      return json(res, 200, { config, periods, history, amortization, meta, problems });
    }

    // Everything an iPhone widget needs to draw the burndown, in one small
    // payload. `today` is the *phone's* local date: the server may well be on
    // UTC, and paydates.js is explicit that a UTC reading dates evening
    // spending a day forward. A malformed value falls back to the server's own
    // date rather than 400ing a home-screen widget into an error card.
    if (pathname === '/api/widget/burndown' && (req.method === 'GET' || req.method === 'HEAD')) {
      const asked = url.searchParams.get('today');
      const todayISO = asked && ISO_DATE.test(asked) ? asked : PayDates.todayISO();
      const [config, periods] = await Promise.all([readConfig(), readPeriods()]);
      return json(res, 200, widgetBurndown(config, periods, todayISO));
    }

    if (pathname === '/api/widget/composition' && (req.method === 'GET' || req.method === 'HEAD')) {
      const asked = url.searchParams.get('today');
      const todayISO = asked && ISO_DATE.test(asked) ? asked : PayDates.todayISO();
      const [config, history] = await Promise.all([readConfig(), readHistory()]);
      return json(res, 200, widgetComposition(config, history, todayISO));
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      const current = await readConfig();

      // Optimistic concurrency. The client echoes back the version it loaded;
      // if the file has moved on since, another writer got there first and this
      // request would silently overwrite them. Reject instead, and hand back
      // the current state so the client can reload rather than guess.
      const held = Number(current.version) || 0;
      const sent = Number(incoming.version) || 0;
      if (sent !== held) {
        return json(res, 409, {
          error: `config was changed elsewhere (you have v${sent}, the file is v${held})`,
          version: held,
          config: current,
        });
      }

      // `sources` is hand-edited in the file, not through the UI.
      const merged = { ...current, ...incoming, sources: current.sources, version: held + 1 };
      await writeJsonAtomic(CONFIG_PATH, merged);
      return json(res, 200, { saved: true, version: merged.version });
    }

    // Events are annotations on the history — a vest liquidated, a down payment
    // — hand-added through the Assets tab. Snapshots are not writable here:
    // those arrive at period close, and a stale tab must not rewrite a decade
    // of balances on its way to adding a note.
    if (pathname === '/api/history/events' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(incoming.events)) return json(res, 400, { error: 'events must be an array' });
      const current = await readHistory();

      const held = Number(current.version) || 0;
      const sent = Number(incoming.version) || 0;
      if (sent !== held) {
        return json(res, 409, {
          error: `history was changed elsewhere (you have v${sent}, the file is v${held})`,
          version: held,
          history: current,
        });
      }

      const merged = { ...current, events: incoming.events, version: held + 1 };
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await writeJsonAtomic(HISTORY_PATH, merged);
      return json(res, 200, { saved: true, version: merged.version });
    }

    // Upsert one period. The browser owns period identity and all arithmetic.
    const periodMatch = pathname.match(/^\/api\/periods\/([\w-]+)$/);
    if (periodMatch && req.method === 'PUT') {
      const id = periodMatch[1];
      const incoming = JSON.parse(await readBody(req) || '{}');
      if (incoming.id !== id) return json(res, 400, { error: 'id mismatch' });

      const periods = await readPeriods();
      const existing = periods.findIndex((p) => p.id === id);
      const stored = existing === -1 ? null : periods[existing];

      // A closed period is history. Refuse to overwrite one, so a stale tab
      // cannot silently rewrite totals you already reconciled.
      if (stored && stored.status === 'closed' && incoming.status !== 'closed') {
        return json(res, 409, { error: `period ${id} is closed`, period: stored });
      }

      // The open period gets the same version check as config: two devices
      // logging spending at once would otherwise clobber each other.
      const held = stored ? Number(stored.version) || 0 : 0;
      const sent = Number(incoming.version) || 0;
      if (stored && sent !== held) {
        return json(res, 409, {
          error: `period ${id} was changed elsewhere (you have v${sent}, the file is v${held})`,
          version: held,
          period: stored,
        });
      }
      incoming.version = held + 1;

      if (existing === -1) periods.push(incoming);
      else periods[existing] = incoming;

      periods.sort((a, b) => a.start.localeCompare(b.start));
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await writeJsonAtomic(PERIODS_PATH, periods);
      return json(res, 200, { saved: true, id, version: incoming.version });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    // HEAD is GET without a body. Proxies, health checks and uptime monitors
    // all use it, and rejecting it makes a working route look broken.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`config.json not found at ${CONFIG_PATH}`);
  process.exit(1);
}

/** Every non-internal IPv4 address, so the reachable URLs can be printed. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

server.listen(PORT, HOST, () => {
  console.log(`Finances → http://127.0.0.1:${PORT}`);
  if (HOST !== '127.0.0.1') {
    for (const address of lanAddresses()) {
      console.log(`         → http://${address}:${PORT}`);
    }
    console.log('Reachable from other devices on this network. No login — set HOST=127.0.0.1 to restrict.');
  }
  console.log(`Config:  ${path.relative(process.cwd(), CONFIG_PATH)}`);
  console.log(`History: ${path.relative(process.cwd(), PERIODS_PATH)}`);
});
