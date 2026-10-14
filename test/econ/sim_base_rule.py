#!/usr/bin/env python3
"""Review 8, question C: how the base follows a falling market under three base rules.

Model of BuybackEngine + Treasury in one-hour steps, same conventions as
test/review8/Review8BuybackSim.t.sol (which runs the real contracts and which this
reproduces for the rule as coded): the floor loses 70% in a year, fees arrive every hour
as `f` floors per day of the current floor, competitive sellers sell whenever the bid is at
or above the floor. After the year a lump of ten floors arrives and the market is flat for
30 days.

Rules for the base after a sale at `price`:
  coded   base = max(price, base) * (1 - s)            (the contract)
  price   base = price * (1 - s)                       (the economics review's sketch)
  capped  base = max(price, base * (1 - 3s)) * (1 - s) (suggested: several steps at most)

Run: python3 test/review8/sim_base_rule.py
"""
import math

HOURS = 8760
FALL = math.exp(math.log(0.3) / HOURS)


class Engine:
    def __init__(self, base, cap, g, s, rule):
        self.base, self.cap, self.g, self.s, self.rule = base, cap, g, s, rule
        self.reset = 0.0  # hours
        self.budget = 0.0

    def curve(self, t):
        return min(self.cap, self.base * (1 + self.g * (t - self.reset) / 24))

    def bid(self, t):
        return min(self.curve(t), self.budget)

    def deposit(self, t, amount):
        before = self.budget
        self.budget += amount
        if before < self.curve(t):
            self.reset = t

    def sell(self, t):
        price = self.bid(t)
        if self.rule == "coded":
            anchor = max(price, self.base)
        elif self.rule == "price":
            anchor = price
        else:
            anchor = max(price, self.base * (1 - 3 * self.s))
        self.base = anchor * (1 - self.s)
        self.reset = t
        self.budget -= price
        return price


def run(f, s, rule, g=0.10):
    e = Engine(0.9, 1.5, g, s, rule)
    floor, t = 1.0, 0
    fills = paid = worth = 0.0
    for _ in range(HOURS):
        t += 1
        floor *= FALL
        e.deposit(t, floor * f / 24)
        while e.bid(t) >= floor:
            p = e.sell(t)
            fills += 1; paid += p; worth += floor
    before = (fills, paid / worth if worth else 0, e.base / floor)
    # the lump
    fills = paid = worth = over = 0.0
    e.deposit(t, 10 * floor)
    for _ in range(30 * 24 + 1):
        while e.bid(t) >= floor:
            p = e.sell(t)
            fills += 1; paid += p; worth += floor; over += max(0.0, p - floor)
        t += 1
    return before, (fills, paid / worth if worth else 0, over / paid if paid else 0, e.budget / floor)


def main():
    print("Floor -70% a year, growth 10% a day, cap 1.5 F0, then a 10-floor lump and 30 flat days")
    print(f"{'f/day':>6} {'s':>4} {'rule':>7} | {'fills':>5} {'paid/F':>7} {'base/F at end':>13} |"
          f" {'lump fills':>10} {'paid/F':>7} {'overpaid':>8} {'left, floors':>12}")
    for f in (0.005, 0.02, 0.1):
        for s in (0.05, 0.15):
            for rule in ("coded", "price", "capped"):
                b, l = run(f, s, rule)
                print(f"{f:>6} {s:>4.0%} {rule:>7} | {b[0]:>5.0f} {b[1]:>7.3f} {b[2]:>13.2f} |"
                      f" {l[0]:>10.0f} {l[1]:>7.3f} {l[2]:>8.1%} {l[3]:>12.2f}")
    print()
    print("Cost of walking the base down with dust sales (tokens given up for ~0), s = 15%:")
    print("  rule    base after 1 / 3 / 10 dust sales (share of start)")
    for rule, step in (("coded", 0.85), ("capped", 0.85 * 0.55)):
        print(f"  {rule:<7} {step:.3f} / {step**3:.3f} / {step**10:.4f}")
    print("  price   ~0 after one: the curve grows relative to the base, so the bid is dead")


if __name__ == "__main__":
    main()
