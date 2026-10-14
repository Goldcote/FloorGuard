#!/usr/bin/env python3
"""Review 11, question C: what a house-share requester gives up under rule 2, as a function of activity.

Model. Bets arrive as a Poisson stream at `lam` per second and stay open for the randomness latency
(lognormal around `L` seconds, sigma 0.3). House funds are constant at 1 (results are ignored: they do
not change the spread, only the level). Each bet has a wager w (a share of the free bankroll) and an
exposure e, limited as in Games.sol: w <= 1% of the bankroll, e <= 1%, sum of e <= 20% of funds.

  redemption spread  = reserved / funds                 (previewRedeem vs shareValue)
  deposit spread     = openWagers / (funds + openWagers) (previewDeposit vs fair shares)

For each activity level it prints the time-average spread, the share of time the spread is zero or
under a threshold, and how long an "execute when the spread is below x" keeper would wait from a
random moment (mean and 95th percentile).

Run: python3 test/review11/sim_house_usability.py
"""
import heapq
import math
import random

EDGE = 0.02
THRESHOLDS = [0.0, 0.001, 0.005, 0.01, 0.02]


def draw_bet(rng, mix, bankroll):
    """Returns (wager, exposure) as shares of funds."""
    r = rng.random()
    acc = 0.0
    for share, kind in mix:
        acc += share
        if r < acc:
            break
    # wager: lognormal around 0.05% of the bankroll, capped at 1%
    w = min(bankroll * 0.01, bankroll * 0.0005 * math.exp(rng.gauss(0, 1.0)))
    stake = w * (1 - EDGE)
    if kind == "slots":
        mult = 49.0
    else:
        mult = 1.0 / kind - 1.0
    e = stake * mult
    cap = bankroll * 0.01
    if e > cap:  # players size long shots to the exposure limit
        w *= cap / e
        e = cap
    return w, e


def run(lam, L, mix, horizon, seed=1):
    rng = random.Random(seed)
    t = 0.0
    heap = []
    reserved = 0.0
    wagers = 0.0
    series = []  # (duration, redeem spread, deposit spread)
    next_arrival = rng.expovariate(lam)
    volume = 0.0
    rejected = 0
    placed = 0
    while t < horizon:
        next_close = heap[0][0] if heap else float("inf")
        nxt = min(next_arrival, next_close)
        if t > 20 * L:  # skip the warm-up from an empty table
            series.append((nxt - t, reserved, wagers / (1 + wagers)))
        t = nxt
        if next_close <= next_arrival:
            _, w, e = heapq.heappop(heap)
            reserved -= e
            wagers -= w
            if not heap:
                reserved = 0.0
                wagers = 0.0
        else:
            w, e = draw_bet(rng, mix, 1 - reserved)
            if reserved + e <= 0.2:
                latency = L * math.exp(rng.gauss(0, 0.3))
                heapq.heappush(heap, (t + latency, w, e))
                reserved += e
                wagers += w
                volume += w
                placed += 1
            else:
                rejected += 1
            next_arrival = t + rng.expovariate(lam)
    return series, volume / horizon, rejected / max(1, placed + rejected)


def wait_stats(series, col, x):
    """Share of time at or below x; mean and p95 wait from a random moment until the spread is <= x."""
    total = 0.0
    below = 0.0
    runs = []
    cur = 0.0
    for row in series:
        d = row[0]
        total += d
        if row[col] <= x + 1e-15:
            below += d
            if cur:
                runs.append(cur)
                cur = 0.0
        else:
            cur += d
    if cur:
        runs.append(cur)
    mean_wait = sum(d * d / 2 for d in runs) / total
    # P(wait > w) = sum(max(d - w, 0)) / total; find w with P = 5%
    lo, hi = 0.0, max(runs) if runs else 0.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if sum(d - mid for d in runs if d > mid) / total > 0.05:
            lo = mid
        else:
            hi = mid
    return below / total, mean_wait, hi


def fmt_t(s):
    if s < 120:
        return f"{s:6.1f}s"
    if s < 7200:
        return f"{s / 60:6.1f}m"
    if s < 172800:
        return f"{s / 3600:6.1f}h"
    return f"{s / 86400:6.1f}d"


MIXES = {
    "coinflip-heavy": [(0.70, 0.5), (0.15, 0.9), (0.10, 0.25), (0.05, "slots")],
    "mixed, a quarter slots": [(0.45, 0.5), (0.10, 0.9), (0.10, 0.1), (0.10, 0.02), (0.25, "slots")],
    "long-shot-heavy": [(0.20, 0.5), (0.30, 0.1), (0.20, 0.01), (0.30, "slots")],
}


def main():
    for chain, L in (("L2, 8 s latency", 8.0), ("mainnet, 50 s latency", 50.0)):
        for name, mix in MIXES.items():
            print(f"\n=== {chain}; bet mix: {name} ===")
            print(
                "open bets | redeem spread: mean  | time at 0 | wait for 0: mean / p95 | "
                "wait <=0.5%: mean / p95 | wait <=1%: mean / p95 | deposit spread mean | "
                "house income per day | mean redeem spread in hours of income | bets refused"
            )
            for n in (0.2, 1, 2, 5, 10, 20, 50):
                lam = n / L
                horizon = max(40_000.0, 400_000.0 / lam if n >= 5 else 60_000.0 / lam * 5)
                horizon = min(horizon, 2_000_000.0 / lam)
                series, vol_rate, refused = run(lam, L, mix, horizon)
                total = sum(r[0] for r in series)
                mean_r = sum(r[0] * r[1] for r in series) / total
                mean_d = sum(r[0] * r[2] for r in series) / total
                z, mw0, p0 = wait_stats(series, 1, 0.0)
                z5, mw5, p5 = wait_stats(series, 1, 0.005)
                z10, mw10, p10 = wait_stats(series, 1, 0.01)
                income_day = vol_rate * 86400 * EDGE / 2
                hours = mean_r / (income_day / 24) if income_day else 0

                def w(share, mean, p95):
                    # a threshold never reached in the simulated time has no measured wait
                    return f"never in {fmt_t(total).strip()}" if share == 0 else f"{fmt_t(mean)} / {fmt_t(p95)}"

                print(
                    f"{n:9.1f} | {mean_r * 100:7.3f}%            | {z * 100:7.3f}%  | "
                    f"{w(z, mw0, p0)} | {w(z5, mw5, p5)} | "
                    f"{w(z10, mw10, p10)} | {mean_d * 100:7.3f}% | {income_day * 100:8.2f}% | "
                    f"{hours:8.2f} | {refused * 100:5.1f}%"
                )
    # analytic check for the wait for an empty table: M/G/infinity busy period
    print("\nAnalytic: mean time for a busy table to empty = (e^n - 1) / lam, n = mean open bets")
    for L in (8.0, 50.0):
        for n in (1, 2, 5, 10, 15, 20):
            lam = n / L
            print(f"  L={L:4.0f}s n={n:3d}: {fmt_t((math.exp(n) - 1) / lam)}")


if __name__ == "__main__":
    main()
