'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Model, scenario, spend, surprise, nowPoint, readExample } = require('./helpers.js');

const targets = readExample('config.json').expenses.targets;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg} — ${a} vs ${b}`);

/** Every shape of period the burndown has to survive. */
const CASES = {
  'nothing logged': {},
  'ordinary spending': { spending: [spend('groceries', 84, '2026-08-25'), spend('takeout', 30, '2026-08-27')] },
  'one category just past the cushion': { spending: [spend('groceries', 950)] },
  'one category far past the cushion': { spending: [spend('groceries', 4000)] },
  'every category blown': { spending: targets.map((t) => spend(t.id, Math.round(t.monthly * 0.9) + 40)) },
  'surprise bill only': { oneOffs: [surprise(1200)] },
  'overspend and a surprise bill': { spending: [spend('groceries', 950)], oneOffs: [surprise(300)] },
  'first day of the period': { spending: [spend('groceries', 900, '2026-08-24')], todayISO: '2026-08-24' },
  'last day of the period': { spending: [spend('groceries', 900)], todayISO: '2026-09-09' },
};

describe('burndown', () => {
  for (const [name, args] of Object.entries(CASES)) {
    describe(name, () => {
      const { burndown: bd, settlement } = scenario(args);

      test('every point adds up: bands plus cushion is the total', () => {
        for (const pt of bd.points) {
          const bands = Object.values(pt.values).reduce((t, v) => t + v, 0);
          near(bands + pt.unplanned, pt.total, `day ${pt.day}`);
        }
      });

      test('no band is ever negative', () => {
        for (const pt of bd.points) {
          for (const [id, v] of Object.entries(pt.values)) {
            assert.ok(v >= -0.005, `day ${pt.day}, ${id} = ${v}`);
          }
        }
      });

      test('nothing in the projection increases', () => {
        // A burndown that goes up is money appearing from nowhere. This caught
        // a cushion that refilled itself a little on every projected day.
        const proj = bd.points.filter((pt) => pt.day > bd.todayDay);
        for (let i = 1; i < proj.length; i++) {
          const [prev, cur] = [proj[i - 1], proj[i]];
          assert.ok(cur.total - prev.total <= 0.005, `total rose on day ${cur.day}`);
          assert.ok(cur.unplanned - prev.unplanned <= 0.005, `cushion rose on day ${cur.day}`);
          assert.ok(cur.borrowed - prev.borrowed <= 0.005, `borrowing rose on day ${cur.day}`);
          for (const id of Object.keys(cur.values)) {
            assert.ok(cur.values[id] - prev.values[id] <= 0.005, `${id} rose on day ${cur.day}`);
          }
        }
      });

      test('lending never runs past what the lenders have', () => {
        for (const pt of bd.points) {
          assert.ok(pt.borrowed >= 0, `day ${pt.day} borrowed ${pt.borrowed}`);
          // Borrowing only ever happens to cover a cushion in deficit.
          if (pt.borrowed > 0.005) assert.ok(pt.unplanned <= 0.005, `day ${pt.day} borrowed with a cushion in hand`);
        }
      });

      test('the total agrees with the period settlement', () => {
        // The chart and the This Period panel are two readings of one position,
        // so the money in them has to be the same money. True only of spending
        // dated today or earlier — see the future-dated test below.
        near(nowPoint(bd).total, settlement.totalLeft, 'left now');
      });

      test('the pace line runs the full height, and lands on zero', () => {
        near(bd.points[0].pace, bd.startTotal, 'starts at the top of the stack');
        near(bd.points[bd.points.length - 1].pace, 0, 'ends empty');
        for (let i = 1; i < bd.points.length; i++) {
          assert.ok(bd.points[i].pace <= bd.points[i - 1].pace + 0.005, 'never rises');
        }
      });
    });
  }

  test('a surprise bill never borrows from the planned pool', () => {
    // settle() is explicit that a surprise draws on the cushion and then the
    // buffer: the planned pool is spoken for by groceries not yet bought.
    const { burndown, settlement } = scenario({ oneOffs: [surprise(1200)] });
    assert.equal(settlement.borrowed, 0, 'the panel lends nothing');
    for (const pt of burndown.points) {
      assert.equal(pt.borrowed, 0, `day ${pt.day} lent against a surprise bill`);
    }
  });

  test('overspend does borrow, and only from categories ahead of their pace', () => {
    const { burndown } = scenario({ spending: [spend('groceries', 950)] });
    const now = nowPoint(burndown);
    assert.ok(now.borrowed > 0, 'something was lent');
    // Groceries is the category that overspent, so it cannot also be a lender.
    assert.equal(now.values.groceries, 0);
  });

  test('lending moves money between bands without creating any', () => {
    // The same period read with and without a lender available: the stack is
    // the same height either way, only the bands differ.
    const withSlack = scenario({ spending: [spend('groceries', 950)] });
    const noSlack = scenario({ spending: targets.map((t) => spend(t.id, Math.round(t.monthly * 3))) });
    for (const s of [withSlack, noSlack]) {
      for (const pt of s.burndown.points) {
        const bands = Object.values(pt.values).reduce((t, v) => t + v, 0);
        near(bands + pt.unplanned, pt.total, `day ${pt.day}`);
      }
    }
    assert.ok(nowPoint(withSlack.burndown).borrowed > 0, 'lends when there is slack');
    assert.equal(nowPoint(noSlack.burndown).borrowed, 0, 'lends nothing when every category is blown');
  });

  test('spending dated ahead of today is charted on its own day, not yet', () => {
    // The two views differ here on purpose, and it is worth pinning down. The
    // panel sums every logged amount whatever its date, so a spend entered for
    // next Tuesday counts against you now. The chart puts it on Tuesday, so the
    // stack still stands full until then, and the two disagree until it lands.
    const { burndown, settlement } = scenario({
      spending: [spend('groceries', 900, '2026-09-02')],
      todayISO: '2026-08-26',
    });
    const now = nowPoint(burndown);
    assert.ok(now.total > settlement.totalLeft, 'the chart has not drawn it down yet');
    // By the end of the period it has landed, and they agree again.
    const close = burndown.points[burndown.points.length - 1];
    assert.ok(close.total < now.total, 'and it lands before the period is out');
  });

  test('runsOutDay is the first day the stack is gone, or null', () => {
    const lasts = scenario({});
    assert.equal(lasts.burndown.runsOutDay, null, 'an untouched period lasts');

    const gone = scenario({ spending: [spend('groceries', 4000)] });
    assert.ok(gone.burndown.runsOutDay != null, 'a blown one does not');
    const at = gone.burndown.points.find((pt) => pt.day === gone.burndown.runsOutDay);
    assert.ok(at.total <= 0, 'and the named day is genuinely empty');
    const before = gone.burndown.points.filter((pt) => pt.day < gone.burndown.runsOutDay);
    assert.ok(before.every((pt) => pt.total > 0), 'with nothing empty before it');
  });
});

describe('proration', () => {
  test('a monthly figure is spread by the days the period actually ran', () => {
    near(Model.prorate(Model.DAYS_PER_MONTH, Model.DAYS_PER_MONTH), Model.DAYS_PER_MONTH, 'a full month is itself');
    near(Model.prorate(304.375, 10), 100, 'ten days of a 304.375 month');
    assert.equal(Model.prorate(500, 0), 0);
  });
});

describe('settlement', () => {
  test('the two pools are the whole of what is left', () => {
    for (const args of Object.values(CASES)) {
      const { settlement } = scenario(args);
      near(settlement.unplannedLeft + settlement.plannedLeft, settlement.totalLeft, 'pools sum to the total');
    }
  });

  test('what is lent never exceeds the slack it came from', () => {
    for (const args of Object.values(CASES)) {
      const { settlement, pace } = scenario(args);
      assert.ok(settlement.borrowed <= pace.slack + 0.005, 'borrowed within slack');
      assert.ok(settlement.borrowed >= 0);
    }
  });
});
