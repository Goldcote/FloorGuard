# Economics review

Scope: commit `1400a8b` on `audit-pass`, 13 October 2026. This is a review of
the mechanism, not of the code: it asks what happens, and who gains at whose
expense, when everybody follows the contracts as written. It is not a
professional audit and not legal advice.

How to reproduce the numbers:

```bash
forge test --match-path 'test/econ/*' -vv     # 17 tests against the real contracts
python3 test/econ/sim_buyback.py              # rising bid, Monte Carlo
python3 test/econ/sim_flywheel.py             # fees in, support out
python3 test/econ/sim_games.py                # bankroll risk, randomness cost
python3 test/econ/sim_markets.py              # predictions, auctions, raffles
```

Three kinds of statement appear below, and they are marked:

- **Result**: follows from the contract code, shown by a test or by algebra.
- **Model**: output of a simulation whose assumptions are listed with it.
- **Assumption**: a number I chose because no data exists yet (turnover, market
  share, fees on other venues, gas, Chainlink premiums). The last section lists
  what real data would replace them.

Units: `F` is the collection's lowest ask on other venues. A "fee-ETH" of
points is the points earned by one ETH of fees reaching a buyback budget
(2,500 points at the deployed rate).

## Status of this review

This review was written against commit `1400a8b`. The text below is unchanged
and describes the code as it was then. Since then:

| Recommendation (section 10) | Status |
|---|---|
| 1. Bid limited by the budget | Done |
| 2. Credit each fee once | Done, in the Marketplace and the PredictionMarket |
| 3. Wager cap | Done (`maxWagerBps`, 1% of the bankroll). `minBet` and `maxExposureBps` defaults unchanged: the operator sets them per chain |
| 4. Prize cap against activated points | Partly: the owner can set `minPointsToDraw`; the 25% rule is guidance, not enforced |
| 5. Dead band, shorter betting, fresh start price | Done (2%, a tenth of the duration, one hour) |
| 6. Cooldown limit; doc wording | Done |
| 7. Timeouts that do not reward withholding | Not done; FAIRNESS.md now states the limitation |
| 8. Bankroll keeps part of the edge | Available as `bankrollShareBps`, off by default |
| 9. Guardian that can only lower or pause | Done |
| 10. Curve rises only while funded | Done, through a Treasury notice to the engine |
| 11–13 | Not done |

The Foundry tests that demonstrated findings 1 to 3 were removed when the fixes
made them fail; the Python models in `test/econ/` are kept. None of the changes
above has been through an independent review yet.

## Executive summary

1. **The rising bid does not find the floor at the script defaults; it finds
   `maxPrice`.** The bid keeps rising while the budget is empty, so unless fees
   arrive faster than `F × growth × (1 − stepDown) / stepDown` (1.9 floors a
   day at the defaults, which is 95 floors a day of trading), every fill is
   dearer than the last until the engine pays `maxPrice` every time. One
   changed line (`bid = min(curve, budget)`) removes the steady-state case.
2. **The support is real but small: one token bought for every 50 traded.** At a
   quarter of an active 10,000-token collection's volume, the Vault holds about
   1.5% of supply after three years, and auctions never add to that number
   because each token sold funds at most one bought back. In flat or falling
   markets 60 to 75% of matured holdings never reach the 130% unlock.
3. **A vault raffle is a give-away, and as built it can be taken.** A point
   costs half the fee behind it (both sides of a wash trade are credited), only
   activated points count, and whoever calls `draw` freezes everyone else's
   pending points; a farmer profits whenever the prizes are worth more than
   half of the activated fee-ETH. An auction always returns more ETH to the
   budget than a raffle can.
4. **The games bankroll is a donation that carries all the risk and earns
   nothing.** It cannot be withdrawn by its funder, its median path declines,
   the 1% exposure rule lets a single 95% dice bet stake 19% of the bankroll,
   and on Ethereum mainnet one randomness request costs 7 to 400 times the fee
   on a minimum bet. Letting the bankroll keep half the edge and capping the
   stake fixes the first three at the cost of half the games fees.
5. **Prediction markets pay informed bettors at the expense of early ones.**
   With betting open for half the market's life, the last bettor wins 75% of
   the time and honest bettors lose up to 12% of their stake instead of the
   1.5% fee; a stale start price, a one-wei price change and an unresolved
   market each hand the pool to whoever acts. On the sales oracle the "lower"
   side can be bought for gas.

Two further points do not fit in five: on a rollup the sequencer (and on any
chain the randomness oracle) can turn a losing result into a refund or a
redraw, which FAIRNESS.md says cannot happen (section 8); and several
sentences in the docs promise more than the mechanism delivers (section 9).

---

## 1. The rising floor bid

### 1.1 What the code does

`bid(t) = min(maxPrice, base × (1 + g × days since reset))`; a fill sets
`base = price × (1 − s)`. A fill needs two things: the bid is at or above the
cheapest seller's price `A`, and the budget covers the bid. The clock runs
whether or not the budget is there. That last fact decides everything.

### 1.2 Two regimes (Result)

Let `f` be the fee inflow in ETH per day. After a fill the bid needs
`T_c = s / ((1 − s) g)` days to climb back to the price it just paid.

- **Budget-rich, `f ≥ f* = A × g (1 − s) / s`.** The budget is always there
  when the bid reaches `A`. Sellers compete, the fill is at `A`, and the engine
  buys one token every `T_c` days. It cannot buy faster, so the share
  `1 − f*/f` of the inflow is never spent.
- **Budget-constrained, `f < f*`.** When the bid reaches `A` the money is not
  there. The bid goes on rising; the fill happens when the budget catches up,
  above `A`. The next price is `p' = p (1 − s) f / (f − p (1 − s) g)`, which
  has a fixed point `p* = f s / ((1 − s) g)` with slope `1/(1 − s) > 1`: it is
  unstable, and since every fill is at or above `A > p*` each fill is dearer
  than the one before. If `f ≤ p (1 − s) g` the bid outruns the budget outright
  and the next fill is at `maxPrice`. Either way the engine ends at `maxPrice`
  and stays there.

There is no parameter setting that is both fully spent and never overpaying:
that needs `f = f*` exactly, and `f` moves every day.

| `g` per day | `s` | `f*` in floors/day | Trading needed at 2% | Most it can buy |
|---|---|---|---|---|
| 10% (default) | 5% (default) | 1.90 | 95 floors/day | 1.90/day |
| 2% | 5% | 0.38 | 19 | 0.38/day |
| 1% | 5% | 0.19 | 9.5 | 0.19/day |
| 0.25% | 5% | 0.0475 | 2.4 | 0.05/day |
| 1% | 10% | 0.09 | 4.5 | 0.09/day |

For a 10,000-token collection the default curve needs 34,700 sales a year on
FloorGuard alone, 3.5 times the supply. Below that it pays `maxPrice`.

### 1.3 How much is overpaid

**Result** (`test/econ/EconBuyback.t.sol`, real contracts, constant market at
`F = 1`, hourly fee deposits, competitive sellers):

