/* ==========================================================================
   Budget — views and wiring. All arithmetic lives in model.js.

   Only one period is ever open. Spending entered after the next deposit but
   before you close still lands on the open period, which is why proration uses
   the actual span rather than the scheduled one.
   ========================================================================== */

'use strict';

const VIEWS = ['budget', 'expenses', 'assets', 'projections', 'mortgage'];

// Which column each sortable table is ordered by. In memory only — a sort is a
// way of looking at the data, not a property of it.
const sorts = { committed: { col: 'perPeriod', key: 'perPeriod', dir: 'desc' } };
const state = { config: null, periods: [], history: { snapshots: [], events: [] }, view: 'budget' };

// --- formatting -------------------------------------------------------------

const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmt = {
  usd: (n) => money2.format(n || 0),
  usd0: (n) => money0.format(Math.round(n || 0)),
  bare: (n) => (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  signed: (n) => (n >= 0 ? '+' : '−') + money2.format(Math.abs(n || 0)),
  short: (n) => (Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`),
  day: (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${+d}`;
  },
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const uid = () => Math.random().toString(36).slice(2, 10);

// --- sorting ----------------------------------------------------------------

/**
 * Numbers compare numerically, booleans by truth, everything else by locale.
 * Ties fall back to name so the order never shuffles between renders.
 */
function compareBy(a, b, key) {
  const av = a[key], bv = b[key];
  let r;
  if (typeof av === 'boolean' || typeof bv === 'boolean') r = (av ? 1 : 0) - (bv ? 1 : 0);
  else if (typeof av === 'number' && typeof bv === 'number') r = av - bv;
  else r = String(av ?? '').localeCompare(String(bv ?? ''));
  return r;
}

function sortRows(rows, spec) {
  // Direction applies to the chosen column only. Reversing the finished array
  // would flip the name tie-break too, so equal rows would shuffle Z-A.
  const sign = spec.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * compareBy(a, b, spec.key) || compareBy(a, b, 'name'));
}

/** Marks the active column and points the arrow, for sighted and AT users alike. */
function paintSortHeaders(headId, spec) {
  for (const th of document.querySelectorAll(`#${headId} th[data-sort]`)) {
    let arrow = th.querySelector('.sort-arrow');
    if (!arrow) {
      arrow = el('span', 'sort-arrow');
      th.append(arrow);
    }
    if (th.dataset.col === spec.col) {
      th.setAttribute('aria-sort', spec.dir === 'asc' ? 'ascending' : 'descending');
      arrow.textContent = spec.dir === 'asc' ? '▲' : '▼';
    } else {
      th.removeAttribute('aria-sort');
      arrow.textContent = '';
    }
  }
}

function wireSortHeaders(headId, spec, onChange) {
  for (const th of document.querySelectorAll(`#${headId} th[data-sort]`)) {
    const activate = () => {
      const key = th.dataset.sort;
      const col = th.dataset.col;
      if (spec.col === col) {
        spec.dir = spec.dir === 'asc' ? 'desc' : 'asc';
      } else {
        spec.col = col;
        spec.key = key;
        // Text reads best A-Z; money and flags read best largest-first.
        spec.dir = key === 'name' || key === 'category' ? 'asc' : 'desc';
      }
      onChange();
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
    });
  }
}

// --- routing ----------------------------------------------------------------

/**
 * The visible tab lives in ?view= so a refresh, a bookmark, or a pasted link
 * lands where you left off. Anything unrecognised falls back to the budget
 * rather than rendering nothing.
 */
function viewFromUrl() {
  const asked = new URLSearchParams(location.search).get('view');
  return VIEWS.includes(asked) ? asked : 'budget';
}

function setView(view, { push = true } = {}) {
  state.view = VIEWS.includes(view) ? view : 'budget';
  const url = new URL(location.href);
  url.searchParams.set('view', state.view);
  if (url.href !== location.href) {
    history[push ? 'pushState' : 'replaceState']({ view: state.view }, '', url);
  }
  render();
}

// --- theme ------------------------------------------------------------------

/**
 * The accent is the one colour the app takes from config. Backgrounds and body
 * text are fixed in the stylesheet; this drives headlines, chart series, and
 * the primary button. A bad hex falls back rather than blanking the page.
 */
