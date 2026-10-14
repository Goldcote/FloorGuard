#!/usr/bin/env python3
"""Review 10, part 2(a)/(c): the base rule as coded at c114991, in one-hour steps.

Model of BuybackEngine + Treasury (floors in units of the starting floor F0):
  sale at price p:   base = max(p, base*(1-3s)) * (1-s);  clock restarts;  refused if p < minBid
  deposit:           if budgetBefore < curve: base = max(base, budgetBefore); clock restarts
  bid = min(curve, budget);  curve = min(cap, base*(1 + g*days))
Competitive sellers sell whenever the bid is at or above the floor and the engine accepts.
minBid modes:  fixed  = a tenth of the first base, never changed (the contract's default)
               follow = a tenth of the current base (suggested)

Run: python3 test/review10/sim_base_rule_r10.py
"""
import math


class Engine:
    def __init__(self, base=0.9, cap=1.5, g=0.10, s=0.15, mode="fixed"):
        self.base, self.cap, self.g, self.s, self.mode = base, cap, g, s, mode
        self.reset, self.budget, self.min0 = 0.0, 0.0, base / 10

    def min_bid(self):
        return self.min0 if self.mode == "fixed" else self.base / 10

    def curve(self, t):
        return min(self.cap, self.base * (1 + self.g * (t - self.reset) / 24))

    def bid(self, t):
        return min(self.curve(t), self.budget)

    def deposit(self, t, amount):
        before = self.budget
        self.budget += amount
        if before < self.curve(t):
            self.base = max(self.base, before)
            self.reset = t

    def sell(self, t):
        p = self.bid(t)
        self.base = max(p, self.base * (1 - 3 * self.s)) * (1 - self.s)
        self.reset = t
        self.budget -= p
        return p


def run(path, f, lumps, mode):
    """path: list of (hours, hourly factor or ('jump', x)); lumps: {hour: floors}."""
    e = Engine(mode=mode)
    floor, t = 1.0, 0
    fills = paid = worth = over = inflow = idle_h = blocked = 0.0
    worst = 0.0
    for hours, factor in path:
        if isinstance(factor, tuple):
            floor *= factor[1]
            factor = 1.0
        for _ in range(hours):
            t += 1
            floor *= factor
            amt = floor * f / 24 + lumps.get(t, 0) * floor
            e.deposit(t, amt)
            inflow += amt
            while e.bid(t) >= floor:
                if e.bid(t) < e.min_bid():
                    blocked += 1
                    break
                p = e.sell(t)
                fills += 1; paid += p; worth += floor; over += max(0.0, p - floor)
                worst = max(worst, p / floor)
            idle_h += e.budget / floor
    return (fills, paid / worth if worth else 0, worst, over / paid if paid else 0,
            e.budget / inflow if inflow else 0, idle_h / t, blocked / t, e.base / floor)


def hourly(total, hours):
    return math.exp(math.log(total) / hours)


Y = 8760
SCENARIOS = {
    "steady, flat 1y": ([(Y, 1.0)], {}),
    "fall -70%/y": ([(Y, hourly(0.3, Y))], {}),
    "fall -70%/y + 10-floor lump at end, 30d flat": ([(Y, hourly(0.3, Y)), (720, 1.0)], {Y + 1: 10}),
    "crash -60% overnight after 30d, 180d flat": ([(720, 1.0), (1, ("jump", 0.4)), (4320, 1.0)], {}),
    "crash -60%, 10-floor lump a day later": ([(720, 1.0), (1, ("jump", 0.4)), (744, 1.0)], {746: 10}),
    "halving every 30d for 150d, 3-floor lump monthly": (
        [(3600, hourly(0.5, 720)), (720, 1.0)], {720 * k: 3 for k in range(1, 6)}),
    "fall -70%/y for 180d then x3/y for 180d": ([(4320, hourly(0.3, Y)), (4320, hourly(3, Y))], {}),
    "fall to F0/16 in 120d, then 180d flat": ([(2880, hourly(0.5, 720)), (4320, 1.0)], {}),
    "fall to F0/100 in 199d, then 90d flat": ([(4784, hourly(0.5, 720)), (2160, 1.0)], {}),
}


def main():
    print("base 0.9 F0, cap 1.5 F0, growth 10%/day, step 15%; f = fee inflow in current floors per day")
    hdr = (f"{'scenario':<50} {'f':>5} {'minBid':>6} | {'fills':>5} {'paid/F':>6} {'max':>6} {'overpaid':>8} "
           f"{'left/in':>7} {'avg idle, floors':>16} {'blocked':>7} {'base/F end':>10}")
    print(hdr)
    for name, (path, lumps) in SCENARIOS.items():
        for f in (0.005, 0.02, 0.1):
            for mode in ("fixed", "follow"):
                r = run(path, f, lumps, mode)
                print(f"{name:<50} {f:>5} {mode:>6} | {r[0]:>5.0f} {r[1]:>6.3f} {r[2]:>6.2f} {r[3]:>8.1%} "
                      f"{r[4]:>7.1%} {r[5]:>16.2f} {r[6]:>7.1%} {r[7]:>10.2f}")


if __name__ == "__main__":
    main()
