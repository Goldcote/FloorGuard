#!/usr/bin/env python3
"""What it costs to force a prediction market to settle "Lower", under three settlement rules.
Run: python3 test/econ/sim_settlement_attack.py

The attack: bet on "Lower", then make the settlement price read low (dump, fake, or sell into the
bid) and collect the other side's pool. It pays whenever the pool the attacker wins is larger than
what the manipulation costs. Costs below are in floors (1 = one token at the floor), and count only
what the attacker gives up: tokens sold below what they are worth.

The buyback engine follows the contract's rules: curve = base x (1 + 10% x days since restart), capped;
bid = min(curve, budget); after a fill the curve restarts 15% below the fill price; when the budget
cannot cover the curve, the curve restarts from the budget (late money does not inherit a rise); no
bid below 10% of the base; a cooldown between fills. Fees reach the budget daily. The floor is a
random walk (40% volatility a year). Honest holders: the cheapest one sells when the bid reaches the
floor give or take 2%. A fill is "curve-limited" when the budget could pay the whole curve, i.e. the
price is one a holder accepted rather than whatever an empty budget allowed.

Rules compared, for a market of 7 days whose start price is the floor at its start, with the
contract's 2% dead band:
  A. One reading at settlement (today's design, any oracle that reads a single moment): the attacker
     sells one token 3% under the floor just before settlement. A fake listing on a venue the reporter
     reads may cost nothing at all.
  B. The last price the buyback engine paid: the attacker sells into the bid at its lowest just before
     settlement.
  C. The lower median of curve-limited engine fills during the market, voided with fewer than 3: the
     attacker must supply more than half of them, each one restarting the curve 15% lower, and each
     needs budget to be curve-limited.
"""
import math
import statistics
import numpy as np

DAY_STEPS = 24
GROWTH, STEP, CAP_MULT, MIN_BID = 0.10, 0.15, 1.5, 0.10
COOLDOWN = 6 / 24  # days
MARKET_DAYS, DEAD_BAND, MIN_FILLS = 7, 0.02, 3


def run(fees_per_day, seed, days=210):
    rng = np.random.default_rng(seed)
    F, budget, base = 1.0, 3.0, 0.9
    curve, last_fill_t = base, -10.0
    sigma = 0.4
    history = []  # per hour: (t, F, curve, budget, base)
    fills = []  # (t, price, curve_limited)
    for i in range(days * DAY_STEPS):
        t = i / DAY_STEPS
        F *= math.exp(-sigma ** 2 / 2 / 365 / DAY_STEPS + sigma * math.sqrt(1 / 365 / DAY_STEPS) * rng.standard_normal())
        before = budget
        budget += fees_per_day * F / DAY_STEPS
        if before < curve:
            curve = max(base, before)
        curve = min(CAP_MULT * F, curve + GROWTH * base / DAY_STEPS)
        bid = min(curve, budget)
        reservation = F * (1 + 0.02 * rng.standard_normal())
        if t - last_fill_t >= COOLDOWN and bid >= MIN_BID * base and bid >= reservation:
            fills.append((t, bid, budget >= curve))
            budget -= bid
            base = curve = bid * (1 - STEP)
            last_fill_t = t
        history.append((t, F, curve, budget, base))
    return history, fills