function hexToRgba(hex, alpha, fallback) {
  const raw = String(hex || '').trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function applyTheme(theme) {
  const DEFAULT = '#D4AF37';
  const accent = /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(theme?.accent || '').trim())
    ? String(theme.accent).trim().replace(/^#?/, '#')
    : DEFAULT;
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-wash', hexToRgba(accent, 0.16, 'rgba(212, 175, 55, 0.16)'));
  root.style.setProperty('--accent-dim', hexToRgba(accent, 0.55, 'rgba(212, 175, 55, 0.55)'));
}

// --- persistence ------------------------------------------------------------

let saveTimer = null;
const pending = new Set();

function status(text) { $('save-status').textContent = text; }

/** Debounced so typing in a table doesn't fire a request per keystroke. */
function queueSave(what) {
  pending.add(what);
  status('saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  const jobs = [...pending];
  pending.clear();
  try {
    for (const what of jobs) {
      if (what === 'config') {
        const res = await request('/api/config', 'PUT', state.config);
        state.config.version = res.version;
      } else {
        const period = state.periods.find((p) => p.id === what);
        if (period) {
          const res = await request(`/api/periods/${period.id}`, 'PUT', period);
          period.version = res.version;
        }
      }
    }
    status('saved');
    setTimeout(() => { if (!pending.size) status(''); }, 1600);
  } catch (err) {
    status('');
    if (err.status === 409) {
      notice(`${err.message}. Reloaded from disk — your last edit was not saved.`);
      await reloadState().catch(() => {});
    } else {
      notice(`Could not save: ${err.message}`);
    }
  }
}

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/**
 * Pull everything fresh and redraw. Used after a version conflict: another
 * device wrote first, so the safe move is to take their state rather than
 * merge two histories automatically.
 */
async function reloadState() {
  const payload = await request('/api/state', 'GET');
  state.config = payload.config;
  state.periods = payload.periods || [];
  state.history = payload.history || { snapshots: [], events: [] };
  applyTheme(state.config.theme);
  Mortgage.setConfig(state.config.mortgage, state.meta);
  render();
}

function notice(text) {
  const n = $('notice');
  if (!text) { n.hidden = true; return; }
  n.textContent = text;
  n.hidden = false;
}

// --- period access ----------------------------------------------------------

const today = () => PayDates.todayISO();

function makePeriod(dateISO) {
  const sched = PayDates.periodContaining(dateISO);
  return {
    id: sched.id,
    start: sched.start,
    scheduledEnd: sched.scheduledEnd,
    status: 'open',
    closedOn: null,
    takeHome: state.config.income.takeHomePerPeriod,
    spending: [],
    oneOffs: [],
    flows: [],
    balances: {},
  };
}

/** Exactly one open period, created on demand. */
function openPeriod() {
  let p = state.periods.find((x) => x.status !== 'closed');
  if (!p) {
    p = makePeriod(today());
    state.periods.push(p);
    queueSave(p.id);
  }
  return p;
}

const closedPeriods = () => state.periods.filter((p) => p.status === 'closed').sort((a, b) => a.start.localeCompare(b.start));
const lastClosed = () => closedPeriods().slice(-1)[0] || null;

/** Last closed snapshot, falling back to the opening balances in config. */
function latestBalances() {
  const last = lastClosed();
  if (last && last.balances && Object.keys(last.balances).length) return last.balances;
  const out = {};
  for (const [k, v] of Object.entries(state.config.openingBalances || {})) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

/**
 * Buckets are virtual, so their balances are derived: an opening allocation
 * plus everything contributed since, less anything drawn against them.
 */
function bucketBalances() {
  const cfg = state.config;
  const out = {};
  for (const b of cfg.buckets) out[b.id] = b.opening || 0;
  const n = closedPeriods().length;
  for (const s of cfg.expenses.sinking) {
    if (out[s.bucketId] != null) out[s.bucketId] = Model.round2(out[s.bucketId] + s.perPeriod * n);
  }
  for (const d of cfg.waterfall.longtermSplit || []) {
    if (out[d.bucketId] != null && d.perPeriod) {
      out[d.bucketId] = Model.round2(out[d.bucketId] + d.perPeriod * n);
    }
  }
  for (const p of state.periods) {
    for (const f of p.flows || []) {
      if (f.bucketId && out[f.bucketId] != null) {
        out[f.bucketId] = Model.round2(out[f.bucketId] - Math.abs(f.amount));
      }
    }
  }
  return out;
}

function context() {
  const period = openPeriod();
  const days = Model.periodDays(period, today());
  const balances = latestBalances();
  const wf = Model.waterfall(state.config, { days: days.projected, balances });
  const pace = Model.pace(state.config, period, today());
  return { period, days, balances, buckets: bucketBalances(), wf, pace };
}

/**
 * What is actually still spendable this period: take-home, less the bills, less
 * everything the plan sets aside, less what has already gone out. Unlike the
 * waterfall's unallocated figure this moves as spending is logged, and it goes
 * negative when the period has overrun.
 *
 * `savingsTotal` already contains the sinking contribution, so committed bills
 * are added on their own to avoid counting it twice.
 */
// The masthead figure is both pools together: everything still spendable.
function leftToSpend(cfg, period, wf, pace) {
  return Model.settle(cfg, period, wf, pace).totalLeft;
}

// --- charts -----------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function emptyChart(svg, label) {
  svg.replaceChildren();
  const t = svgEl('text', { x: 380, y: 130, 'text-anchor': 'middle', class: 'chart-empty' });
  t.textContent = label;
  svg.append(t);
}

/** Projection line with an optional dashed target and a zero rule. */
function lineChart(svg, points, { target = null, xLabel = 'periods ahead' } = {}) {
  svg.replaceChildren();
  if (!points.length) return emptyChart(svg, 'no data');

  const pad = { l: 62, r: 16, t: 14, b: 30 };
  const W = 760, H = 260;
  const values = points.map((p) => p.balance).concat(target != null ? [target, 0] : [0]);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);

  svg.append(svgEl('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, class: 'axis-line' }));

  for (const frac of [0, 0.5, 1]) {
    const v = lo + span * frac;
    const t = svgEl('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt.short(v);
    svg.append(t);
  }

  if (lo < 0 && hi > 0) svg.append(svgEl('line', { x1: pad.l, y1: y(0), x2: W - pad.r, y2: y(0), class: 'zero-line' }));
  if (target != null) {
    svg.append(svgEl('line', { x1: pad.l, y1: y(target), x2: W - pad.r, y2: y(target), class: 'target-line' }));
    const t = svgEl('text', { x: W - pad.r, y: y(target) - 6, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = `target ${fmt.short(target)}`;
    svg.append(t);
  }

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const base = y(Math.max(lo, 0));
  svg.append(svgEl('path', { d: `${line} L${x(points.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`, class: 'series-area' }));
  svg.append(svgEl('path', { d: line, class: 'series-line' }));

  for (const i of [0, Math.floor(points.length / 2), points.length - 1]) {
    const t = svgEl('text', { x: x(i), y: H - pad.b + 18, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = i === 0 ? 'now' : `+${points[i].period}`;
    svg.append(t);
  }
  const lbl = svgEl('text', { x: W - pad.r, y: H - 6, 'text-anchor': 'end', class: 'axis-text' });
  lbl.textContent = xLabel;
  svg.append(lbl);
}

function barChart(svg, bars) {
  svg.replaceChildren();
  if (!bars.length) return emptyChart(svg, 'no closed periods yet');

  const pad = { l: 62, r: 16, t: 14, b: 34 };
  const W = 760, H = 260;
  const hi = Math.max(...bars.map((b) => b.value), 0);
  const lo = Math.min(...bars.map((b) => b.value), 0);
  const span = hi - lo || 1;
  const bw = (W - pad.l - pad.r) / bars.length;
  const y = (v) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);

  svg.append(svgEl('line', { x1: pad.l, y1: y(0), x2: W - pad.r, y2: y(0), class: 'axis-line' }));
  for (const frac of [0, 0.5, 1]) {
    const v = lo + span * frac;
    const t = svgEl('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt.short(v);
    svg.append(t);
  }

  bars.forEach((b, i) => {
    const top = y(Math.max(b.value, 0));
    const h = Math.abs(y(b.value) - y(0));
    svg.append(svgEl('rect', {
      x: pad.l + i * bw + bw * 0.18, y: top,
      width: bw * 0.64, height: Math.max(1, h),
      class: `bar${b.value < 0 ? ' is-negative' : ''}`,
    }));
    if (i % Math.ceil(bars.length / 8) === 0) {
      const t = svgEl('text', { x: pad.l + i * bw + bw / 2, y: H - pad.b + 18, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = fmt.day(b.label);
      svg.append(t);
    }
  });
}

// --- budget view ------------------------------------------------------------

function renderBudget() {
  const cfg = state.config;
  const { period, days, balances, wf, pace } = context();
  const settlement = Model.settle(cfg, period, wf, pace);

  // Recovery banner
  const rb = $('recovery-banner');
  rb.hidden = !wf.inRecovery;
  if (wf.inRecovery) {
    const acct = cfg.accounts.find((a) => a.id === 'emergency');
    $('recovery-text').textContent =
      `The emergency fund is ${fmt.usd(acct.target - (balances.emergency || 0))} below target, so buffer, Roth, ` +
      `long-term and brokerage are cut ${cfg.rules.recoveryReductionPct}% and ${fmt.usd(wf.freed)} redirects to the ` +
      `emergency fund each period. Sinking funds are untouched.`;
  }

  // Per-day pace for whatever is left, over the days actually left.
  const perDay = (amount, id) => {
    const node = $(id);
    const rate = Model.round2(amount / days.remaining);
    node.classList.toggle('is-warn', amount < 0);
    // A negative pool has no daily allowance left, so the target is zero rather
    // than a negative rate nobody can spend to.
    node.textContent = amount < 0
      ? `$0 a day — already ${fmt.usd(-amount)} past it`
      : `${fmt.usd(rate)} a day for ${days.remaining} more ${days.remaining === 1 ? 'day' : 'days'}`;
  };

  $('big-unspent').textContent = fmt.bare(settlement.unplannedLeft);
  perDay(settlement.unplannedLeft, 'daily-unplanned');
  perDay(settlement.plannedLeft, 'daily-planned');
  $('unspent-caption').textContent =
    `Take-home less ${fmt.usd(Model.committedTotal(cfg))} of bills, ${fmt.usd(wf.savingsTotal)} of planned savings, ` +
    `and ${fmt.usd(pace.budget)} in planned spending` +
    (pace.overage > 0 ? `, then ${fmt.usd(pace.overage)} of category overspend on top.` : '.') +
    (settlement.borrowed > 0
      ? ` ${fmt.usd(settlement.borrowed)} of that was covered by categories running behind pace.`
      : '') +
    (settlement.surprises > 0 ? ` ${fmt.usd(settlement.surprises)} of surprise bills draws on this first.` : '');

  $('big-unused').textContent = fmt.bare(settlement.plannedLeft);
  const overCats = pace.rows.filter((r) => r.overage > 0);
  $('unused-caption').textContent =
    `Category budget not yet spent, summed per category. Surprise bills never touch this. ` +
    (settlement.borrowed > 0
      ? `${fmt.usd(settlement.borrowed)} has been lent to cover overspending elsewhere, taken only from categories behind their pace. `
      : '') +
    (overCats.length
      ? `${overCats.map((r) => `${r.name} is ${fmt.usd(r.overage)} over`).join(', ')}.`
      : `Nothing is over its category budget yet.`);
  $('stat-day').textContent = `${days.elapsed} / ${days.projected}`;
  // Split the same way the two pools are: spending that fits inside a category
  // budget draws on planned, anything past it — plus surprise bills — draws on
  // unplanned. The two add up to everything logged this period.
  $('stat-planned-spend').textContent = fmt.usd(Model.round2(pace.spent - pace.overage));
  $('stat-unplanned-spend').textContent = fmt.usd(Model.round2(pace.overage + settlement.surprises));
  $('stat-projected').textContent = pace.reliable ? fmt.usd(pace.projected) : '—';
  $('stat-oneoff').textContent = fmt.usd(settlement.surprises);
  $('period-bar-fill').style.width = `${Math.min(100, (days.elapsed / days.projected) * 100)}%`;

  const over = Model.round2(pace.projected - pace.budget);
  $('verdict').innerHTML = !pace.reliable
    ? `<strong>${fmt.usd(pace.spent)}</strong> of the ${fmt.usd(pace.budget)} prorated for a ${days.projected}-day period. ` +
      `Projections start on day ${pace.minDays}.`
    : over > 0
      ? `At this pace variable spending lands <strong>${fmt.usd(over)} over</strong> the ${fmt.usd(pace.budget)} prorated for a ${days.projected}-day period.`
      : `At this pace variable spending lands <strong>${fmt.usd(-over)} under</strong> the ${fmt.usd(pace.budget)} prorated for a ${days.projected}-day period.`;

  // Waterfall
  const body = $('waterfall-rows');
  body.replaceChildren();
  let running = 0;
  for (const tier of wf.tiers) {
    running = Model.round2(running + tier.amount);
    const tr = el('tr');
    tr.append(el('td', null, tier.label));
    tr.append(el('td', 'r', fmt.usd(tier.amount)));
    tr.append(el('td', 'r', fmt.usd(running)));
    const note = el('td');
    if (tier.note) note.append(el('span', 'flag soft', tier.note));
    tr.append(note);
    body.append(tr);
  }
  const totalRow = el('tr', 'is-total');
  totalRow.append(el('td', null, 'Unallocated'));
  totalRow.append(el('td', 'r', fmt.usd(wf.unallocated)));
  totalRow.append(el('td', 'r', fmt.usd(period.takeHome)));
  totalRow.append(el('td', null, 'cushion for one-off bills'));
  body.append(totalRow);

  // Pace bars
  $('pace-note').textContent =
    `Targets are monthly amounts prorated across ${days.projected} days. The tick marks where you should be on day ${days.elapsed}.`;
  const rows = $('pace-rows');
  rows.replaceChildren();
  for (const r of pace.rows) {
    const row = el('div', 'pace-row');
    const name = el('div', 'pace-name');
    name.append(document.createTextNode(r.name));
    name.append(el('span', 'pace-sub', `${fmt.usd(r.monthly)}/mo → ${fmt.usd(r.budget)}`));
    row.append(name);

    const track = el('div', 'pace-track');
    const pct = r.budget > 0 ? Math.min(100, (r.spent / r.budget) * 100) : 0;
    const fill = el('div', `pace-fill${r.spent > r.toDate ? ' is-over' : ''}`);
    fill.style.width = `${pct}%`;
    track.append(fill);

    // A band immediately after what has been spent, showing budget this
    // category lent to cover an overspend elsewhere. It is no longer available
    // even though it has not been spent here.
    const lent = settlement.lent?.[r.id] || 0;
    if (lent > 0 && r.budget > 0) {
      const band = el('div', 'pace-lent');
      band.style.left = `${pct}%`;
      band.style.width = `${Math.min(100 - pct, (lent / r.budget) * 100)}%`;
      band.title = `${fmt.usd(lent)} lent to cover overspending elsewhere`;
      track.append(band);
    }

    const marker = el('div', 'pace-marker');
    marker.style.left = `${r.budget > 0 ? Math.min(100, (r.toDate / r.budget) * 100) : 0}%`;
    marker.dataset.label = 'on pace';
    track.append(marker);
    row.append(track);

    const figures = el('div', 'pace-figures');
    figures.append(document.createTextNode(`${fmt.usd(r.spent)} of ${fmt.usd(r.budget)}`));
    figures.append(el('br'));
    const proj = el('span', !pace.reliable ? '' : r.overBy > 0 ? 'over' : 'under');
    proj.textContent = !pace.reliable
      ? `${Math.round(r.budget > 0 ? (r.spent / r.budget) * 100 : 0)}% of target`
      : r.overBy > 0 ? `projects ${fmt.usd(r.overBy)} over` : `projects ${fmt.usd(-r.overBy)} under`;
    figures.append(proj);

    if (lent > 0) {
      figures.append(el('br'));
      figures.append(el('span', 'lent', `${fmt.usd(lent)} lent`));
    } else if (r.overage > 0) {
      figures.append(el('br'));
      figures.append(el('span', 'over', `${fmt.usd(r.overage)} over target`));
    }
    row.append(figures);
    rows.append(row);
  }

  renderSpendingLog(period);
  renderOneOffs(period, settlement);
  renderFlows(period);
  renderClose(period, balances);
}

function renderSpendingLog(period) {
  const sel = $('spend-target');
  if (sel.options.length !== state.config.expenses.targets.length) {
    sel.replaceChildren();
    for (const t of state.config.expenses.targets) {
      sel.append(new Option(t.name, t.id));
    }
  }
  const body = $('spend-rows');
  body.replaceChildren();
  const entries = [...(period.spending || [])].sort((a, b) => b.date.localeCompare(a.date));
  if (!entries.length) {
    const tr = el('tr', 'is-muted');
    const td = el('td', null, 'Nothing logged yet this period.');
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const s of entries) {
    const target = state.config.expenses.targets.find((t) => t.id === s.targetId);
    const tr = el('tr');
    tr.append(el('td', null, fmt.day(s.date)));
    tr.append(el('td', null, target ? target.name : s.targetId));
    tr.append(el('td', 'r', fmt.usd(s.amount)));
    tr.append(el('td', null, s.note || ''));
    tr.append(removeCell(() => {
      period.spending = period.spending.filter((x) => x.id !== s.id);
      queueSave(period.id);
      renderBudget();
    }));
    body.append(tr);
  }
}

function renderOneOffs(period, settlement) {
  $('oneoff-settlement').innerHTML = settlement.surprises === 0
    ? 'Nothing to settle. Any bill added here draws on unplanned pay first, then the buffer.'
    : settlement.fromBuffer > 0
      ? `${fmt.usd(settlement.surprises)} to settle at close: <strong>${fmt.usd(settlement.fromPay)}</strong> from unplanned pay, ` +
        `<strong>${fmt.usd(settlement.fromBuffer)}</strong> from the buffer, which would leave it at ` +
        `${fmt.usd(Model.round2((latestBalances().buffer ?? 0) - settlement.fromBuffer))}.`
      : `${fmt.usd(settlement.surprises)} to settle at close, all of it from unplanned pay. ` +
        `${fmt.usd(settlement.unplannedLeft)} of unplanned pay would remain before the buffer is touched.`;

  const body = $('oneoff-rows');
  body.replaceChildren();
  const entries = [...(period.oneOffs || [])].sort((a, b) => b.date.localeCompare(a.date));
  if (!entries.length) {
    const tr = el('tr', 'is-muted');
    const td = el('td', null, 'No surprise bills this period.');
    td.colSpan = 4;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const o of entries) {
    const tr = el('tr');
    tr.append(el('td', 'nowrap', fmt.day(o.date)));
    tr.append(el('td', null, o.name));
    tr.append(el('td', 'r nowrap', fmt.usd(o.amount)));
    tr.append(removeCell(() => {
      period.oneOffs = period.oneOffs.filter((x) => x.id !== o.id);
      queueSave(period.id);
      renderBudget();
    }));
    body.append(tr);
  }
}

function renderFlows(period) {
  for (const id of ['flow-account', 'flow-to']) {
    const sel = $(id);
    if (sel.options.length !== state.config.accounts.length) {
      sel.replaceChildren();
      for (const a of state.config.accounts) sel.append(new Option(a.name, a.id));
    }
  }
  const body = $('flow-rows');
  body.replaceChildren();
  const entries = period.flows || [];
  if (!entries.length) {
    const tr = el('tr', 'is-muted');
    const td = el('td', null, 'No extra flows recorded.');
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const f of entries) {
    const from = state.config.accounts.find((a) => a.id === f.accountId);
    const to = state.config.accounts.find((a) => a.id === f.toAccountId);
    const tr = el('tr');
    tr.append(el('td', null, f.type === 'transfer' ? `${from?.name} → ${to?.name}` : from?.name || f.accountId));
    tr.append(el('td', null, f.type));
    tr.append(el('td', 'r', fmt.usd(f.amount)));
    tr.append(el('td', null, f.note || ''));
    tr.append(removeCell(() => {
      period.flows = period.flows.filter((x) => x.id !== f.id);
      queueSave(period.id);
      renderBudget();
    }));
    body.append(tr);
  }
}

function removeCell(onClick) {
  const td = el('td');
  const b = el('button', 'link-button', '×');
  b.type = 'button';
  b.title = 'Remove';
  b.addEventListener('click', onClick);
  td.append(b);
  return td;
}

/** Balance entry. Closing needs every account, so the count is shown as you go. */
function renderClose(period, prevBalances) {
  const cfg = state.config;
  const body = $('close-rows');
  body.replaceChildren();

  const live = cfg.accounts.filter((a) => !a.retired);

  /**
   * Recount the gate without rebuilding the table. Re-rendering on every
   * keystroke would replace the input being typed into and drop focus, so
   * the handler below touches only the two things a keystroke can change.
   */
  const updateGate = () => {
    const n = live.filter((a) => {
      const v = period.balances?.[a.id];
      return v != null && v !== '';
    }).length;
    $('close-progress').textContent = `${n} of ${live.length} balances entered`;
    $('close-period').disabled = n !== live.length;
  };

  for (const a of live) {
    const value = period.balances?.[a.id];
    const prev = prevBalances[a.id];

    const tr = el('tr');
    tr.append(el('td', null, a.name));
    const kind = el('td');
    kind.append(el('span', `flag ${a.volatile ? 'warn' : 'soft'}`, a.volatile ? 'volatile' : 'stable'));
    if (!a.liquid) kind.append(el('span', 'flag soft', ' · illiquid'));
    tr.append(kind);
    tr.append(el('td', 'r', prev != null ? fmt.usd(prev) : '—'));

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = value != null ? value : '';
    input.placeholder = 'enter';
    const inputCell = el('td', 'r');
    inputCell.append(input);
    tr.append(inputCell);

    const delta = value != null && prev != null ? Model.round2(value - prev) : null;
    const deltaCell = el('td', 'r', delta != null ? fmt.signed(delta) : '—');
    tr.append(deltaCell);

    input.addEventListener('input', () => {
      period.balances = period.balances || {};
      if (input.value === '') delete period.balances[a.id];
      else period.balances[a.id] = Number(input.value);
      queueSave(period.id);
      const v = period.balances[a.id];
      deltaCell.textContent = v != null && prev != null ? fmt.signed(Model.round2(v - prev)) : '—';
      updateGate();
    });

    body.append(tr);
  }

  updateGate();
  renderMortgageField(period);

  const days = Model.periodDays(period, today());
  const nextDeposit = PayDates.nextDepositAfter(period.start);
  const secondDeposit = nextDeposit ? PayDates.nextDepositAfter(nextDeposit.available) : null;
  let note = `Closing snapshots balances, computes the reconciliation residual, and archives this period's log. Proration will use the actual ${days.projected}-day span.`;
  if (secondDeposit && today() >= secondDeposit.available) {
    note += ` Heads up: a second deposit landed on ${fmt.day(secondDeposit.available)} while this period was still open, so two paychecks are sitting in one period.`;
  }
  $('close-note').textContent = note;
}

/**
 * The mortgage balance is a liability, not one of the accounts, so it sits
 * outside the balances table and never counts toward the "N of M entered" gate.
 * Entering it updates the loan on the Mortgage tab straight away — that figure
 * is a live setting rather than a period snapshot — and is also recorded on the
 * period so the close has a note of what it was.
 */
function renderMortgageField(period) {
  const input = $('close-mortgage');
  if (!state.config.mortgage) return;

  if (document.activeElement !== input) {
    input.value = period.mortgageBalance != null ? period.mortgageBalance : '';
  }

  if (input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('input', () => {
    const open = openPeriod();
    if (input.value === '') {
      delete open.mortgageBalance;
      queueSave(open.id);
      return;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) return;
    open.mortgageBalance = value;
    state.config.mortgage.currentLoan.balance = value;
    Mortgage.setBalance(value);
    queueSave(open.id);
    queueSave('config');
    // No re-render here: rebuilding the form would drop focus mid-typing.
  });
}

async function closePeriod() {
  const period = openPeriod();
  const cfg = state.config;
  const balances = latestBalances();
  const days = Model.periodDays({ ...period, closedOn: today() }, today());
  const pace = Model.pace(cfg, { ...period, closedOn: today() }, today());
  const wf = Model.waterfall(cfg, { days: days.projected, balances });

  const settlement = Model.settle(cfg, { ...period, closedOn: today() }, wf, pace);
  const surplus = settlement.surplus;
  const sweep = Model.sweepPlan(cfg, surplus, period.balances || {});

  period.closedOn = today();
  period.status = 'closed';
  period.totals = {
    days: days.projected,
    committed: Model.committedTotal(cfg),
    sinking: Model.sinkingTotal(cfg),
    targetBudget: pace.budget,
    variableSpent: pace.spent,
    surprises: settlement.surprises,
    surpriseFromPay: settlement.fromPay,
    surpriseFromBuffer: settlement.fromBuffer,
    surplus,
    sweep,
    contributed: Model.round2(
      wf.tiers.filter((t) => ['sinking', 'emergency', 'buffer', 'roth', 'longterm', 'brokerage'].includes(t.key))
        .reduce((a, t) => a + t.amount, 0) + Model.contributed(period)
    ),
    windfalls: Model.windfalls(period),
    mortgageBalance: period.mortgageBalance ?? state.config.mortgage?.currentLoan?.balance ?? null,
  };

  const closeRes = await request(`/api/periods/${period.id}`, 'PUT', period);
  period.version = closeRes.version;

  const next = makePeriod(today());
  if (next.id === period.id) {
    const d = PayDates.nextDepositAfter(period.start);
    if (d) Object.assign(next, makePeriod(d.available));
  }
  state.periods.push(next);
  const nextRes = await request(`/api/periods/${next.id}`, 'PUT', next);
  next.version = nextRes.version;

  const swept = sweep.map((s) => `${fmt.usd(s.amount)} → ${s.target}`).join(', ');
  const surpriseLine = settlement.surprises > 0
    ? ` ${fmt.usd(settlement.surprises)} of surprise bills settled: ${fmt.usd(settlement.fromPay)} from unplanned pay` +
      (settlement.fromBuffer > 0 ? `, ${fmt.usd(settlement.fromBuffer)} from the buffer.` : ', buffer untouched.')
    : '';
  notice(`Period ${fmt.day(period.start)}–${fmt.day(period.closedOn)} closed.${surpriseLine}` +
    (surplus > 0 ? ` Surplus ${fmt.usd(surplus)} sweeps ${swept || 'nowhere — no shortfalls'}.` : ' No surplus left to sweep.'));
  render();
}

// --- expenses view ----------------------------------------------------------

function renderExpenses() {
  const cfg = state.config;
  const { days, buckets, wf, period } = context();

  const committed = Model.committedTotal(cfg);
  const sinking = Model.sinkingTotal(cfg);
  const targets = Model.targetsTotal(cfg, days.projected);
  // Money set aside is an outflow too — it leaves the account on schedule just
  // like a bill. Without it the total answers a question nobody asked.
  const savings = wf.savingsTotal;
  const total = Model.round2(committed + targets + savings);

  $('exp-total').textContent = fmt.bare(total);
  const annualTargets = Model.sum(cfg.expenses.targets, (t) => t.monthly) * 12;
  const annual = Model.round2((committed + savings) * 24 + annualTargets);
  $('exp-caption').textContent =
    `Across a ${days.projected}-day period — bills, targets, and savings. ${fmt.usd(annual)} a year.`;
  $('exp-committed').textContent = fmt.usd(committed);
  $('exp-targets').textContent = fmt.usd(targets);
  $('exp-savings').textContent = fmt.usd(savings);
  const unallocated = Model.round2(period.takeHome - total);
  $('exp-unallocated').textContent = fmt.bare(unallocated);
  $('exp-unallocated-wrap').classList.toggle('is-warn', unallocated < 0);
  $('exp-unallocated-caption').textContent = unallocated < 0
    ? `The plan spends ${fmt.usd(-unallocated)} more than ${fmt.usd(period.takeHome)} of take-home. Something here has to give.`
    : `Take-home not claimed by any bill, target, or savings tier. This is what surprise bills draw on before the buffer.`;

  const computed = Model.scheduledTransfer(cfg);
  const actual = cfg.waterfall.sinkingTransferActual;
  const drift = actual != null ? Model.round2(actual - computed) : null;
  // Overfunding is deliberate here — the standing transfer is rounded up — so
  // only a shortfall is worth saying anything about.
  const floor = Model.necessaryFloor(cfg, days.projected);
  $('transfer-verdict').innerHTML =
    `Cut everything optional and the floor is <strong>${fmt.usd(floor)}</strong> a period, ` +
    `leaving ${fmt.usd(Model.round2(period.takeHome - floor))} of the paycheck. ` +
    `Your standing transfer should move ${fmt.usd(computed)} per period to cover every annual bill.` +
    (drift != null && drift < 0
      ? ` You transfer ${fmt.usd(actual)}, <strong>underfunding by ${fmt.usd(-drift)}</strong> a period.`
      : '');

  // 1 — committed
  const cbody = $('committed-rows');
  cbody.replaceChildren();
  paintSortHeaders('committed-head', sorts.committed);
  for (const e of sortRows(cfg.expenses.committed, sorts.committed)) {
    const tr = el('tr');
    tr.append(el('td', null, e.name));
    tr.append(el('td', null, e.category));
    tr.append(numberCell(e.perPeriod, (v) => { e.perPeriod = v; queueSave('config'); render(); }));
    tr.append(el('td', 'r', fmt.usd(e.perPeriod * 2)));
    tr.append(el('td', 'r', fmt.usd(e.perPeriod * 24)));
    tr.append(checkCell(e.necessary, (v) => { e.necessary = v; queueSave('config'); renderExpenses(); }));
    cbody.append(tr);
  }
  const ctot = el('tr', 'is-total');
  ctot.append(el('td', null, `${cfg.expenses.committed.length} bills`));
  ctot.append(el('td'));
  ctot.append(el('td', 'r', fmt.usd(committed)));
  ctot.append(el('td', 'r', fmt.usd(committed * 2)));
  ctot.append(el('td', 'r', fmt.usd(committed * 24)));
  ctot.append(el('td'));
  cbody.append(ctot);

  // 2 — sinking
  const sbody = $('sinking-rows');
  sbody.replaceChildren();
  const coverage = Model.sinkingCoverage(cfg, buckets, today());
  for (const s of coverage) {
    const tr = el('tr');
    tr.append(el('td', null, s.name));
    tr.append(el('td', 'r', fmt.usd(s.perPeriod)));
    tr.append(el('td', 'r', fmt.usd(s.annualAmount)));
    const due = el('td');
    due.append(document.createTextNode(s.dueISO ? fmt.day(s.dueISO) : '—'));
    if (s.daysUntilDue != null && s.daysUntilDue <= 30) {
      due.append(el('span', `flag ${s.urgent ? 'warn' : 'soft'}`, ` ${s.daysUntilDue}d`));
    }
    tr.append(due);
    tr.append(el('td', 'r', fmt.usd(s.balance)));
    tr.append(el('td', 'r', s.required != null ? fmt.usd(s.required) : '—'));
    const cov = el('td');
    if (s.status === 'no-due-date') cov.append(el('span', 'flag warn', 'due date needed'));
    else if (s.urgent) cov.append(el('span', 'flag warn', `top up ${fmt.usd(s.shortfall)} now`));
    else if (s.status === 'short') cov.append(el('span', 'flag warn', `short ${fmt.usd(s.shortfall)}`));
    else cov.append(el('span', 'flag gain', `covered · ${s.periodsLeft} periods`));
    tr.append(cov);
    sbody.append(tr);
  }
  const topUp = Model.round2(Model.sum(coverage, (s) => s.shortfall || 0));
  const stot = el('tr', 'is-total');
  stot.append(el('td', null, `${coverage.length} annual bills`));
  stot.append(el('td', 'r', fmt.usd(sinking)));
  stot.append(el('td', 'r', fmt.usd(Model.sum(coverage, (s) => s.annualAmount))));
  stot.append(el('td'));
  stot.append(el('td', 'r', fmt.usd(Model.sum(coverage, (s) => s.balance))));
  stot.append(el('td', 'r', fmt.usd(Model.sum(coverage, (s) => s.required || 0))));
  const totCell = el('td');
  totCell.append(el('span', `flag ${topUp > 0 ? 'warn' : 'gain'}`,
    topUp > 0 ? `top up ${fmt.usd(topUp)} to be on schedule` : 'on schedule'));
  stot.append(totCell);
  sbody.append(stot);

  // 3 — targets
  const tbody = $('target-rows');
  tbody.replaceChildren();
  for (const t of cfg.expenses.targets) {
    const tr = el('tr');
    tr.append(el('td', null, t.name));
    tr.append(el('td', null, t.category));
    tr.append(numberCell(t.monthly, (v) => { t.monthly = v; queueSave('config'); render(); }));
    tr.append(el('td', 'r', fmt.usd(Model.prorate(t.monthly, 13))));
    tr.append(el('td', 'r', fmt.usd(Model.prorate(t.monthly, 19))));
    tr.append(checkCell(t.necessary, (v) => { t.necessary = v; queueSave('config'); renderExpenses(); }));
    tbody.append(tr);
  }

  // 4 — planned savings
  const savingsRows = wf.tiers.filter((t) => t.saving);
  const sbody2 = $('savings-rows');
  sbody2.replaceChildren();
  let plannedTotal = 0;
  for (const t of savingsRows) {
    const dests = t.destinations || [];
    const acct = dests.length === 1 ? cfg.accounts.find((a) => a.id === dests[0].accountId) : null;
    // Goals share one account; brokerage destinations are separate accounts.
    const byGoal = dests.length > 1 && dests.every((d) => d.bucketId);
    const parentAcct = byGoal && cfg.accounts.find((a) => a.id === dests[0].accountId);
    plannedTotal += t.base;
    const tr = el('tr', t.base === 0 ? 'is-muted' : '');
    tr.append(el('td', null, t.label));
    tr.append(el('td', null,
      acct ? acct.name
        : byGoal ? `${parentAcct ? parentAcct.name : ''} · ${dests.length} goals`
        : dests.length > 1 ? `${dests.length} accounts` : '—'));

    // Sinking is the sum of section 2's per-bill contributions, so editing it
    // here would be thrown away on the next render. Left read-only on purpose.
    if (t.configKey) {
      tr.append(numberCell(t.base, (v) => {
        cfg.waterfall[t.configKey] = Math.max(0, v);
        queueSave('config');
        render();
      }));
    } else {
      tr.append(el('td', 'r', fmt.usd(t.base)));
    }

    tr.append(el('td', 'r', fmt.usd(t.amount)));
    tr.append(el('td', 'r', fmt.usd(t.base * 24)));
    const note = el('td');
    if (t.note) note.append(el('span', 'flag soft', t.note));
    else if (t.splitKey) note.append(el('span', 'flag soft', byGoal ? 'sum of the goals below' : 'sum of the accounts below'));
    else if (wf.inRecovery && t.reducible) note.append(el('span', 'flag warn', 'halved in recovery'));
    else if (t.base === 0) note.append(el('span', 'flag soft', 'nothing set aside'));
    tr.append(note);
    sbody2.append(tr);

    // A tier that fans out to several accounts edits its destinations in
    // dollars — they are separate real transfers, not shares of one pot.
    if (t.splitKey) {
      for (const d of dests) {
        const dAcct = cfg.accounts.find((a) => a.id === d.accountId);
        const dBucket = d.bucketId && cfg.buckets.find((b) => b.id === d.bucketId);
        const sub = el('tr', 'is-muted');
        sub.append(el('td', null, `↳ ${dBucket ? dBucket.name : dAcct ? dAcct.name : d.accountId}`));
        sub.append(el('td'));
        sub.append(numberCell(d.base, (v) => {
          cfg.waterfall[t.splitKey][d.index].perPeriod = Math.max(0, v);
          queueSave('config');
          render();
        }));
        sub.append(el('td', 'r', fmt.usd(d.amount)));
        sub.append(el('td', 'r', fmt.usd(d.base * 24)));
        const dn = el('td');
        if (wf.inRecovery) dn.append(el('span', 'flag warn', 'halved in recovery'));
        sub.append(dn);
        sbody2.append(sub);
      }
    }

  }

  plannedTotal = Model.round2(plannedTotal);
  const srow = el('tr', 'is-total');
  srow.append(el('td', null, 'Set aside each period'));
  srow.append(el('td'));
  srow.append(el('td', 'r', fmt.usd(plannedTotal)));
  srow.append(el('td', 'r', fmt.usd(savings)));
  srow.append(el('td', 'r', fmt.usd(plannedTotal * 24)));
  srow.append(el('td', null, `${Model.round2((savings / period.takeHome) * 100)}% of take-home`));
  sbody2.append(srow);

  $('savings-note').textContent = wf.inRecovery
    ? `Recovery mode is on, so the reducible tiers are cut ${cfg.rules.recoveryReductionPct}% and ${fmt.usd(wf.freed)} redirects to the emergency fund. Sinking funds are untouched.`
    : 'Money set aside is an outflow like any other — it leaves on schedule. Sinking funds appear here and in section 2; they are counted once.';

  // pay calendar
  const cal = $('calendar-rows');
  cal.replaceChildren();
  const from = today();
  const to = PayDates.iso(PayDates.parse(from) + 200 * PayDates.DAY);
  const deposits = PayDates.depositsBetween(from, to);
  deposits.forEach((p, i) => {
    const tr = el('tr');
    tr.append(el('td', null, fmt.day(p.nominal)));
    tr.append(el('td', null, fmt.day(p.paid)));
    tr.append(el('td', null, fmt.day(p.available)));
    const next = deposits[i + 1];
    tr.append(el('td', 'r', next ? String(PayDates.daysBetween(p.available, next.available)) : '—'));
    const why = el('td');
    if (p.reasons.length) why.append(el('span', 'flag soft', p.reasons.join(' → ')));
    tr.append(why);
    cal.append(tr);
  });
}

function numberCell(value, onChange) {
  const td = el('td', 'r');
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.value = value;
  input.addEventListener('change', () => onChange(Number(input.value)));
  td.append(input);
  return td;
}

function checkCell(value, onChange) {
  const td = el('td', 'c');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  td.append(input);
  return td;
}

/**
 * A decade of snapshots on a date axis. Annotated events get a rule, because a
 * vested-equity liquidation or a house down payment moves the line by six
 * figures without being saving or spending.
 */
function timeChart(svg, series, events = []) {
  svg.replaceChildren();
  if (!series.length) return emptyChart(svg, 'no history');

  const pad = { l: 66, r: 16, t: 14, b: 34 };
  const W = 760, H = 320;
  const t0 = PayDates.parse(series[0].date);
  const t1 = PayDates.parse(series[series.length - 1].date);
  const hi = Math.max(...series.map((p) => p.value));
  const x = (d) => pad.l + ((PayDates.parse(d) - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / (hi || 1)) * (H - pad.t - pad.b);

  svg.append(svgEl('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, class: 'axis-line' }));
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const v = hi * frac;
    const t = svgEl('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt.short(v);
    svg.append(t);
  }

  for (const ev of events) {
    const ex = x(ev.date);
    if (ex < pad.l || ex > W - pad.r) continue;
    svg.append(svgEl('line', { x1: ex, y1: pad.t, x2: ex, y2: H - pad.b, class: 'event-rule' }));
  }

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d: `${line} L${x(series[series.length - 1].date).toFixed(1)},${y(0)} L${x(series[0].date).toFixed(1)},${y(0)} Z`, class: 'series-area' }));
  svg.append(svgEl('path', { d: line, class: 'series-line' }));

  const years = [...new Set(series.map((p) => p.date.slice(0, 4)))];
  for (const yr of years) {
    const first = series.find((p) => p.date.startsWith(yr));
    const t = svgEl('text', { x: x(first.date), y: H - pad.b + 18, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = yr;
    svg.append(t);
  }
}

/**
 * Net worth broken into its accounts, stacked. Illiquid sits at the bottom in
 * cool shades and liquid rides on top in warm ones, so the warm band is the
 * part you could actually reach — its thickness is the answer to a different
 * question than the total height.
 */
function stackChart(svg, snapshots, series, events = []) {
  svg.replaceChildren();
  if (!snapshots.length || !series.length) return emptyChart(svg, 'no history');

  const pad = { l: 66, r: 16, t: 14, b: 34 };
  const W = 760, H = 340;
  const t0 = PayDates.parse(snapshots[0].date);
  const t1 = PayDates.parse(snapshots[snapshots.length - 1].date);
  const totals = snapshots.map((sn) => series.reduce((a, s) => a + (sn.balances[s.id] || 0), 0));
  const hi = Math.max(...totals, 1);
  const x = (d) => pad.l + ((PayDates.parse(d) - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);

  let lower = new Array(snapshots.length).fill(0);
  for (const s of series) {
    const upper = lower.map((v, i) => v + (snapshots[i].balances[s.id] || 0));
    // Skip a band that never holds anything — an empty path in the stack is
    // just a legend entry with nothing to point at.
    if (upper.every((v, i) => Math.abs(v - lower[i]) < 0.005)) { lower = upper; continue; }
    const top = snapshots.map((sn, i) => `${i ? 'L' : 'M'}${x(sn.date).toFixed(1)},${y(upper[i]).toFixed(1)}`).join(' ');
    const bottom = snapshots.map((sn, i) => `L${x(sn.date).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse().join(' ');
    svg.append(svgEl('path', { d: `${top} ${bottom} Z`, fill: s.color, stroke: 'none' }));
    lower = upper;
  }

  // After the bands, so the rules sit on top of the fill rather than under it.
  for (const ev of events) {
    const ex = x(ev.date);
    if (ex < pad.l || ex > W - pad.r) continue;
    svg.append(svgEl('line', { x1: ex, y1: pad.t, x2: ex, y2: H - pad.b, class: 'event-rule' }));
  }

  svg.append(svgEl('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, class: 'axis-line' }));
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const t = svgEl('text', { x: pad.l - 8, y: y(hi * frac) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt.short(hi * frac);
    svg.append(t);
  }
  // A decade wants year ticks; a few months of projection wants months, or the
  // axis collapses to a single label.
  const spanDays = (t1 - t0) / PayDates.DAY;
  const key = spanDays > 550 ? (d) => d.slice(0, 4) : (d) => d.slice(0, 7);
  const label = spanDays > 550
    ? (k) => k
    : (k) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+k.slice(5, 7) - 1]} ${k.slice(2, 4)}`;
  for (const k of [...new Set(snapshots.map((sn) => key(sn.date)))]) {
    const first = snapshots.find((sn) => key(sn.date) === k);
    const t = svgEl('text', { x: x(first.date), y: H - pad.b + 18, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = label(k);
    svg.append(t);
  }
}

/** Stack order: illiquid at the bottom in cool shades, liquid above in warm. */
function compositionSeries(cfg) {
  const cool = cfg.theme?.coolPalette || ['#1F3D5C', '#2F6285', '#4A93A6'];
  const warm = cfg.theme?.warmPalette || ['#6E3410', '#AC601A', '#C67C1F', '#D4AF37', '#E4C86A', '#F1E0A8'];
  const order = (ids) => ids.map((id) => cfg.accounts.find((a) => a.id === id)).filter(Boolean);

  const illiquid = order(['k401', 'roth', 'equity'])
    .concat(cfg.accounts.filter((a) => !a.liquid && !['k401', 'roth', 'equity'].includes(a.id)));
  const liquidIds = ['emergency', 'buffer', 'sinking', 'longterm', 'other', 'etrade-self', 'etrade-robo', 'robinhood'];
  const liquid = order(liquidIds)
    .concat(cfg.accounts.filter((a) => a.liquid && !liquidIds.includes(a.id)));

  return [
    ...illiquid.map((a, i) => ({ id: a.id, name: a.name, group: 'Illiquid', color: cool[i % cool.length] })),
    ...liquid.map((a, i) => ({ id: a.id, name: a.name, group: 'Liquid', color: warm[i % warm.length] })),
  ];
}

// --- assets view ------------------------------------------------------------

function renderAssets() {
  const cfg = state.config;
  const { balances, buckets, wf } = context();
  const summary = Model.assetSummary(cfg, balances, buckets);

  $('asset-accessible').textContent = fmt.bare(summary.accessible);
  $('asset-total').textContent = fmt.usd0(summary.total);
  $('asset-illiquid').textContent = fmt.usd0(summary.illiquid);
  $('asset-encumbered').textContent = fmt.usd(summary.encumbered);
  const last = lastClosed();
  $('asset-contributed').textContent = last?.totals ? fmt.usd(last.totals.contributed) : '—';

  // accounts + their buckets
  const body = $('account-rows');
  body.replaceChildren();
  const drift = Object.fromEntries(
    Model.bucketDrift(cfg, balances, buckets).map((d) => [d.account.id, d])
  );
  for (const a of cfg.accounts) {
    if (a.retired && !(balances[a.id] > 0)) continue;
    const tr = el('tr');
    tr.append(el('td', null, a.name));
    tr.append(el('td', null, a.tier));
    tr.append(el('td', 'c', a.volatile ? 'yes' : '—'));
    tr.append(el('td', 'c', a.liquid ? 'yes' : '—'));
    tr.append(el('td', 'r', fmt.usd(balances[a.id] ?? 0)));
    const targetCell = el('td', 'r');
    targetCell.append(document.createTextNode(a.target ? fmt.usd(a.target) : '—'));
    const d = drift[a.id];
    if (d && !d.ok) {
      targetCell.append(el('span', 'flag warn',
        ` ${d.drift > 0 ? fmt.usd(d.drift) + ' unallocated' : fmt.usd(-d.drift) + ' over-allocated'}`));
    }
    tr.append(targetCell);
    body.append(tr);

    // Sinking buckets are listed per bill on the Expenses tab, with due dates and
    // coverage. Repeating them here is noise; the account total is enough.
    for (const b of cfg.buckets.filter((x) => x.accountId === a.id && x.kind !== 'sinking')) {
      const br = el('tr', 'is-muted');
      br.append(el('td', null, `↳ ${b.name}`));
      br.append(el('td', null, b.kind));
      br.append(el('td', 'c', '—'));
      br.append(el('td', 'c', '—'));
      br.append(el('td', 'r', fmt.usd(buckets[b.id] ?? 0)));
      br.append(el('td', 'r', b.target ? fmt.usd(b.target) : '—'));
      body.append(br);
    }
  }
  const tot = el('tr', 'is-total');
  tot.append(el('td', null, 'Total picture'));
  tot.append(el('td')); tot.append(el('td')); tot.append(el('td'));
  tot.append(el('td', 'r', fmt.usd(summary.total)));
  tot.append(el('td'));
  body.append(tot);

  // long-term progress
  const snaps = state.history.snapshots || [];
  const events = state.history.events || [];
  const series = snaps.map((sn) => ({
    date: sn.date,
    value: Model.round2(Object.values(sn.balances).reduce((a, b) => a + b, 0)),
  }));
  if (series.length) {
    const first = series[0], lastPt = series[series.length - 1];
    const years = PayDates.daysBetween(first.date, lastPt.date) / 365.25;
    $('history-note').textContent =
      `${series.length} snapshots from ${first.date} to ${lastPt.date}. ` +
      `${fmt.usd0(first.value)} → ${fmt.usd0(lastPt.value)} over ${years.toFixed(1)} years. ` +
      `Dashed rules mark transfers and one-time events, which move the line without being saving.`;
  } else {
    $('history-note').textContent = 'No history loaded.';
  }
  timeChart($('chart-history'), series, events);

  // composition
  const composition = compositionSeries(cfg);
  stackChart($('chart-composition'), snaps, composition, events);
  if (snaps.length) {
    const lastBal = snaps[snaps.length - 1].balances;
    const grouped = (g) => Model.round2(Model.sum(composition.filter((x) => x.group === g), (x) => lastBal[x.id] || 0));
    $('composition-note').textContent =
      `The same total, split by account. Illiquid sits at the bottom in cool shades — ` +
      `${fmt.usd0(grouped('Illiquid'))} today — with liquid stacked above it in warm — ${fmt.usd0(grouped('Liquid'))}. ` +
      `The warm band is what you could actually reach. Dashed rules mark the same events as the chart above.`;

    const legend = $('composition-legend');
    legend.replaceChildren();
    for (const g of ['Illiquid', 'Liquid']) {
      legend.append(el('div', 'legend-group', g));
      for (const sr of composition.filter((x) => x.group === g)) {
        const item = el('div', 'legend-item');
        const sw = el('span', 'legend-swatch');
        sw.style.background = sr.color;
        item.append(sw, document.createTextNode(sr.name), el('span', 'legend-value', fmt.usd0(lastBal[sr.id] || 0)));
        legend.append(item);
      }
    }
  }

  const ebody = $('event-rows');
  ebody.replaceChildren();
  // Sorted here so a hand-added event can be appended anywhere in the file.
  for (const ev of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const tr = el('tr');
    tr.append(el('td', 'nowrap', ev.date));
    tr.append(el('td', null, ev.note));
    tr.append(el('td', 'r nowrap', fmt.usd(ev.amount)));
    ebody.append(tr);
  }

  // contribution per period
  barChart($('chart-contrib'), closedPeriods().map((p) => ({
    label: p.start,
    value: p.totals?.contributed ?? 0,
  })));

  // reconciliation
  const rbody = $('reconcile-rows');
  rbody.replaceChildren();
  const closed = closedPeriods();
  if (closed.length < 1) {
    const tr = el('tr', 'is-muted');
    const td = el('td', null, 'Nothing to reconcile until a period is closed.');
    td.colSpan = 5;
    tr.append(td);
    rbody.append(tr);
  } else {
    const current = closed[closed.length - 1];
    const prior = closed.length > 1 ? closed[closed.length - 2].balances : latestBalancesFallback();
    const currentDays = Model.periodDays(current, today());
    const currentWf = Model.waterfall(cfg, { days: currentDays.projected, balances: prior || {} });
    const planned = Model.plannedFlows(cfg, current, currentWf);
    for (const r of Model.reconcile(cfg, current, prior || {}, planned)) {
      const tr = el('tr', r.warn ? '' : 'is-muted');
      tr.append(el('td', null, r.account.name));
      tr.append(el('td', 'r', r.delta != null ? fmt.signed(r.delta) : '—'));
      tr.append(el('td', 'r', fmt.signed(r.flow)));
      tr.append(el('td', 'r', r.recorded ? fmt.signed(r.recorded) : '—'));
      tr.append(el('td', 'r', r.residual != null ? fmt.signed(r.residual) : '—'));
      const m = el('td');
      m.append(el('span', `flag ${r.warn ? 'warn' : 'soft'}`, r.meaning));
      tr.append(m);
      rbody.append(tr);
    }
  }
}

function latestBalancesFallback() {
  const out = {};
  for (const [k, v] of Object.entries(state.config.openingBalances || {})) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

// --- live sources -----------------------------------------------------------

// Fetched the first time the Mortgage tab is opened, not on page load: FRED
// sits behind an 8s timeout and the other three tabs have no use for the rate.
// `tried` stops a failed lookup from retrying on every render; the button
// always retries on demand.
const liveSources = { tried: false, inFlight: false };

async function refreshMortgageSources({ auto = false } = {}) {
  if (liveSources.inFlight) return;
  liveSources.inFlight = true;
  const btn = $('refresh-rate');
  btn.disabled = true;
  btn.textContent = auto ? 'Fetching…' : 'Refreshing…';
  try {
    const payload = await request('/api/state?live=1', 'GET');
    state.config.mortgage = payload.config.mortgage;
    state.meta = payload.meta || {};
    Mortgage.setConfig(state.config.mortgage, state.meta);
    notice((payload.problems || []).length
      ? `Falling back to config.json — ${payload.problems.join('; ')}`
      : '');
  } catch (err) {
    notice(`Could not reach the rate source: ${err.message}. Using the value in config.json.`);
  } finally {
    liveSources.tried = true;
    liveSources.inFlight = false;
    btn.disabled = false;
    btn.textContent = 'Refresh sources';
    render();
  }
}


// --- projections view -------------------------------------------------------

/** Everything forward-looking: where the plan takes each pool from here. */
function renderProjections() {
  const cfg = state.config;
  const { balances, buckets, wf } = context();

  // emergency trajectory — only while short
  const emg = Model.emergencyTrajectory(cfg, balances, wf);
  $('emergency-block').hidden = !emg;
  if (emg) {
    $('emergency-note').textContent =
      `${fmt.usd(emg.gap)} below target. At ${fmt.usd(emg.inflow)} a period including the recovery redirect, ` +
      `back to target in ${emg.periodsToTarget} periods.`;
    lineChart($('chart-emergency'), emg.points, { target: emg.target });
  }

  // buffer trajectory
  const buf = Model.bufferTrajectory(cfg, balances, closedPeriods(), wf.inRecovery);
  $('buffer-note').textContent =
    `${fmt.usd(buf.inflow)} in per period against ${fmt.usd(buf.draw.value)} of one-off spending ` +
    `(${buf.draw.source}${buf.draw.n ? `, ${buf.draw.n} period${buf.draw.n === 1 ? '' : 's'}` : ''}) — ` +
    (buf.net >= 0
      ? `net ${fmt.usd(buf.net)} a period, holding.`
      : `net ${fmt.usd(buf.net)} a period. Empty in ${buf.periodsToZero} periods.`);
  lineChart($('chart-buffer'), buf.points, { target: buf.target });

  // savings trajectory — where the plan lands, contributions only
  const traj = Model.savingsTrajectory(cfg, balances, closedPeriods(), wf, today());
  if (traj) {
    const warm = cfg.theme?.warmPalette || ['#6E3410', '#AC601A', '#C67C1F', '#D4AF37', '#E4C86A', '#F1E0A8'];
    const trajSeries = traj.destinations
      .filter((id) => traj.perPeriod[id] > 0 || (balances[id] ?? 0) > 0)
      .map((id, i) => {
        const a = cfg.accounts.find((x) => x.id === id);
        return { id, name: a ? a.name : id, color: warm[i % warm.length] };
      });
    stackChart($('chart-savings-traj'), traj.points, trajSeries);

    const months = Model.round2(PayDates.daysBetween(traj.points[0].date, traj.points[traj.points.length - 1].date) / 30.44);
    const bills = traj.billsPaid.length
      ? ` The sinking line drops where a bill lands — ${traj.billsPaid.map((b) => `${b.name} ${fmt.usd(b.amount)}`).join(', ')}.`
      : '';
    const bleed = traj.draw.value > 0
      ? ` The buffer bleeds ${fmt.usd(traj.draw.value)} a period against one-off spending (${traj.draw.source}).`
      : '';
    $('savings-traj-note').textContent =
      `${fmt.usd(traj.contributedPerPeriod)} a period across ${trajSeries.length} destinations takes savings from ` +
      `${fmt.usd0(traj.start)} to ${fmt.usd0(traj.end)} over ${traj.periods} periods — about ${months} months, ` +
      `adding ${fmt.usd(Model.round2(traj.end - traj.start))}. Contributions only: no market movement is assumed, ` +
      `which matters most for the brokerage.${bills}${bleed}`;

    const tlegend = $('savings-traj-legend');
    tlegend.replaceChildren();
    for (const sr of trajSeries) {
      const item = el('div', 'legend-item');
      const sw = el('span', 'legend-swatch');
      sw.style.background = sr.color;
      item.append(sw, document.createTextNode(sr.name),
        el('span', 'legend-value', `${fmt.usd(traj.perPeriod[sr.id])}/period`));
      tlegend.append(item);
    }
  }

  const traj2 = Model.savingsTrajectory(cfg, balances, closedPeriods(), wf, today());
  $('projections-note').textContent = traj2
    ? `Projected from today's balances and the current plan, over ${traj2.periods} pay periods. ` +
      `Contributions only — no market growth is assumed.`
    : 'Not enough of a pay calendar ahead to project.';
}

// --- wiring -----------------------------------------------------------------

function render() {
  for (const view of VIEWS) {
    $(`view-${view}`).hidden = view !== state.view;
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === state.view));
  // The masthead belongs to no single tab, so it is filled here — a deep link
  // straight to Expenses or Assets must not land on an empty header.
  const { period, days, balances, buckets, wf, pace } = context();
  const summary = Model.assetSummary(state.config, balances, buckets);
  const left = leftToSpend(state.config, period, wf, pace);
  $('chip-accessible').textContent = fmt.usd0(summary.accessible);
  $('chip-networth').textContent = fmt.usd0(summary.total);
  $('chip-takehome').textContent = fmt.usd(period.takeHome);
  $('chip-left').textContent = fmt.usd(left);
  $('chip-left-wrap').classList.toggle('is-warn', left < 0);
  $('period-caption').textContent =
    `Period ${fmt.day(period.start)} – ${fmt.day(period.scheduledEnd)} · day ${days.elapsed} of ${days.projected}` +
    (days.late ? ' · closing late' : '');

  if (state.view === 'budget') renderBudget();
  if (state.view === 'expenses') renderExpenses();
  if (state.view === 'assets') renderAssets();
  if (state.view === 'projections') renderProjections();
  if (state.view === 'mortgage') {
    Mortgage.render();
    // Fire-and-forget on first open; the flags above keep it to one attempt.
    if (!liveSources.tried && !liveSources.inFlight) refreshMortgageSources({ auto: true });
  }
}

function wire() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });

  // Back and forward move between tabs rather than leaving the app.
  window.addEventListener('popstate', () => {
    state.view = viewFromUrl();
    render();
  });

  $('spend-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const period = openPeriod();
    period.spending = period.spending || [];
    period.spending.push({
      id: uid(),
      date: $('spend-date').value,
      targetId: $('spend-target').value,
      amount: Number($('spend-amount').value),
      note: $('spend-note').value.trim(),
    });
    queueSave(period.id);
    $('spend-amount').value = '';
    $('spend-note').value = '';
    renderBudget();
  });

  $('oneoff-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const period = openPeriod();
    period.oneOffs = period.oneOffs || [];
    period.oneOffs.push({
      id: uid(),
      date: $('oneoff-date').value,
      name: $('oneoff-name').value.trim(),
      amount: Number($('oneoff-amount').value),
    });
    queueSave(period.id);
    $('oneoff-name').value = '';
    $('oneoff-amount').value = '';
    renderBudget();
  });

  $('flow-type').addEventListener('change', () => {
    $('flow-to-wrap').hidden = $('flow-type').value !== 'transfer';
  });

  $('flow-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const period = openPeriod();
    period.flows = period.flows || [];
    const type = $('flow-type').value;
    period.flows.push({
      id: uid(),
      accountId: $('flow-account').value,
      toAccountId: type === 'transfer' ? $('flow-to').value : null,
      type,
      amount: Number($('flow-amount').value),
      note: $('flow-note').value.trim(),
    });
    queueSave(period.id);
    $('flow-amount').value = '';
    $('flow-note').value = '';
    renderBudget();
  });

  $('close-period').addEventListener('click', () => {
    closePeriod().catch((err) => notice(`Could not close: ${err.message}`));
  });

  wireSortHeaders('committed-head', sorts.committed, () => renderExpenses());

  // The calculator owns its own inputs; it just needs a way to persist.
  Mortgage.wire(() => queueSave('config'));

  $('refresh-rate').addEventListener('click', () => refreshMortgageSources());

  $('spend-date').value = today();
  $('oneoff-date').value = today();
}

async function boot() {
  try {
    const payload = await request('/api/state', 'GET');
    state.config = payload.config;
    state.meta = payload.meta || {};
    state.problems = payload.problems || [];
    applyTheme(state.config.theme);
    Mortgage.setConfig(state.config.mortgage, state.meta);
    state.periods = payload.periods || [];
    state.history = payload.history || { snapshots: [], events: [] };
    wire();
    // Normalise the URL on load so it always states the view, then render it.
    setView(viewFromUrl(), { push: false });
  } catch (err) {
    notice(`Could not load: ${err.message}`);
  }
}

boot();
