#!/usr/bin/env python3
"""Bankroll risk of Games.sol. Run: python3 test/econ/sim_games.py

Contract facts used: the edge e (2%) leaves the wager for the Treasury; the stake s = wager*(1-e) is
played at fair odds, so the house's result per bet has mean zero. Dice at chance c: house +s with
probability 1-c, -s(1-c)/c with probability c. Slots: house -(m-1)s for multiplier m, table below.
A bet may put at most 1% of the free bankroll at risk (maxExposureBps), all open bets 20%.

Assumptions: bets settle one after another (the 20% cap on open bets is ignored, which is exact when
randomness arrives before the next bet); "max bets" means every bet is sized to the 1% limit of the
bankroll at that moment; in the "realistic" model bets have a fixed size b, far below the limit.
"""
import math
import numpy as np

EDGE = 0.02
MAXEXP = 0.01
SLOTS = [(0.002, 50), (0.010, 10), (0.040, 5), (0.150, 2), (0.300, 1), (0.498, 0)]


def dice_outcomes(c):
    """House result per unit of stake: list of (probability, result)."""
    return [(1 - c, 1.0), (c, -(1 - c) / c)]


def slots_outcomes():
    return [(p, 1.0 - m) for p, m in SLOTS]


def stats(outcomes, label):
    worst = -min(x for _, x in outcomes)            # house loss per unit stake in the worst outcome
    stake = MAXEXP / worst                          # max stake as a fraction of the bankroll
    mean = sum(p * x for p, x in outcomes)
    var = sum(p * x * x for p, x in outcomes) - mean ** 2
    logdrift = sum(p * math.log(1 + stake * x) for p, x in outcomes)
    sd = stake * math.sqrt(var)
    n_half = math.log(0.5) / logdrift
    wager = stake / (1 - EDGE)
    fees_to_half = n_half * wager * EDGE
    print(f"{label:<12} max stake {100 * stake:7.3f}% of B  sd/bet {100 * sd:6.3f}% of B  log-drift/bet {logdrift:+.2e}"
          f"  median halves after {n_half:>10,.0f} max bets, during which players pay fees of {fees_to_half:5.2f} B")
    return stake, var


def mc_max_bets(outcomes, n_bets, paths=4000, seed=7):
    """Sequential max bets: probability the bankroll ever falls to half, and quantiles at the end."""
    rng = np.random.default_rng(seed)
    worst = -min(x for _, x in outcomes)
    stake = MAXEXP / worst
    probs = np.array([p for p, _ in outcomes])
    steps = np.log1p(stake * np.array([x for _, x in outcomes]))
    logb = np.zeros(paths)
    low = np.zeros(paths)
    chunk = 2000
    done = 0
    while done < n_bets:
        m = min(chunk, n_bets - done)
        idx = rng.choice(len(probs), size=(paths, m), p=probs)
        walk = logb[:, None] + np.cumsum(steps[idx], axis=1)
        low = np.minimum(low, walk.min(axis=1))
        logb = walk[:, -1]
        done += m
    return (low <= math.log(0.5)).mean(), np.exp(np.quantile(logb, [0.05, 0.5, 0.95]))


def required_bankroll(W, b, var, days=365, z=2.5758):
    """Zero-drift random walk: P(min over the year <= -B/2) = 2*Phi(-(B/2)/sigma) = 1%  ->  B = 2*z*sigma."""
    sigma = math.sqrt(days * (W / b) * b * b * (1 - EDGE) ** 2 * var)
    return 2 * z * sigma


if __name__ == "__main__":
    print("== 1. One bet at the 1% exposure limit ==")
    table = {}
    for c in (0.01, 0.10, 0.50, 0.90, 0.95):
        table[f"dice {int(c * 100)}%"] = (dice_outcomes(c), *stats(dice_outcomes(c), f"dice {int(c * 100)}%"))
    table["slots"] = (slots_outcomes(), *stats(slots_outcomes(), "slots"))

    print("\n== 2. Sustained max bets: P(bankroll ever at or below half) and 5/50/95% quantiles of B/B0 ==")
    for label in ("dice 1%", "dice 50%", "dice 95%", "slots"):
        out = table[label][0]
        for n in (1_000, 10_000, 100_000):
            p, q = mc_max_bets(out, n)
            print(f"  {label:<9} after {n:>7,} max bets: P(half) {100 * p:5.1f}%   B/B0 5% {q[0]:.3f}  median {q[1]:.3f}  95% {q[2]:.3f}")

    print("\n== 3. Bankroll needed for a 99% chance of never being down by half within a year ==")
    print("   (fixed bet size b in ETH, W = ETH wagered per day; B = 5.15 * sqrt(365 * W * b * var) * (1-e))")
    for label in ("dice 50%", "dice 95%", "dice 10%", "dice 1%", "slots"):
        var = table[label][2]
        for W in (1, 10, 100):
            cells = "  ".join(f"b={b}: {required_bankroll(W, b, var):7.1f}" for b in (0.01, 0.1, 1.0))
            print(f"  {label:<9} W={W:>3} ETH/day   {cells}   (annual fees to Treasury {W * 365 * EDGE:6.1f} ETH)")
    print("   check by simulation, coinflip, W=10, b=0.1 (1000 bets/day... 36,500 a year, 4000 paths):")
    rng = np.random.default_rng(3)
    B = required_bankroll(10, 0.1, 1.0)
    n = int(365 * 10 / 0.1)
    wins = rng.random((4000, n)) < 0.5
    walk = np.cumsum(np.where(wins, -0.098, 0.098), axis=1)
    print(f"     B = {B:.1f} ETH -> P(min <= -B/2) = {100 * (walk.min(axis=1) <= -B / 2).mean():.2f}%")

    print("\n== 4. Alternative: the bankroll keeps a share theta of the edge ==")
    print("   drift = theta*e*W per day, variance = W*b*var per day; P(ever down by half) = exp(-theta*e*B/(b*var*(1-e)^2))")
    for theta in (0.25, 0.5, 1.0):
        for label in ("dice 50%", "dice 95%", "slots"):
            var = table[label][2] * (1 - EDGE) ** 2
            need = math.log(100) * var / (theta * EDGE)
            print(f"  theta {theta:4.2f}  {label:<9} B for 1% lifetime risk = {need:7.0f} x bet size;"
                  f"  i.e. safe if a single stake is at most {100 / need:5.3f}% of B")
    print("   cost to buybacks: theta of the games fee. Expected bankroll growth per year = theta*e*365*W.")

    print("\n== 5. Randomness cost against the fee on a minimum bet ==")
    print("   assumed gas per request: 100k (request, paid by the player) + 115k verification + ~120k callback")
    print("   = 235k billed to the subscription, times (1 + premium). Fee to budget = minBet * 2%.")
    for chain, gwei_list, premium in (("Ethereum mainnet", (0.5, 2, 10, 30), 0.20), ("L2 (Base/Arbitrum/OP)", (0.005, 0.02, 0.1), 0.60)):
        for gwei in gwei_list:
            cost = 235_000 * gwei * 1e-9 * (1 + premium)
            print(f"  {chain:<22} {gwei:>6} gwei: request costs {cost:.6f} ETH -> break-even minBet {cost / EDGE:.5f} ETH"
                  f"  (default 0.001 ETH covers {100 * 0.001 * EDGE / cost:6.1f}%);  lottery/raffle minPot {cost / 0.05:.5f} ETH")
