#!/usr/bin/env python3
"""Fees in, floor support out, over three years. Run: python3 test/econ/sim_flywheel.py

Collection: 10,000 tokens, floor 1 ETH at t = 0. Assumptions (not market data):
  * `turnover` = sales per year on ALL venues as a share of supply; `share` = FloorGuard's part of them.
  * Only the 2% marketplace fee is modelled, less the project share. Volume in ETH scales with the floor.
  * The engine buys at the floor with no overpayment (the best case; section 1 covers the rest).
  * The floor is a geometric random walk (annual drift mu, volatility sigma). It does NOT react to the
    buybacks: the point is to measure how large they are, not to assume their effect.
  * A holding unlocks when it is 180 days old and the floor is at least 1.3x its purchase price, is
    auctioned 34 days later (30-day governance window plus a 4-day descent) at 98% of the floor, and the
    proceeds buy tokens again at the floor. `unlock=False` models an oracle held down (free, see 3 and 6).
"""
import math
import numpy as np

SUPPLY = 10_000


def run(turnover, share, mu, sigma, years=3, project_share=0.0, unlock=True, seed=0):
    rng = np.random.default_rng(seed)
    F = 1.0
    budget = 0.0
    lots = []            # [price, day bought, day unlocked or None]
    fees = bought = sold = recycled_units = 0.0
    spent = 0.0
    for day in range(years * 365):
        F *= math.exp((mu - sigma ** 2 / 2) / 365 + sigma * math.sqrt(1 / 365) * rng.standard_normal())
        fee = 0.02 * turnover * share * SUPPLY * F / 365 * (1 - project_share)
        fees += fee
        budget += fee
        keep = []
        for lot in lots:
            price, t0, tu, units = lot
            if tu is None and unlock and day - t0 >= 180 and F >= 1.3 * price:
                lot[2] = tu = day
            if tu is not None and day - tu >= 34:
                budget += 0.98 * F * units
                sold += units
                continue
            keep.append(lot)
        lots = keep
        if budget > 0:
            units = budget / F
            lots.append([F, day, None, units])
            bought += units
            spent += budget
            budget = 0.0
    held = sum(l[3] for l in lots)
    never = sum(l[3] for l in lots if l[2] is None and (years * 365 - l[1]) >= 180)
    return dict(F=F, fees=fees, bought=bought, sold=sold, held=held, stuck=never,
                value=held * F, cost=sum(l[0] * l[3] for l in lots))


def avg(n=40, **kw):
    rs = [run(seed=k, **kw) for k in range(n)]
    return {k: float(np.mean([r[k] for r in rs])) for k in rs[0]}


if __name__ == "__main__":
    print("== 1. Size: tokens removed from circulation after 3 years (flat, volatile market) ==")
    print("   turnover  share   fees paid   in vault   % of supply   % of all sales absorbed")
    for turnover in (0.25, 1.0, 3.0):
        for share in (0.05, 0.25, 1.0):
            r = avg(turnover=turnover, share=share, mu=0.0, sigma=0.8)
            sales = turnover * SUPPLY * 3
            print(f"   {turnover:7.2f}  {100 * share:4.0f}%  {r['fees']:9.1f}  {r['held']:9.1f}  {100 * r['held'] / SUPPLY:10.2f}%"
                  f"  {100 * r['held'] / sales:12.2f}%")

    print("\n== 2. Price paths: turnover 1.0, share 25%, three years ==")
    print("   path                      end floor  fees   bought   auctioned  in vault  held >180d, never unlocked  vault value / cost")
    for label, mu, sigma, unlock in (("flat, vol 80%", 0.0, 0.8, True), ("flat, vol 30%", 0.0, 0.3, True),
                                     ("rising +60%/yr", 0.6, 0.8, True), ("falling -60%/yr", -0.6, 0.8, True),
                                     ("rising, oracle held down", 0.6, 0.8, False)):
        r = avg(turnover=1.0, share=0.25, mu=mu, sigma=sigma, unlock=unlock)
        print(f"   {label:<25} {r['F']:8.2f} {r['fees']:6.1f} {r['bought']:8.1f} {r['sold']:10.1f} {r['held']:9.1f}"
              f" {r['stuck']:16.1f}            {r['value'] / r['cost']:.2f}")
    print("   'bought' counts recycled purchases too: each auctioned token funds 0.98 of a token bought back,")
    print("   so auctions never add to the number of tokens off the market; only fees do.")

    print("\n== 3. Per ETH of volume ==")
    print("   1 ETH traded at a 1 ETH floor -> 0.02 ETH of budget -> 0.02 tokens bought (0.01 with a 50% project share).")
    print("   One token leaves circulation per 50 traded; per 100 with the maximum project share.")