| Scenario | Fills | Average paid | Left unspent |
|---|---|---|---|
| Defaults, 0.1 floor/day, `maxPrice` 2F, one year | 18 | 2.00 F | 1% |
| Defaults, 2.5 floors/day (above `f*`), 60 days | 112 | 1.00 F | 25% (37.8 of 150 ETH) |
| `g` 0.25%, 0.1 floor/day (twice `f*`), one year | 16 | 1.00 F | 56% (20.5 of 36.5 ETH) |
| `g` 0.6%, 0.1 floor/day (12% under `f*`), two years | 50 | 1.42 F, last 2.00 F | 2% |
| Floor falls 1.0 to 0.5 in 180 days, `maxPrice` 1.5 | 11 | 199% of market value | |

**Model** (`sim_buyback.py`, section 2; cheapest seller at 0.98 F when an
impatient holder is around, else an arbitrageur at 1.015 F):

| Inflow, floors/day | `maxPrice` 1.1F | 1.5F | 2.0F |
|---|---|---|---|
| 0.02 to 1.5 (below `f*`) | paid 1.10 F, 9% of spend overpaid | 1.50 F, 33% | 2.00 F, 50% |
| 2.5 and 5 (above `f*`) | 0.99 F, 25% and 62% of inflow idle | same | same |

So, in the long run and below `f*`: **expected overpayment = 1 − F/maxPrice of
everything spent**, whatever the inflow. Above `f*` it is zero and the idle
share is `1 − f*/f`. The Treasury "budget" in the docs is therefore worth
`F/maxPrice` of its face value in tokens.

`fillCooldownOf` (**Result**): a cooldown `c` longer than `T_c` (12.6 hours at
the defaults) means the bid regrows more than it stepped down before the next
fill is allowed, so prices ratchet to `maxPrice` even when the budget is rich.
Model, 2.5 floors/day, defaults: cooldown 12 h pays 1.01 F; 13 h pays 1.48 F;
24 h pays 1.50 F. SECURITY.md recommends "a buyback cooldown" for open-supply
collections without this limit.

### 1.4 The cases asked about

- **Long unfunded period, then money** (Result). After 30 unfunded days the bid
  is at `maxPrice`. A 30 ETH deposit with `maxPrice` 2F is sold into 14 times
  in one block: 20.49 ETH for tokens worth 14, 6.49 floors overpaid. In
  general the cascade from `M` down to `F` overpays the sum of
  `M (1 − s)^k − F` over the fills above `F`: with `s` = 5% that is 6.5 F for
  `M` = 2F, 2.1 F for 1.5F, 0.66 F for 1.25F and 0.15 F for 1.1F; with `s` =
  15% it is 2.4, 0.86, 0.31 and 0.10 F. A 6-hour cooldown makes it worse, not
  better (26 fills over 6 days, 12.0 floors overpaid from a 60 ETH lump),
  because at the defaults the bid regrows 2.5% per cooldown and drops 5%, so
  the descent takes twice as many fills. All it gives is time for the owner to
  reconfigure.
- **Lumps from auctions.** Auction proceeds arrive as 1.3 or more purchase
  prices at once, into a bid that has usually been unfunded and is at
  `maxPrice`. Every vault auction is followed by the cascade above. The same
  holds for `allocate` and donations.
- **Falling market.** `maxPrice` is an absolute number, so the cap loosens as
  the floor falls. Model, floor drifting down 70% a year: defaults with a fixed
  cap of 1.5 F0 pay on average 2.9 times market, 50% of spend overpaid. A cap
  reset weekly to 1.10 F holds it to 9.6%.
- **One dominant holder.** If one party is the only supply (it holds the float
  and the listings elsewhere are thin), it waits `(M/F − 1)/g` days once (5
  days for `M` = 1.5F at the defaults) and then sells at `maxPrice` every
  `T_c`. It collects the whole budget at `M`: the Vault receives `budget/M`
  tokens instead of `budget/F`. No curve fixes this; only a second seller or a
  tight `maxPrice` does. Two sellers who each see the other's fills can sustain
  the same outcome tacitly.
- **Does it converge to the floor?** In the budget-rich regime it converges to
  the lowest price any holder accepts. A holder who wants out today can hit the
  best bid on another venue, so that price is the best outside bid net of
  selling costs, typically 1 to 3% under the lowest ask (Assumption). The bid
  is paid in full with no fee and no royalty, so it wins as soon as it matches.
  The engine is then the best bid in the market by a hair, once every `T_c`.

### 1.5 Does it support floors on other venues?

Buying the cheapest listing elsewhere and selling it into the bid earns
`bid − ask × (1 + cost) − gas` (Assumption: buy-side cost 0.5% to 5.5%
depending on venue fee and royalty, gas 0.0003 to 0.01 ETH):

| Bid | Cost 0.5% | Cost 3% | Cost 5.5% |
|---|---|---|---|
| 0.98 F | −0.025 F | −0.053 F | −0.085 F |
| 1.00 F | −0.005 F | −0.033 F | −0.065 F |
| 1.05 F | +0.045 F | +0.017 F | −0.015 F |
| 1.10 F | +0.095 F | +0.067 F | +0.035 F |

It pays only when the bid is 1 to 6% above the lowest ask. In the regime where
the bid converges, it stops below the ask, a holder sells first and no listing
is lifted. Listings elsewhere are lifted exactly when the engine is
overpaying, and then in bursts (a searcher sweeps the cheapest 14 listings into
the cascade of 1.4). The sentence in ARCHITECTURE.md is true only in the case
the design tries to avoid.

### 1.6 Recommendations

Ranked by benefit against complexity.

1. **Rule A, one line: `currentBid = min(curve, maxPrice, budgetOf)`.** A bid
   the Treasury cannot pay is not a bid. With it, an empty budget makes the bid
   rise with the fee inflow and the fill happens when the budget reaches the
   cheapest seller's price. Model: defaults, inflow 0.02 to 0.5 floors/day:
   paid 0.99 to 1.00 F, under 3% idle; it also follows a falling market,
   because every round starts from an empty budget. It does not fix lumps (4.5%
   of a 40-floor lump overpaid at `maxPrice` 1.5F) or a dominant holder.
2. **Rule B: the bid's clock runs only while the budget covers the bid.** This
   needs a checkpoint when money arrives (a hook from `Treasury.deposit*` and
   `allocate` into the engine, roughly 8k gas per deposit, or a permissionless
   `checkpoint`). Model: with `g` 10%, `s` 15% and a cap fixed at 1.5 F0 for
   two years, overpayment is 0.2% in a volatile market and −0.2% in a falling
   one; a 40-floor lump is bought at 0.985 F. This is a design sketch and
   needs its own review.
3. **A guardian role that can only lower `basePrice` and `maxPrice` or pause a
   collection**, exempt from the timelock. The docs ask for a timelocked owner;
   a timelocked owner cannot keep `maxPrice` near a moving floor.
4. Enforce `fillCooldown < s / ((1 − s) g)` in `setFillCooldown` and
   `configureBid`.

Default parameters:

| | Today's code | With rule A | With rule B |
|---|---|---|---|
| `growthBpsPerDay` | `0.5 × f30 × s/(1 − s)`, where `f30` is the 30-day fee inflow in floors/day: 11 at 0.02, 55 at 0.1, 280 at 0.5. Never the default 1,000 | 500 to 1,000 | 1,000 |
| `stepDownBps` | 1,000 | 500 | 1,500 |
| `maxPrice` | 1.10 × lowest outside ask, reset weekly, and before every `allocate`, donation or vault auction | 1.25 ×, monthly, and before every lump | 1.5 ×, quarterly; 1.10 × where one holder dominates the float |
| `basePrice` at set-up | 0.90 × best outside bid | same | same |
| `fillCooldown` | 1 hour; never above 0.8 × `T_c` | 1 hour | 1 hour |

