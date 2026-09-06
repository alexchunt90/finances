'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PayDates } = require('./helpers.js');

describe('pay calendar', () => {
  test('pays on the 10th and 25th', () => {
    const window = PayDates.depositsBetween('2026-03-01', '2026-03-31');
    assert.deepEqual(window.map((p) => p.nominal), ['2026-03-10', '2026-03-25']);
  });

  test('a pay date on a weekend walks back to the business day before it', () => {
    // 2026-04-25 is a Saturday.
    const [, second] = PayDates.depositsBetween('2026-04-01', '2026-04-30');
    assert.equal(second.nominal, '2026-04-25');
    assert.equal(second.paid, '2026-04-24', 'Saturday pay date moves back to Friday');
    assert.equal(second.available, '2026-04-23', 'and the cash lands the business day before that');
    assert.deepEqual(second.reasons, ['Saturday'], 'and it says why');
  });

  test('the deposit lands the business day BEFORE the pay date', () => {
    // The case the module was written against, verified against a real deposit:
    // Aug 10 2026 is a Monday and a valid pay date, and the money landed on the
    // Friday — not the Sunday. A "minus one calendar day" rule gets this wrong.
    const [first] = PayDates.depositsBetween('2026-08-01', '2026-08-20');
    assert.equal(first.paid, '2026-08-10', 'Monday the 10th is itself a pay date');
    assert.equal(first.available, '2026-08-07', 'available the Friday before, not the Sunday');
  });

  test('a federal holiday is not a business day', () => {
    // These two take a timestamp, not an ISO string — an ISO string silently
    // matches no holiday at all and every day looks like a working one.
    const at = (iso) => PayDates.parse(iso);
    assert.equal(PayDates.holidayName(at('2026-07-03')), 'Independence Day',
      'July 4th 2026 is a Saturday, so it is observed on the Friday');
    assert.equal(PayDates.isBusinessDay(at('2026-07-03')), false);
    assert.equal(PayDates.holidayName(at('2026-12-25')), 'Christmas Day');
    assert.equal(PayDates.holidayName(at('2026-11-26')), 'Thanksgiving');
    assert.equal(PayDates.isBusinessDay(at('2026-12-24')), true, 'Christmas Eve is a working day');
  });

  test('daysBetween counts calendar days, and is signed', () => {
    assert.equal(PayDates.daysBetween('2026-08-24', '2026-09-09'), 16);
    assert.equal(PayDates.daysBetween('2026-09-09', '2026-08-24'), -16);
    assert.equal(PayDates.daysBetween('2026-08-24', '2026-08-24'), 0);
  });

  test('a period runs from one deposit to the next', () => {
    const p = PayDates.periodContaining('2026-08-31');
    assert.equal(p.start, '2026-08-24');
    assert.equal(p.scheduledEnd, '2026-09-09');
  });

  test('every day of a year falls in exactly one period', () => {
    // Periods must tile the calendar: a gap loses a day's spending, an overlap
    // files it twice.
    let day = PayDates.parse('2026-01-01');
    const end = PayDates.parse('2026-12-31');
    while (day <= end) {
      const iso = PayDates.iso(day);
      const p = PayDates.periodContaining(iso);
      assert.ok(p.start <= iso && iso < p.scheduledEnd, `${iso} sits outside ${p.start}..${p.scheduledEnd}`);
      day += PayDates.DAY;
    }
  });
});
