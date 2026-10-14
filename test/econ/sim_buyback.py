#!/usr/bin/env python3
"""Monte-Carlo model of the BuybackEngine's rising bid. Run: python3 test/econ/sim_buyback.py

The bid formula is the contract's:  bid(t) = min(maxPrice, base * (1 + g * elapsed_days)),
after a fill base = price * (1 - s). A fill needs  bid >= acceptance price  and  budget >= bid.

Assumptions (all of them are assumptions, none is market data):
  * Prices are in units of the collection's lowest ask on other venues, F (F = 1 at t = 0).
  * An "impatient" seller, who would otherwise hit the best bid on another venue, accepts
    F * (1 - DELTA). Such sellers arrive as a Poisson process and stay one day.
  * Otherwise the cheapest supply is an arbitrageur who buys the lowest ask elsewhere and
    needs F * (1 + ARB_COST) (marketplace fee, royalty, gas).
  * Sellers are competitive: the first hour in which the bid is acceptable and funded is taken.
  * Fees arrive as Poisson trades of 0.02 F each (2% of a floor-priced sale), or as lumps.
  * Time step: one hour. `fixed=True` models the proposed rule B "the bid's clock only runs
    while the budget covers the bid"; `fixed="min"` models rule A "bid = min(curve, budget)".
"""
import math
import numpy as np

DELTA = 0.02      # impatient sellers accept 2% under the outside ask
ARB_COST = 0.015  # cost of buying the outside ask and delivering it
HOURS = 24


def run(f_per_day, g, s, max_price, days=730, cooldown_h=0, impatient_per_day=1.0, sigma=0.0,
        drift=0.0, lumps=None, monopolist=False, track_max=None, fixed=False, seed=1):
    """Returns dict with fills, mean paid/F at fill time, overpaid share of spend, idle budget share."""
    rng = np.random.default_rng(seed)
    F = 1.0
    base, t_reset = 0.9, 0.0
    clock = 0.0  # effective elapsed days since reset (differs from wall time only if fixed)
    budget = 0.0
    last_fill = -1e9
    impatient_until = -1.0
    paid = value = inflow = 0.0
    fills = 0
    ratios = []
    lumps = dict(lumps or {})
    steps = days * HOURS
    dt = 1.0 / HOURS
    for i in range(steps):
        t = i * dt
        if sigma or drift:
            F *= math.exp((drift - 0.5 * sigma ** 2) * dt / 365 + sigma * math.sqrt(dt / 365) * rng.standard_normal())
        if track_max and i % (track_max[0] * HOURS) == 0:
            max_price = track_max[1] * F  # the owner resets the cap every N days to k * F
        # fees
        n_trades = rng.poisson(f_per_day * dt / 0.02) if f_per_day else 0
        add = n_trades * 0.02 * F + lumps.pop(i, 0.0) * F
        budget += add
        inflow += add
        if rng.random() < impatient_per_day * dt:
            impatient_until = t + 1.0
        bid_now = min(max_price, base * (1 + g * clock))
        if fixed != True or budget >= bid_now:
            clock += dt
        while True:
            bid = min(max_price, base * (1 + g * clock))
            if fixed == "min":
                bid = min(bid, budget)  # variant A: the bid never exceeds the budget
            if monopolist:
                accept = max_price  # one holder is the only supply and waits for the cap
            else:
                accept = F * (1 - DELTA) if t <= impatient_until else F * (1 + ARB_COST)
            if bid < accept or budget < bid or (t - last_fill) * HOURS < cooldown_h:
                break
            budget -= bid
            paid += bid
            value += F
            fills += 1
            ratios.append(bid / F)
            base, clock, last_fill = bid * (1 - s), 0.0, t
    return dict(fills=fills, mean_ratio=(np.mean(ratios) if ratios else float("nan")),
                last_ratio=(np.mean(ratios[-5:]) if ratios else float("nan")),
                overpaid=(paid - value) / paid if paid else 0.0,
                idle=budget / inflow if inflow else 0.0)


def row(label, r):
    print(f"{label:<58} fills {r['fills']:>5}  paid/F mean {r['mean_ratio']:.3f} last {r['last_ratio']:.3f}"
          f"  overpaid {100 * r['overpaid']:5.1f}% of spend  idle {100 * r['idle']:5.1f}% of inflow")


def threshold(g, s):
    return g * (1 - s) / s