def attack_costs(history, fills, start_day):
    """Cost of forcing "Lower" under each rule, or None for a rule whose market would settle Lower (or
    void, for C) without any attacker: there is nothing to manipulate there."""
    end_day = start_day + MARKET_DAYS
    h0 = history[start_day * DAY_STEPS]
    h1 = history[end_day * DAY_STEPS - 1]
    start, F_end, curve, budget, base = h0[1], h1[1], h1[2], h1[3], h1[4]
    target = start * (1 - DEAD_BAND)  # the price must read below this to settle Lower
    window = [(p, limited) for (t, p, limited) in fills if start_day <= t < end_day]
    honest = sorted(p for (p, limited) in window if limited)

    # A: one token sold 3% under the floor at the settlement moment
    cost_a = 0.03 * F_end if F_end >= target else None

    # B: sell into the bid at settlement, again after each step-down, until the last fill reads low
    if window and window[-1][0] < target:
        cost_b = None
    else:
        cost_b, price, b = 0.0, min(curve, budget), budget
        while True:
            if price < MIN_BID * base or b < price:
                cost_b = math.inf
                break
            cost_b += max(0.0, F_end - price)
            b -= price
            if price < target:
                break
            price = min(price * (1 - STEP), b)

    # C: the lower median of curve-limited fills must read below the target, with at least MIN_FILLS
    natural_c = honest[(len(honest) - 1) // 2] if len(honest) >= MIN_FILLS else None
    if natural_c is not None and natural_c < target:
        cost_c = None
    else:
        cost_c, b, c, mine = 0.0, budget, curve, []
        while True:
            prices = sorted(honest + mine)
            if len(prices) >= MIN_FILLS and prices[(len(prices) - 1) // 2] < target:
                break
            if b < c or c < MIN_BID * base:  # the next fill would not be curve-limited, so would not count
                cost_c = math.inf
                break
            mine.append(c)
            cost_c += max(0.0, F_end - c)
            b -= c
            c = c * (1 - STEP)
    return cost_a, cost_b, cost_c, len(honest), natural_c is None


def summarise(fees_per_day, seeds=40):
    a, b, c, h, voids, n = [], [], [], [], 0, 0
    for s in range(seeds):
        history, fills = run(fees_per_day, s)
        for start_day in range(60, 200, 7):
            ra, rb, rc, honest, void = attack_costs(history, fills, start_day)
            n += 1
            h.append(honest)
            voids += void
            if ra is not None: a.append(ra)
            if rb is not None: b.append(rb)
            if rc is not None: c.append(rc)

    def med(xs):
        finite = [x for x in xs if x != math.inf]
        return statistics.median(finite) if finite else math.inf

    def p10(xs):
        finite = [x for x in xs if x != math.inf]
        return float(np.percentile(finite, 10)) if finite else math.inf

    return dict(a=med(a), b=med(b), c=med(c), c_low=p10(c), c_impossible=100 * sum(x == math.inf for x in c) / max(1, len(c)),
                b_impossible=100 * sum(x == math.inf for x in b) / max(1, len(b)), honest=statistics.mean(h), voids=100 * voids / n)


if __name__ == "__main__":
    print("Cost to force a 7-day market to settle Lower, in floors (median over markets that would")
    print("not have fallen on their own; 40 runs x 20 markets each)\n")
    def f(x):
        return "  never" if x == math.inf else f"{x:7.2f}"
    print(f"{'fees/day':>9} {'A: one reading':>15} {'B: last fill':>13} {'C: median':>10} {'C cheapest 10%':>15} {'C impossible':>13} {'C voids anyway':>15} {'honest fills':>13}")
    for fees in (0.05, 0.2, 0.5, 1.0, 2.0):
        r = summarise(fees)
        print(f"{fees:>9} {f(r['a']):>15} {f(r['b']):>13} {f(r['c']):>10} {f(r['c_low']):>15} {r['c_impossible']:>12.0f}% {r['voids']:>14.0f}% {r['honest']:>13.1f}")
    print("\nfees/day: fees reaching the collection's budget per day, in floors (0.2 = ten floors of trading a")
    print("day at 2%). Each cost is the median over markets that rule would not settle Lower by itself.")
    print("'C impossible': markets where the budget cannot pay enough curve-limited fills to move the median,")
    print("so the attack cannot be done at any price. 'C voids anyway': markets with fewer than 3 honest")
    print("curve-limited fills, which rule C refunds without an attacker. 'honest fills': curve-limited fills")
    print("by ordinary holders per market. An attacker profits when the pool on the other side (less the 3%")
    print("fee) is larger than the cost.")
