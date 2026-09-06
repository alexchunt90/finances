'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ROOT, tempState, freePort } = require('./helpers.js');

let proc, base, stateDir, banner;

before(async () => {
  stateDir = await tempState();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      STATE_DIR: stateDir,
      // Emptied deliberately. server.js reads the .env sitting beside it, and a
      // machine configured against a real bucket would otherwise point this
      // whole suite at live money.
      S3_BUCKET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  banner = '';
  proc.stdout.on('data', (d) => { banner += d; });
  proc.stderr.on('data', (d) => { banner += d; });

  const deadline = Date.now() + 15000;
  for (;;) {
    if (banner.includes('Finances →')) break;
    if (Date.now() > deadline) throw new Error(`server did not start:\n${banner}`);
    await new Promise((r) => setTimeout(r, 50));
  }
});

after(async () => {
  if (proc) proc.kill();
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);
const put = (p, body) => fetch(base + p, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const openPeriod = async () => (await (await get('/api/state')).json()).periods.find((p) => p.status !== 'closed');

describe('server', () => {
  test('an empty store is seeded from example/, and says so', async () => {
    assert.match(banner, /seeded from example\//);
    assert.match(banner, /\(file\)/, 'and on files, not a bucket');
    for (const f of ['config.json', 'data/periods.json', 'data/history.json', 'data/amortization.json']) {
      await fsp.access(path.join(stateDir, f));
    }
  });

  test('the seeded period is one that is actually running', async () => {
    // A checkout in any month must open on a live period, not one that closed
    // years ago — the example is written against a fixed calendar and rebased.
    const period = await openPeriod();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(period.start <= today, `period starts ${period.start}`);
    assert.ok(period.scheduledEnd >= today, `period ends ${period.scheduledEnd}`);
  });

  test('/api/state hands over everything in one round trip', async () => {
    const res = await get('/api/state');
    assert.equal(res.status, 200);
    const state = await res.json();
    for (const key of ['config', 'periods', 'history', 'amortization', 'meta', 'problems']) {
      assert.ok(key in state, `missing ${key}`);
    }
    assert.ok(Array.isArray(state.periods) && state.periods.length > 0);
  });

  test('a period saves, and the version moves with it', async () => {
    const period = await openPeriod();
    period.spending.push({ id: 'test-1', date: period.start, targetId: 'groceries', amount: 12.34, note: '' });
    const res = await put(`/api/periods/${period.id}`, period);
    assert.equal(res.status, 200);
    const { version } = await res.json();
    assert.equal(version, period.version + 1);
    const after = await openPeriod();
    assert.ok(after.spending.some((s) => s.id === 'test-1'));
  });

  test('a stale client is refused, and told what it is missing', async () => {
    const period = await openPeriod();
    const res = await put(`/api/periods/${period.id}`, { ...period, version: period.version - 1 });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /changed elsewhere/);
    assert.equal(body.version, period.version, 'hands back the version it holds');
    assert.ok(body.period, 'and the document, so the client can reload');
  });

  test('an id that disagrees with the path is refused', async () => {
    const period = await openPeriod();
    const res = await put(`/api/periods/${period.id}`, { ...period, id: 'something-else' });
    assert.equal(res.status, 400);
  });

  test('several instances writing at once all survive', async () => {
    // The whole point of the conditional writes: two servers on one bucket must
    // not lose each other's edits. They share periods.json, so every write
    // after the first has to notice and redo itself.
    const ids = Array.from({ length: 12 }, (_, i) => `1990-${String(i + 1).padStart(2, '0')}-01`);
    const statuses = await Promise.all(ids.map((id) => put(`/api/periods/${id}`, {
      id, start: id, scheduledEnd: id, status: 'closed', closedOn: id,
      takeHome: 1, spending: [], oneOffs: [], flows: [], balances: {}, version: 0,
    }).then((r) => r.status)));
    assert.deepEqual([...new Set(statuses)], [200]);

    const stored = (await (await get('/api/state')).json()).periods.map((p) => p.id);
    assert.deepEqual(ids.filter((id) => !stored.includes(id)), [], 'none were clobbered');
  });

  test('a closed period refuses to be reopened', async () => {
    const id = '1990-01-01';
    const stored = (await (await get('/api/state')).json()).periods.find((p) => p.id === id);
    const res = await put(`/api/periods/${id}`, { ...stored, status: 'open' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /is closed/);
  });

  test('config saves under the same version check', async () => {
    const { config } = await (await get('/api/state')).json();
    const ok = await put('/api/config', { ...config, rules: { ...config.rules, trajectoryPeriods: 13 } });
    assert.equal(ok.status, 200);
    const stale = await put('/api/config', { ...config, rules: { ...config.rules, trajectoryPeriods: 14 } });
    assert.equal(stale.status, 409);
  });

  test('history events are writable; snapshots are not', async () => {
    const { history } = await (await get('/api/state')).json();
    const res = await put('/api/history/events', { version: history.version, events: [] });
    assert.equal(res.status, 200);
    const bad = await put('/api/history/events', { version: history.version + 1, events: 'nope' });
    assert.equal(bad.status, 400, 'events must be an array');
  });

  describe('widget endpoints', () => {
    test('burndown returns a drawable chart', async () => {
      const res = await get('/api/widget/burndown?today=2026-08-31');
      assert.equal(res.status, 200);
      const w = await res.json();
      assert.equal(w.asOf, '2026-08-31');
      assert.ok(w.series.length > 1);
      assert.equal(w.series[w.series.length - 1].id, '__unplanned', 'cushion stacks last');
      for (const pt of w.points) {
        assert.equal(pt.v.length, w.series.length, 'a value per band');
        assert.equal(typeof pt.c, 'number', 'and the pace level');
      }
    });

    test('a malformed date falls back rather than erroring a home screen', async () => {
      const res = await get('/api/widget/burndown?today=not-a-date');
      assert.equal(res.status, 200);
      assert.match((await res.json()).asOf, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('composition returns a stacked history', async () => {
      const res = await get('/api/widget/composition');
      assert.equal(res.status, 200);
      const w = await res.json();
      assert.ok(Array.isArray(w.series));
    });
  });

  describe('routing', () => {
    test('an unknown api route is 404, not the index page', async () => {
      const res = await get('/api/nope');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /json/);
    });

    test('the app itself is served', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>Finances<\/title>/);
    });

    test('HEAD works, because health checks use it', async () => {
      const res = await fetch(base + '/api/state', { method: 'HEAD' });
      assert.equal(res.status, 200);
    });

    test('a path cannot climb out of public/', async () => {
      for (const p of ['/../server.js', '/..%2Fserver.js', '/public/../../.env']) {
        const res = await get(p);
        assert.ok(res.status === 403 || res.status === 404, `${p} returned ${res.status}`);
        assert.doesNotMatch(await res.text(), /AWS_SECRET|createStore/, `${p} leaked a file`);
      }
    });

    test('an unsupported method on a static path is refused', async () => {
      const res = await fetch(base + '/styles.css', { method: 'DELETE' });
      assert.equal(res.status, 405);
    });
  });
});
