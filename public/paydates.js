/* ==========================================================================
   Pay calendar.

   Paid on the 10th and 25th. If that lands on a weekend or federal holiday the
   pay date walks back to the first business day at or before it, and the bank
   makes the deposit available on the first business day BEFORE that.

   Verified against a real deposit: Aug 10 2026 is a Monday and a valid pay
   date, and the money landed Friday Aug 7 — not Sunday Aug 9. A "minus one
   calendar day" rule gets that wrong.

   Every date is handled at UTC midnight so a local timezone can never shift a
   day across a boundary.
   ========================================================================== */

'use strict';

const PayDates = (() => {
  const DAY = 86400000;
  const D = (y, m, d) => Date.UTC(y, m - 1, d);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return D(y, m, d);
  };
  const dow = (t) => new Date(t).getUTCDay(); // 0 Sun .. 6 Sat

  // nth weekday of a month — nth(2026, 1, 1, 3) is the 3rd Monday of January.
  function nth(y, m, weekday, n) {
    const first = D(y, m, 1);
    return first + (((weekday - dow(first) + 7) % 7) + (n - 1) * 7) * DAY;
  }
  function lastWeekday(y, m, weekday) {
    const last = Date.UTC(y, m, 0); // day 0 of the next month
    return last - ((dow(last) - weekday + 7) % 7) * DAY;
  }
  // Fixed-date holidays: Saturday is observed Friday, Sunday is observed Monday.
  function observed(t) {
    if (dow(t) === 6) return t - DAY;
    if (dow(t) === 0) return t + DAY;
    return t;
  }

  function federalHolidays(y) {
    return new Map([
      [observed(D(y, 1, 1)), "New Year's Day"],
      [nth(y, 1, 1, 3), 'MLK Jr. Day'],
      [nth(y, 2, 1, 3), "Washington's Birthday"],
      [lastWeekday(y, 5, 1), 'Memorial Day'],
      [observed(D(y, 6, 19)), 'Juneteenth'],
      [observed(D(y, 7, 4)), 'Independence Day'],
      [nth(y, 9, 1, 1), 'Labor Day'],
      [nth(y, 10, 1, 2), 'Columbus Day'],
      [observed(D(y, 11, 11)), 'Veterans Day'],
      [nth(y, 11, 4, 4), 'Thanksgiving'],
      [observed(D(y, 12, 25)), 'Christmas Day'],
      // Jan 1 of next year on a Saturday is observed Dec 31 — a December hazard.
      [observed(D(y + 1, 1, 1)), "New Year's Day (observed)"],
    ]);
  }

  const cache = new Map();
  function holidaysFor(y) {
    if (!cache.has(y)) cache.set(y, federalHolidays(y));
    return cache.get(y);
  }
  function holidayName(t) {
    const y = new Date(t).getUTCFullYear();
    return holidaysFor(y).get(t) || holidaysFor(y - 1).get(t) || null;
  }
  const isBusinessDay = (t) => dow(t) !== 0 && dow(t) !== 6 && !holidayName(t);

  /** One pay event: what was scheduled, when payroll pays, when the cash lands. */
  function payday(y, m, nominalDay) {
    const nominal = D(y, m, nominalDay);
    let paid = nominal;
    const reasons = [];
    while (!isBusinessDay(paid)) {
      reasons.push(holidayName(paid) || ['Sunday', '', '', '', '', '', 'Saturday'][dow(paid)]);
      paid -= DAY;
    }
    let available = paid - DAY;
    while (!isBusinessDay(available)) available -= DAY;
    return { nominal: iso(nominal), paid: iso(paid), available: iso(available), reasons };
  }

  /** Every deposit date in [fromISO, toISO), in order. */
  function depositsBetween(fromISO, toISO) {
    const from = parse(fromISO);
    const to = parse(toISO);
    const out = [];
    // Start a month early: a late-month deposit can be pulled back into the
    // previous month by a holiday run.
    const start = new Date(from - 40 * DAY);
    const end = new Date(to + 40 * DAY);
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
      for (let m = 1; m <= 12; m++) {
        for (const d of [10, 25]) {
          const p = payday(y, m, d);
          const t = parse(p.available);
          if (t >= from && t < to) out.push(p);
        }
      }
    }
    return out.sort((a, b) => a.available.localeCompare(b.available));
  }

  /**
   * The scheduled period containing a date: from the deposit on or before it,
   * to the next deposit. `end` here is the *scheduled* end. A period that is
   * closed late uses its actual close date for proration instead.
   */
  function periodContaining(dateISO) {
    const t = parse(dateISO);
    const window = depositsBetween(iso(t - 60 * DAY), iso(t + 60 * DAY));
    for (let i = 0; i < window.length - 1; i++) {
      const a = parse(window[i].available);
      const b = parse(window[i + 1].available);
      if (t >= a && t < b) {
        return { id: window[i].available, start: window[i].available, scheduledEnd: window[i + 1].available, pay: window[i] };
      }
    }
    return null;
  }

  function nextDepositAfter(dateISO) {
    const t = parse(dateISO);
    const window = depositsBetween(dateISO, iso(t + 90 * DAY));
    return window.find((p) => parse(p.available) > t) || null;
  }

  const daysBetween = (aISO, bISO) => Math.round((parse(bISO) - parse(aISO)) / DAY);
  // Local date, not UTC. toISOString() would roll over to tomorrow after 5pm
  // Pacific, dating evening spending a day forward and skewing the day count.
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return { payday, depositsBetween, periodContaining, nextDepositAfter, daysBetween, todayISO, isBusinessDay, holidayName, iso, parse, DAY };
})();

if (typeof module !== 'undefined') module.exports = PayDates;
