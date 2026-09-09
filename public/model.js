/* ==========================================================================
   The arithmetic. No DOM here.

   Two ideas do most of the work:

   1. Fixed obligations divide by 24 flat; variable targets accrue per DAY and
      are prorated by the period's real length. Periods run 13-19 days, so a
      flat per-period grocery target would flag a 19-day period as an overspend
      you never committed.

   2. What you *contribute* is the goal metric, not what your balances do.
      Balances move on markets. Contributions move on decisions.
   ========================================================================== */

'use strict';

const Model = (() => {
  const DAYS_PER_MONTH = 365.25 / 12; // 30.4375
  const sum = (xs, f = (x) => x) => xs.reduce((t, x) => t + f(x), 0);
  const round2 = (n) => Math.round(n * 100) / 100;

  // --- expenses -------------------------------------------------------------

  const committedTotal = (cfg) => sum(cfg.expenses.committed, (e) => e.perPeriod);
  const sinkingTotal = (cfg) => sum(cfg.expenses.sinking, (e) => e.perPeriod);

  /** The scheduled bank transfer that funds every annual bill. */
  const scheduledTransfer = (cfg) => round2(sinkingTotal(cfg));

  /** A monthly target, prorated to however many days the period actually ran. */
  function prorate(monthly, days) {
    return round2((monthly / DAYS_PER_MONTH) * days);
  }

  function targetsFor(cfg, days) {
    return cfg.expenses.targets.map((t) => ({ ...t, budget: prorate(t.monthly, days) }));
  }

  const targetsTotal = (cfg, days) => round2(sum(targetsFor(cfg, days), (t) => t.budget));

  /** What you'd still owe if everything optional were cut. The real floor. */
  function necessaryFloor(cfg, days) {
    const c = sum(cfg.expenses.committed.filter((e) => e.necessary), (e) => e.perPeriod);
    const s = sum(cfg.expenses.sinking.filter((e) => e.necessary), (e) => e.perPeriod);
    const t = sum(targetsFor(cfg, days).filter((e) => e.necessary), (e) => e.budget);
    return round2(c + s + t);
  }

  // --- the waterfall --------------------------------------------------------

  /**
   * Order money leaves take-home. Sinking funds sit above the reducible tiers
   * and are never cut: halving them means the annual bill is unfunded when it
   * lands, which sends you back to the emergency fund you were trying to refill.
   */
  function waterfall(cfg, { days, balances = {} }) {
    const w = cfg.waterfall;
    const emergencyAcct = cfg.accounts.find((a) => a.id === 'emergency');
    const emergencyBalance = balances.emergency ?? 0;
    const inRecovery = emergencyBalance < (emergencyAcct?.target ?? 0);
    const keep = inRecovery ? 1 - cfg.rules.recoveryReductionPct / 100 : 1;

    // Brokerage and long-term both fan out, so each is the sum of its parts
    // rather than a number of its own. Older shapes still load: a single
    // brokerage account, or a long-term percentage map plus a total.
    const brokerageSplit = Array.isArray(w.brokerageSplit) && w.brokerageSplit.length
      ? w.brokerageSplit
      : [{ accountId: w.brokerageAccountId, perPeriod: w.brokeragePerPeriod || 0 }];

    const longtermSplit = Array.isArray(w.longtermSplit)
      ? w.longtermSplit
      : Object.entries(w.longtermSplit || {}).map(([bucketId, pct]) => ({
          bucketId, perPeriod: round2((w.longtermPerPeriod || 0) * (pct / 100)),
        }));

    const reducible = {
      buffer: w.bufferPerPeriod,
      roth: w.rothPerPeriod,
      longterm: round2(sum(longtermSplit, (d) => d.perPeriod || 0)),
      brokerage: round2(sum(brokerageSplit, (d) => d.perPeriod || 0)),
    };
    const freed = inRecovery ? round2(sum(Object.values(reducible)) * (1 - keep)) : 0;

    const tiers = [
      { key: 'committed', label: 'Committed bills', amount: committedTotal(cfg), reducible: false, saving: false },
      { key: 'targets', label: 'Spending targets', amount: targetsTotal(cfg, days), reducible: false, saving: false },
      // `base` is the configured figure and what an editor must bind to;
      // `amount` is what actually moves this period once recovery is applied.
      // Binding an input to `amount` would silently halve the saved value.
      { key: 'sinking', label: 'Sinking funds', amount: sinkingTotal(cfg), base: sinkingTotal(cfg), configKey: null, reducible: false, saving: true, accountId: 'sinking', note: 'set in section 2' },
      { key: 'emergency', label: 'Emergency fund', amount: round2(w.emergencyPerPeriod + freed), base: w.emergencyPerPeriod, configKey: 'emergencyPerPeriod', reducible: false, saving: true, accountId: 'emergency', note: freed ? `includes ${freed.toFixed(2)} redirected` : '' },
      { key: 'buffer', label: 'Buffer replenishment', amount: round2(reducible.buffer * keep), base: reducible.buffer, configKey: 'bufferPerPeriod', reducible: true, saving: true, accountId: 'buffer' },
      { key: 'roth', label: 'Roth IRA', amount: round2(reducible.roth * keep), base: reducible.roth, configKey: 'rothPerPeriod', reducible: true, saving: true, accountId: 'roth' },
      { key: 'longterm', label: 'Long-term savings', amount: round2(reducible.longterm * keep), base: reducible.longterm, configKey: null, splitKey: 'longtermSplit', reducible: true, saving: true, accountId: 'longterm',
        destinations: longtermSplit.map((d, i) => ({
          index: i,
          // Goals live inside one real account, so the money lands there while
          // the bucket only records which goal it is earmarked for.
          accountId: (cfg.buckets.find((b) => b.id === d.bucketId) || {}).accountId || 'longterm',
          bucketId: d.bucketId,
          base: round2(d.perPeriod || 0),
          amount: round2((d.perPeriod || 0) * keep),
        })) },
      // configKey is null because the parent is derived from its destinations —
      // the same reason the sinking row is not editable in place.
      { key: 'brokerage', label: 'Brokerage', amount: round2(reducible.brokerage * keep), base: reducible.brokerage, configKey: null, splitKey: 'brokerageSplit', reducible: true, saving: true, accountId: null,
        destinations: brokerageSplit.map((d, i) => ({
          index: i,
          accountId: d.accountId,
          base: round2(d.perPeriod || 0),
          amount: round2((d.perPeriod || 0) * keep),
        })) },
    ];

    // Every saving tier gets a uniform destination list so anything downstream
    // — expected flows, the trajectory — can iterate one shape.
    for (const t of tiers) {
      if (!t.saving || t.destinations) continue;
      t.destinations = [{ index: 0, accountId: t.accountId, base: t.base, amount: t.amount }];
    }

    const allocated = round2(sum(tiers, (t) => t.amount));
    return {
      tiers,
      allocated,
      savingsTotal: round2(sum(tiers.filter((t) => t.saving), (t) => t.amount)),
      inRecovery,
      freed,
      unallocated: round2(cfg.income.takeHomePerPeriod - allocated),
    };
  }

  /**
   * Assumptions the Projections tab runs on. Defaulted here rather than
   * required in config, so a config written before this existed still projects
   * sensibly; the panel writes them on first edit.
   */
  function projection(cfg) {
    const p = cfg.projections || {};
    return {
      periods: Number.isFinite(p.periods) && p.periods > 0 ? Math.round(p.periods) : 24,
      annualReturnPct: Number.isFinite(p.annualReturnPct) ? p.annualReturnPct : 7,
    };
  }

  /**
   * What lands in the 401k each period. Withheld pre-tax, so it never appears
   * in the waterfall — but it still arrives in the account, and it is large
   * enough that leaving it out understates where the plan lands.
   *
   * Stored per period; the older monthly key still reads for a config written
   * before the Projections panel existed.
   */
  function k401PerPeriod(cfg) {
    const pre = cfg.income?.preTax || {};
    if (pre.retirement401kPerPeriod != null) return round2(pre.retirement401kPerPeriod);
    return round2((pre.retirement401kMonthly || 0) / 2);
  }

  /** A yearly return as a per-period rate — 24 deposits a year. */
  function periodReturn(annualPct) {
    const a = Number(annualPct) || 0;
    return a ? Math.pow(1 + a / 100, 1 / 24) - 1 : 0;
  }

  // --- the open period ------------------------------------------------------

  /**
   * A period's end is whenever you close it, not when the next deposit lands.
   * Closing four days late means four extra days of groceries went on this
   * period, so proration follows the actual span.
   */
  function periodDays(period, todayISO) {
    const end = period.closedOn || todayISO;
    // Completed days, which is none on the first day and none again on the days
    // before a period that has not opened yet — closing early leaves that gap.
    // Flooring this at one, as it once was, made the first two days both read
    // as day two and dated the day before a period into it.
    const elapsed = Math.max(0, PayDates.daysBetween(period.start, end));
    const scheduled = Math.max(1, PayDates.daysBetween(period.start, period.scheduledEnd));
    // A period closed the day it opened still ran for a day, or the arithmetic
    // below divides by a period no time passed in.
    const projected = period.closedOn ? Math.max(1, elapsed) : Math.max(elapsed, scheduled);
    // Floored at 1 so a per-day figure on the final day divides by a day, not
    // by zero.
    const remaining = Math.max(1, projected - elapsed);
    // Which day of the period today *is*, as opposed to how many are behind it.
    // `elapsed` counts completed days, because today's allowance is not earned
    // until the day is done, and every prorated figure is built on that. But as
    // a position it reads a day behind — on the first afternoon you are in day
    // one, not day zero — so anything that says "day N of M" wants this one. It
    // holds at day one until the period opens, since a period yet to begin is
    // not somewhere you can be further into. A closed period needs no
    // adjustment: projected equals elapsed, and the min leaves it alone.
    const current = Math.min(projected, elapsed + 1);
    return { elapsed, scheduled, projected, remaining, current, late: elapsed > scheduled };
  }

  /** Where each variable target stands, and where this pace lands by close. */
  function pace(cfg, period, todayISO) {
    const days = periodDays(period, todayISO);
    const spentBy = {};
    for (const s of period.spending || []) {
      spentBy[s.targetId] = (spentBy[s.targetId] || 0) + s.amount;
    }
    const rows = cfg.expenses.targets.map((t) => {
      const spent = round2(spentBy[t.id] || 0);
      const budget = prorate(t.monthly, days.projected);
      const toDate = prorate(t.monthly, days.elapsed);
      const projected = round2((spent / Math.max(1, days.elapsed)) * days.projected);
      return {
        ...t, spent, budget, toDate, projected,
        pacePct: toDate > 0 ? round2((spent / toDate) * 100) : 0,
        overBy: round2(projected - budget),
        overage: round2(Math.max(0, spent - budget)),
        unused: round2(Math.max(0, budget - spent)),
        // How far behind its to-date share this category is. Spending less than
        // your pace so far is slack that can cover an overspend elsewhere.
        behind: round2(Math.max(0, toDate - spent)),
      };
    });
    // A single Costco run on day 2 extrapolates to an absurd month. Projections
    // only mean something once a few days of ordinary spending are behind them,
    // so below the threshold the app says so instead of guessing loudly.
    const minDays = Math.max(3, Math.ceil(days.projected * 0.25));
    // Overage and unused are summed per category and never netted against each
    // other: a blown grocery budget is not undone by an untouched fuel budget,
    // even though both come out of the same paycheck.
    return {
      days, rows, reliable: days.elapsed >= minDays, minDays,
      spent: round2(sum(rows, (r) => r.spent)),
      budget: round2(sum(rows, (r) => r.budget)),
      projected: round2(sum(rows, (r) => r.projected)),
      overage: round2(sum(rows, (r) => r.overage)),
      unused: round2(sum(rows, (r) => r.unused)),
      slack: round2(sum(rows, (r) => r.behind)),
    };
  }

  /**
   * What is left to spend, day by day. Every category budget and the unplanned
   * pool start full on day 1 and draw down as spending is logged. Past today
   * the lines keep falling at the pace set so far, which is what makes running
   * out visible before it happens rather than after.
   *
   * A point is the state at the *start* of its day, so day 1 is the full
   * amount, untouched. One extra point past the last day carries the final
   * day's spending, which would otherwise never appear.
   */
  function burndown(cfg, period, wf, todayISO) {
    const days = periodDays(period, todayISO);
    const n = days.projected;
    const p = pace(cfg, period, todayISO);
    const todayDay = days.current;

    const blank = () => new Array(n + 2).fill(0);
    const dayOf = (iso) =>
      Math.min(Math.max(PayDates.daysBetween(period.start, iso) + 1, 1), n);

    const byDay = {};
    for (const t of cfg.expenses.targets) byDay[t.id] = blank();
    // Spending logged against a target deleted since is still money that left,
    // so it draws on the unplanned pool rather than vanishing from the chart.
    // Surprise bills draw there too — that is what that pool is for.
    const unbudgeted = blank();
    for (const s of period.spending || []) (byDay[s.targetId] || unbudgeted)[dayOf(s.date)] += s.amount;
    for (const o of period.oneOffs || []) unbudgeted[dayOf(o.date)] += o.amount;

    const rows = cfg.expenses.targets.map((t) => {
      const row = p.rows.find((r) => r.id === t.id);
      const budget = row ? row.budget : 0;
      return {
        id: t.id,
        name: t.name,
        budget,
        // An even share of the period's budget per day — spending exactly on
        // pace. Not the rate observed so far: a few days of noise reads as a
        // trend, and a category with nothing logged yet would project flat
        // across the rest of the period.
        rate: round2(budget / n),
      };
    });

    const left = {};
    for (const r of rows) left[r.id] = r.budget;
    // The same cushion settle() works from: pay no bill, saving or category
    // budget has a claim on.
    let unplanned = round2(period.takeHome - committedTotal(cfg) - wf.savingsTotal - p.budget);
    // The cushion draws down at pace too. It is money for the period like any
    // category budget, so spending exactly on pace should empty it by close —
    // holding it flat drew a plan that never spends its uncommitted pay.
    // Fixed off the opening figure, the same way a category's rate is.
    const unplannedRate = round2(Math.max(0, unplanned) / n);
    // What the cushion can absorb, and how much category overspend it has been
    // asked to. settle() decides how much to borrow from these two alone,
    // before surprise bills are considered at all, and the chart has to make
    // the same decision from the same figures.
    //
    // A capacity, not a balance: the whole period's uncommitted pay is there to
    // absorb an overspend on day 2 as much as on day 15, so it does not shrink
    // as the days pass. Draining it would make the same overspend look less and
    // less coverable each day, and the borrowing it triggered would grow to
    // match — drawing a cushion that refills itself into the future.
    const cushionBase = round2(unplanned);
    let overspill = 0;

    /**
     * The transfer settle() makes at close, read off any day of the chart.
     *
     * Overspending a category eats the cushion first. Only once that would take
     * the cushion below zero does it borrow from categories running behind
     * their own pace, and only down to that pace — never their whole remaining
     * budget. Nothing is created: it moves between the two pools, so the stack
     * stands exactly as tall either way. What changes is which band it sits in,
     * and that is the honest picture — a cushion propped up by grocery money
     * nobody has spent yet is not the same thing as money still uncommitted.
     *
     * Read fresh for each day rather than carried forward. It states where the
     * position stands on that day; it is not an event. Carrying it would leave
     * the lenders looking further behind tomorrow and lending again on top.
     */
    function lend(d) {
      const values = Object.fromEntries(rows.map((r) => [r.id, round2(Math.max(0, left[r.id]))]));
      // Only the overspend the cushion could not absorb is borrowable, which is
      // settle()'s rule and not the same as "however far below zero the cushion
      // is". A surprise bill draws on the cushion and then on the buffer; it
      // never reaches into the planned pool, because that money is already
      // spoken for by groceries and fuel that simply have not been bought yet.
      const need = round2(Math.max(0, overspill - cushionBase));
      if (need === 0) return { values, unplanned: round2(unplanned), borrowed: 0 };

      // How far ahead of its own pace each category is at the start of day d,
      // which is the most it can lend without falling behind itself.
      const ahead = {};
      let slack = 0;
      for (const r of rows) {
        const onPace = Math.max(0, round2(r.budget - r.rate * (d - 1)));
        ahead[r.id] = round2(Math.max(0, values[r.id] - onPace));
        slack = round2(slack + ahead[r.id]);
      }

      const borrowed = round2(Math.min(need, slack));
      if (borrowed <= 0) return { values, unplanned: round2(unplanned), borrowed: 0 };

      // In proportion to how far ahead each lender is. The last one absorbs the
      // rounding remainder, so the parts always sum to the whole.
      const donors = rows.filter((r) => ahead[r.id] > 0);
      let rest = borrowed;
      donors.forEach((r, i) => {
        const share = i === donors.length - 1
          ? rest
          : Math.min(ahead[r.id], round2(borrowed * (ahead[r.id] / slack)));
        const take = round2(Math.max(0, Math.min(share, ahead[r.id], rest)));
        values[r.id] = round2(values[r.id] - take);
        rest = round2(rest - take);
      });
      return { values, unplanned: round2(unplanned + borrowed), borrowed };
    }

    const points = [];
    for (let d = 1; d <= n + 1; d++) {
      const settled = lend(d);
      points.push({
        day: d,
        projected: d > todayDay,
        values: settled.values,
        // The cushion can still be overdrawn once everything behind pace has
        // lent what it can, and the total says so: the chart draws that as a
        // band below the axis rather than pretending the money is still there.
        unplanned: settled.unplanned,
        overrun: round2(Math.max(0, -settled.unplanned)),
        // What the categories are covering for the cushion on this day.
        borrowed: settled.borrowed,
        total: round2(sum(rows, (r) => settled.values[r.id]) + settled.unplanned),
      });
      if (d > n) break;

      for (const r of rows) {
        // Logged spending comes off first, whichever side of today it falls,
        // and overspending a category draws the remainder from the unplanned
        // pool — the same way settle() accounts for it at close. A logged
        // amount is money committed, so the cushion absorbs it either way.
        left[r.id] = round2(left[r.id] - byDay[r.id][d]);
        if (left[r.id] < 0) {
          unplanned = round2(unplanned + left[r.id]);
          overspill = round2(overspill - left[r.id]);
          left[r.id] = 0;
        }
        // Past today, the pace assumption fills in the ordinary days around
        // whatever is already logged. It stops at empty rather than charging
        // on into the cushion: an overdraft nobody has committed to would
        // compound, with every exhausted category draining it every remaining
        // day.
        if (d > todayDay) left[r.id] = round2(Math.max(0, left[r.id] - r.rate));
      }
      // Surprise bills, and spending against a target deleted since, are logged
      // amounts rather than projections, so they land on their own day either
      // side of today. Nothing is assumed on top of them: a surprise is an
      // event, not a rate.
      unplanned = round2(unplanned - unbudgeted[d]);

      // Past today the cushion drains at its own pace, stopping at empty. It is
      // never pushed further negative: a pool already overdrawn by real
      // spending would compound an overdraft nobody has committed to.
      if (d > todayDay && unplannedRate > 0) {
        unplanned = round2(unplanned - Math.min(unplannedRate, Math.max(0, unplanned)));
      }
    }

    // Spending exactly on pace: the whole period's spending money drawn down in
    // n equal daily shares. One level per day rather than a continuous slope,
    // because a day's share is not earned partway through it — the same reason
    // proration counts completed days. How that gets drawn is the chart's
    // business. The stack sitting below this is spending faster than pace.
    //
    // It reads off the total, cushion included, so that it can be compared
    // against the top of the stack. A line covering the category budgets alone
    // would sit inside the stack with nothing meaningful above or below it.
    const startTotal = points[0].total;
    for (const pt of points) {
      pt.pace = round2(Math.max(0, startTotal * (1 - (pt.day - 1) / n)));
    }

    // Empty means the visible stack is gone — every category budget spent and
    // the cushion overdrawn.
    const empty = points.find((pt) => pt.total <= 0);
    return {
      n, todayDay, days, rows, points,
      startTotal,
      // An even day's share of everything there is to spend.
      paceRate: round2(startTotal / n),
      endTotal: points[points.length - 1].total,
      endOverrun: points[points.length - 1].overrun,
      // The day the whole stack is gone, if this pace holds.
      runsOutDay: empty ? empty.day : null,
      reliable: p.reliable,
    };
  }

  const surpriseTotal = (period) => round2(sum(period.oneOffs || [], (o) => o.amount));

  /**
   * Two separate pools of what is left in the period:
   *
   *   unplanned — pay not committed to any bill, saving, or category budget
   *   planned   — category budget that exists but has not been spent yet
   *
   * A surprise bill draws only on the unplanned pool, then on the buffer. It
   * never eats the planned pool, because that money is already spoken for by
   * groceries and fuel that have simply not been bought yet.
   */
  function settle(cfg, period, wf, pace) {
    const surprises = surpriseTotal(period);

    // Pay not committed to a bill, a saving, or a category budget.
    const base = round2(
      period.takeHome - committedTotal(cfg) - wf.savingsTotal - pace.budget
    );

    // Overspending a category first eats the unplanned pool. Only once that
    // would go negative does it borrow from categories running behind their
    // pace, and only down to their pace — never their whole remaining budget.
    // This is a transfer between the two pools, so their sum is unchanged.
    const shortfall = round2(Math.max(0, pace.overage - base));
    const borrowed = round2(Math.min(shortfall, pace.slack));
    const afterOverage = round2(base - pace.overage + borrowed);

    // Surprise bills draw on what is left of unplanned, then the buffer. They
    // never borrow from the planned pool.
    const fromPay = round2(Math.min(surprises, Math.max(0, afterOverage)));
    const fromBuffer = round2(surprises - fromPay);

    // Split the borrowed total across the categories that actually lent it,
    // in proportion to how far behind pace each one is, so the pace bars can
    // show where it came from. The last donor absorbs any rounding remainder.
    const lent = {};
    if (borrowed > 0 && pace.slack > 0) {
      const donors = pace.rows.filter((r) => r.behind > 0);
      let left = borrowed;
      donors.forEach((r, i) => {
        const share = i === donors.length - 1
          ? left
          : Math.min(r.behind, round2(borrowed * (r.behind / pace.slack)));
        lent[r.id] = round2(Math.max(0, Math.min(share, r.behind, left)));
        left = round2(left - lent[r.id]);
      });
    }

    const unplannedLeft = round2(afterOverage - surprises);
    const plannedLeft = round2(pace.unused - borrowed);

    return {
      surprises,
      cushion: base,
      borrowed,
      lent,
      unplannedLeft,
      plannedLeft,
      totalLeft: round2(unplannedLeft + plannedLeft),
      fromPay, fromBuffer,
      left: unplannedLeft,
      // Whatever survives in either pool is real money at close. The unplanned
      // pool floors at zero because anything past that came from the buffer.
      surplus: round2(Math.max(0, unplannedLeft) + plannedLeft),
    };
  }

  /** Surplus goes where the shortfalls are: emergency, then buffer, then a goal. */
  function sweepPlan(cfg, surplus, balances) {
    if (surplus <= 0) return [];
    const plan = [];
    let left = surplus;
    for (const step of cfg.rules.surplusSweepOrder) {
      if (left <= 0.005) break;
      if (step.startsWith('bucket:')) {
        plan.push({ target: step.slice(7), kind: 'bucket', amount: round2(left) });
        left = 0;
        break;
      }
      const acct = cfg.accounts.find((a) => a.id === step);
      if (!acct || !acct.target) continue;
      const gap = round2(acct.target - (balances[acct.id] ?? 0));
      if (gap <= 0) continue;
      const give = Math.min(gap, left);
      plan.push({ target: acct.id, kind: 'account', amount: round2(give) });
      left = round2(left - give);
    }
    return plan;
  }

  // --- reconciliation -------------------------------------------------------

  /**
   * Balance change minus recorded flows. On a stable account that gap is money
   * that moved without being written down. On a brokerage it is market
   * movement and means nothing — flagging it there would cry wolf every period.
   */
  /**
   * The standing per-period transfers are configuration, not hand-entered
   * flows. If reconciliation ignored them, every period would flag the routine
   * $500 to the brokerage as unaccounted — noise that buries the real signal.
   */
  function plannedFlows(cfg, period, wf) {
    const map = {};
    const add = (id, amt) => { if (id) map[id] = round2((map[id] || 0) + amt); };
    for (const t of wf.tiers) {
      if (!t.saving) continue;
      for (const d of t.destinations || []) add(d.accountId, d.amount);
    }
    // Only the part of a surprise bill the buffer actually covered.
    add('buffer', -(period.totals ? period.totals.surpriseFromBuffer || 0 : 0));
    // The 401k is funded pre-tax and never touches the waterfall, but it still
    // lands in the account, so reconciliation has to expect it.
    const k401 = k401PerPeriod(cfg);
    if (k401) add('k401', k401);
    return map;
  }

  function reconcile(cfg, period, prevBalances, planned = {}) {
    const flowsBy = {};
    for (const f of period.flows || []) {
      // A transfer is one movement across two accounts. It nets to zero and
      // must never register as a contribution, or a liquidity event would show
      // up as the best savings period you ever had.
      const signed = f.type === 'withdrawal' ? -Math.abs(f.amount) : Math.abs(f.amount);
      flowsBy[f.accountId] = (flowsBy[f.accountId] || 0) + (f.type === 'transfer' ? -Math.abs(f.amount) : signed);
      if (f.type === 'transfer' && f.toAccountId) {
        flowsBy[f.toAccountId] = (flowsBy[f.toAccountId] || 0) + Math.abs(f.amount);
      }
    }
    return cfg.accounts.map((a) => {
      const before = prevBalances[a.id];
      const after = period.balances?.[a.id];
      const expected = round2(planned[a.id] || 0);
      const recorded = round2(flowsBy[a.id] || 0);
      const flow = round2(expected + recorded);
      const known = before != null && after != null;
      const delta = known ? round2(after - before) : null;
      const residual = known ? round2(delta - flow) : null;
      return {
        account: a, before, after, flow, expected, recorded, delta, residual,
        meaning: !known
          ? 'no snapshot'
          : a.volatile ? 'market movement'
          : Math.abs(residual) < 1 ? 'reconciled'
          : 'unaccounted',
        warn: known && !a.volatile && Math.abs(residual) >= 1,
      };
    });
  }

  /** Contributions out of take-home. Windfalls and transfers are excluded. */
  function contributed(period) {
    return round2(sum((period.flows || []).filter((f) => f.type === 'contribution'), (f) => f.amount));
  }
  const windfalls = (period) =>
    round2(sum((period.flows || []).filter((f) => f.type === 'windfall'), (f) => f.amount));

  // --- trajectories ---------------------------------------------------------

  /** Trailing average one-off draw, seeded from config until history exists. */
  function averageDraw(cfg, closedPeriods) {
    const recent = closedPeriods.slice(-cfg.rules.trailingPeriodsForAverage);
    if (recent.length < 2) return { value: cfg.rules.expectedOneOffPerPeriod, source: 'estimate', n: 0 };
    const avg = sum(recent, (p) => (p.totals && p.totals.surpriseFromBuffer) || 0) / recent.length;
    return { value: round2(avg), source: 'trailing average', n: recent.length };
  }

  /**
   * The buffer is the tier most likely to fail quietly: replenished at a fixed
   * trickle, drained unpredictably. It can trend to zero for months without any
   * single period looking wrong.
   */
  function bufferTrajectory(cfg, balances, closedPeriods, inRecovery) {
    const keep = inRecovery ? 1 - cfg.rules.recoveryReductionPct / 100 : 1;
    const inflow = round2(cfg.waterfall.bufferPerPeriod * keep);
    const draw = averageDraw(cfg, closedPeriods);
    const net = round2(inflow - draw.value);
    const points = [];
    let bal = balances.buffer ?? 0;
    for (let i = 0; i <= projection(cfg).periods; i++) {
      points.push({ period: i, balance: round2(bal) });
      bal += net;
    }
    const acct = cfg.accounts.find((a) => a.id === 'buffer');
    return {
      inflow, draw, net, points,
      target: acct?.target ?? 0,
      periodsToZero: net < 0 ? Math.ceil((balances.buffer ?? 0) / -net) : null,
    };
  }

  /** Only worth showing while the emergency fund is short. */
  function emergencyTrajectory(cfg, balances, waterfallResult) {
    const acct = cfg.accounts.find((a) => a.id === 'emergency');
    const target = acct?.target ?? 0;
    const bal = balances.emergency ?? 0;
    if (bal >= target) return null;
    const inflow = waterfallResult.tiers.find((t) => t.key === 'emergency').amount;
    const points = [];
    let b = bal;
    for (let i = 0; i <= projection(cfg).periods; i++) {
      points.push({ period: i, balance: round2(Math.min(b, target)) });
      b += inflow;
    }
    return {
      inflow, target, balance: bal, points,
      gap: round2(target - bal),
      periodsToTarget: inflow > 0 ? Math.ceil((target - bal) / inflow) : null,
    };
  }

  /**
   * Where the savings destinations land over the next stretch of periods, from
   * planned contributions alone. Deliberately no market assumption: the point
   * is what the plan does, and half these accounts are volatile.
   *
   * Two destinations are not monotonic and are modelled properly: sinking funds
   * drop by the whole bill on its due date, and the buffer bleeds the trailing
   * average of one-off spending.
   */
  function savingsTrajectory(cfg, balances, closedPeriods, wf, todayISO) {
    const n = projection(cfg).periods;
    const horizon = PayDates.iso(PayDates.parse(todayISO) + (n + 2) * 20 * PayDates.DAY);
    const deposits = PayDates.depositsBetween(todayISO, horizon).slice(0, n + 1);
    if (!deposits.length) return null;

    const perPeriod = {};
    for (const t of wf.tiers.filter((x) => x.saving)) {
      for (const d of t.destinations || []) {
        if (d.accountId) perPeriod[d.accountId] = round2((perPeriod[d.accountId] || 0) + d.amount);
      }
    }
    const k401 = k401PerPeriod(cfg);
    if (k401) perPeriod.k401 = round2((perPeriod.k401 || 0) + k401);

    // Every account that holds something or receives something, not just the
    // waterfall's destinations. The 401k and vested equity dominate the total
    // and never appear in the waterfall, so leaving them out answered a much
    // smaller question than the chart appears to ask.
    const destinations = cfg.accounts
      .filter((a) => !(a.retired && !(balances[a.id] > 0)))
      .map((a) => a.id)
      .filter((id) => (balances[id] ?? 0) > 0 || (perPeriod[id] || 0) > 0);

    // Volatile accounts compound; cash savings do not, in any way worth
    // modelling over two years.
    const rate = periodReturn(projection(cfg).annualReturnPct);
    const grows = new Set(cfg.accounts.filter((a) => a.volatile).map((a) => a.id));

    const draw = averageDraw(cfg, closedPeriods);
    const running = {};
    for (const id of destinations) running[id] = round2(balances[id] ?? 0);

    // Next occurrence of each annual bill, so the sinking line saws rather than
    // climbing through a payment that actually empties it.
    const dues = cfg.expenses.sinking
      .filter((sk) => sk.dueMonth != null && sk.dueDay != null)
      .map((sk) => {
        const t = PayDates.parse(todayISO);
        const y = new Date(t).getUTCFullYear();
        let due = Date.UTC(y, sk.dueMonth - 1, sk.dueDay);
        if (due < t) due = Date.UTC(y + 1, sk.dueMonth - 1, sk.dueDay);
        return { name: sk.name, amount: sk.annualAmount, dueISO: PayDates.iso(due) };
      });

    // Point zero is today with today's balances; each later point is a deposit
    // date with that period's contributions and outflows applied.
    const points = [{ date: todayISO, balances: { ...running } }];
    const paid = [];
    let from = todayISO;
    let growth = 0;
    for (const dep of deposits.slice(0, n)) {
      const to = dep.available;
      for (const id of destinations) running[id] = round2(running[id] + (perPeriod[id] || 0));
      // Return applies after the contribution, so a period's own deposit earns
      // that period — close enough at this cadence, and it never compounds a
      // balance that was not there yet.
      if (rate) {
        for (const id of destinations) {
          if (!grows.has(id)) continue;
          const gain = round2(running[id] * rate);
          growth = round2(growth + gain);
          running[id] = round2(running[id] + gain);
        }
      }
      if (running.buffer != null) running.buffer = round2(running.buffer - draw.value);
      for (const d of dues) {
        if (d.dueISO >= from && d.dueISO < to && running.sinking != null) {
          running.sinking = round2(running.sinking - d.amount);
          paid.push({ ...d, at: to });
        }
      }
      points.push({ date: to, balances: { ...running } });
      from = to;
    }

    const total = (p) => round2(sum(destinations, (id) => p.balances[id] || 0));
    return {
      points, destinations, perPeriod, draw, billsPaid: paid,
      periods: points.length - 1,
      start: total(points[0]),
      end: total(points[points.length - 1]),
      contributedPerPeriod: round2(sum(destinations, (id) => perPeriod[id] || 0)),
      // Split out so the note can say how much of the climb is contribution
      // and how much is assumed market return.
      growth: round2(growth),
      annualReturnPct: projection(cfg).annualReturnPct,
      k401PerPeriod: k401,
    };
  }

  /**
   * Stack order for the composition chart: illiquid at the bottom in cool
   * shades, liquid above in warm, so the warm band is the part you could
   * actually reach. Named accounts come first in a deliberate order; anything
   * added later falls in behind its group.
   */
  function compositionSeries(cfg) {
    const cool = cfg.theme?.coolPalette || ['#1F3D5C', '#2F6285', '#4A93A6'];
    const warm = cfg.theme?.warmPalette || ['#6E3410', '#AC601A', '#C67C1F', '#D4AF37', '#E4C86A', '#F1E0A8'];
    const order = (ids) => ids.map((id) => cfg.accounts.find((a) => a.id === id)).filter(Boolean);

    const illiquidIds = ['k401', 'roth', 'equity'];
    const illiquid = order(illiquidIds)
      .concat(cfg.accounts.filter((a) => !a.liquid && !illiquidIds.includes(a.id)));
    const liquidIds = ['emergency', 'buffer', 'sinking', 'longterm', 'other', 'etrade-self', 'etrade-robo', 'robinhood'];
    const liquid = order(liquidIds)
      .concat(cfg.accounts.filter((a) => a.liquid && !liquidIds.includes(a.id)));

    return [
      ...illiquid.map((a, i) => ({ id: a.id, name: a.name, group: 'Illiquid', color: cool[i % cool.length] })),
      ...liquid.map((a, i) => ({ id: a.id, name: a.name, group: 'Liquid', color: warm[i % warm.length] })),
    ];
  }

  // --- mortgage -------------------------------------------------------------

  /**
   * Where the loan stands, read off the servicer's schedule rather than
   * recomputed. The schedule is the lender's arithmetic, including how they
   * round; re-deriving it from a rate would drift from the statement.
   *
   * Extra principal is subtracted on top. That is an approximation — paying
   * early also saves the interest that principal would have accrued, so the
   * real balance runs slightly below this — but it never overstates how much
   * has been paid off.
   */
  function mortgageStanding(amortization, extraPrincipal, todayISO) {
    const payments = (amortization && amortization.payments) || [];
    if (!payments.length) return null;
    const extra = round2(extraPrincipal || 0);

    // The last payment whose due date has passed.
    let paid = null;
    for (const p of payments) {
      if (p.date <= todayISO) paid = p; else break;
    }
    const scheduled = paid ? paid.end : round2(amortization.opening ?? payments[0].end + payments[0].principal);
    const next = payments.find((p) => p.date > todayISO) || null;

    return {
      scheduled,
      extra,
      balance: round2(Math.max(0, scheduled - extra)),
      paidThrough: paid ? paid.date : null,
      paymentsMade: paid ? paid.n : 0,
      paymentsLeft: payments.length - (paid ? paid.n : 0),
      next,
      opening: round2(amortization.opening ?? 0),
    };
  }

  /**
   * Scheduled remaining principal over the projection horizon. Monthly, because
   * the loan is: interpolating it onto pay periods would invent balances that
   * never exist on a statement.
   */
  function mortgageTrajectory(cfg, amortization, extraPrincipal, todayISO) {
    const standing = mortgageStanding(amortization, extraPrincipal, todayISO);
    if (!standing) return null;
    // 24 pay periods is a year; the horizon is stated in periods everywhere
    // else on the tab, so convert rather than introduce a second unit.
    const months = Math.max(1, Math.round(projection(cfg).periods / 2));
    const upcoming = (amortization.payments || []).filter((p) => p.date > todayISO).slice(0, months);

    const points = [{ period: 0, date: todayISO, balance: standing.balance }];
    for (const p of upcoming) {
      points.push({ period: p.n - standing.paymentsMade, date: p.date, balance: round2(Math.max(0, p.end - standing.extra)) });
    }
    const principalPaid = round2(sum(upcoming, (p) => p.principal));
    return {
      points, months: upcoming.length, standing,
      interestPaid: round2(sum(upcoming, (p) => p.interest)),
      principalPaid,
      start: points[0].balance,
      end: points[points.length - 1].balance,
    };
  }

  /** Will each sinking fund cover its bill by the due date? */
  function sinkingCoverage(cfg, bucketBalances, todayISO) {
    return cfg.expenses.sinking.map((s) => {
      const balance = round2(bucketBalances[s.bucketId] ?? 0);
      if (s.dueMonth == null || s.dueDay == null) {
        return { ...s, balance, status: 'no-due-date', shortfall: null, periodsLeft: null };
      }
      const today = PayDates.parse(todayISO);
      const y = new Date(today).getUTCFullYear();
      let due = Date.UTC(y, s.dueMonth - 1, s.dueDay);
      if (due < today) due = Date.UTC(y + 1, s.dueMonth - 1, s.dueDay);
      const dueISO = PayDates.iso(due);
      const periodsLeft = PayDates.depositsBetween(todayISO, dueISO).length;
      const projected = round2(balance + s.perPeriod * periodsLeft);
      // What the fund should already hold: the bill, less everything the
      // remaining contributions will still add before it lands.
      const required = round2(Math.max(0, s.annualAmount - s.perPeriod * periodsLeft));
      const shortfall = round2(required - balance);
      const daysUntilDue = PayDates.daysBetween(todayISO, dueISO);
      return {
        ...s, balance, dueISO, periodsLeft, projected, required, daysUntilDue,
        shortfall: shortfall > 0.005 ? shortfall : 0,
        status: shortfall > 0.005 ? 'short' : 'covered',
        urgent: shortfall > 0.005 && periodsLeft <= 1,
      };
    });
  }

  // --- accounts -------------------------------------------------------------

  /**
   * Two headline numbers, because one blended total lies in both directions:
   * sinking funds are pre-paid bills, not wealth, and illiquid holdings are
   * real but unspendable.
   */
  function assetSummary(cfg, balances, bucketBalances) {
    const encumbered = round2(
      sum(cfg.buckets.filter((b) => b.kind === 'sinking'), (b) => bucketBalances[b.id] ?? 0)
    );
    const liquid = round2(sum(cfg.accounts.filter((a) => a.liquid), (a) => balances[a.id] ?? 0));
    const total = round2(sum(cfg.accounts, (a) => balances[a.id] ?? 0));
    return {
      accessible: round2(liquid - encumbered),
      liquid, encumbered, total,
      illiquid: round2(total - liquid),
    };
  }

  /**
   * Buckets are allocations inside a real account, so they must add up to it.
   * When they drift, either a deposit was not allocated or a bucket was spent
   * without being recorded — both worth knowing before the numbers are trusted.
   */
  function bucketDrift(cfg, balances, bucketBalances) {
    const out = [];
    for (const a of cfg.accounts) {
      const owned = cfg.buckets.filter((b) => b.accountId === a.id);
      if (!owned.length) continue;
      const allocated = round2(sum(owned, (b) => bucketBalances[b.id] ?? 0));
      const actual = round2(balances[a.id] ?? 0);
      const drift = round2(actual - allocated);
      out.push({ account: a, allocated, actual, drift, ok: Math.abs(drift) < 0.005 });
    }
    return out;
  }

  return {
    round2, sum, prorate, DAYS_PER_MONTH, bucketDrift,
    committedTotal, sinkingTotal, scheduledTransfer, targetsFor, targetsTotal, necessaryFloor, burndown,
    projection, k401PerPeriod, periodReturn,
    mortgageStanding, mortgageTrajectory,
    compositionSeries,
    waterfall, periodDays, pace, surpriseTotal, settle, sweepPlan,
    reconcile, plannedFlows, contributed, windfalls,
    averageDraw, bufferTrajectory, emergencyTrajectory, savingsTrajectory, sinkingCoverage, assetSummary,
  };
})();

if (typeof module !== 'undefined') module.exports = Model;
