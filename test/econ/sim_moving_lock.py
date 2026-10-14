#!/usr/bin/env python3
"""The Vault's fixed lock against its moving lock, on the same price paths.
Run: python3 test/econ/sim_moving_lock.py

Same collection and assumptions as sim_flywheel.py (10,000 tokens, floor 1 ETH at t = 0, 1x turnover a year,
25% of it on FloorGuard, 2% fee, the engine buys at the floor, the floor is a geometric random walk that does
not react to the buybacks, three years, 40 seeds). Unlocked holdings are auctioned 34 days later at 98% of the
floor and the proceeds buy again at the floor.

Fixed lock (before): a holding unlocks at 180 days once the floor is at least 1.3x its purchase price.
Moving lock (now):
  * from 90 days, a daily draw picks a holding with a chance rising from 0.5% (90 days) to 5% (365 days);
  * a picked holding unlocks if the median of the last 30 daily floors is at least the required multiple of
    its price, 1.3x at 90 days falling to 1.0x at 365 days;
  * at most 5% of the collection's holdings (at least one token) unlock in any 7 days;
  * one purchase in five is set aside for players: raffled after 30 days, and back in circulation 37 days
    later (7-day announcement, 30-day vesting). Raffles are modelled as giving the token away.
"""
import math
import statistics
import numpy as np

SUPPLY = 10_000
YEARS = 3


def ramp(age, start, end):
    if age <= 90:
        return start
    if age >= 365:
        return end
    return start + (end - start) * (age - 90) / 275


def run(mu, sigma, moving, seed, turnover=1.0, share=0.25):
    rng = np.random.default_rng(seed)
    draw_rng = np.random.default_rng(seed + 10_000)
    F = 1.0
    floors = []
    budget = 0.0
    lots = []  # dict(price, t0, units, unlocked_day or None, players)
    released = to_players = 0.0
    weekly = {}
    unlock_ages = []
    window_start, window_cap, window_used = None, 0.0, 0.0
    credit = 0
    for day in range(YEARS * 365):
        F *= math.exp((mu - sigma ** 2 / 2) / 365 + sigma * math.sqrt(1 / 365) * rng.standard_normal())
        floors.append(F)
        median = statistics.median_low(floors[-30:]) if len(floors) >= 15 else None
        budget += 0.02 * turnover * share * SUPPLY * F / 365
        held = sum(l["units"] for l in lots)
        keep = []
        for l in lots:
            age = day - l["t0"]
            if l["unlocked"] is None:
                if l["players"]:
                    if age >= 30 + 37:
                        to_players += l["units"]
                        weekly[day // 7] = weekly.get(day // 7, 0) + l["units"]
                        continue
                elif not moving:
                    if age >= 180 and F >= 1.3 * l["price"]:
                        l["unlocked"] = day
                        unlock_ages.append(age)
                elif age >= 90 and draw_rng.random() < ramp(age, 0.005, 0.05) and median is not None \
                        and median >= ramp(age, 1.3, 1.0) * l["price"]:
                    if window_start is None or day - window_start >= 7:
                        window_start, window_cap, window_used = day, max(1.0, 0.05 * held), 0.0
                    if window_used + l["units"] <= window_cap:
                        window_used += l["units"]
                        l["unlocked"] = day
                        unlock_ages.append(age)
            if l["unlocked"] is not None and day - l["unlocked"] >= 34:
                budget += 0.98 * F * l["units"]
                released += l["units"]
                weekly[day // 7] = weekly.get(day // 7, 0) + l["units"]
                continue
            keep.append(l)
        lots = keep
        if budget > 0:
            players = False
            if moving:
                credit += 2_000
                if credit >= 10_000:
                    credit -= 10_000
                    players = True
            lots.append(dict(price=F, t0=day, units=budget / F, unlocked=None, players=players))
            budget = 0.0
    held = sum(l["units"] for l in lots)
    # held for over a year and still locked: the "never unlocks" problem
    old = [l for l in lots if not l["players"] and YEARS * 365 - l["t0"] >= 365 and l["unlocked"] is None]
    return dict(
        held=held,
        released=released,
        to_players=to_players,
        stuck_share=sum(l["units"] for l in old) / held if held else 0.0,
        peak_week=max(weekly.values()) if weekly else 0.0,
        unlock_spread=statistics.pstdev(unlock_ages) if len(unlock_ages) > 1 else 0.0,
        median_unlock_age=statistics.median(unlock_ages) if unlock_ages else float("nan"),
    )


def avg(n=40, **kw):
    rs = [run(seed=k, **kw) for k in range(n)]
    out = {}
    for k in rs[0]:
        vals = [r[k] for r in rs if not (isinstance(r[k], float) and math.isnan(r[k]))]
        out[k] = float(np.mean(vals)) if vals else float("nan")
    return out


def size_table():
    print("Size: share of supply held after three years, flat market, volatility 80% (as in section 9 of the review)")
    print(f"{'sales a year':>12} {'share':>6} {'fixed':>7} {'moving':>7}")
    for turnover, share in ((0.25, 0.05), (1.0, 0.25), (1.0, 1.0), (3.0, 0.25)):
        f = avg(mu=0.0, sigma=0.8, moving=False, turnover=turnover, share=share)
        m = avg(mu=0.0, sigma=0.8, moving=True, turnover=turnover, share=share)
        print(f"{int(turnover * SUPPLY):>12,} {100 * share:5.0f}% {100 * f['held'] / SUPPLY:6.2f}% {100 * m['held'] / SUPPLY:6.2f}%")
    print()


if __name__ == "__main__":
    size_table()
    paths = (("flat, vol 80%", 0.0, 0.8), ("flat, vol 30%", 0.0, 0.3), ("rising +60%/yr", 0.6, 0.8),
             ("falling -60%/yr", -0.6, 0.8))
    print("turnover 1.0, share 25%, three years, 40 seeds; tokens are of a 10,000 supply")
    print(f"{'path':<17} {'rule':<7} {'off market':>10} {'auctioned':>9} {'to players':>10} {'locked >1 yr':>14}"
          f" {'peak week':>9} {'unlock age':>10} {'spread':>7}")
    for label, mu, sigma in paths:
        for moving in (False, True):
            r = avg(mu=mu, sigma=sigma, moving=moving)
            print(f"{label:<17} {'moving' if moving else 'fixed':<7} {r['held']:10.1f} {r['released']:9.1f}"
                  f" {r['to_players']:10.1f} {100 * r['stuck_share']:13.0f}% {r['peak_week']:9.1f}"
                  f" {r['median_unlock_age']:9.0f}d {r['unlock_spread']:6.0f}d")
    print("'off market': tokens the Vault holds at the end; 7,500 are traded on FloorGuard in the three years, so")
    print("148 is one in 51 and 110 one in 68. 'locked >1 yr': share of them held over a year and still locked.")
    print("'peak week': most tokens returned to circulation in one week (auctions plus players' prizes).")
    print("'unlock age': median age at unlock; 'spread': its standard deviation. Under the fixed lock the earliest")
    print("date is public and the price trigger is visible to all; under the moving lock no date is known before")
    print("that day's draw.")
