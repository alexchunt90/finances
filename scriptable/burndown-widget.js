// Variables used by Scriptable.
// These must be at the very top of the file. Comments below are ignored.
// icon-color: yellow; icon-glyph: chart-area;

/* ==========================================================================
   Finances — home-screen burndown.

   Draws the budget tab's burndown chart on the iPhone home screen: what is
   left to spend, stacked by where it is earmarked, solid to today and dimmed
   past it. Tapping opens the log-spending form in Chrome, since the reason to
   look at a burndown is usually that you have something to add to it.

   The server does the arithmetic — GET api/widget/burndown returns the same
   figures model.js gives the page, so the widget can never disagree with the
   chart it mirrors. This file only draws.

   Requires the Tailscale app to be connected: the host resolves through
   MagicDNS and is reachable from nowhere else.

   Setup
     1. Scriptable → + → paste this in → name it "Burndown".
     2. Home screen → long press → + → Scriptable → medium.
     3. Long press the widget → Edit Widget → Script: Burndown,
        When Interacting: Run Script.
   ========================================================================== */

'use strict';

// --- configuration ----------------------------------------------------------

// Your own host. A tailnet name identifies your machine, so it stays out of the
// repository — fill this in on the phone, where the script actually lives.
const BASE = 'https://YOUR-HOST.ts.net/finances/';

// The section to land on. A fragment names a section and the app works out
// which tab holds it, so this does not have to say `?view=budget` as well —
// and it keeps working if the form ever moves to another tab.
const SECTION = 'log-spending';

// A plain https link, so iOS opens it in whichever browser is set as default.
const OPEN_URL = `${BASE}#${SECTION}`;

// How long iOS should wait before asking for fresh figures. A request, not a
// promise: WidgetKit budgets refreshes across the day and will stretch this,
// often to twice it or more. Asking for less than you want costs nothing and
// is the only lever there is — so the footer prints how old the figures
// actually are rather than implying they are current.
const REFRESH_MINUTES = 15;

// --- palette ----------------------------------------------------------------
// styles.css, so the widget and the page read as the same thing.

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const INK_FAINT = new Color('#6b6b76');
const PAPER = new Color('#0a0a0b');
const WARN = new Color('#e8705f');

// --- formatting -------------------------------------------------------------

