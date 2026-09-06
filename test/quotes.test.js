'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { ROOT, readExample, clone } = require('./helpers.js');
const Quotes = require(path.join(ROOT, 'lib/quotes.js'));

/** A Yahoo chart result shaped like the real thing, with a known price path. */
function yahoo(symbol, closes, { prevClose = 100, start = 1_700_000_000, step = 300, price } = {}) {
  return {
    chart: {
      result: [{
        meta: {
          symbol, currency: 'USD', instrumentType: 'ETF', exchangeName: 'PCX',
          longName: `${symbol} Long Name`, shortName: `${symbol} Short`,
          regularMarketPrice: price ?? closes[closes.length - 1],
          chartPreviousClose: prevClose,
          regularMarketTime: start + step * (closes.length - 1),
          dataGranularity: '5m',
        },
        timestamp: closes.map((_, i) => start + i * step),
        indicators: { quote: [{ close: closes }] },
      }],
      error: null,
    },
  };
}

describe('symbols', () => {
  test('are upper-cased, trimmed, de-duplicated, and kept in order', () => {
    const out = Quotes.parseSymbols(' spy, nvda ,SPY,, gld ');
    assert.deepEqual(out.map((s) => s.symbol), ['SPY', 'NVDA', 'GLD']);
  });

  test('a bare crypto ticker means the coin, not the ETF that shares its letters', () => {
    // On Yahoo, BTC is a Grayscale trust. Nobody typing BTC into a watchlist
    // means that, so it maps to the dollar pair — but the label stays as typed.
    const [btc] = Quotes.parseSymbols('btc');
    assert.equal(btc.symbol, 'BTC-USD');
    assert.equal(btc.label, 'BTC');
    // Typed with a suffix, it is passed through: that is how to reach the ETF.
    assert.equal(Quotes.parseSymbols('BTC-USD, ETH-EUR').map((s) => s.symbol).join(), 'BTC-USD,ETH-EUR');
    // The coin typed both ways is one symbol, not two cards.
    assert.equal(Quotes.parseSymbols('BTC, BTC-USD').length, 1);
  });

  test('share classes, indices, currency pairs and futures survive; junk does not', () => {
    const ok = ['BRK-B', 'BRK.B', '^GSPC', 'EURUSD=X', 'GC=F'];
    assert.deepEqual(Quotes.parseSymbols(ok.join(',')).map((s) => s.symbol), ok);
    assert.deepEqual(Quotes.parseSymbols('<script>, ../etc, SPY NVDA, -X, a'.split(',')), [{ symbol: 'A', label: 'A' }]);
    assert.deepEqual(Quotes.parseSymbols(''), []);
    assert.deepEqual(Quotes.parseSymbols(null), []);
  });

  test('a list is capped, so a URL cannot fan out into hundreds of upstream calls', () => {
    const many = Array.from({ length: 100 }, (_, i) => `S${i}`);
    assert.equal(Quotes.parseSymbols(many).length, Quotes.MAX_SYMBOLS);
  });

  test('the watchlist flattens every group in display order', () => {
    const config = clone(readExample('config.json'));
    // As typed, so the cards keep the label the user wrote; get() maps BTC to
    // the coin the same way it does for a widget parameter.
    assert.deepEqual(Quotes.watchlistSymbols(config), ['SPY', 'VFIAX', 'EEM', 'NVDA', 'GLD', 'BTC']);
    assert.deepEqual(Quotes.watchlistSymbols({}), []);
    assert.deepEqual(Quotes.watchlistSymbols({ investments: { groups: [{ symbols: 'not a list' }] } }), []);
  });
});

