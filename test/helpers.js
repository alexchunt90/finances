'use strict';

/* ---------------------------------------------------------------------------
 * Shared fixtures.
 *
 * Everything is built from example/, which ships with the repository, so the
 * suite never reads — or writes — whatever real state the machine happens to
 * have beside it.
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'example');

// model.js reads PayDates off the global scope, the way it does in the browser
// where both files are plain scripts sharing one.
global.PayDates = require(path.join(ROOT, 'public/paydates.js'));
const Model = require(path.join(ROOT, 'public/model.js'));
const PayDates = global.PayDates;

const readExample = (rel) => JSON.parse(fs.readFileSync(path.join(EXAMPLE, rel), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A period of a known length, so the arithmetic in a test can be checked by hand. */
const PERIOD = { id: '2026-08-24', start: '2026-08-24', scheduledEnd: '2026-09-09' };
const TODAY = '2026-08-31';

/**
 * The example household with a given period's worth of spending on it, and the
 * three derived objects every burndown test needs.
 */
function scenario({ spending = [], oneOffs = [], todayISO = TODAY } = {}) {
  const config = clone(readExample('config.json'));
  const periods = clone(readExample('data/periods.json'));
  const period = periods.find((p) => p.status !== 'closed');
  Object.assign(period, PERIOD, { spending, oneOffs });

  const days = Model.periodDays(period, todayISO);
  const wf = Model.waterfall(config, { days: days.projected, balances: config.openingBalances });
  const pace = Model.pace(config, period, todayISO);
  return {
    config, periods, period, days, wf, pace,
    burndown: Model.burndown(config, period, wf, todayISO),
    settlement: Model.settle(config, period, wf, pace),
  };
}

/** Spend `amount` on one category, on a day inside the period. */
const spend = (targetId, amount, date = '2026-08-26') => ({ id: `s-${targetId}`, date, targetId, amount });
const surprise = (amount, date = '2026-08-27') => ({ id: 's-one', date, amount });

/** The point the app reads as "now" — after today's logged spending. */
const nowPoint = (bd) => bd.points[Math.min(bd.todayDay, bd.points.length - 1)];

/** A temporary state directory seeded from example/, removed by the caller. */
async function tempState() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'finances-test-'));
  return dir;
}

/** A port nothing is listening on, for a server spawned by a test. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = {
  ROOT, EXAMPLE, Model, PayDates,
  readExample, clone, scenario, spend, surprise, nowPoint,
  tempState, freePort, PERIOD, TODAY,
};