if __name__ == "__main__":
    print("== 1. Regime threshold: fee inflow (floors/day) the curve needs, f* = g(1-s)/s ==")
    for g, s in [(0.10, 0.05), (0.05, 0.05), (0.02, 0.05), (0.01, 0.05), (0.005, 0.05), (0.0025, 0.05),
                 (0.10, 0.10), (0.02, 0.10), (0.01, 0.10), (0.01, 0.02)]:
        fs = threshold(g, s)
        print(f"  g {100 * g:5.2f}%/day  s {100 * s:4.1f}%  ->  f* = {fs:6.3f} floors/day"
              f" = {fs * 50:7.1f} floors/day of 2%-fee volume;  max purchase rate {1 / (s / ((1 - s) * g)):6.2f}/day")

    print("\n== 2. Script defaults (g 10%/day, s 5%), constant market, two years ==")
    for f in (0.02, 0.1, 0.5, 1.5, 2.5, 5.0):
        for m in (1.1, 1.5, 2.0):
            row(f"  inflow {f:4.2f} floors/day, maxPrice {m:.1f}F", run(f, 0.10, 0.05, m))

    print("\n== 3. Curve tuned to the inflow: g = 0.5 * f * s / (1 - s) ==")
    for f in (0.02, 0.1, 0.5):
        g = 0.5 * f * 0.05 / 0.95
        row(f"  inflow {f:4.2f}, g {1e4 * g:5.1f} bps/day, s 5%, maxPrice 1.5F", run(f, g, 0.05, 1.5))
    print("   ... and the same curves when the inflow then halves twice (to a quarter):")
    for f in (0.02, 0.1, 0.5):
        g = 0.5 * f * 0.05 / 0.95
        row(f"  inflow {f / 4:5.3f}, g {1e4 * g:5.1f} bps/day, s 5%, maxPrice 1.5F", run(f / 4, g, 0.05, 1.5))

    print("\n== 4. Proposed rule: the clock runs only while the budget covers the bid ==")
    for f in (0.02, 0.1, 0.5, 2.5):
        row(f"  inflow {f:4.2f}, g 2%/day, s 3%, maxPrice 1.5F, fixed", run(f, 0.02, 0.03, 1.5, fixed=True))
    row("  inflow 0.10, defaults, maxPrice 2.0F, fixed", run(0.1, 0.10, 0.05, 2.0, fixed=True))

    print("\n== 5. Moving market (GBM, 80% annual volatility), inflow 0.1 floors/day, 20 seeds ==")
    def avg(**kw):
        rs = [run(0.1, seed=k, sigma=0.8, **kw) for k in range(20)]
        return dict(fills=int(np.mean([r["fills"] for r in rs])), mean_ratio=np.nanmean([r["mean_ratio"] for r in rs]),
                    last_ratio=np.nanmean([r["last_ratio"] for r in rs]), overpaid=np.mean([r["overpaid"] for r in rs]),
                    idle=np.mean([r["idle"] for r in rs]))
    row("  defaults, maxPrice fixed at 1.5 F0", avg(g=0.10, s=0.05, max_price=1.5))
    row("  defaults, maxPrice reset weekly to 1.10 F", avg(g=0.10, s=0.05, max_price=1.1, track_max=(7, 1.10)))
    row("  defaults, maxPrice reset daily to 1.05 F", avg(g=0.10, s=0.05, max_price=1.05, track_max=(1, 1.05)))
    row("  g 25bps, maxPrice reset weekly to 1.10 F", avg(g=0.0025, s=0.05, max_price=1.1, track_max=(7, 1.10)))
    row("  fixed rule, g 2%, s 3%, maxPrice fixed 1.5 F0", avg(g=0.02, s=0.03, max_price=1.5, fixed=True))
    row("  fixed rule, g 2%, s 3%, weekly cap 1.10 F", avg(g=0.02, s=0.03, max_price=1.1, track_max=(7, 1.10), fixed=True))
    row("  fixed rule, g 10%, s 15%, maxPrice fixed 1.5 F0", avg(g=0.10, s=0.15, max_price=1.5, fixed=True))
    row("  fixed rule, g 5%, s 10%, maxPrice fixed 1.5 F0", avg(g=0.05, s=0.10, max_price=1.5, fixed=True))
    row("  defaults, maxPrice reset monthly to 1.25 F", avg(g=0.10, s=0.05, max_price=1.25, track_max=(30, 1.25)))
    print("   falling market (drift -70%/yr, vol 60%):")
    def avgf(**kw):
        rs = [run(0.1, seed=k, sigma=0.6, drift=-0.7, **kw) for k in range(20)]
        return dict(fills=int(np.mean([r["fills"] for r in rs])), mean_ratio=np.nanmean([r["mean_ratio"] for r in rs]),
                    last_ratio=np.nanmean([r["last_ratio"] for r in rs]), overpaid=np.mean([r["overpaid"] for r in rs]),
                    idle=np.mean([r["idle"] for r in rs]))
    row("  defaults, maxPrice fixed at 1.5 F0", avgf(g=0.10, s=0.05, max_price=1.5))
    row("  defaults, maxPrice reset weekly to 1.10 F", avgf(g=0.10, s=0.05, max_price=1.1, track_max=(7, 1.10)))
    row("  fixed rule, g 2%, s 3%, maxPrice fixed 1.5 F0", avgf(g=0.02, s=0.03, max_price=1.5, fixed=True))
    row("  fixed rule, g 2%, s 3%, weekly cap 1.10 F", avgf(g=0.02, s=0.03, max_price=1.1, track_max=(7, 1.10), fixed=True))
    row("  fixed rule, g 10%, s 15%, maxPrice fixed 1.5 F0", avgf(g=0.10, s=0.15, max_price=1.5, fixed=True))
    row("  fixed rule, g 5%, s 10%, maxPrice fixed 1.5 F0", avgf(g=0.05, s=0.10, max_price=1.5, fixed=True))
    row("  defaults, maxPrice reset monthly to 1.25 F", avgf(g=0.10, s=0.05, max_price=1.25, track_max=(30, 1.25)))

    print("\n== 6. Lumps: 180 unfunded days, then 40 floors at once (vault auctions), one year ==")
    lump = {180 * HOURS: 40.0}
    for label, kw in [
        ("defaults, maxPrice 2.0F, no cooldown", dict(g=0.10, s=0.05, max_price=2.0)),
        ("defaults, maxPrice 1.5F, no cooldown", dict(g=0.10, s=0.05, max_price=1.5)),
        ("defaults, maxPrice 1.1F, no cooldown", dict(g=0.10, s=0.05, max_price=1.1)),
        ("defaults, maxPrice 1.5F, 6h cooldown", dict(g=0.10, s=0.05, max_price=1.5, cooldown_h=6)),
        ("g 1%, s 5%, maxPrice 1.5F, 6h cooldown", dict(g=0.01, s=0.05, max_price=1.5, cooldown_h=6)),
        ("g 1%, s 10%, maxPrice 1.5F, 6h cooldown", dict(g=0.01, s=0.10, max_price=1.5, cooldown_h=6)),
        ("fixed rule, g 2%, s 3%, maxPrice 1.5F, 1h cooldown", dict(g=0.02, s=0.03, max_price=1.5, cooldown_h=1, fixed=True)),
    ]:
        row("  " + label, run(0.0, days=365, lumps=lump, **kw))

    print("\n== 7. One dominant holder is the only supply and waits for maxPrice ==")
    for f in (0.1, 2.5):
        row(f"  inflow {f}, defaults, maxPrice 1.5F", run(f, 0.10, 0.05, 1.5, monopolist=True))
    row("  inflow 0.1, fixed rule, g 2%, s 3%, maxPrice 1.5F", run(0.1, 0.02, 0.03, 1.5, monopolist=True, fixed=True))

    print("\n== 7b. Rule A, bid = min(curve, maxPrice, budget), script defaults ==")
    for f in (0.02, 0.1, 0.5):
        row(f"  inflow {f:4.2f}, defaults, maxPrice 1.5F, rule A", run(f, 0.10, 0.05, 1.5, fixed="min"))
    row("  lump of 40 after 180 unfunded days, maxPrice 1.5F, rule A", run(0.0, 0.10, 0.05, 1.5, days=365, lumps=lump, fixed="min"))
    row("  one dominant holder, inflow 0.1, rule A", run(0.1, 0.10, 0.05, 1.5, monopolist=True, fixed="min"))

    print("\n== 7c. Cooldown against the curve: budget-rich (2.5 floors/day), defaults, maxPrice 1.5F ==")
    print("   a cooldown longer than s/((1-s)g) = 12.6 hours lets the bid regrow more than it stepped down")
    for c in (0, 6, 12, 13, 24, 72):
        row(f"  cooldown {c:>2} h", run(2.5, 0.10, 0.05, 1.5, cooldown_h=c))

    print("\n== 8. Is 'buy the outside floor, sell into the bid' profitable? ==")
    print("  profit per token = bid - ask*(1 + buy-side cost) - gas; with ask = F:")
    for bid in (0.98, 1.0, 1.02, 1.05, 1.10, 1.5):
        for cost, gas in ((0.005, 0.0003), (0.03, 0.003), (0.055, 0.01)):
            print(f"    bid {bid:.2f}F  cost {100 * cost:.1f}%  gas {gas:.4f}  ->  {bid - (1 + cost) - gas:+.4f} F", end="")
        print()
