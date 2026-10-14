#!/usr/bin/env python3
"""Prediction markets, vault auctions, vault raffles and ticket raffles. Run: python3 test/econ/sim_markets.py

Every section states its own assumptions. Prices follow a driftless random walk unless stated.
"""
import math
import numpy as np
from statistics import NormalDist

N = NormalDist()
FEE = 0.03


def late_bettor(beta, fee=FEE, grid=20001):
    """Honest bettors put S = 1 on each side at the start. One informed bettor acts at the close, after a
    fraction beta of the market's life, knowing the move so far (z standard deviations of that period).
    P(the side that is ahead wins) = Phi(|z| * sqrt(beta / (1 - beta))).
    Returns (mean p, informed profit as a monopolist, honest loss with a monopolist, honest loss when
    informed bettors compete their profit away), all per unit of honest stake (2S)."""
    zs = np.linspace(-6, 6, grid)
    w = np.exp(-zs ** 2 / 2)
    w /= w.sum()
    k = math.sqrt(beta / (1 - beta))
    p = np.array([N.cdf(abs(z) * k) for z in zs])
    def honest(win_bet):
        # favoured pool 1 + win_bet, unfavoured pool 1; honest EV summed over both sides
        fav = p * (1 * (1 - fee) / (1 + win_bet)) - (1 - p) * 1
        unf = (1 - p) * ((1 + win_bet) * (1 - fee)) - p * 1
        return fav + unf
    w_mono = np.maximum(0, np.sqrt(p * (1 - fee) / (1 - p)) - 1)
    profit_mono = p * w_mono * (1 - fee) / (1 + w_mono) - (1 - p) * w_mono
    w_comp = np.maximum(0, p * (1 - fee) / (1 - p) - 1)
    return ((p * w).sum(), (profit_mono * w).sum() / 2, -(honest(w_mono) * w).sum() / 2,
            -(honest(w_comp) * w).sum() / 2, -(honest(0 * p) * w).sum() / 2)


def auction_time(m):
    """Days until a price opening at 16x the reserve, halving daily (linear inside each day), reaches m x."""
    if m >= 16:
        return 0.0
    k = int(math.floor(math.log2(16 / m)))
    top = 16 / 2 ** k
    return min(4.0, k + (top - m) / (top / 2))


def raffle_optimum(V, T, kappa):
    """Farmer buys y fee-ETH of points at kappa ETH each against T active fee-ETH: profit and spend."""
    if V <= kappa * T:
        return 0.0, 0.0, 0.0
    if T == 0:
        return V, 0.0, 1.0  # any dust of points wins the prize
    y = math.sqrt(V * T / kappa) - T
    return V * y / (T + y) - kappa * y, kappa * y, y / (T + y)


