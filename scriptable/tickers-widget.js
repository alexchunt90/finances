// Variables used by Scriptable.
// These must be at the very top of the file. Comments below are ignored.
// icon-color: yellow; icon-glyph: chart-line;

/* ==========================================================================
   Finances — home-screen tickers.

   A row of tickers on the iPhone home screen: symbol, price, the change over
   a range, and a sparkline of that range, in the page's colours. Tapping
   opens the Investments tab.

   The widget parameter is the symbols to show, comma-separated:

       SPY, NVDA, BTC, GLD

   A bare crypto ticker (BTC, ETH) means the coin against the dollar, the same
   as on the page. Add a range token to change the window the change and the
   sparkline cover — 1d (the default), 1w, 1m, 3m, 1y, 3y or 10y:

       SPY, NVDA, BTC @1w

   With no parameter at all it shows the watchlist configured on the page.

   The server does the fetching — GET api/widget/tickers goes through the same
   cache the page reads, so a widget refreshing on the phone and a tab open on
   a laptop cost one upstream call between them. This file only draws.

   Requires the Tailscale app to be connected: the host resolves through
   MagicDNS and is reachable from nowhere else.

   Setup
     1. Scriptable → + → paste this in → name it "Tickers".
     2. Home screen → long press → + → Scriptable → small, medium or large.
     3. Long press the widget → Edit Widget → Script: Tickers,
        When Interacting: Run Script, Parameter: your symbols.
   ========================================================================== */

'use strict';

// --- configuration ----------------------------------------------------------

// Your own host. A tailnet name identifies your machine, so it stays out of the
// repository — fill this in on the phone, where the script actually lives.
const BASE = 'https://YOUR-HOST.ts.net/finances/';

// The section to land on. A fragment names a section and the app works out
// which tab holds it, so this does not have to say `?view=investments`.
const SECTION = 'tickers';
const OPEN_URL = `${BASE}#${SECTION}`;

// How often to ask iOS for a redraw. iOS decides what it actually grants — a
// widget is usually allowed a refresh every fifteen minutes or so, and never
// on demand — so the footer prints how old the figures really are.
const REFRESH_MINUTES = 15;

// How many rows each size holds before the rest are dropped.
const ROWS = { small: 3, medium: 5, large: 11 };

const RANGES = ['1d', '1w', '1m', '3m', '1y', '3y', '10y'];
const RANGE_LABELS = { '1d': '24h', '1w': '1W', '1m': '1M', '3m': '3M', '1y': '1Y', '3y': '3Y', '10y': '10Y' };

// --- palette ----------------------------------------------------------------
// styles.css, so the widget and the page read as the same thing.

const INK = new Color('#f4f4f6');
const INK_SOFT = new Color('#a2a2ad');
const INK_FAINT = new Color('#6b6b76');
const PAPER = new Color('#0a0a0b');
const RULE = new Color('#2c2c33');
const GAIN = new Color('#4ec9a5');
const WARN = new Color('#e8705f');

// --- the parameter ----------------------------------------------------------

/**
 * "SPY, NVDA, BTC @1w" → { symbols: 'SPY,NVDA,BTC', range: '1w' }.
 * The range token may come with or without its @, anywhere in the list; the
 * server does the real symbol parsing, this only lifts the range out.
 */
function parseParameter(raw) {
  let range = '1d';
  const symbols = [];
  for (const token of String(raw || '').split(/[,\s]+/)) {
    const t = token.trim();
    if (!t) continue;
    const asRange = t.replace(/^@/, '').toLowerCase();
    if (RANGES.includes(asRange)) { range = asRange; continue; }
    symbols.push(t.toUpperCase());
  }
  return { symbols: symbols.join(','), range };
}

// --- formatting -------------------------------------------------------------

/** Prices as the page prints them: two places, four under a dollar, $ for USD. */
function price(n, currency) {
  if (!Number.isFinite(n)) return '—';
  const sym = currency === 'USD' || !currency ? '$' : `${currency} `;
  const a = Math.abs(n);
  const body = a < 1 ? a.toFixed(4) : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : ''}${sym}${body}`;
}

const pct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%` : '—');

// --- fetching ---------------------------------------------------------------
//
// A widget that shows an error card the moment the phone leaves the tailnet is
// worse than one showing this morning's figures, so the last good payload is
// kept and reused. Stale data is labelled rather than passed off as current.
// Cached per parameter, so two widgets with different lists do not overwrite
// each other's fallback.

const fm = FileManager.local();

function cacheFile(symbols, range) {
  const slug = `${symbols}-${range}`.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);
  return fm.joinPath(fm.cacheDirectory(), `finances-tickers-${slug || 'watchlist'}.json`);
}

async function load(symbols, range) {
  const params = new URLSearchParams({ range });
  if (symbols) params.set('symbols', symbols);
  const req = new Request(`${BASE}api/widget/tickers?${params}`);
  req.timeoutInterval = 10;
  const file = cacheFile(symbols, range);
  try {
    const data = await req.loadJSON();
    if (!data || !Array.isArray(data.quotes)) throw new Error('unexpected payload');
    fm.writeString(file, JSON.stringify(data));
    return { data, stale: false };
  } catch (err) {
    if (!fm.fileExists(file)) return { data: null, stale: false, error: String(err) };
    try {
      return { data: JSON.parse(fm.readString(file)), stale: true };
    } catch (_) {
      return { data: null, stale: false, error: String(err) };
    }
  }
}