With today's code the tuned curve leaves half the inflow unspent (Model: 51 to
59% idle) and tips into the ratchet if the inflow later falls by more than
half (Model: inflow at a quarter, last fills at 1.5 F). It is a stopgap.

What a deployer must monitor, per collection:

- `rho = f30 × s / ((1 − s) × g × F)`. Below 1 the bid is ratcheting. Keep it
  between 1.5 and 3; above 3 raise `g`.
- `currentBid / lowest outside ask`. Above 1.02 while `isFillable` is false
  means the next deposit will be overpaid: call `configureBid` to restart the
  curve before it lands.
- Budget in units of the bid. More than 3 means the curve is too slow.
- Every `Unlocked` and `AuctionStarted` event: a lump is coming.
- The share of `Buyback` events going to the top seller, and the gap between
  fills. Fills landing in the block a cooldown expires or a deposit lands are
  the sign of a race for an overpaying bid.
- `maxPrice / F` after every 10% move in the floor.

---

## 2. Does the flywheel hold?

### 2.1 Fees in

| Source | To the budget, before project share | Per ETH of activity |
|---|---|---|
| Marketplace | 2% of price | 0.020 |
| Prediction market | 3% of winnings = 3% of the losing pool | 0.015 per ETH staked if pools are balanced |
| Dice, coinflip, slots | 2% of the wager | 0.020 |
| Lottery, ticket raffle | 5% of the pot | 0.050 |
| Project share | up to −50% of all of the above | |

### 2.2 Value out, and the identity that bounds it (Result)

Fees scale with the floor and tokens are bought at the floor, so the number of
tokens the fees buy is `2% × (1 − project share) ×` the number of tokens traded
on FloorGuard, on any price path. One token leaves circulation per 50 traded,
per 100 at the maximum project share, and fewer in proportion to
`F/maxPrice` when the bid overpays.

An auction returns about one floor to the budget, which buys about one token.
Model: 0.98 of a token. **Recycling never increases the number of tokens off
the market.** It converts a token bought at `P` into a token bought at 1.3 `P`
or more. The whitepaper's "compounds Treasury holdings over time" is true in
ETH when the floor rises and false in tokens always.

### 2.3 Is it material? (Model, `sim_flywheel.py`; turnover and share are Assumptions)

10,000 tokens, 1 ETH floor, three years, no overpayment, no project share:

| Sales per year on all venues | FloorGuard's share | Fees | In the Vault | Share of all sales absorbed |
|---|---|---|---|---|
| 2,500 | 5% | 6 ETH | 0.07% of supply | 0.10% |
| 2,500 | 25% | 31 ETH | 0.37% | 0.49% |
| 10,000 | 25% | 122 ETH | 1.48% | 0.49% |
| 10,000 | 100% | 489 ETH | 5.93% | 1.98% |
| 30,000 | 25% | 367 ETH | 4.45% | 0.49% |

The buyback is extra demand equal to 2% of FloorGuard's own flow. To remove 1%
of supply a year at a 1 ETH floor, FloorGuard needs 5,000 ETH a year of that
collection's volume (13.7 ETH a day). For comparison, NFT floors commonly move
several percent in a day. I would call the effect second-order unless
FloorGuard carries most of a collection's trading.

Two offsets belong in the same sentence:

- The 2% fee is paid by sellers. Venues charging 0 to 0.5% (Assumption) net a
  seller 1.5 to 2% more for the same price, which is the same size as the
  support. Holders as a group pay the fee and one holder in fifty receives it.
- Every token the Vault releases comes back as supply: at market through an
  auction, or for nothing through a raffle.

### 2.4 Price paths (Model; 10,000 sales a year, 25% share, three years, 40 seeds)

| Path | Bought | Auctioned | In Vault | Matured but never unlocked | Vault value / cost |
|---|---|---|---|---|---|
| No drift, 80% volatility | 230 | 82 | 148 | 87 (59%) | 0.64 |
| No drift, 30% volatility | 201 | 52 | 149 | 100 (67%) | 0.87 |
| Rising 60% a year | 302 | 155 | 147 | 57 (39%) | 1.04 |
| Falling 60% a year | 179 | 30 | 149 | 113 (76%) | 0.26 |
| Rising, oracle held down | 150 | 0 | 150 | 126 | 1.94 |

- **Budget in ETH.** It grows only with fees and with the floor. In a flat or
  falling market it is fee income, spent once, and what it bought stays locked.
- **The 130% rule sells winners and keeps losers.** Every token that gains 30%
  is sold and replaced by one bought 30% higher; the others stay. Even on the
  rising path the Vault is worth only 1.04 times its cost. With the oracle held
  down (no auctions) it would be worth 1.94 times.
- **The rule works against holders in a rally and they can switch it off for
  gas.** A whole vintage unlocks together when the floor crosses 1.3 times its
  price, and after the 30-day window anyone can auction all of it: on the
  rising path about 50 tokens a year into a market of 2,500 FloorGuard sales.
  Four self-trades at 1 wei (Result: 819k gas, no fee) keep the sales oracle
  low and every holding locked. Every holder gains from that, so expect it.
  SECURITY.md says anyone "can" do this; the point is that everyone wants to.
  In practice unlocking is the owner's decision.
- **The oracle is not independent of the engine.** Buyback fills are recorded
  as floor sales. When the engine ratchets to `maxPrice`, four such fills move
  the oracle to `maxPrice`; if that is 1.3 times older purchase prices, old
  holdings unlock on the engine's own overpayment and then sit at a reserve
  nobody will pay.

### 2.5 Recommendations

1. State the size plainly (section 9) and fix the bid first: at `maxPrice` 1.5F
   a third of the support is lost before any of this applies.
2. Treat the Vault as a sink, not a fund. If the aim is floor support, never
   selling is the strongest policy and the 130% auction weakens it. If the aim
   is a growing budget, say so and accept the selling into rallies.
3. If auctions stay, sell gradually (at most `n` auctions per collection per
   week) and reconfigure the bid before proceeds land.
4. Do not feed buyback fills into the oracle the Vault reads, or read the push
   oracle for unlocks and keep the sales oracle for display.

---

## 3. Points and vault raffles

### 3.1 Cost of a point (Result, `test/econ/EconPoints.t.sol`)

| Route | ETH spent per fee-ETH of points | Capital, time | Who receives the spend |
|---|---|---|---|
| Marketplace wash trade, no royalty | **0.50** | The price for one transaction (flash-loanable); one contract can be buyer and seller | The collection's budget |
| Same, then sell a token into a bid at `k × F` | **0.50 / k** | One floor token | The farmer takes the fee back through the bid |
| Same, farmer is the project (share 50%) | 0.50 | | Half back to the farmer |
| Same, 50% project share, outsider | 1.00 | | Half to the project |
| Same, 5% royalty to a third party | 1.75 | | 5/7 to the creator |
| Prediction market, both sides | **0.50** | 67 × the fee locked for at least 20 minutes; needs the price to move | Budget |
| Dice at 95% or 1%, slots | 1.00 expected | Variance; stake limited by the bankroll | Budget; the operator also pays the randomness |

