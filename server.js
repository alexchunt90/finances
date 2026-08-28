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

// --- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // Everything the browser needs to render, in one round trip.
    if (pathname === '/api/state' && req.method === 'GET') {
      const [config, periods, history] = await Promise.all([readConfig(), readPeriods(), readHistory()]);
      // Live lookups are opt-in so the ordinary page load never waits on a
      // network call; the Mortgage tab's refresh button asks for them.
      const live = url.searchParams.get('live') === '1';
      const { meta, problems } = await resolveSources(config, live);
      return json(res, 200, { config, periods, history, meta, problems });
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
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    return res.end(data);
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
