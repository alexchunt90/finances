'use strict';

/* ---------------------------------------------------------------------------
 * Market quotes for the Investments tab and the tickers widget.
 *
 * Yahoo's chart endpoint is the one free source that covers everything the
 * watchlist is likely to hold — stocks, ETFs, mutual funds and crypto — in one
 * shape and without a key. It is unofficial, so everything that could change
 * about it is kept in this file: the URL, the range table, and the mapping
 * from its response to the flat payload the page and the widget draw.
 *
 * The browser never talks to Yahoo. The server fetches, caches, and hands over
 * a small normalised payload, so a page polling every minute and a widget on
 * a phone add up to one upstream request per symbol per range per TTL.
 * ------------------------------------------------------------------------- */

const DAY = 86400;

/**
 * The ranges the page offers, and what to ask Yahoo for each. `range` uses
 * Yahoo's named windows, which end at the latest session; `days` uses explicit
 * timestamps instead, for windows Yahoo has no name for. The interval is the
 * finest that keeps the point count in the low hundreds — a decade at daily
 * resolution is 2,500 points nobody can see on a chart 760 units wide.
 *
 * `ttl` is how long a fetched answer is served before asking again. Intraday
 * moves by the minute; a ten-year line does not change shape in an hour.
 */
const RANGES = {
  '1d':  { label: '24h', range: '1d',  interval: '5m',  ttl: 45 },
  '1w':  { label: '1W',  range: '5d',  interval: '30m', ttl: 300 },
  '1m':  { label: '1M',  range: '1mo', interval: '1h',  ttl: 900 },
  '3m':  { label: '3M',  range: '3mo', interval: '1d',  ttl: 1800 },
  '1y':  { label: '1Y',  range: '1y',  interval: '1d',  ttl: 3600 },
  '3y':  { label: '3Y',  days: 3 * 365, interval: '1wk', ttl: 3600 },
  '10y': { label: '10Y', range: '10y', interval: '1wk', ttl: 3600 },
};
const RANGE_KEYS = Object.keys(RANGES);
const DEFAULT_RANGE = '1d';

/**
 * A bare crypto ticker is ambiguous on Yahoo — "BTC" is a Grayscale ETF, and
 * Bitcoin itself is "BTC-USD". Someone typing BTC into a watchlist means the
 * coin, so the common ones are mapped to their dollar pair. Anything typed
 * with a suffix already is passed through untouched, which is how to reach
 * the ETF, or a pair against another currency.
 */
const CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LTC', 'BNB', 'AVAX', 'DOT',
  'LINK', 'MATIC', 'BCH', 'XLM', 'UNI', 'ATOM', 'TRX', 'SHIB', 'NEAR', 'XMR',
]);

// Yahoo symbols: letters and digits, plus the punctuation of share classes
// (BRK-B, BRK.B), indices (^GSPC), currency pairs (EURUSD=X) and futures (GC=F).
const SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^&]{0,19}$/;
const MAX_SYMBOLS = 40;

/**
 * "spy, nvda,btc" → [{ symbol: 'SPY', label: 'SPY' }, …, { symbol: 'BTC-USD', label: 'BTC' }].
 * Upper-cased, trimmed, de-duplicated, and anything that could not be a symbol
 * dropped rather than sent upstream to fail. Accepts an array as well as a
 * comma-separated string, since config stores a list and a URL carries text.
 */
function parseSymbols(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const label = String(item || '').trim().toUpperCase();
    if (!SYMBOL.test(label)) continue;
    const symbol = CRYPTO.has(label) ? `${label}-USD` : label;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, label });
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

/**
 * Every symbol in every group of the config's watchlist, in display order,
 * as typed — the labels, ready to be parsed again by get(). Parsed here only
 * to drop junk and duplicates.
 */
function watchlistSymbols(config) {
  const groups = (config && config.investments && config.investments.groups) || [];
  return parseSymbols(groups.flatMap((g) => (Array.isArray(g.symbols) ? g.symbols : []))).map((s) => s.label);
}

