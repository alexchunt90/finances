/* ==========================================================================
   Mortgage — how far the principal has to come down before a new loan costs
   less each month. Ported from refi_calc.

   Wrapped in a module because the standalone version used bare globals for
   `state`, `fmt`, `$` and `el`, all of which the budget app already owns.
   Everything here is internal except Mortgage.render / setConfig.
   ========================================================================== */

'use strict';

const Mortgage = (() => {
  const view = { cfg: null, meta: {}, balance: 0, domain: { min: 0, max: 0 } };

  const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmt = {
    dollars: (n) => money0.format(Math.round(n)),
    signed: (n) => (n >= 0 ? '+' : '−') + money0.format(Math.abs(Math.round(n))),
    pct: (n) => `${n.toFixed(3).replace(/0$/, '')}%`,
    ltv: (n) => `${n.toFixed(1)}%`,
    short: (n) => (Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`),
  };

  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (name, attrs, text) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // --- amortization ---------------------------------------------------------

  const monthlyRate = (annualPct) => annualPct / 100 / 12;

  function payment(principal, annualPct, months) {
    if (months <= 0 || principal <= 0) return 0;
    const r = monthlyRate(annualPct);
    if (r === 0) return principal / months;
    return (principal * r) / (1 - Math.pow(1 + r, -months));
  }

  /**
   * Walk a loan forward a month at a time. Mortgage insurance is recomputed
   * each month so it falls away on its own once the balance crosses 80%.
   */
  function simulate({ principal, annualPct, monthlyPI, months, pmiAnnualPct, homeValue, upfront = 0 }) {
    const r = monthlyRate(annualPct);
    let balance = principal;
    let paid = 0;
    const series = new Array(months + 1);
    series[0] = { month: 0, paid: 0, balance, net: upfront + balance };
    for (let m = 1; m <= months; m++) {
      if (balance > 0) {
        const interest = balance * r;
        const pmi = pmiAnnualPct > 0 && (balance / homeValue) * 100 > 80
          ? (pmiAnnualPct / 100) * balance / 12
          : 0;
        let principalPart = monthlyPI - interest;
        if (principalPart > balance) principalPart = balance;
        if (principalPart < 0) principalPart = 0;
        balance -= principalPart;
        paid += interest + principalPart + pmi;
      }
      series[m] = { month: m, paid, balance, net: upfront + paid + balance };
    }
    return series;
  }

  // --- pricing --------------------------------------------------------------

  const sortedTiers = () => [...view.cfg.ltvTiers].sort((a, b) => a.maxLtv - b.maxLtv);

  function tierFor(ltvPct) {
    const tiers = sortedTiers();
    return tiers.find((t) => ltvPct <= t.maxLtv + 1e-9) || tiers[tiers.length - 1];
  }

  function rolledCosts() {
    const { closingCosts, rollClosingCosts } = view.cfg.refinance;
    return rollClosingCosts ? closingCosts : 0;
  }

  /** What a new loan looks like if you refinance at a given remaining principal. */
  function quote(balance) {
    const cfg = view.cfg;
    const homeValue = cfg.property.homeValue;
    const loanAmount = balance + rolledCosts();
    const ltv = (loanAmount / homeValue) * 100;
    const tier = tierFor(ltv);
    const rate = cfg.refinance.baseRate + tier.rateAdjustment;
    const months = Math.round(cfg.refinance.termYears * 12);
    const pi = payment(loanAmount, rate, months);
    const pmi = ltv > 80 ? (cfg.refinance.pmiAnnualRate / 100) * loanAmount / 12 : 0;
    return { balance, loanAmount, ltv, tier, rate, months, pi, pmi, total: pi + pmi };
  }

  /** The loan you already have. Its payment does not move when you pay extra. */
  function current() {
    const cfg = view.cfg;
    const bal = cfg.currentLoan.balance;
    const homeValue = cfg.property.homeValue;
    const pi = cfg.currentLoan.paymentOverride
      || payment(bal, cfg.currentLoan.rate, cfg.currentLoan.monthsRemaining);
    const ltv = (bal / homeValue) * 100;
    const pmi = ltv > 80 ? (cfg.currentLoan.pmiAnnualRate / 100) * bal / 12 : 0;
    return { balance: bal, ltv, rate: cfg.currentLoan.rate, months: cfg.currentLoan.monthsRemaining, pi, pmi, total: pi + pmi };
  }

  /**
   * What the payment becomes if you pay down and recast: same rate, same
   * remaining term, re-amortized on the smaller balance. No repricing, so
   * unlike the refinance line it has no tiers to step down through.
   */
  function recastAt(balance) {
    const cfg = view.cfg;
    const pi = payment(balance, cfg.currentLoan.rate, cfg.currentLoan.monthsRemaining);
    const ltv = (balance / cfg.property.homeValue) * 100;
    const pmi = ltv > 80 ? (cfg.currentLoan.pmiAnnualRate / 100) * balance / 12 : 0;
    return pi + pmi;
  }

  /**
   * The balance whose recast payment hits a given figure. Bisected rather than
   * solved: the payment is linear in principal, but mortgage insurance above
   * 80% adds a term that is not, so the closed form would be wrong there.
   */
  function recastBalanceFor(targetTotal) {
    let lo = 0;
    let hi = view.cfg.currentLoan.balance;
    if (recastAt(hi) <= targetTotal) return hi;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (recastAt(mid) < targetTotal) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Remaining principal at which each pricing tier starts to apply. */
  function cliffTargets() {
    const homeValue = view.cfg.property.homeValue;
    return sortedTiers().map((tier) => ({
      tier,
      target: (tier.maxLtv / 100) * homeValue - rolledCosts(),
    }));
  }

  /**
   * The balance where the new payment first matches what you pay today. Within
   * a tier the payment is a straight line in the balance, so each segment can
   * be solved directly rather than scanned.
   */
  function findCrossing() {
    const cur = current();
    if (quote(cur.balance).total <= cur.total) return { balance: cur.balance, alreadyCheaper: true };
    const segments = chartSegments();
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const perDollar = seg.sample.total / seg.sample.loanAmount;
      const solved = cur.total / perDollar - rolledCosts();
      if (solved >= seg.from - 1 && solved <= seg.to + 1) {
        return { balance: Math.min(solved, cur.balance), alreadyCheaper: false };
      }
    }
    return null;
  }

  // --- chart geometry -------------------------------------------------------

  function computeDomain() {
    const cur = current();
    const homeValue = view.cfg.property.homeValue;
    const ahead = cliffTargets().map((c) => c.target).filter((t) => t > 0 && t < cur.balance);
    const deepest = ahead.length ? Math.min(...ahead) : cur.balance * 0.6;
    const min = Math.max(0, Math.min(deepest - homeValue * 0.03, cur.balance * 0.6));
    view.domain = { min: Math.floor(min / 100) * 100, max: cur.balance };
  }

  /** Split the balance range at every tier boundary so the steps stay crisp. */
  function chartSegments() {
    const { min, max } = view.domain;
    const cuts = cliffTargets().map((c) => c.target).filter((t) => t > min && t < max);
    const edges = [min, ...cuts, max].sort((a, b) => a - b);
    const segments = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const from = edges[i];
      const to = edges[i + 1];
      if (to - from < 1) continue;
      const sample = quote((from + to) / 2);
      const perDollar = sample.total / sample.loanAmount;
      segments.push({
        from, to, sample,
        fromTotal: (from + rolledCosts()) * perDollar,
        toTotal: (to + rolledCosts()) * perDollar,
      });
    }
    return segments;
  }

  // --- readout --------------------------------------------------------------

  function renderChips() {
    paintChip('chip-rate', fmt.pct(view.cfg.refinance.baseRate), view.meta['mortgage.refinance.baseRate'] || {});
    paintChip('chip-home', fmt.dollars(view.cfg.property.homeValue), view.meta['mortgage.property.homeValue'] || {});
  }

  function paintChip(id, valueText, meta) {
    const node = $(id);
    if (!node) return;
    node.querySelector('.chip-value').textContent = valueText;
    node.querySelector('.chip-source').textContent = meta.asOf
      ? `${meta.label} · ${meta.asOf}`
      : (meta.label || 'saved in config.json');
    node.classList.toggle('is-live', Boolean(meta.live));
  }

  function renderSlider() {
    const slider = $('balance-slider');
    slider.min = String(view.domain.min);
    slider.max = String(view.domain.max);
    slider.step = '100';
    slider.value = String(view.balance);
    $('scale-left').textContent = fmt.dollars(view.domain.min);
    $('scale-right').textContent = `${fmt.dollars(view.domain.max)} — today`;
  }

  function renderReadout() {
    const cur = current();
    const q = quote(view.balance);
    const paydown = cur.balance - view.balance;

    const field = $('balance-field');
    if (document.activeElement !== field) field.value = Math.round(view.balance);

    $('paydown-caption').textContent = paydown < 1
      ? 'today’s balance, nothing paid down'
      : `${fmt.dollars(paydown)} paid down from today`;

    const recastNow = recastAt(view.balance);

    $('stat-ltv').textContent = fmt.ltv(q.ltv);
    $('stat-rate').textContent = fmt.pct(q.rate);
    $('stat-payment').textContent = fmt.dollars(q.total);
    $('stat-recast').textContent = fmt.dollars(recastNow);

    // Both deltas are against what you actually pay now, so the two options can
    // be read against today and against each other in one glance.
    const paintDelta = (id, value) => {
      const node = $(id);
      node.textContent = fmt.signed(value) + '/mo';
      node.classList.toggle('is-gain', value < 0);
      node.classList.toggle('is-cost', value > 0);
    };
    paintDelta('stat-delta', q.total - cur.total);
    paintDelta('stat-recast-delta', recastNow - cur.total);

    renderVerdict();
  }

  function renderVerdict() {
    const cur = current();
    const crossing = findCrossing();
    const box = $('mortgage-verdict');
    box.classList.remove('is-gain', 'is-cost');

    if (!crossing) {
      box.textContent = 'No amount of principal in this range brings the new payment down to what you pay today. '
        + 'The gap between your rate and the market rate is too wide.';
      box.classList.add('is-cost');
      return;
    }
    if (crossing.alreadyCheaper) {
      const q = quote(cur.balance);
      const stretch = q.months - cur.months;
      box.textContent = `A new loan is already cheaper each month at today's balance, by ${fmt.dollars(cur.total - q.total)}. `
        + `You would not be paying down principal to earn that — you would be buying it by adding ${stretch} months back onto the term. `
        + 'The horizon table below is where that shows up.';
      box.classList.add('is-gain');
      return;
    }
    box.innerHTML = `Pay the balance down to <strong>${fmt.dollars(crossing.balance)}</strong> — that is `
      + `${fmt.dollars(cur.balance - crossing.balance)} of principal — and the new payment matches what you pay today. `
      + 'Every dollar past that point buys a lower monthly payment.';
  }

  function renderJumps() {
    const cur = current();
    const box = $('jump-buttons');
    box.replaceChildren();

    const stops = [{ label: 'Today', balance: cur.balance }];

    const crossing = findCrossing();
    if (crossing && !crossing.alreadyCheaper) {
      stops.push({ label: 'Refi current payment', balance: crossing.balance, kind: 'refi' });
    }

    const step = view.cfg.recastStepDown;
    if (Number.isFinite(step) && step > 0 && cur.total - step > 0) {
      const target = recastBalanceFor(cur.total - step);
      if (target > 0 && target < cur.balance) {
        stops.push({ label: `Recast ${fmt.dollars(step)} less`, balance: target, kind: 'recast' });
      }
    }

    cliffTargets()
      .filter((c) => c.target > view.domain.min && c.target < cur.balance)
      .sort((a, b) => b.target - a.target)
      .forEach((c) => stops.push({ label: `${c.tier.maxLtv}% LTV`, balance: c.target }));

    for (const stop of stops) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'jump-button' + (stop.kind ? ` is-${stop.kind}` : '');
      btn.textContent = stop.label;
      btn.addEventListener('click', () => {
        view.balance = Math.max(view.domain.min, Math.floor(stop.balance));
        renderAll();
      });
      box.appendChild(btn);
    }
  }

  // --- chart ----------------------------------------------------------------

  function renderChart() {
    const node = $('chart-mortgage');
    node.replaceChildren();

    const W = 760, H = 380;
    const pad = { top: 26, right: 22, bottom: 44, left: 74 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const cur = current();
    const segments = chartSegments();
    if (!segments.length) return;

    // Sampled rather than drawn as a straight line: the payment is linear in
    // principal, but mortgage insurance falling away at 80% puts a kink in it.
    const STEPS = 48;
    const recastPoints = [];
    for (let i = 0; i <= STEPS; i++) {
      const bal = view.domain.min + ((view.domain.max - view.domain.min) * i) / STEPS;
      recastPoints.push({ bal, total: recastAt(bal) });
    }

    const payments = segments.flatMap((s) => [s.fromTotal, s.toTotal])
      .concat(recastPoints.map((r) => r.total))
      .concat([cur.total]);
    let yMin = Math.min(...payments);
    let yMax = Math.max(...payments);
    const padY = Math.max((yMax - yMin) * 0.18, 40);
    yMin -= padY;
    yMax += padY;

    const x = (bal) => pad.left + ((bal - view.domain.min) / (view.domain.max - view.domain.min)) * plotW;
    const y = (amt) => pad.top + (1 - (amt - yMin) / (yMax - yMin)) * plotH;

    // Band where a new loan costs less per month than the one you have.
    const cheaper = segments.filter((s) => Math.max(s.fromTotal, s.toTotal) < cur.total);
    if (cheaper.length) {
      const left = Math.min(...cheaper.map((s) => s.from));
      const right = Math.max(...cheaper.map((s) => s.to));
      node.appendChild(svg('rect', {
        class: 'chart-gain-band', x: x(left), y: pad.top,
        width: Math.max(0, x(right) - x(left)), height: plotH,
      }));
    }

    for (let i = 0; i <= 5; i++) {
      const value = yMin + ((yMax - yMin) * i) / 5;
      const py = y(value);
      node.appendChild(svg('line', { class: 'chart-grid', x1: pad.left, y1: py, x2: W - pad.right, y2: py }));
      node.appendChild(svg('text', { class: 'axis-text', x: pad.left - 10, y: py + 4, 'text-anchor': 'end' }, fmt.dollars(value)));
    }

    const linePoints = [];
    segments.forEach((seg, i) => {
      linePoints.push(`${x(seg.from)},${y(seg.fromTotal)}`, `${x(seg.to)},${y(seg.toTotal)}`);
      const next = segments[i + 1];
      if (next) {
        node.appendChild(svg('line', {
          class: 'chart-drop', x1: x(seg.to), y1: y(seg.toTotal), x2: x(next.from), y2: y(next.fromTotal),
        }));
        const jump = next.fromTotal - seg.toTotal;
        if (Math.abs(jump) > 5) {
          node.appendChild(svg('text', {
            class: 'chart-cliff-label', x: x(seg.to) + 6, y: y((seg.toTotal + next.fromTotal) / 2) + 4,
          }, `${fmt.signed(-Math.abs(jump))}/mo`));
        }
        linePoints.push(`${x(next.from)},${y(next.fromTotal)}`);
      }
    });

    const areaPoints = [`${x(view.domain.min)},${pad.top + plotH}`, ...linePoints, `${x(view.domain.max)},${pad.top + plotH}`];
    node.appendChild(svg('polygon', { class: 'chart-fill', points: areaPoints.join(' ') }));
    node.appendChild(svg('polyline', { class: 'chart-curve', points: linePoints.join(' ') }));

    node.appendChild(svg('polyline', {
      class: 'chart-recast',
      points: recastPoints.map((r) => `${x(r.bal)},${y(r.total)}`).join(' '),
    }));

    node.appendChild(svg('line', { class: 'chart-now', x1: pad.left, y1: y(cur.total), x2: W - pad.right, y2: y(cur.total) }));
    node.appendChild(svg('text', { class: 'chart-now-label', x: pad.left + 6, y: y(cur.total) - 8 },
      `You pay ${fmt.dollars(cur.total)} now`));

    const crossing = findCrossing();
    if (crossing && !crossing.alreadyCheaper && crossing.balance > view.domain.min && crossing.balance < view.domain.max) {
      node.appendChild(svg('line', {
        class: 'chart-cross', x1: x(crossing.balance), y1: pad.top, x2: x(crossing.balance), y2: pad.top + plotH,
      }));
      node.appendChild(svg('text', {
        class: 'chart-cross-label', x: x(crossing.balance) - 8, y: pad.top + 12, 'text-anchor': 'end',
      }, 'Breakpoint'));
    }

    // The marker reads both curves at the slider position, so the two payments
    // can be compared directly at whatever balance is being considered.
    const q = quote(view.balance);
    const recastNow = recastAt(view.balance);
    const mx = x(view.balance);
    node.appendChild(svg('line', { class: 'chart-marker-line', x1: mx, y1: pad.top, x2: mx, y2: pad.top + plotH }));
    node.appendChild(svg('circle', { class: 'chart-marker-dot is-refi', cx: mx, cy: y(q.total), r: 5 }));
    node.appendChild(svg('circle', { class: 'chart-marker-dot is-recast', cx: mx, cy: y(recastNow), r: 5 }));

    // Flip the labels to the inside when the marker is near the right edge,
    // which is where it sits at today's balance.
    const nearRight = mx > pad.left + plotW * 0.62;
    const anchor = nearRight ? 'end' : 'start';
    const dx = nearRight ? -11 : 11;
    // Nudge apart if the two payments are close enough to collide.
    const tight = Math.abs(y(q.total) - y(recastNow)) < 20;
    const bump = tight ? (q.total >= recastNow ? -7 : 7) : 0;

    node.appendChild(svg('text', {
      class: 'chart-marker-label is-refi', x: mx + dx, y: y(q.total) + 4 + bump, 'text-anchor': anchor,
    }, `${fmt.dollars(q.total)} refinance`));
    node.appendChild(svg('text', {
      class: 'chart-marker-label is-recast', x: mx + dx, y: y(recastNow) + 4 - bump, 'text-anchor': anchor,
    }, `${fmt.dollars(recastNow)} recast`));

    node.appendChild(svg('line', { class: 'chart-axis', x1: pad.left, y1: pad.top + plotH, x2: W - pad.right, y2: pad.top + plotH }));
    for (let i = 0; i <= 5; i++) {
      const bal = view.domain.min + ((view.domain.max - view.domain.min) * i) / 5;
      const px = x(bal);
      node.appendChild(svg('text', { class: 'axis-text', x: px, y: pad.top + plotH + 18, 'text-anchor': 'middle' }, fmt.short(bal)));
    }
    node.appendChild(svg('text', { class: 'chart-axis-title', x: pad.left, y: H - 6 },
      'Remaining principal'));
    node.appendChild(svg('text', { class: 'chart-axis-title', x: pad.left - 10, y: pad.top - 12, 'text-anchor': 'end' }, 'Monthly'));
  }

  // --- tables ---------------------------------------------------------------

  function breakEvenMonth(targetBalance) {
    const cfg = view.cfg;
    const cur = current();
    const q = quote(targetBalance);
    const cash = Math.max(0, cur.balance - targetBalance) + (cfg.refinance.rollClosingCosts ? 0 : cfg.refinance.closingCosts);
    const horizon = Math.max(cur.months, q.months);
    const keep = simulate({
      principal: cur.balance, annualPct: cur.rate, monthlyPI: cur.pi, months: horizon,
      pmiAnnualPct: cfg.currentLoan.pmiAnnualRate, homeValue: cfg.property.homeValue, upfront: 0,
    });
    const refi = simulate({
      principal: q.loanAmount, annualPct: q.rate, monthlyPI: q.pi, months: horizon,
      pmiAnnualPct: cfg.refinance.pmiAnnualRate, homeValue: cfg.property.homeValue, upfront: cash,
    });
    for (let m = 1; m <= horizon; m++) if (refi[m].net <= keep[m].net) return m;
    return null;
  }

  function renderCliffs() {
    const cur = current();

    // Below the threshold every tier is already cleared, so the table is a list
    // of cliffs you are past — noise rather than a decision.
    const floor = view.cfg.hideCliffsBelowLtv;
    const block = $('cliffs-block');
    if (block) block.hidden = Number.isFinite(floor) && cur.ltv < floor;

    const body = $('cliff-rows');
    body.replaceChildren();

    const all = cliffTargets().sort((a, b) => b.tier.maxLtv - a.tier.maxLtv);
    const activeTier = quote(view.balance).tier;
    // Tiers already priced past are noise. Keep the one you are in, everything
    // better than it, and one worse tier for context.
    const activeIndex = all.findIndex((r) => r.tier === activeTier);
    const rows = activeIndex < 0 ? all : all.slice(Math.max(0, activeIndex - 1));
    let anyAhead = false;

    for (const { tier, target } of rows) {
      const tr = document.createElement('tr');
      const reachable = target > 0;
      const cash = cur.balance - target;
      const alreadyThere = cash <= 0;
      if (!alreadyThere && reachable) anyAhead = true;
      if (tier === activeTier) tr.classList.add('is-current');
      if (!reachable) tr.classList.add('is-muted');

      let cells;
      if (!reachable) {
        cells = [`≤ ${tier.maxLtv}% LTV`, 'out of reach', '—', '—', '—', '—', '—'];
      } else {
        const q = quote(target);
        const months = alreadyThere ? null : breakEvenMonth(target);
        cells = [
          `≤ ${tier.maxLtv}% LTV`,
          fmt.dollars(target),
          alreadyThere ? 'already there' : fmt.dollars(cash),
          fmt.pct(q.rate),
          fmt.dollars(q.total),
          fmt.signed(q.total - cur.total) + '/mo',
          alreadyThere ? '—' : (months === null ? 'never' : `${months}`),
        ];
      }

      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i > 0) td.className = 'r';
        if (i === 5 && reachable) {
          td.classList.add(quote(target).total < cur.total ? 'is-gain' : 'is-cost');
        }
        tr.appendChild(td);
      });

      if (tier === activeTier) {
        const tag = document.createElement('span');
        tag.className = 'flag gain';
        tag.textContent = ' you are here';
        tr.firstChild.appendChild(tag);
      }
      body.appendChild(tr);
    }

    $('cliffs-note').textContent = anyAhead
      ? 'Break-even counts the months until the cheaper path has cost you less overall, paydown cash included.'
      : `At ${fmt.ltv(cur.ltv)} loan-to-value you already clear every tier, so paying down principal no longer buys a better rate.`;
  }

  function renderHorizon() {
    const cfg = view.cfg;
    const cur = current();
    const q = quote(view.balance);
    const months = Math.round(cfg.horizonYears * 12);
    const paydown = Math.max(0, cur.balance - view.balance);

    const keep = simulate({
      principal: cur.balance, annualPct: cur.rate, monthlyPI: cur.pi, months,
      pmiAnnualPct: cfg.currentLoan.pmiAnnualRate, homeValue: cfg.property.homeValue, upfront: 0,
    });

    // With nothing paid down there is nothing to re-amortize, so the recast row
    // should read exactly like the loan you already have.
    const recastPayment = paydown < 1 ? cur.pi : payment(view.balance, cur.rate, cur.months);
    const recastCash = paydown < 1 ? 0 : paydown + cfg.currentLoan.recastFee;
    const recast = simulate({
      principal: view.balance, annualPct: cur.rate, monthlyPI: recastPayment, months,
      pmiAnnualPct: cfg.currentLoan.pmiAnnualRate, homeValue: cfg.property.homeValue, upfront: recastCash,
    });

    const refiCash = paydown + (cfg.refinance.rollClosingCosts ? 0 : cfg.refinance.closingCosts);
    const refi = simulate({
      principal: q.loanAmount, annualPct: q.rate, monthlyPI: q.pi, months,
      pmiAnnualPct: cfg.refinance.pmiAnnualRate, homeValue: cfg.property.homeValue, upfront: refiCash,
    });

    const paths = [
      { name: 'Keep the loan, change nothing', cash: 0, monthly: cur.total, series: keep },
      { name: `Pay down, then recast at ${fmt.pct(cur.rate)}`, cash: recastCash, monthly: recastPayment, series: recast },
      { name: `Pay down, then refinance at ${fmt.pct(q.rate)}`, cash: refiCash, monthly: q.total, series: refi },
    ];

    const best = Math.min(...paths.map((p) => p.series[months].net));
    const body = $('horizon-rows');
    body.replaceChildren();

    for (const path of paths) {
      const end = path.series[months];
      const tr = document.createElement('tr');
      const isBest = Math.abs(end.net - best) < 1;
      if (isBest) tr.classList.add('is-current');

      [path.name, fmt.dollars(path.cash), fmt.dollars(path.monthly), fmt.dollars(end.paid), fmt.dollars(end.balance), fmt.dollars(end.net)]
        .forEach((text, i) => {
          const td = document.createElement('td');
          td.textContent = text;
          if (i > 0) td.className = 'r';
          tr.appendChild(td);
        });

      if (isBest) {
        const tag = document.createElement('span');
        tag.className = 'flag gain';
        tag.textContent = ' lowest';
        tr.firstChild.appendChild(tag);
      }
      body.appendChild(tr);
    }

    $('horizon-note').textContent =
      `Measured over ${cfg.horizonYears} years at a remaining principal of ${fmt.dollars(view.balance)}. `
      + 'A recast keeps your rate and payoff date and only lowers the payment.';
  }

  // --- controls -------------------------------------------------------------

  const BINDINGS = [
    ['in-cur-balance', 'currentLoan.balance', 'number'],
    ['in-cur-rate', 'currentLoan.rate', 'number'],
    ['in-cur-months', 'currentLoan.monthsRemaining', 'number'],
    ['in-cur-payment', 'currentLoan.paymentOverride', 'nullableNumber'],
    ['in-cur-pmi', 'currentLoan.pmiAnnualRate', 'number'],
    ['in-recast-fee', 'currentLoan.recastFee', 'number'],
    ['in-base-rate', 'refinance.baseRate', 'number'],
    ['in-term', 'refinance.termYears', 'number'],
    ['in-closing', 'refinance.closingCosts', 'number'],
    ['in-new-pmi', 'refinance.pmiAnnualRate', 'number'],
    ['in-roll', 'refinance.rollClosingCosts', 'boolean'],
    ['in-home-value', 'property.homeValue', 'number'],
    ['in-horizon', 'horizonYears', 'number'],
  ];

  const dig = (obj, dotPath) => dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);

  function setPath(obj, dotPath, value) {
    const keys = dotPath.split('.');
    const last = keys.pop();
    keys.reduce((acc, k) => (acc[k] = acc[k] || {}), obj)[last] = value;
  }

  function fillControls() {
    for (const [id, path, kind] of BINDINGS) {
      const input = $(id);
      const value = dig(view.cfg, path);
      if (kind === 'boolean') input.checked = Boolean(value);
      else if (document.activeElement !== input) input.value = value == null ? '' : value;
    }
  }

  let onEdit = () => {};

  function wire(saveConfig) {
    onEdit = () => { renderAll(); saveConfig(); };

    for (const [id, path, kind] of BINDINGS) {
      $(id).addEventListener('input', () => {
        const input = $(id);
        let value;
        if (kind === 'boolean') value = input.checked;
        else if (kind === 'nullableNumber') value = input.value === '' ? null : Number(input.value);
        else value = Number(input.value);
        if (kind !== 'boolean' && value !== null && !Number.isFinite(value)) return;
        setPath(view.cfg, path, value);
        if (path === 'currentLoan.balance') view.balance = value;
        onEdit();
      });
    }

    const move = () => { renderReadout(); renderChart(); renderCliffs(); renderHorizon(); };

    $('balance-slider').addEventListener('input', (ev) => {
      view.balance = Number(ev.target.value);
      move();
    });
    $('balance-field').addEventListener('input', (ev) => {
      const value = Number(ev.target.value);
      if (!Number.isFinite(value)) return;
      view.balance = Math.min(Math.max(value, view.domain.min), view.domain.max);
      $('balance-slider').value = String(view.balance);
      move();
    });
  }

  function renderAll() {
    if (!view.cfg) return;
    computeDomain();
    view.balance = Math.min(Math.max(view.balance, view.domain.min), view.domain.max);
    renderChips();
    renderSlider();
    renderReadout();
    renderJumps();
    renderChart();
    renderCliffs();
    renderHorizon();
  }

  function setConfig(cfg, meta) {
    view.cfg = cfg;
    view.meta = meta || {};
    if (!view.balance) view.balance = cfg.currentLoan.balance;
  }

  return { setConfig, wire, render: () => { fillControls(); renderAll(); }, quote, current, cliffTargets, findCrossing };
})();

if (typeof module !== 'undefined') module.exports = Mortgage;
