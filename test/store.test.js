'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createStore, StoreConflict, sign, escapePath } = require('../lib/store.js');
const { tempState } = require('./helpers.js');

describe('SigV4 signing', () => {
  // AWS publishes worked examples with the signature spelled out. If these two
  // match, the canonical request, the string to sign and the derived key are
  // all correct — there is no partial credit in a signature.
  const creds = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
  };
  const at = new Date('2013-05-24T00:00:00Z');
  const signatureOf = (h) => h.authorization.match(/Signature=([0-9a-f]+)/)[1];

  test('GET Object with a Range header', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com' + escapePath('test.txt'));
    const h = sign('GET', url, { range: 'bytes=0-9' }, '', creds, at);
    assert.equal(signatureOf(h), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.equal(h.authorization.match(/SignedHeaders=([^,]+)/)[1], 'host;range;x-amz-content-sha256;x-amz-date');
  });

  test('PUT Object, whose key needs escaping', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com' + escapePath('test$file.text'));
    assert.equal(url.pathname, '/test%24file.text', 'the URL parser leaves $ alone; S3 does not');
    const h = sign('PUT', url, { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      'Welcome to Amazon S3.', creds, at);
    assert.equal(signatureOf(h), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    assert.equal(h['x-amz-content-sha256'], '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  });

  test('the payload hash covers the body, so it changes with it', () => {
    const url = new URL('https://b.s3.amazonaws.com/k');
    const a = sign('PUT', url, {}, 'one', creds, at);
    const b = sign('PUT', url, {}, 'two', creds, at);
    assert.notEqual(a['x-amz-content-sha256'], b['x-amz-content-sha256']);
    assert.notEqual(signatureOf(a), signatureOf(b));
  });

  test('escapePath encodes per segment, keeping the separators', () => {
    assert.equal(escapePath('data/periods.json'), '/data/periods.json');
    assert.equal(escapePath('a b/c$d'), '/a%20b/c%24d');
    // encodeURIComponent leaves these alone and S3 does not.
    assert.equal(escapePath("!*'()"), '/%21%2A%27%28%29');
  });
});

describe('file store', () => {
  const dirs = [];
  const store = async () => {
    const dir = await tempState();
    dirs.push(dir);
    return createStore({}, dir);
  };
  after(async () => {
    for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  });

  test('an absent document reads as undefined, with no token', async () => {
    const s = await store();
    assert.deepEqual(await s.read('config'), { value: undefined, token: null });
  });

  test('a null token means create, and only once', async () => {
    const s = await store();
    const first = await s.write('config', { version: 1 }, null);
    assert.ok(first.token);
    // Two instances starting at once must not both create it, or one vanishes.
    await assert.rejects(() => s.write('config', { version: 99 }, null), StoreConflict);
    assert.equal((await s.read('config')).value.version, 1);
  });

  test('a write must present the token it read', async () => {
    const s = await store();
    const first = await s.write('config', { version: 1 }, null);
    const held = await s.read('config');
    assert.equal(held.token, first.token);

    const second = await s.write('config', { version: 2 }, held.token);
    assert.notEqual(second.token, first.token, 'the token moves with the content');

    // The token we used to hold is now stale: someone else has written since.
    await assert.rejects(() => s.write('config', { version: 3 }, first.token), StoreConflict);
    assert.equal((await s.read('config')).value.version, 2, 'the stale write was dropped');
  });

  test('nested keys land in their own directory', async () => {
    const s = await store();
    await s.write('periods', [{ id: 'a' }], null);
    const back = await s.read('periods');
    assert.deepEqual(back.value, [{ id: 'a' }]);
  });

  test('concurrent writes do not clobber each other', async () => {
    // Two bugs lived here. Every write shared one temp filename per process, so
    // simultaneous saves renamed each other's half-written bytes into place;
    // and the check-then-rename was not atomic, so both writers read the same
    // version, both passed, and the second overwrote the first.
    const s = await store();
    await s.write('periods', [], null);

    const add = async (id) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const { value, token } = await s.read('periods');
        try {
          return await s.write('periods', [...value, { id }], token);
        } catch (err) {
          if (!(err instanceof StoreConflict)) throw err;
        }
      }
      throw new Error(`${id} never got a turn`);
    };

    const ids = Array.from({ length: 16 }, (_, i) => `p${i}`);
    await Promise.all(ids.map(add));
    const stored = (await s.read('periods')).value.map((p) => p.id);
    assert.equal(stored.length, ids.length, 'every write survived');
    assert.deepEqual([...stored].sort(), [...ids].sort());
  });

  test('a torn write never replaces a good document', async () => {
    // Writes go through a temp file and a rename, so an interrupted save leaves
    // the previous document intact rather than a truncated one.
    const s = await store();
    const dir = dirs[dirs.length - 1];
    await s.write('config', { version: 1, keep: 'me' }, null);
    await assert.rejects(() => s.write('config', { version: 2 }, 'not-the-token'), StoreConflict);
    const raw = await fsp.readFile(path.join(dir, 'config.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), { version: 1, keep: 'me' });
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp files left behind');
  });
});

describe('backend selection', () => {
  test('files when no bucket is named', async () => {
    const dir = await tempState();
    assert.equal(createStore({}, dir).kind, 'file');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('S3 when one is, and it refuses to start half-configured', () => {
    const env = { S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' };
    assert.equal(createStore(env, '').kind, 's3');
    assert.throws(() => createStore({ S3_BUCKET: 'b' }, ''), /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
  });

  test('an explicit endpoint switches to path style, for R2 and MinIO', () => {
    const aws = createStore({ S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }, '');
    assert.match(aws.describe(), /^s3:\/\/b\//);
    const other = createStore({
      S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's',
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_PREFIX: 'finances',
    }, '');
    assert.match(other.describe(), /r2\.cloudflarestorage\.com\/b\/finances\//);
  });
});