describe('shaping', () => {
  test('the 24h change is against the previous close, not the first intraday point', () => {
    const body = yahoo('SPY', [101, 102, 103], { prevClose: 100 });
    const q = Quotes.shapeQuote(body.chart.result[0], { label: 'SPY', rangeKey: '1d' });
    assert.equal(q.price, 103);
    assert.equal(q.prevClose, 100);
    assert.equal(q.change, 3);
    assert.equal(q.changePct, 3);
    // The first point is already a step up from the close. Measuring from it
    // would report +2% on a day that is up 3%.
    assert.equal(q.rangeStart, 100);
    assert.equal(q.rangeChange, 3);
    assert.equal(q.rangeChangePct, 3);
  });

  test('a longer range measures from its first point', () => {
    const body = yahoo('SPY', [80, 90, 100, 120], { prevClose: 110 });
    const q = Quotes.shapeQuote(body.chart.result[0], { label: 'SPY', rangeKey: '1y' });
    assert.equal(q.rangeStart, 80);
    assert.equal(q.rangeChange, 40);
    assert.equal(q.rangeChangePct, 50);
    // While the session change is still what the ticker shows.
    assert.equal(q.change, 10);
    assert.equal(q.high, 120);
    assert.equal(q.low, 80);
  });

  test('gaps are dropped, not drawn as zero', () => {
    const body = yahoo('VFIAX', [10, null, 11, null, 12]);
    const q = Quotes.shapeQuote(body.chart.result[0], { label: 'VFIAX', rangeKey: '1w' });
    assert.deepEqual(q.points.map((p) => p[1]), [10, 11, 12]);
    assert.ok(q.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  });

  test('thinning keeps the last point, which the headline is quoted from', () => {
    const closes = Array.from({ length: 523 }, (_, i) => 100 + i);
    const body = yahoo('SPY', closes, { step: 604800 });
    const q = Quotes.shapeQuote(body.chart.result[0], { label: 'SPY', rangeKey: '10y', maxPoints: 80 });
    assert.ok(q.points.length <= 81, `${q.points.length} points`);
    assert.equal(q.points[0][1], 100);
    assert.equal(q.points[q.points.length - 1][1], 622);
    assert.deepEqual(Quotes.thin([1, 2, 3], 10), [1, 2, 3]);
  });

  test('sub-dollar prices keep enough places to show a move', () => {
    const body = yahoo('DOGE-USD', [0.12345, 0.12399], { prevClose: 0.1201 });
    const q = Quotes.shapeQuote(body.chart.result[0], { label: 'DOGE', rangeKey: '1d' });
    assert.equal(q.price, 0.124);
    assert.equal(q.prevClose, 0.1201);
  });

  test('the URL asks Yahoo for named windows, or explicit timestamps where it has no name', () => {
    const now = 1_800_000_000;
    const named = new URL(Quotes.chartUrl('https://x/chart', 'SPY', '1d', now));
    assert.equal(named.pathname, '/chart/SPY');
    assert.equal(named.searchParams.get('range'), '1d');
    assert.equal(named.searchParams.get('interval'), '5m');
    const explicit = new URL(Quotes.chartUrl('https://x/chart', 'BTC-USD', '3y', now));
    assert.equal(explicit.searchParams.get('range'), null);
    assert.equal(Number(explicit.searchParams.get('period2')), now);
    assert.equal(Number(explicit.searchParams.get('period1')), now - 3 * 365 * 86400);
    // A symbol with a caret has to survive the URL.
    assert.match(Quotes.chartUrl('https://x/chart', '^GSPC', '1d', now), /\/chart\/%5EGSPC\?/);
  });

  test('every range the page offers is one the module knows', () => {
    assert.deepEqual(Quotes.RANGE_KEYS, ['1d', '1w', '1m', '3m', '1y', '3y', '10y']);
    for (const key of Quotes.RANGE_KEYS) {
      const spec = Quotes.RANGES[key];
      assert.ok(spec.range || spec.days, `${key} has no window`);
      assert.ok(spec.interval && spec.ttl > 0 && spec.label, `${key} is incomplete`);
    }
  });
});

describe('the service', () => {
  /** A fetcher that answers from a table and counts what it was asked. */
  function stub(table) {
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const answer = table[symbol];
      if (typeof answer === 'function') return answer();
      if (!answer) {
        const err = new Error('No data found, symbol may be delisted');
        err.status = 404;
        throw err;
      }
      return answer;
    };
    return { fetcher, calls };
  }

  test('one bad symbol reports itself and the rest come back whole', async () => {
    const { fetcher } = stub({ SPY: yahoo('SPY', [100, 101]) });
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher });
    const out = await svc.get('SPY, NOPE', '1d');
    assert.equal(out.range, '1d');
    assert.equal(out.quotes.length, 2);
    assert.equal(out.quotes[0].price, 101);
    assert.equal(out.quotes[1].symbol, 'NOPE');
    assert.equal(out.quotes[1].error, 'not found');
  });

  test('answers are cached for the range TTL, and shared between simultaneous callers', async () => {
    let t = 1_800_000_000_000;
    const { fetcher, calls } = stub({ SPY: yahoo('SPY', [100, 101]) });
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher, now: () => t });
    await Promise.all([svc.get('SPY', '1d'), svc.get('SPY', '1d'), svc.get('spy', '1d')]);
    assert.equal(calls.length, 1, 'three callers at once, one upstream call');
    t += 30_000;
    const again = await svc.get('SPY', '1d');
    assert.equal(calls.length, 1, 'inside the 45s TTL');
    assert.equal(again.quotes[0].cached, true);
    t += 30_000;
    await svc.get('SPY', '1d');
    assert.equal(calls.length, 2, 'past it');
    // A different range is a different question.
    await svc.get('SPY', '1y');
    assert.equal(calls.length, 3);
  });

  test('a typo is remembered too, so it does not hit upstream once a minute until fixed', async () => {
    const { fetcher, calls } = stub({});
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher });
    await svc.get('NOPE', '1d');
    await svc.get('NOPE', '1d');
    assert.equal(calls.length, 1);
  });

  test('when upstream fails, the last good answer is served and marked stale', async () => {
    let t = 1_800_000_000_000;
    let down = false;
    const { fetcher } = stub({
      SPY: () => { if (down) throw new Error('ECONNRESET'); return yahoo('SPY', [100, 101]); },
      QQQ: () => { throw new Error('ECONNRESET'); },
    });
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher, now: () => t });
    const first = await svc.get('SPY', '1d');
    assert.equal(first.quotes[0].stale, false);
    down = true;
    t += 60_000;
    const later = await svc.get('SPY', '1d');
    assert.equal(later.quotes[0].price, 101);
    assert.equal(later.quotes[0].stale, true);
    assert.equal(later.quotes[0].error, undefined);
    // With nothing held, the failure is reported rather than invented around.
    const cold = await svc.get('QQQ', '1d');
    assert.equal(cold.quotes[0].error, 'ECONNRESET');
  });

  test('the label rides along, even when the cache was filled under another spelling', async () => {
    const { fetcher } = stub({ 'BTC-USD': yahoo('BTC-USD', [70000, 71000]) });
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher });
    const a = await svc.get('BTC-USD', '1d');
    const b = await svc.get('BTC', '1d');
    assert.equal(a.quotes[0].label, 'BTC-USD');
    assert.equal(b.quotes[0].label, 'BTC');
    assert.equal(b.quotes[0].symbol, 'BTC-USD');
  });

  test('an unknown range falls back to the default rather than erroring', async () => {
    const { fetcher } = stub({ SPY: yahoo('SPY', [100, 101]) });
    const svc = Quotes.createQuotes({ baseUrl: 'https://x/chart', fetch: fetcher });
    const out = await svc.get('SPY', 'forever');
    assert.equal(out.range, Quotes.DEFAULT_RANGE);
  });

  test('the default fetcher reads the error Yahoo puts in a 404 body', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      await assert.rejects(
        Quotes.fetchJson(`http://127.0.0.1:${port}/NOPE`),
        (err) => err.status === 404 && /delisted/.test(err.message),
      );
    } finally {
      server.close();
    }
  });
});