if __name__ == "__main__":
    print("== 1. Prediction market: value of betting last ==")
    print("   beta = bettingPeriod / duration (the contract allows up to 0.5); fee 3% of winnings")
    print("   beta   mean P(leader wins)  informed profit   honest loss (1 informed)  honest loss (competing)  honest loss (none)")
    for beta in (0.5, 0.33, 0.2, 0.1, 0.02):
        mp, prof, loss_m, loss_c, loss_0 = late_bettor(beta)
        print(f"   {beta:4.2f}   {mp:18.3f}  {100 * prof:13.2f}%  {100 * loss_m:23.2f}%  {100 * loss_c:22.2f}%  {100 * loss_0:17.2f}%"
              "   (% of honest stake)")

    print("\n== 2. Stale start price: the oracle price is `age` old when a market is created ==")
    print("   P(the side of the gap wins) = Phi(|z| * sqrt(age / duration)), averaged over z ~ N(0,1)")
    for age_h, dur_h in ((1, 0.33), (6, 0.33), (24, 0.33), (24, 24), (24, 168), (24, 720), (1, 24), (1, 168)):
        zs = np.linspace(-6, 6, 4001)
        w = np.exp(-zs ** 2 / 2); w /= w.sum()
        p = sum(wi * N.cdf(abs(z) * math.sqrt(age_h / dur_h)) for z, wi in zip(zs, w))
        print(f"   price {age_h:>2}h old, market lasts {dur_h:>6}h:  mean P = {p:.3f}")

    print("\n== 3. Cost of deciding a market, against the pool needed to pay for it ==")
    F = 1.0
    for royalty in (0.0, 0.05):
        cost_up = 4 * (0.02 + royalty) * F
        print(f"   SalesFloorOracle, up, royalty {100 * royalty:.0f}%: 4 wash sales just above the start price cost {cost_up:.3f} F"
              f" -> pays when the losing pool exceeds {cost_up / (1 - FEE):.3f} F")
    print("   SalesFloorOracle, down: 4 sales at 1 wei, ~0.82M gas -> pays when the losing pool exceeds the gas")
    for gwei in (0.02, 1, 10, 30):
        print(f"      at {gwei:>5} gwei: {0.82e6 * gwei * 1e-9:.6f} ETH")
    print("   PushFloorOracle reading the lowest listing: buy the cheapest listing (up) or list one token 1 wei")
    print("   under the floor (down); round-trip cost about 1-6% of one floor, so pools above ~0.01-0.06 F pay.")

    print("\n== 4. Vault Dutch auction: 16x the reserve, halving daily ==")
    print("   market value / reserve   days to reach it   price fall per 12s block at that point")
    for m in (16, 8, 4, 2, 1.5, 1.3, 1.1, 1.0):
        t = auction_time(m)
        k = min(3, int(t))
        slope_per_day = (16 / 2 ** k) / 2  # in reserves per day
        print(f"   {m:>6.2f}                  {t:6.2f}             {100 * slope_per_day / m / 7200:.4f}% of the price")
    print("   a buyer who waits one more block saves that fraction and risks losing the token to a rival;")
    print("   with two or more buyers who value the token at v, the sale is at v less at most one block's fall.")

    print("\n== 5. Vault raffle: farmer's optimum against T active fee-ETH, prize V = 1 ETH ==")
    print("   kappa = ETH spent per fee-ETH of points; T = activated points only")
    for kappa, tag in ((0.5, "wash trade, no royalty"), (0.25, "wash trade + fees recaptured at a bid of 2F"),
                       (1.0, "dice/slots, or 50% project share"), (1.75, "wash trade, 5% royalty")):
        cells = []
        for T in (0.0, 0.1, 0.5, 1.0, 2.0, 4.0):
            prof, spend, share = raffle_optimum(1.0, T, kappa)
            cells.append(f"T={T}: +{prof:.3f} (spend {spend:.3f}, {100 * share:.0f}%)")
        print(f"   kappa {kappa:<4} {tag:<44} " + "  ".join(cells))
    print("   several raffles in a row (prize 1 ETH each, T = 2 honest fee-ETH, kappa 0.5, 20% kept after a win):")
    rng = np.random.default_rng(5)
    for n_raffles in (1, 3, 10):
        best = (0, 0)
        for y in np.linspace(0.05, 12, 240):
            a = np.full(20000, y); wins = np.zeros(20000)
            honest = np.full(20000, 2.0)
            for _ in range(n_raffles):
                won = rng.random(20000) < a / (a + honest)
                wins += won
                a = np.where(won, a * 0.2, a)
                honest = np.where(won, honest, honest - 0.8 * honest / 20)  # an honest winner (1 of 20 equal holders) is reset
            prof = wins.mean() - 0.5 * y
            if prof > best[0]:
                best = (prof, y)
        print(f"      {n_raffles:>2} raffles: best farm {best[1]:.2f} fee-ETH (cost {0.5 * best[1]:.2f} ETH), expected profit {best[0]:+.2f} ETH")

    print("\n== 6. Ticket raffle: creator buys the unsold tickets in the last block ==")
    print("   V = value of the NFT, N*t = the pot if sold out, sold = share bought by others; fee 5%")
    for pot in (1.0, 1.5, 2.0):
        for sold in (0.25, 0.5, 0.75, 0.9):
            gain = (1 - sold) * (1 - 0.05 * pot)          # in units of V
            ev_fair = 1 / (sold * pot) - 1                 # buyer's return if nobody dilutes
            ev_dil = 1 / pot - 1
            print(f"   pot {pot:.1f}V, {int(100 * sold)}% sold: creator gains {gain:.3f} V for a fee of {0.05 * pot * (1 - sold):.4f} V;"
                  f" buyers' expected return {100 * ev_fair:+6.1f}% -> {100 * ev_dil:+6.1f}%")
    print("   lottery: a ticket's expected return is -5% whatever anyone else does (prize 95% of the pot, uniform draw).")
