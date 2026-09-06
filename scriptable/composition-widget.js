// Variables used by Scriptable.
// These must be at the very top of the file. Comments below are ignored.
// icon-color: yellow; icon-glyph: layer-group;

/* ==========================================================================
   Finances — home-screen asset composition.

   Draws the assets tab's composition chart on the iPhone home screen: net
   worth over the whole history, stacked by account, illiquid on the bottom in
   cool shades and liquid above in warm. The warm band is the part you could
   actually reach. Tapping opens the same chart, full size, in Chrome.

   The server does the arithmetic — GET api/widget/composition returns the same
   series, in the same order and colours, that model.js gives the page, so the
   widget can never disagree with the chart it mirrors. This file only draws.

   Requires the Tailscale app to be connected: the host resolves through
   MagicDNS and is reachable from nowhere else.

   Setup
     1. Scriptable → + → paste this in → name it "Composition".
     2. Home screen → long press → + → Scriptable → medium.
     3. Long press the widget → Edit Widget → Script: Composition,
        When Interacting: Run Script.
   ========================================================================== */

'use strict';

// --- configuration ----------------------------------------------------------

// Your own host. A tailnet name identifies your machine, so it stays out of the
// repository — fill this in on the phone, where the script actually lives.
const BASE = 'https://YOUR-HOST.ts.net/finances/';

// The section to land on. A fragment names a section and the app works out
// which tab holds it, so this does not have to say `?view=assets` as well —
// and it keeps working if the chart ever moves to another tab.
const SECTION = 'composition';

// A plain https link, so iOS opens it in whichever browser is set as default.
const OPEN_URL = `${BASE}#${SECTION}`;

// Balances move on markets and on period closes, neither of which is minute to
// minute, so this asks for less than the burndown does. Either way iOS decides;
// the footer prints how old the figures actually are.
const REFRESH_MINUTES = 60;

// --- palette ----------------------------------------------------------------
// styles.css, so the widget and the page read as the same thing.

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const INK_FAINT = new Color('#6b6b76');
const PAPER = new Color('#0a0a0b');
const GAIN = new Color('#5fb894');
const WARN = new Color('#e8705f');

// --- formatting -------------------------------------------------------------

const usd0 = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`;

/** Six figures on a phone widget is a wall of digits. $573k reads at a glance. */
function compact(n) {
  const v = Math.abs(n || 0);
  const sign = n < 0 ? '-' : '';
  if (v >= 1000000) return `${sign}$${(v / 1000000).toFixed(2)}M`;
  if (v >= 10000) return `${sign}$${Math.round(v / 1000)}k`;
  return `${sign}${usd0(v)}`;
}

const signed = (n) => `${n >= 0 ? '+' : '−'}${compact(Math.abs(n))}`;

// Local date, not UTC. The server may well be on UTC, and paydates.js is
// explicit that a UTC reading dates evening entries a day forward.
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
const CACHE = fm.joinPath(fm.cacheDirectory(), 'finances-composition.json');

async function load() {
  const req = new Request(`${BASE}api/widget/composition?today=${todayISO()}`);
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
 * The stacked composition, drawn into an image.
 *
 * Coordinates are arbitrary — the image is scaled to whatever width iOS gives
 * the widget — so the canvas is sized by aspect ratio rather than by guessing
 * at device point sizes.
 *
 * The x axis is time, and the history is not evenly spaced: a decade of
 * snapshots clusters where balances were entered often. Positioning by date
 * rather than by index keeps the shape honest, so a gap in the record reads as
 * a gap rather than as a steady stretch.
 */
function chartImage(data, w, h, { stacked = true } = {}) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const pts = data.points;
  const t0 = Date.parse(pts[0].t);
  const t1 = Date.parse(pts[pts.length - 1].t);
  const span = t1 - t0 || 1;
  const X = (iso) => ((Date.parse(iso) - t0) / span) * w;

  const totals = pts.map((p) => p.v.reduce((a, b) => a + b, 0));
  const hi = Math.max(...totals, 1);
  const Y = (v) => h - (v / hi) * h;

  const fillBand = (upper, lower, color, alpha) => {
    if (upper.every((v, i) => Math.abs(v - lower[i]) < 0.005)) return;
    const path = new Path();
    path.move(new Point(X(pts[0].t), Y(upper[0])));
    for (let i = 1; i < pts.length; i++) path.addLine(new Point(X(pts[i].t), Y(upper[i])));
    for (let i = pts.length - 1; i >= 0; i--) path.addLine(new Point(X(pts[i].t), Y(lower[i])));
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
    // Small widgets get the total alone. Eleven bands in 155 points is a smear.
    fillBand(totals, pts.map(() => 0), data.accent, 0.85);
  }

  return dc.getImage();
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
  if (!data.yearAgo) {
    return { text: `${data.span.snapshots} snapshots since ${data.span.from.slice(0, 4)}`, tone: 'flat' };
  }
  const change = data.latest.total - data.yearAgo.total;
  const pct = data.yearAgo.total > 0 ? (change / data.yearAgo.total) * 100 : 0;
  return {
    text: `${signed(change)} over the past year${data.yearAgo.total > 0 ? ` · ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%` : ''}`,
    tone: change >= 0 ? 'gain' : 'warn',
  };
}

// --- layout -----------------------------------------------------------------

function buildWidget(data, stale) {
  const family = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.backgroundColor = PAPER;
  w.url = OPEN_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  w.setPadding(12, 12, 10, 12);

  if (!data || data.empty) {
    const t = w.addText(data && data.empty ? 'No history yet' : 'Composition unavailable');
    t.font = Font.mediumSystemFont(13);
    t.textColor = INK_SOFT;
    const h = w.addText(data && data.empty
      ? 'Close a period, or load a history file.'
      : 'Check that Tailscale is connected.');
    h.font = Font.systemFont(11);
    h.textColor = INK_FAINT;
    return w;
  }

  const v = verdict(data);
  const small = family === 'small';

  // Header: what it is, and how much of it you could actually reach.
  const head = w.addStack();
  head.centerAlignContent();
  const eyebrow = head.addText('NET WORTH');
  eyebrow.font = Font.semiboldSystemFont(9);
  eyebrow.textColor = INK_FAINT;
  head.addSpacer();
  const liq = head.addText(`${compact(data.latest.liquid)} LIQUID`);
  liq.font = Font.semiboldSystemFont(9);
  liq.textColor = INK_FAINT;

  const big = w.addText(usd0(data.latest.total));
  big.font = Font.mediumRoundedSystemFont(small ? 22 : 26);
  big.textColor = INK;
  big.minimumScaleFactor = 0.6;
  big.lineLimit = 1;

  const sub = w.addText(
    `${compact(data.latest.illiquid)} illiquid · ${compact(data.latest.liquid)} within reach`
  );
  sub.font = Font.systemFont(small ? 9 : 10);
  sub.textColor = INK_SOFT;
  sub.lineLimit = 1;
  sub.minimumScaleFactor = 0.7;

  w.addSpacer(small ? 5 : 7);

  // The chart. A fitted image scales to whichever axis runs out first, so the
  // canvas is cut slightly flatter than the space each family leaves for it.
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
  line.textColor = v.tone === 'gain' ? GAIN : v.tone === 'warn' ? WARN : INK_SOFT;
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

  return w;
}

/**
 * Large only: what each band is, and what is in it. Two fixed columns rather
 * than a flowing row, so the figures line up down the page. Empty accounts are
 * dropped — a legend entry with nothing to point at is noise.
 */
function legend(w, data) {
  const live = data.series.filter((s) => s.value > 0.005);
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
      const val = cell.addText(compact(sr.value));
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