const round = (n, places = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Prices under a dollar need more places to show a move at all. */
const price = (n) => (Number.isFinite(n) && Math.abs(n) < 1 ? round(n, 4) : round(n, 2));

/**
 * Keep every `stride`th point plus the last, so a long series fits a drawing
 * budget without losing the point the headline figure is quoted from.
 */
function thin(points, maxPoints) {
  if (!maxPoints || points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const kept = points.filter((_, i) => i % stride === 0);
  if (kept[kept.length - 1] !== points[points.length - 1]) kept.push(points[points.length - 1]);
  return kept;
}

/**
 * One Yahoo chart result → the flat quote the page and the widget draw.
 *
 * Two changes are reported. `change` is against the previous close, which is
 * what a ticker conventionally shows and what the 24h view is about.
 * `rangeChange` is over the window asked for, measured from its first point —
 * except for the 24h window, where the first intraday point is already a step
 * away from the close and the honest baseline is the close itself.
 */
function shapeQuote(result, { label, rangeKey, maxPoints }) {
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const closes = ((result.indicators || {}).quote || [{}])[0].close || [];

  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const v = closes[i];
    // Gaps come through as nulls — a halted stock, a fund with one print a
    // day asked for at 30-minute resolution. Dropped, not drawn as zero.
    if (Number.isFinite(v)) points.push([ts[i], price(v)]);
  }

  const last = points.length ? points[points.length - 1][1] : null;
  const current = Number.isFinite(meta.regularMarketPrice) ? price(meta.regularMarketPrice) : last;
  const prevClose = Number.isFinite(meta.chartPreviousClose) ? price(meta.chartPreviousClose)
    : Number.isFinite(meta.previousClose) ? price(meta.previousClose) : null;

  const base = rangeKey === '1d' && prevClose != null ? prevClose : points.length ? points[0][1] : null;
  const pct = (from, to) => (from ? round(((to - from) / from) * 100, 2) : null);

  let high = null, low = null;
  for (const [, v] of points) {
    if (high == null || v > high) high = v;
    if (low == null || v < low) low = v;
  }

  return {
    symbol: meta.symbol || label,
    label,
    name: meta.longName || meta.shortName || meta.symbol || label,
    currency: meta.currency || 'USD',
    type: meta.instrumentType || null,
    exchange: meta.exchangeName || null,
    price: current,
    prevClose,
    change: current != null && prevClose != null ? round(current - prevClose) : null,
    changePct: current != null && prevClose != null ? pct(prevClose, current) : null,
    // Seconds since the epoch, as Yahoo reports it: when the price was last set.
    asOf: Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : (points.length ? points[points.length - 1][0] : null),
    range: rangeKey,
    interval: meta.dataGranularity || RANGES[rangeKey].interval,
    rangeStart: base,
    rangeChange: current != null && base != null ? round(current - base) : null,
    rangeChangePct: current != null && base != null ? pct(base, current) : null,
    high,
    low,
    points: thin(points, maxPoints),
  };
}

/** Yahoo's URL for one symbol over one of the ranges above. */
function chartUrl(baseUrl, symbol, rangeKey, nowSeconds) {
  const spec = RANGES[rangeKey];
  const params = new URLSearchParams({ interval: spec.interval, includePrePost: 'false' });
  if (spec.range) {
    params.set('range', spec.range);
  } else {
    params.set('period1', String(nowSeconds - spec.days * DAY));
    params.set('period2', String(nowSeconds));
  }
  return `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(symbol)}?${params}`;
}

/** The default upstream fetcher. Yahoo answers a bare client with 429s, hence the UA. */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (finances; +https://github.com/alexchunt90/finances)', Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(
        (body && body.chart && body.chart.error && body.chart.error.description) || `HTTP ${res.status}`,
      );
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The quote service: fetch on demand, cache per symbol and range for that
 * range's TTL, and share one in-flight request between callers who ask at the
 * same moment. When the upstream fails and a stale answer is held, the stale
 * answer is served and marked, the same way the widgets treat a lost tailnet —
 * this morning's figure beats an error card.
 */
function createQuotes({ baseUrl, fetch: fetcher = fetchJson, now = () => Date.now() } = {}) {
  const base = baseUrl || 'https://query1.finance.yahoo.com/v8/finance/chart';
  const cache = new Map();
  const inFlight = new Map();

  async function one({ symbol, label }, rangeKey, maxPoints) {
    const key = `${symbol}|${rangeKey}`;
    const held = cache.get(key);
    const ttlMs = RANGES[rangeKey].ttl * 1000;
    if (held && now() - held.at < ttlMs) return { ...held.quote, label, stale: false, cached: true };

    if (!inFlight.has(key)) {
      inFlight.set(key, (async () => {
        try {
          const body = await fetcher(chartUrl(base, symbol, rangeKey, Math.floor(now() / 1000)));
          const result = body && body.chart && body.chart.result && body.chart.result[0];
          if (!result) {
            const err = new Error((body && body.chart && body.chart.error && body.chart.error.description) || 'no data');
            err.status = 404;
            throw err;
          }
          const quote = shapeQuote(result, { label, rangeKey, maxPoints });
          cache.set(key, { at: now(), quote });
          return { ...quote, stale: false, cached: false };
        } catch (err) {
          // A symbol Yahoo has never heard of is an answer, not an outage, and
          // it is remembered for the TTL so a typo does not hit upstream once a
          // minute until it is fixed.
          if (err.status === 404) {
            const quote = { symbol, label, error: 'not found' };
            cache.set(key, { at: now(), quote });
            return { ...quote, stale: false, cached: false };
          }
          if (held) return { ...held.quote, stale: true, cached: true };
          return { symbol, label, error: err.message || 'unavailable', stale: false, cached: false };
        } finally {
          inFlight.delete(key);
        }
      })());
    }
    const out = await inFlight.get(key);
    return { ...out, label };
  }

  /**
   * Every symbol in parallel. One bad symbol reports its own `error` and the
   * rest come back whole — a watchlist is not all-or-nothing.
   */
  async function get(symbols, rangeKey = DEFAULT_RANGE, { maxPoints = 240 } = {}) {
    const range = RANGES[rangeKey] ? rangeKey : DEFAULT_RANGE;
    const list = parseSymbols(symbols);
    const quotes = await Promise.all(list.map((s) => one(s, range, maxPoints)));
    return {
      generatedAt: new Date(now()).toISOString(),
      range,
      interval: RANGES[range].interval,
      ranges: RANGE_KEYS.map((k) => ({ key: k, label: RANGES[k].label })),
      quotes,
    };
  }

  return { get, parseSymbols, cache };
}

module.exports = {
  RANGES, RANGE_KEYS, DEFAULT_RANGE, MAX_SYMBOLS,
  parseSymbols, watchlistSymbols, shapeQuote, thin, chartUrl, createQuotes, fetchJson,
};