// --- drawing ----------------------------------------------------------------

/**
 * One quote's path over the range, with the baseline the change is measured
 * from ruled across. Coloured by direction, the same as the card on the page.
 */
function sparkImage(q, w, h) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const pts = q.points || [];
  if (pts.length < 2) return dc.getImage();

  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const vals = pts.map((p) => p[1]);
  if (Number.isFinite(q.rangeStart)) vals.push(q.rangeStart);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const X = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - 2) + 1;
  const Y = (v) => 2 + (1 - (v - lo) / span) * (h - 4);

  if (Number.isFinite(q.rangeStart)) {
    const base = new Path();
    base.move(new Point(0, Y(q.rangeStart)));
    base.addLine(new Point(w, Y(q.rangeStart)));
    dc.addPath(base);
    dc.setStrokeColor(RULE);
    dc.setLineWidth(1);
    dc.strokePath();
  }

  const line = new Path();
  line.move(new Point(X(pts[0][0]), Y(pts[0][1])));
  for (let i = 1; i < pts.length; i++) line.addLine(new Point(X(pts[i][0]), Y(pts[i][1])));
  dc.addPath(line);
  dc.setStrokeColor((q.rangeChange || 0) >= 0 ? GAIN : WARN);
  dc.setLineWidth(2);
  dc.strokePath();

  return dc.getImage();
}

// --- layout -----------------------------------------------------------------

function buildWidget(data, stale, range, error) {
  const family = config.widgetFamily || 'medium';
  const small = family === 'small';
  const w = new ListWidget();
  w.backgroundColor = PAPER;
  w.url = OPEN_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  w.setPadding(12, small ? 10 : 14, 10, small ? 10 : 14);

  if (!data || !data.quotes.length) {
    const t = w.addText(data ? 'Nothing to show' : 'Tickers unavailable');
    t.font = Font.mediumSystemFont(13);
    t.textColor = INK_SOFT;
    const h = w.addText(data
      ? 'Set the widget parameter to symbols, e.g. SPY, NVDA, BTC.'
      : 'Check that Tailscale is connected.');
    h.font = Font.systemFont(11);
    h.textColor = INK_FAINT;
    if (error) {
      const e = w.addText(String(error));
      e.font = Font.systemFont(9);
      e.textColor = INK_FAINT;
      e.lineLimit = 2;
    }
    return w;
  }

  // Header: what the change and sparkline cover.
  const head = w.addStack();
  head.centerAlignContent();
  const eyebrow = head.addText(small ? RANGE_LABELS[range] : `TICKERS · ${RANGE_LABELS[range]}`);
  eyebrow.font = Font.semiboldSystemFont(9);
  eyebrow.textColor = INK_FAINT;
  head.addSpacer();
  if (stale) {
    const mark = head.addText('stale');
    mark.font = Font.semiboldSystemFont(9);
    mark.textColor = WARN;
  } else if (data.generatedAt) {
    // As a date rather than a string: iOS keeps a relative date counting up on
    // its own, so the widget says how old the figures are without spending a
    // refresh to do it.
    const mark = head.addDate(new Date(data.generatedAt));
    mark.applyRelativeStyle();
    mark.font = Font.systemFont(9);
    mark.textColor = INK_FAINT;
  }

  w.addSpacer(6);

  const rows = data.quotes.slice(0, ROWS[family] || ROWS.medium);
  const rowStack = w.addStack();
  rowStack.layoutVertically();
  rowStack.spacing = small ? 4 : 5;

  for (const q of rows) {
    const row = rowStack.addStack();
    row.centerAlignContent();
    row.spacing = 6;

    const sym = row.addText(q.label || q.symbol);
    sym.font = Font.boldSystemFont(small ? 12 : 13);
    sym.textColor = new Color(data.accent || '#D4AF37');
    sym.lineLimit = 1;

    if (q.error) {
      row.addSpacer();
      const e = row.addText(q.error === 'not found' ? 'not found' : 'unavailable');
      e.font = Font.systemFont(10);
      e.textColor = INK_FAINT;
      continue;
    }

    if (!small) {
      row.addSpacer(2);
      const img = row.addImage(sparkImage(q, family === 'large' ? 120 : 84, 22));
      img.imageSize = new Size(family === 'large' ? 60 : 42, 11);
      img.resizable = true;
    }
    row.addSpacer();

    const figures = row.addStack();
    figures.layoutVertically();
    figures.spacing = 0;
    const p = figures.addText(price(q.price, q.currency));
    p.font = Font.mediumSystemFont(small ? 11 : 12);
    p.textColor = INK;
    p.lineLimit = 1;
    p.minimumScaleFactor = 0.7;
    p.rightAlignText();
    const ch = figures.addText(pct(q.rangeChangePct));
    ch.font = Font.systemFont(small ? 9 : 10);
    ch.textColor = Number.isFinite(q.rangeChange) ? (q.rangeChange >= 0 ? GAIN : WARN) : INK_FAINT;
    ch.rightAlignText();
  }

  w.addSpacer();
  return w;
}

// --- run --------------------------------------------------------------------

const { symbols, range } = parseParameter(args.widgetParameter);
const { data, stale, error } = await load(symbols, range);
const widget = buildWidget(data, stale, range, error);

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