Both sides of a sale are credited the whole fee, and in a prediction market the
loser and the winner are both credited for the same fee. So a point costs half
of what ARCHITECTURE.md's "points follow fees" suggests, and a quarter when
the bid is at twice the floor (test: 2 ETH of fees paid, 2 ETH taken back for a
1 ETH token, 4 fee-ETH of points kept).

### 3.2 Farming a raffle (Result for the formula and the test; Model for the table)

A farmer who buys `y` fee-ETH at `k` ETH each against `T` *activated* fee-ETH
expects `V y/(T + y) − k y`. The best `y` is `sqrt(V T / k) − T`, and the
profit is `(sqrt(V) − sqrt(k T))²`, positive whenever **`V > k × T`**.

Prize 1 ETH:

| `k` | `T` = 0 | 0.1 | 0.5 | 1 | 2 | 4 |
|---|---|---|---|---|---|---|
| 0.5 (wash trade) | +1.00 | +0.60 | +0.25 | +0.09 | 0 | 0 |
| 0.25 (bid at 2F) | +1.00 | +0.71 | +0.42 | +0.25 | +0.09 | 0 |
| 1.0 (games) | +1.00 | +0.47 | +0.09 | 0 | 0 | 0 |

SECURITY.md says a raffle is safe "while the prize is worth less than the fees
behind all outstanding points". Four things make it worse than that:

1. **Only activated points count.** Activation costs seven storage writes, so
   small holders will not do it. In the test, honest users hold 4 fee-ETH but
   only 1 is active: the farmer pays 0.207 ETH for a 29% chance at 1 ETH
   (+0.086), where against all 4 the same spend would buy under 10%. With
   nothing activated, a fee of 0.00002 ETH wins the prize outright (test).
2. **The caller of `draw` sets the snapshot.** Wash trade, `flush(self)` and
   `draw` fit in one transaction, and from then on `flush` reverts for
   everyone else. Nobody can respond to the farmer's purchase. The first
   transaction after `drawAfter` takes the profit, so it becomes a priority-fee
   race on mainnet and a latency race on a rollup.
3. **Points are reused.** A loser keeps everything and a winner keeps 20%.
   Against `T` = 2 one raffle is break-even, three in a row are worth +0.31 ETH
   and ten +1.09 ETH (Model). The inequality has to be applied to the sum of
   the prizes the same points can reach.
4. **Points are global.** A raffle of an expensive collection can be won with
   points from wash trades on a cheap one. The prize was bought with one
   collection's budget and the farming fees go to another's.

`winnerKeepBps`: a higher keep raises the value of a farm across several
raffles; a lower one punishes honest winners. It does not affect the first
draw.

### 3.3 Is a raffle ever better than an auction for the protocol?

Not in ETH. An auction returns the reserve or more (at least 1.3 times cost) to
the budget. A raffle returns nothing directly; the most it can induce is the
fees farmers pay, and rational farmers together spend less than the prize
(`V (n − 1)/n` with `n` equal competitors, far less when one can move last).
Points already held by organic users induce nothing. A raffle is a marketing
expense of one floor per prize, paid to fee payers in proportion to activated
points. That may be worth doing; it should be decided as such.

The whitepaper's version, paid tickets for vault NFTs, does beat an auction
when the pot exceeds the floor. `TicketRaffle` already exists: letting the
Vault create a ticket raffle with `minTickets × ticketPrice` at or above the
auction reserve would return at least the reserve or the NFT.

### 3.4 Rules that would make raffles safe

| Rule | Effect | Complexity |
|---|---|---|
| Credit each fee once (half to each side, winner only in predictions) | `k` from 0.5 to 1; doubles the cost of every farm | Trivial |
| Prize cap: `sendToRaffle` requires the prizes open at one time to be worth at most 25% of activated fee-ETH | Farming has no positive optimum even at `k` = 0.25. A 1 ETH prize needs 4 fee-ETH active, about 100 ETH of volume behind activated points | Low |
| Count only points activated before the raffle opened | Removes the one-transaction farm and the `draw` race; a farmer has to buy before the prize is announced | Medium (snapshot total in the tree, or freeze from `open` after an announced activation window) |
| Time-weighting: points count in proportion to age, full after 90 days | A farmer commits three months ahead and others can answer. The game becomes a contest in which up to `(n − 1)/n` of the prize is paid in fees; farmer profit falls from `(sqrt(V) − sqrt(kT))²` to about `V/n²` | High |
| Points per collection, raffles weighted by that collection's points | Removes the cross-subsidy; makes `T` smaller, so it needs the prize cap | Medium |
| All points lose a share at each draw, not only the winner's | Stops one farm paying over many raffles | Low |

The first two together are cheap and sufficient for a single prize. Without at
least the prize cap I would not call `sendToRaffle` safe to use.

---

## 4. Games bankroll

### 4.1 The house's position (Result)

Per bet the house wins the stake with probability `1 − c` and loses
`stake × (1 − c)/c` with probability `c`: mean zero, variance
`stake² (1 − c)/c`. Slots have variance 6.9 × stake². The 1% rule caps the
house's *loss*, not its risk:

| Game | Largest stake | Standard deviation per bet | Median bankroll halves after | Fees players pay meanwhile |
|---|---|---|---|---|
| Dice 1% | 0.010% of B | 0.10% of B | 1,363,000 max bets | 2.8 B |
| Dice 50% | 1.0% | 1.0% | 13,900 | 2.8 B |
| Dice 95% | **19%** | **4.4%** | **815** | 3.2 B |
| Slots | 0.020% | 0.054% | 4,800,000 | 20 B |

The mean stays at B; the median falls at `variance/2` per bet because bets
scale with the bankroll (the Kelly argument run backwards: zero edge and
positive variance means negative log growth).

### 4.2 Drawdowns under sustained maximum bets (Model, 4,000 paths)

| Game | Bets | P(bankroll ever at half) | 5% / median / 95% of B |
|---|---|---|---|
| Dice 50% | 1,000 | 3.6% | 0.58 / 0.95 / 1.57 |
| Dice 50% | 10,000 | 66% | 0.11 / 0.60 / 3.00 |
| Dice 50% | 100,000 | 98.5% | 0.00 / 0.006 / 1.46 |
| Dice 95% | 1,000 | 78% | 0.06 / 0.43 / 3.24 |
| Dice 95% | 10,000 | 99.6% | 0.00 / 0.00 / 0.15 |
| Dice 1% | 100,000 | 4.3% | 0.57 / 0.95 / 1.58 |
| Slots | 100,000 | 0.0% | 0.75 / 0.99 / 1.29 |

The 50x slots tail is the least dangerous thing here, because the 1% rule
holds the stake to 0.02% of the bankroll. The danger is high-chance dice.
Nobody profits from doing this: the player pays 2.8 to 3.2 bankrolls in fees
to halve the median. But those fees go to the Treasury and the losses stay
with the bankroll.

### 4.3 Bankroll needed for realistic play (Result for the formula, checked by simulation)

With bets of fixed size `b` and `W` ETH wagered a day, a zero-drift bankroll
has a 99% chance of never being down by half within a year if
`B ≥ 5.15 × sqrt(365 × W × b × variance)`. It grows with the square root of
volume and bet size, not in proportion:

| Game | `W` = 1 ETH/day, `b` = 0.1 | `W` = 10, `b` = 0.1 | `W` = 10, `b` = 1 | `W` = 100, `b` = 1 |
|---|---|---|---|---|
| Coinflip | 31 ETH | 97 | 305 | 965 |
| Dice 10% | 92 | 289 | 915 | 2,894 |
| Dice 1% | 304 | 960 | 3,035 | 9,597 |
| Slots | 80 | 253 | 801 | 2,534 |
| Fees to the Treasury per year | 7.3 | 73 | 73 | 730 |

(Simulation of the coinflip case at 96.5 ETH: 1.05%.)

### 4.4 Who would fund it?

Nobody acting for a return. `fundBankroll` has no way back to the funder: the
money leaves only to players or to the Treasury's unallocated pool. Expected
return is zero before that and −100% after it. A funder is making a donation
that buys the collection budgets 2% of whatever is wagered, so it beats
donating to a budget directly only if lifetime wagering exceeds 50 times the
bankroll, and the funder cannot choose which collection benefits. There is
also no path from the Treasury back to the bankroll, so drawdowns can only be
repaired by new donations.

### 4.5 A sustainable alternative

Let the bankroll keep a share `theta` of the edge. Then it has drift
`theta × e × W` and the chance of ever being down by half is
`exp(−theta × e × B / (b × variance))`:

| `theta` | Coinflip: B for 1% lifetime risk | Dice 95% | Slots |
|---|---|---|---|
| 25% | 885 × bet size | 47 × | 6,103 × |
| 50% | 442 × | 23 × | 3,052 × |
| 100% | 221 × | 12 × | 1,526 × |

Recommendation, in order:

1. `theta` = 50%: half the edge stays in the bankroll. Cost: half the games
   fees. Example: 10 ETH a day wagered pays 36.5 ETH a year to the bankroll
   and 36.5 to buybacks, instead of 73 and 0.
2. Cap the stake as well as the exposure: `maxExposureBps` 20 (0.2% of the
   bankroll, the coinflip bound for `theta` 50%) and stake at most 1% of the
   bankroll. That brings a 95% dice bet from 19% of the bankroll to 1%.
   Slots at a 0.2% exposure cap stake 0.004%, inside their 0.033% bound.
3. Funders' shares that can be redeemed (a vault-style share of `bankroll`),
   so somebody other than the owner has a reason to fund it. With `theta` 50%,
   B = 100 ETH and 10 ETH a day in 0.1 ETH coinflips, a share earns about 36%
   a year with a standard deviation of about 19% (Model).

### 4.6 Randomness cost against the fee (Assumption-heavy)

Assumed: 235k gas billed per request (115k verification, 120k callback) and a
Chainlink premium of 20% on mainnet and 60% on a rollup. Neither has been
measured against a live coordinator.

| Chain, gas price | Cost per request | `minBet` that breaks even at 2% | Default 0.001 ETH covers | `minPot` that breaks even at 5% |
|---|---|---|---|---|
| Mainnet, 0.5 gwei | 0.00014 ETH | 0.007 ETH | 14% | 0.003 ETH |
| Mainnet, 2 gwei | 0.00056 | 0.028 | 3.5% | 0.011 |
| Mainnet, 10 gwei | 0.0028 | 0.14 | 0.7% | 0.056 |
| Mainnet, 30 gwei | 0.0085 | 0.42 | 0.2% | 0.17 |
| Rollup, 0.005 gwei | 0.000002 | 0.00009 | 1,060% | 0.00004 |
| Rollup, 0.02 gwei | 0.000008 | 0.0004 | 266% | 0.00015 |
| Rollup, 0.1 gwei | 0.00004 | 0.0019 | 53% | 0.0008 |

Dice and slots cost the same per request. "Breaks even" is for the system as a
whole: the fee goes to a budget and the subscription is paid by the operator,
who can never be reimbursed from it. Halve the coverage if the bankroll keeps
half the edge, and halve it again at a 50% project share. Recommended:
`minBet` 0.05 ETH on mainnet and review above 3 gwei; 0.002 ETH on a rollup;
`minPot` 0.05 ETH is adequate on a rollup and on mainnet up to about 9 gwei.

---

## 5. Prediction markets

### 5.1 Value of betting last (Model, `sim_markets.py`)

Honest bettors stake equally on both sides at the start. An informed bettor
acts at the close knowing the move so far. With a driftless walk the leading
side wins with probability `Phi(|z| × sqrt(beta/(1 − beta)))`, `beta` =
betting period / duration.

| `beta` | Leader wins | One informed bettor's profit | Honest loss | Honest loss if informed bettors compete | Honest loss with none |
|---|---|---|---|---|---|
| 0.50 (the limit) | 75.0% | 10.2% of honest stake | **11.9%** | 2.2% | 1.5% |
| 0.33 | 69.5% | 5.9% | 7.6% | 2.1% | 1.5% |
| 0.20 | 64.8% | 3.3% | 4.9% | 1.9% | 1.5% |
| 0.10 | 60.2% | 1.5% | 3.1% | 1.8% | 1.5% |
| 0.02 | 54.5% | 0.25% | 1.8% | 1.6% | 1.5% |

Honest bettors never have a non-negative expectation: the best case is −1.5%
(the fee), and against one late bettor it is −12%. Competing informed bettors
hurt less than one, because their money on the favourite is what the honest
underdog wins.

### 5.2 The start price

`createMarket` snapshots whatever the oracle holds, up to `maxOracleAge` (one
day) old. Model, probability that the side of the known gap wins:

| Oracle price age | Market length | P |
|---|---|---|
| 24 h | 20 min | 96% |
| 6 h | 20 min | 93% |
| 1 h | 20 min | 83% |
| 24 h | 1 day | 75% |
| 24 h | 30 days | 56% |

A 20-minute market on a daily-pushed oracle is a known outcome; it only needs
someone to take the other side (otherwise it is void and costs gas). Creating
a market in front of a pending `pushFloor` is the same thing on purpose.

### 5.3 Who resolves when (Result)

`resolve` uses the price held at the moment it is called, with no deadline.
If a winner with more at stake than gas is watching, the option is worth
nothing: they resolve at the first eligible price. If nobody does, the losing
side waits. For a driftless walk the chance that the price crosses back within
a further time `T` after a market of length `D` is `(2/pi) × atan(sqrt(T/D))`:
20% after a tenth of the market's length, 50% after one length, 67% after
three. There is no cap, so an unresolved market eventually belongs to whoever
is patient.

### 5.4 Cost of moving the settlement price

The outcome is decided by any difference from the start price, even one wei.

| Oracle | Direction | Cost | Pays when the losing pool exceeds |
|---|---|---|---|
| `SalesFloorOracle` | Down | Gas only (Result: 819k gas; 0.0008 ETH at 1 gwei, 0.025 at 30) | The gas |
| `SalesFloorOracle` | Up | Four fees just above the start price: 0.08 F, or 0.28 F with a 5% royalty (Result). The fees go to the budget and can partly be taken back through the bid | 0.082 F to 0.29 F |
| `PushFloorOracle`, reporter | Either | Nothing | Anything |
| `PushFloorOracle`, outsider moving what the reporter reads | Either | Buy the cheapest listing, or list one token a wei under it: about 1 to 6% of one floor (Assumption) | 0.01 to 0.06 F |