const usd = (n) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`;

// Local date, not UTC. The server may well be on UTC, and paydates.js is
// explicit that a UTC reading dates evening spending a day forward — which
// would step the widget's "today" a day ahead of the phone's.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- fetching ---------------------------------------------------------------
//
// A widget that shows an error card the moment the phone leaves the tailnet is
// worse than one showing this morning's figures, so the last good payload is
// kept and reused. Stale data is labelled rather than passed off as current.

const fm = FileManager.local();
const CACHE = fm.joinPath(fm.cacheDirectory(), 'finances-burndown.json');

async function load() {
  const req = new Request(`${BASE}api/widget/burndown?today=${todayISO()}`);
  req.timeoutInterval = 10;
  try {
    const data = await req.loadJSON();
    if (!data || !Array.isArray(data.points)) throw new Error('unexpected payload');
    fm.writeString(CACHE, JSON.stringify(data));
    return { data, stale: false };
  } catch (err) {
    if (!fm.fileExists(CACHE)) return { data: null, stale: false, error: String(err) };
    try {
      return { data: JSON.parse(fm.readString(CACHE)), stale: true };
    } catch (_) {
      return { data: null, stale: false, error: String(err) };
    }
  }
}

// --- the chart --------------------------------------------------------------

/**
 * The stacked burndown, drawn into an image.
 *
 * Coordinates are arbitrary — the image is scaled to whatever width iOS gives
 * the widget — so the canvas is sized by aspect ratio rather than by guessing
 * at device point sizes.
 *
 * Bands come pre-clamped at empty by the server: an overspent category has
 * already handed its overspend to the unplanned cushion, and drawing it
 * negative would count the same money twice. What the cushion is overdrawn by
 * arrives as `o` and hangs below the axis instead.
 */
function chartImage(data, w, h, { stacked = true } = {}) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const pts = data.points;
  const n = Math.max(1, data.period.days);
  const X = (day) => ((day - 1) / n) * w;

  const hi = Math.max(data.startTotal, 1);
  // Reach below zero rather than quietly clipping an overdrawn cushion away.
  const lo = -Math.max(0, ...pts.map((p) => p.o || 0));
  const Y = (v) => h - ((v - lo) / (hi - lo)) * h;

  const fillBand = (upper, lower, color, alpha) => {
    if (upper.every((v, i) => Math.abs(v - lower[i]) < 0.005)) return;
    const path = new Path();
    path.move(new Point(X(pts[0].d), Y(upper[0])));
    for (let i = 1; i < pts.length; i++) path.addLine(new Point(X(pts[i].d), Y(upper[i])));
    for (let i = pts.length - 1; i >= 0; i--) path.addLine(new Point(X(pts[i].d), Y(lower[i])));
    path.closeSubpath();
    dc.setFillColor(alpha == null ? new Color(color) : new Color(color, alpha));
    dc.addPath(path);
    dc.fillPath();
  };

  if (stacked) {
    let lower = pts.map(() => 0);
    data.series.forEach((sr, i) => {
      const upper = lower.map((v, j) => v + (pts[j].v[i] || 0));
      fillBand(upper, lower, sr.color);
      lower = upper;
    });
  } else {
    // Small widgets get the total alone. Nine bands in 155 points is a smear.
    const totals = pts.map((p) => p.v.reduce((t, v) => t + v, 0));
    fillBand(totals, pts.map(() => 0), data.accent, 0.85);
  }

  // What the cushion is overdrawn by. Only spending that already happened can
  // put anything here.
  if (lo < 0) {
    fillBand(pts.map(() => 0), pts.map((p) => -(p.o || 0)), '#e8705f', 0.55);
    dashedLine(dc, 0, Y(0), w, Y(0), WARN, Math.max(1, h / 120));
  }

  // Everything right of today is an assumption — an even share of each budget
  // and the unplanned cushion per day, plus whatever is already logged for
  // those days. One scrim says so once, rather than restyling every band.
  const edge = Math.min(data.period.day + 1, n + 1);
  if (edge <= n) {
    dc.setFillColor(new Color('#0a0a0b', 0.42));
    dc.fillRect(new Rect(X(edge), 0, w - X(edge), h));
  }
  // Spending exactly on pace — the whole period's money in equal daily shares,
  // computed on the server so this cannot disagree with the page. Flat through
  // the front of each day, sloping down across the back of it, which is the
  // shape the bands take; a true staircase's right angles have no counterpart
  // anywhere else in the drawing.
  //
  // Over the scrim, because the line is a fixed reference for the whole period
  // rather than a projection. The stack below it is spending faster than pace.
  if (pts.every((p) => typeof p.c === 'number')) {
    const ramp = (X(2) - X(1)) * 0.5;
    const line = [[X(pts[0].d), Y(pts[0].c)]];
    for (let i = 1; i < pts.length; i++) {
      line.push([X(pts[i].d) - ramp, Y(pts[i - 1].c)]);
      line.push([X(pts[i].d), Y(pts[i].c)]);
    }
    dashedPath(dc, line, new Color('#f4f4f6', 0.75), Math.max(1.5, h / 100), Math.max(4, (X(2) - X(1)) / 5));
  }

  dashedLine(dc, X(edge), 0, X(edge), h, INK_SOFT, Math.max(1.5, h / 100));

  // The day it all runs out, which is the whole reason for projecting.
  if (data.runsOutDay != null && data.runsOutDay <= n) {
    dashedLine(dc, X(data.runsOutDay), 0, X(data.runsOutDay), h, WARN, Math.max(1.5, h / 100));
  }

  return dc.getImage();
}

/**
 * DrawContext has no dash pattern, so the dashes are drawn as segments.
 *
 * The pattern runs continuously across the joints rather than restarting at
 * each one: the pace line is made of thirty-odd short flats and slopes, and
 * restarting at every joint would bunch dashes at the corners and read as a
 * different kind of line from the straight rules beside it.
 */
function dashedPath(dc, points, color, width, dash) {
  const gap = dash * 0.8;
  dc.setStrokeColor(color);
  dc.setLineWidth(width);
  // How far past the last dash start the previous segment ended.
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.01) continue;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    for (let d = -carry; d < len; d += dash + gap) {
      const from = Math.max(0, d);
      const to = Math.min(d + dash, len);
      if (to <= from) continue;
      const path = new Path();
      path.move(new Point(x1 + ux * from, y1 + uy * from));
      path.addLine(new Point(x1 + ux * to, y1 + uy * to));
      dc.addPath(path);
      dc.strokePath();
    }
    carry = (carry + len) % (dash + gap);
  }
}

/** A straight dashed rule, dashed in proportion to its own length. */
function dashedLine(dc, x1, y1, x2, y2, color, width) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return;
  dashedPath(dc, [[x1, y1], [x2, y2]], color, width, Math.max(4, len / 26));
}

/** A legend chip, matched to a band's colour. */
function swatchImage(hex) {
  const dc = new DrawContext();
  dc.size = new Size(24, 24);
  dc.opaque = false;
  dc.respectScreenScale = true;
  dc.setFillColor(new Color(hex));
  dc.fillRect(new Rect(0, 6, 24, 12));
  return dc.getImage();
}

// --- copy -------------------------------------------------------------------

/** The one line worth reading if you read nothing else. */
function verdict(data) {
  if (data.runsOutDay != null && data.runsOutDay <= data.period.day) {
    return { text: 'It is already gone.', warn: true };
  }
  if (data.runsOutDay != null && data.runsOutDay <= data.period.days) {
    return { text: `Runs out day ${data.runsOutDay} of ${data.period.days}`, warn: true };
  }
  if (!data.reliable) {
    return { text: `Too early to project — ${usd0(data.startTotal)} for ${data.period.days} days`, warn: false };
  }
  return { text: `Lasts the period, finishing on ${usd0(data.endTotal)}`, warn: false };
}

// --- layout -----------------------------------------------------------------

function buildWidget(data, stale) {
  const family = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.backgroundColor = PAPER;
  w.url = OPEN_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  w.setPadding(12, 12, 10, 12);

  if (!data) {
    const t = w.addText('Burndown unavailable');
    t.font = Font.mediumSystemFont(13);
    t.textColor = INK_SOFT;
    const h = w.addText('Check that Tailscale is connected.');
    h.font = Font.systemFont(11);
    h.textColor = INK_FAINT;
    return w;
  }

  const v = verdict(data);
  const small = family === 'small';

  // Header: what is left now, and where in the period that is.
  const head = w.addStack();
  head.centerAlignContent();
  const eyebrow = head.addText('BURNDOWN');
  eyebrow.font = Font.semiboldSystemFont(9);
  eyebrow.textColor = INK_FAINT;
  head.addSpacer();
  const day = head.addText(`DAY ${data.period.day} / ${data.period.days}`);
  day.font = Font.semiboldSystemFont(9);
  day.textColor = INK_FAINT;

  const big = w.addText(usd(data.leftNow));
  big.font = Font.mediumRoundedSystemFont(small ? 22 : 26);
  big.textColor = data.leftNow > 0 ? INK : WARN;
  big.minimumScaleFactor = 0.6;
  big.lineLimit = 1;

  const sub = w.addText(
    `${usd(data.perDay)} a day for ${data.period.remaining} more ` +
    `${data.period.remaining === 1 ? 'day' : 'days'}`
  );
  sub.font = Font.systemFont(small ? 9 : 10);
  sub.textColor = INK_SOFT;
  sub.lineLimit = 1;
  sub.minimumScaleFactor = 0.7;

  w.addSpacer(small ? 5 : 7);

  // The chart. A fitted image scales to whichever axis runs out first, so the
  // canvas is cut slightly flatter than the space each family leaves for it:
  // too flat wastes a few points of height, too tall pulls the chart in from
  // both edges and leaves it floating in the middle of the widget.
  const geom = small ? [320, 130] : family === 'large' ? [660, 330] : [660, 120];
  const img = w.addImage(chartImage(data, geom[0], geom[1], { stacked: !small }));
  img.applyFittingContentMode();
  img.containerRelativeShape = false;

  if (family === 'large') {
    w.addSpacer(8);
    legend(w, data);
  }

  w.addSpacer(small ? 4 : 6);

  const foot = w.addStack();
  foot.centerAlignContent();
  const line = foot.addText(v.text);
  line.font = Font.systemFont(small ? 9 : 10);
  line.textColor = v.warn ? WARN : INK_SOFT;
  line.lineLimit = 1;
  line.minimumScaleFactor = 0.7;
  if (!small) {
    foot.addSpacer();
    // How old the figures are, which is the honest thing to show when iOS
    // decides how often this redraws.
    //
    // As a date rather than a string: a rendered timestamp is frozen at the
    // moment it was drawn, so it would read "just now" for as long as the
    // widget sat unrefreshed — the one moment it most needs to say otherwise.
    // In relative style iOS keeps the figure counting up on its own, without
    // spending a refresh to do it.
    if (stale) {
      const mark = foot.addText(`stale · ${data.asOf}`);
      mark.font = Font.systemFont(9);
      mark.textColor = WARN;
    } else {
      const mark = foot.addDate(new Date(data.generatedAt));
      mark.applyRelativeStyle();
      mark.font = Font.systemFont(9);
      mark.textColor = INK_FAINT;
    }
  }

  if (data.provisional) {
    const p = w.addText('No period open yet — showing the one the app would start.');
    p.font = Font.systemFont(9);
    p.textColor = INK_FAINT;
    p.lineLimit = 2;
  }

  return w;
}

/**
 * Large only: what each band is, and what is left in it. Two fixed columns
 * rather than a flowing row, so the figures line up down the page.
 */
function legend(w, data) {
  const live = data.series.filter((s) => s.left > 0.005);
  if (!live.length) return;
  const half = Math.ceil(live.length / 2);
  const row = w.addStack();
  row.spacing = 12;
  for (const column of [live.slice(0, half), live.slice(half)]) {
    const col = row.addStack();
    col.layoutVertically();
    col.spacing = 2;
    for (const sr of column) {
      const cell = col.addStack();
      cell.centerAlignContent();
      cell.spacing = 5;
      const sw = cell.addImage(swatchImage(sr.color));
      sw.imageSize = new Size(9, 9);
      const name = cell.addText(sr.name);
      name.font = Font.systemFont(10);
      name.textColor = INK_SOFT;
      name.lineLimit = 1;
      name.minimumScaleFactor = 0.8;
      cell.addSpacer();
      const val = cell.addText(usd0(sr.left));
      val.font = Font.mediumSystemFont(10);
      val.textColor = INK;
    }
    // Keeps a short second column the same width as the first.
    col.addSpacer();
  }
}

// --- run --------------------------------------------------------------------

const { data, stale } = await load();
const widget = buildWidget(data, stale);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Tapped inside Scriptable: preview at the size being designed for.
  const family = config.widgetFamily || 'medium';
  if (family === 'small') await widget.presentSmall();
  else if (family === 'large') await widget.presentLarge();
  else await widget.presentMedium();
}
Script.complete();