On the sales oracle the trades and `resolve` fit in one transaction at the
settlement time, so the market goes to whoever lands first, and "lower" costs
nothing. SECURITY.md already says not to use it; the number to add is that the
safe pool size is zero. On the push oracle the safe pool size is whatever the
reporter is trusted with, and the one-wei rule makes even an honest reporter's
reading of listing noise decide markets.

### 5.5 Recommendations

1. A dead band: void unless the price moved by at least 2%. Removes one-wei
   and listing-noise outcomes and raises the cost of moving the price from one
   listing to a real sweep.
2. `bettingPeriod` at most 10% of `duration` (honest loss 3.1% instead of
   11.9%), and a start price at most one hour old, or taken from the first
   push after creation.
3. Settle on the first price published at or after the settlement time, not
   on the price at the call: have the oracle keep it, or pay the caller of
   `resolve` a small share of the fee so that a keeper exists.
4. A cap on a market's pool, per collection, set against the cost in 5.4.

---

## 6. Vault auctions

**Price paid (Result for the path, Assumption for buyers).** The price is
public and falls 0.007 to 0.014% per 12-second block. With two or more buyers
who value the token at `v`, it sells within a block of reaching `v`; the
surplus left for the buyer is at most one block's fall (0.0001 ETH on a 1 ETH
token), less than gas, and on mainnet it goes to the block builder in priority
fees. The Vault gets `v`. What `v` is depends on who is bidding: a holder who
wants the token pays up to the lowest ask elsewhere; a flipper pays the best
outside bid less selling costs, 1.5 to 5% lower. Expected discount to the
lowest ask: 0 to 5%, 2% in the flywheel model. With one buyer and no rival,
the price is the reserve.

**Time to sale (Result).**

| Market value / reserve | Days from the start |
|---|---|
| 8 | 1.0 |
| 2 | 3.0 |
| 1.3 | 3.7 |
| 1.0 | 4.0 |
| below 1 | never |

The first three days of every auction are a formality. More important is the
30 days before it. If nobody starts the auction until the governance window
has passed, a holding that unlocked with the floor at exactly 1.3 times its
price has only a 45% chance (driftless, 80% volatility) that the floor is
still at or above its reserve when the descent ends 34 days later; one that
unlocked at 1.5 times has 68%. Otherwise it cannot sell, and it restarts every
four days for gas until the owner prices it by hand.

The reserve is also never below the oracle floor. An auction therefore cannot
sell at a discount to that reading: if the only bidders are flippers who stop
a few percent short of it, the auction stalls and restarts rather than
clearing.

**Restart option.** Worth nothing to the caller. It can be used to grief only
when the market is within a block's fall of the reserve.

**Owner-priced path.** Economically sound when used to exit: buyers still
compete on the way down. It is also how an owner sells to itself (in
AUDIT.md's list).

**Oracle manipulation.**

| Push | When | Cost | Effect |
|---|---|---|---|
| Down | Always | Gas | No holding unlocks. Wanted by every holder (2.4) |
| Down | At `unlock` or `startAuction` | Gas | Opening falls to 16 × 1.3 × purchase price. Harmless unless the token is worth more than 20.8 times its purchase price and `minReserveOf` is unset |
| Up | After 180 days | 0.104 × purchase price (plus royalties), into the budget | Forces an unlock; the auction then stalls at 1.3 × purchase price. Opens the way to `sendToRaffle` only for the owner |
| Up | At `startAuction` or a restart | 0.08 × the fake floor per four days, for all of a collection's auctions started in that window | The auction sits above the market until the next restart |

None of these takes a token below market. The first one switches the
recycling off; the last delays it for 2% of a floor a day.

**Recommendations.** Start auctions as soon as a holding unlocks (owner or
keeper), or cut `GOVERNANCE_WINDOW` to a few days; set `minReserveOf` for
every collection; cap the reserve at, say, 1.5 times the unlock price so that
a pumped oracle cannot hold an auction above the market.

---

## 7. Ticket raffles and lottery

**Creator dilution (Result).** Buying the `k` unsold tickets in the last block
costs the creator the fee on them, `5% × k × t`, and wins the NFT back with
probability `k/N`. The gain is `k × (V/N − 0.05 t)`, positive unless the
full pot is more than 20 times the NFT's value.

| Full pot | Sold to others | Creator's gain | Fee paid | Buyers' expected return, before → after |
|---|---|---|---|---|
| 1.0 V | 50% | 0.475 V | 0.025 V | +100% → 0% |
| 1.5 V | 50% | 0.463 V | 0.038 V | +33% → −33% |
| 1.5 V | 75% | 0.231 V | 0.019 V | −11% → −33% |
| 2.0 V | 50% | 0.450 V | 0.050 V | 0% → −50% |
| 2.0 V | 90% | 0.090 V | 0.010 V | −44% → −50% |

A rational creator always fills the raffle, from a second address nobody can
tell apart. So:

- A buyer's expected return is `V/(N × t) − 1`, judged at `maxTickets`. At the
  whitepaper's suggested pricing (pot 1.4 to 2 times the floor) that is −29%
  to −50%. The 5% fee is the creator's cost, not the buyer's.
- `minTickets` is the creator's option, not the buyers' protection. A raffle
  short of its minimum can be rescued by the creator's own purchases when that
  pays (pot 1.5 V, half sold: +0.175 V against a refund), and left to refund
  when it does not.
- The creator also knows the token better than the buyers (rarity, flags).

**Sybils.** There is no per-address limit and none would hold. They change
nothing for an ordinary buyer; they hide the creator.

**Lottery.** A ticket returns 95% of its price in expectation whatever anyone
else buys or when. No timing, dilution or sybil effect. It is the one game
here whose stated take is the player's actual expected loss.

**`minPot` and randomness.** 0.05 ETH yields a 0.0025 ETH fee per draw: enough
on a rollup, enough on mainnet below about 9 gwei (section 4.6). Forcing a
request costs an attacker that same 0.0025 ETH plus gas, so the subscription
cannot be drained cheaply through raffles. Games at `minBet` 0.001 ETH can.

**Recommendations.** Show buyers the return at `maxTickets`, not at tickets
sold. Close sales to the creator's benefit by making dilution pointless: if
fewer than `maxTickets` are sold, draw over `maxTickets` and return the NFT to
the creator when an unsold ticket wins (the creator then gets exactly what
dilution would give, openly, and buyers can price it). Or simply require
`minTickets == maxTickets`.

---

## 8. MEV and ordering

"Mainnet" assumes a public mempool and competitive builders. "Rollup" assumes
one sequencer, first come first served, able to delay a transaction for the
forced-inclusion period (12 to 24 hours on today's main rollups; Assumption).

| Function | What can be taken | Mainnet | Rollup |
|---|---|---|---|
| `BuybackEngine.sell` | The gap between the bid and the floor. Converging bid: one block of growth, 0.0014% of F at the defaults. Overpaying bid: `maxPrice − F` per fill, the whole cascade after a lump (6.5 F in 1.4) | Searchers back-run the deposit, `allocate` or `Vault.buy` that funds the bid; the surplus goes to builders | Fastest bot or the sequencer |
| `BuybackEngine.sell`, victim | A seller with a loose `minPrice` is front-run and receives 5% less (one step down) or reverts | Yes | Sequencer only |
| `Treasury.allocate`, `deposit` | Same as the first row: the owner's own funding transaction is the trigger | Yes | Yes |
| `Marketplace.acceptOffer` | A collection offer above the cheapest token elsewhere is filled by a searcher first; the seller's transaction reverts. The offerer loses nothing | Yes | Latency |
| `Marketplace.cancelOffer` | A stale high offer is accepted in front of its cancellation: the offerer pays offer minus value | Yes | Sequencer |
| `Marketplace` collection offers | Free or cheap oracle moves placed around `unlock`, `startAuction`, `createMarket`, `resolve` | Atomic, no ordering needed | Same |
| `Vault.buy` | At most one block's fall of the price (0.007 to 0.014%) | Priority-fee auction; the Vault still gets the buyers' value | Latency race; the sequencer can take every auction at one block under the next buyer |
| `Vault.startAuction` (restart) | Nothing; delays a sale at exactly the reserve | Grief for gas | Same |
| `PredictionMarket.createMarket` | A market opened in front of a pending `pushFloor` has a known direction (5.2) | Yes | Sequencer, or anyone who knows the reporter's schedule |
| `PredictionMarket.placeBet` | Last block before the close, with the latest price (5.1) | Anyone | Anyone |
| `PredictionMarket.resolve` | The pool, if nobody else resolves (5.3). Censoring `resolve` until the price crosses | Not feasible for long | **The sequencer can hold every `resolve` and include its own when the price suits** |
| `Games.play`, `spin` | The result is known to the randomness oracle before it submits, and to anyone who sees its transaction before inclusion. Withholding a loss for a day turns it into a refund: wins are paid, losses returned. Expected gain per bet `wager × (1 − e − c)`. Withheld losses hold their exposure for a day and open exposure is capped at 20%, so about 20 losses can be parked per day: roughly a fifth of the bankroll a day at a coinflip, and most of it at 95% dice, where 20 losses come with about 380 wins of 0.6% each | Only the oracle operator. A proposer cannot censor for a day | **The sequencer can, alone** |
| `VaultRaffle.draw` | The farm of 3.2: first caller after `drawAfter` freezes the weights | Priority-fee race for `(sqrt(V) − sqrt(kT))²` | Latency race |
| `VaultRaffle`, `TicketRaffle`, `Lottery` fulfilment | Withholding a result for a day resets the draw: a free re-roll for whoever can withhold | Oracle operator | **Sequencer** |
| `TicketRaffle.buy` | Creator dilution in the last block (7) | Anyone | Anyone |
| `TicketRaffle.close`, `Lottery.draw`, `Points.flushMany` | Nothing to take. Censoring only delays; nobody is paid to call them | | |

The two bold rollup rows and the oracle-operator cases contradict FAIRNESS.md,
which says withholding "gives nobody a choice of outcome". The late-result
rule stops a party from choosing *after* the deadline between a late result
and a refund. It does not stop a party who sees the result *before* the
deadline from choosing between delivering it and letting it expire. The fix is
to make expiry unattractive: on timeout a bet is settled as lost to the
bankroll unless the randomness provider has been replaced, or refunds are paid
less a penalty at least equal to the edge, and a reset raffle draw reuses the
same request rather than a new one. On mainnet with Chainlink this is a trust
statement about the oracle; on a rollup it is a trust statement about the
sequencer, and the 1-day timeouts sit inside the forced-inclusion window.

---

## 9. Statements in the docs that promise more than the analysis supports

I have not edited these files. Proposed wording is given in full.

### README.md

| Now | Problem | Proposed |
|---|---|---|
| "An NFT marketplace protocol that turns its own fees into floor price support." | Promises an outcome. The mechanism buys one token per 50 traded (2.3) | "An NFT marketplace protocol that spends its own fees on buying tokens of the collections it trades." |
| "FloorGuard reverses the incentive: every fee the protocol earns on a collection becomes a budget for buying that collection's floor." | Not every fee (project share up to 50%); nothing is reversed on other venues | "FloorGuard has no listings to undercut. The part of each fee that is not paid to the NFT project (the project can be given up to half) becomes a budget for buying the cheapest tokens of that collection." |
| "It rises over time until a holder sells into it, then steps down and rises again, so it finds the floor without an oracle." | True only above the inflow threshold (1.2) | "It rises over time until a holder sells into it, then steps down and rises again. When fees arrive fast enough for the budget to keep up, this finds the lowest price a holder will accept. When they do not, the bid rises to a maximum the owner sets and the protocol pays that." |
| "Bought NFTs are locked for at least 180 days and until the floor is 30% above the purchase price. They are then auctioned, with proceeds returning to the budget, or raffled." | Leaves out the usual case | Add: "If the floor never gets there they stay locked unless the owner releases them. Selling one returns about enough to buy one back, so auctions do not increase the number of tokens held." |
| "Users earn points for the fees they generate. Points are their odds of winning NFTs raffled from the Vault." | Only activated points count; points can be bought for half the fee | "Users earn points for the fees they generate. Points that have been activated before a draw are a user's weight in raffles of Vault NFTs. Points can be bought by trading with oneself; see SECURITY.md." |

### docs/ARCHITECTURE.md

| Now | Problem | Proposed |
|---|---|---|
| "so trading a collection funds the defence of that collection's floor" | Outcome language | "so the fees from trading a collection are spent on buying that collection's tokens" |
| "After that, buybacks need no operator or bot: holders sell into the bid themselves." | The owner has to keep `maxPrice` and the growth rate in line with the market (1.6) | "After that, no bot is needed to execute buybacks: holders sell into the bid themselves. The owner still has to keep each collection's maximum price and growth rate in line with the market and with the fee inflow; see ECONOMICS-REVIEW.md." |
| "Holders compete to be the first to accept once it reaches the lowest price any of them will take, which is the floor. No oracle is involved, and a manipulated oracle cannot make the engine overpay." | Second sentence is true and misleading: the engine overpays with no oracle at all | "Holders compete to be the first to accept once it reaches the lowest price any of them will take. This holds while the budget covers the bid. The bid keeps rising when the budget is empty, so if fees arrive more slowly than `basePrice × growth × (1 − stepDown) / stepDown` each buyback is dearer than the last, up to `maxPrice`. No oracle is involved." |
| "Anyone can also buy the cheapest listing on another venue and sell it into the bid, which is how the bid supports floors elsewhere." | Pays only when the bid is above the ask (1.5) | "Buying the cheapest listing on another venue and selling it into the bid pays only when the bid exceeds that listing by the buyer's costs, about 1 to 6% plus gas. A bid that has settled at the lowest price holders accept is below that, so it removes tokens from sale without lifting listings elsewhere." |
| "The owner's `maxPrice` is the main guard against overpaying" | It is the only one, and the usual price | "The owner's `maxPrice` is the only limit on what the engine pays, and it is what the engine pays whenever the budget falls behind the bid." |
| "which limits how fast anyone with a cheap supply of tokens can sell into the bid" | A long cooldown causes overpayment (1.3) | Add: "The cooldown must be shorter than `stepDown / ((1 − stepDown) × growth)` (12.6 hours at the script defaults); a longer one lets the bid regrow past its last price before the next sale." |
| "The opening price is deliberately far above the market, so the sale price is found by buyers competing on the way down." | Needs two buyers | Add: "With a single buyer the sale price is the reserve." |
| "so the bankroll has no expected gain or loss and the whole house take funds buybacks" | True, and omits the consequence | Add: "The bankroll therefore earns nothing for the risk it carries, cannot be withdrawn by whoever funded it, and its typical path is downward even though its average is flat." |
| "A price from before the settlement time is never accepted, so nobody can bet on the price the market will settle on." | Says nothing of the start price or of betting last | Add: "The start price can be up to a day old when a market is created, and later bettors know more than earlier ones. Both favour whoever acts last." |
| "Because points follow fees, farming them always pays into buyback budgets." | The farmer can take the fee back, and pays half of it per point | "Points follow fees, so farming them pays into buyback budgets. Both sides of a trade are credited, so a self-trade earns two points per unit of fee, and a farmer who also sells into the bid takes part of the fee back." |
| "The seven-day announce period before each draw is the time to do it." | Whoever calls `draw` ends that period for everyone | Add: "Activation stops for everyone the moment anyone calls `draw`, which can be the first block after the announce period." |

### docs/FAIRNESS.md

| Now | Problem | Proposed |
|---|---|---|
| Title use of "provably fair" for raffles and lottery | The draw is provably uniform; the game around it is not | Open with: "'Provably fair' here means only that the random draw can be checked. It says nothing about a player's expected return, which is given below." |
| House-take table | The take is not the player's expected loss in two rows | Add a column "Player's expected return": dice, coinflip, slots −2%; lottery −5%; ticket raffle `value / (maxTickets × price) − 1`, which is the creator's choice and usually far below −5%; vault raffle: not applicable, weights can be bought. |
| "The operator, the player and the oracle cannot choose the number, and nobody can know it before it is delivered." | The oracle knows it before delivering; anyone who sees its transaction knows it before inclusion | "The operator, the player and the oracle cannot choose the number. The oracle knows it before delivering it, and so does anyone who sees the oracle's transaction before it is included." |
| "so withholding or delaying a result gives nobody a choice of outcome" | False for whoever can withhold after seeing the result (section 8) | "A result that arrives late is ignored, so nobody can choose between a late result and a refund. A party able to hold a result back for the whole day after seeing it, which means the oracle operator or, on a rollup, the sequencer, can still turn a result it dislikes into a refund or a redraw. The claim rests on neither of them colluding with a player." |
| "Fairness of the vault raffle also depends on points, which can be bought with fees" | Understated | "The vault raffle's draw is uniform over activated points. Points can be bought for half the fee behind them by trading with oneself, only activated points count, and whoever requests the draw closes activation for everyone else. A raffle is not a fair distribution among fee payers unless the prize is small against activated points." |

### Regulatory framing (for counsel, not a legal opinion)

- "Floor price support", "defence of that collection's floor" and the README's
  "reverses the incentive" describe a price outcome for holders. Combined with
  a Vault that "compounds" and a flywheel diagram, a reader can take them as a
  promise of price maintenance funded by others' activity. The proposed wording
  describes what the contracts do with fees and leaves the outcome out.
- SECURITY.md flags `Games`, `Lottery` and `TicketRaffle` as regulated. The
  same question applies to two modules it does not name: `VaultRaffle` awards a
  prize by chance to people in proportion to fees they paid, and
  `PredictionMarket` is a pooled bet on a price settled by a reporter the
  operator appoints. Suggested addition to the "Games and paid raffles" item:
  "The same applies to `VaultRaffle`, where the chance of a prize is earned by
  paying fees, and to `PredictionMarket`, which takes bets on a price reported
  by an operator-appointed party."
- "The edge is not kept by an operator: it goes to the Treasury as buyback
  budget" is accurate, but the operator chooses what the Treasury buys and at
  what maximum price, and may hold the collection. Suggested addition: "The
  owner sets the price limits at which that budget is spent."

---

## 10. Recommendations in one list

Ranked by benefit against complexity.

| # | Change | Fixes | Complexity |
|---|---|---|---|
| 1 | `currentBid = min(curve, maxPrice, budget)` | Steady-state ratchet to `maxPrice` (1.2) | One line |
| 2 | Credit each fee once in `Marketplace` and `PredictionMarket` | Halves the price of farming (3.1) | Trivial |
| 3 | Raise default `minBet`; `maxExposureBps` 20; cap stake at 1% of bankroll | 95% dice risk; randomness cost (4) | Parameters and one check |
| 4 | Prize cap on `sendToRaffle` against activated points | Raffle farming (3.2) | Low |
| 5 | Dead band, shorter betting period, fresh start price in `PredictionMarket` | Sections 5.1, 5.2, 5.4 | Low |
| 6 | Enforce the cooldown limit; correct the docs (section 9) | 1.3, 9 | Low |
| 7 | Timeouts that do not reward withholding (section 8) | Free option for oracle or sequencer | Low to medium |
| 8 | Bankroll keeps half the edge | Zero-return bankroll (4.5) | Low; costs half the games fees |
| 9 | Guardian role that can only lower prices or pause | Timelocked owner cannot track the market | Medium |
| 10 | Clock runs only while funded (rule B) | Lumps and falling markets (1.4) | Medium; needs review |
| 11 | Snapshot points at raffle open; vault ticket raffles with a reserve | Sections 3.2, 3.3 | Medium |
| 12 | Redeemable bankroll shares | Nobody has a reason to fund the bankroll | Medium to high |
| 13 | Separate the Vault's oracle from buyback fills; gradual auctions | 2.4 | Medium |

Until 1 is in, run every collection with `growthBpsPerDay` set from the
measured inflow and `maxPrice` at 1.10 times the outside floor, reset weekly.

## 11. Open questions that need real market data

1. **Volume.** What share of a collection's trading will accept a 2% fee when
   other venues charge 0 to 0.5%? Every size estimate in section 2 scales with
   it, and so does the choice of `growthBpsPerDay`.
2. **The cheapest seller.** How far below the lowest ask do holders sell when
   they want out (the spread to the best outside bid), per collection? This is
   what the bid converges to and what the sales oracle will record.
3. **Price impact.** How much does removing 0.5% of annual sales, or 1.5% of
   supply over three years, move a floor? I have not assumed any effect.
   Listing-depth data (tokens listed within 5, 10, 20% of the floor) would
   bound it.
4. **Holder concentration.** For each candidate collection, what share of the
   listed float do the top five holders control? Section 1.4's dominant-holder
   case depends on it.
5. **Fee inflow variance.** Daily fee series for comparable venues, to size
   how often the inflow would fall below `f*` for a given curve.
6. **Activation behaviour.** What fraction of points get activated at
   different gas prices? Section 3.2 is very sensitive to it.
7. **Wager sizes.** The distribution of bet sizes and chosen chances on
   comparable dice games, to replace the fixed `b` in section 4.3.
8. **Randomness cost.** Measured gas per fulfilment for each consumer against a
   live coordinator, and the current Chainlink premium per chain.
9. **Reporter method.** What `PushFloorOracle` reporters will publish (lowest
   ask, a time average, a trimmed set), how often, and from which venues. The
   cost of moving the settlement price in 5.4 is a guess until that is fixed.
10. **Auction demand.** How many independent bidders show up for a floor token
    sold by Dutch auction on-chain, and how far below the lowest ask they stop.
11. **Raffle demand.** Sell-through and late-buying patterns on existing
    ticket-raffle venues, to check the claim that creators fill their own
    raffles.
12. **Forced-inclusion delays and sequencer policy** on the target rollup,
    against the one-day timeouts.
