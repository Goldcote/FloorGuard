# Fairness

This document explains what "provably fair" means for FloorGuard's games,
raffles and lottery, how anyone can check a result, and what has to be true of a
deployment for the claim to hold.

"Provably fair" here means only that the random draw can be checked. It says
nothing about a player's expected return, which is negative in every game and
is given below.

## What is fixed in code

| Game | How the outcome is decided | House take | Player's expected return |
|---|---|---|---|
| Dice and coinflip | `roll = random % 10000`; the bet wins if `roll < chanceBps` | The edge (2% by default) on the wager | −2% of the wager |
| Slots | The same roll, looked up in a fixed table | The edge on the wager | −2% of the wager |
| Lottery | Winning ticket is `random % ticketsSold` | 5% of the pot | −5% of the ticket price |
| Ticket raffle | Winning ticket is `random % ticketsSold` | 5% of ticket revenue | Depends on the prize's value against total ticket sales, which the creator sets; often well below −5% |
| Vault raffle | The holder of point number `random % totalPoints`, with weights frozen when the draw is requested | None | Not applicable: weights can be bought with fees |

In dice and slots the stake that remains after the edge is played at exactly
fair odds: a dice win pays `stake / chance`, and the slots table (50x at 0.2%,
10x at 1%, 5x at 4%, 2x at 15%, 1x at 30%) averages exactly 1x. A test sums the
table over all 10,000 rolls to confirm it. The edge is not kept by an operator:
half of it goes to the Treasury as buyback budget and half stays in the games
bankroll, to pay for the risk the bankroll carries. The owner can change that
split. The owner also sets the price limits at which
that budget is spent.

The edge that applies to a bet is stored with the bet when it is placed. How
that edge is split between the bankroll and the Treasury is read when the bet
settles; it does not change what the player is paid. Fees
and minimum pots of a lottery round, a raffle and a prediction market are fixed
when they are created. A later change by the owner cannot reach them.

## Where the randomness comes from

Each random number comes from Chainlink VRF v2.5. The oracle produces the number
from a seed fixed at request time and delivers it with a cryptographic proof,
which the VRF coordinator verifies on-chain before passing the number on. The
operator, the player and the oracle cannot choose the number. The oracle knows
it before delivering it, and so does anyone who sees the oracle's transaction
before it is included in a block.

What an oracle can still do is withhold a number. A bet without an answer after
six hours is refunded, an unanswered draw can be reset and requested again, and an
answer that arrives after its deadline is ignored, so nobody can choose between
a late result and a refund.

That does not cover a party able to hold a result back for the whole refund period (six hours for a bet, a day for a draw) after
seeing it: the oracle operator, or on a rollup the sequencer, can turn a result
it dislikes into a refund or a redraw. The fairness claim rests on neither of
them colluding with a player.

## Checking a result yourself

Every settled bet emits `BetSettled(requestId, player, won, roll, payout, fee)`.
To check one:

1. Find the bet's `BetPlaced` event for the same `requestId`: it holds the wager
   and the chance (zero means slots).
2. Find the Chainlink fulfilment transaction for that request. The coordinator
   only delivers a number whose proof it has verified.
3. Recompute: `fee = wager * edge / 10000`, `stake = wager - fee`, and the payout
   is `stake * 10000 / chance` for a dice win or `stake * slotsMultiplier(roll)`
   for slots. Both functions can be called on the contract.

Raffle and lottery draws emit the winning ticket, and `ownerOfTicket` returns
who held it.

## What has to be true of a deployment

The claim holds only for a deployment where all of the following are true.
None of them is true yet: nothing has been deployed to a public network.

- **The randomness provider is the Chainlink adapter.** `MockRandomness`, used on
  local chains, lets whoever calls it pick the number. Check `randomness()` on
  each game contract.
- **The owner is behind a timelock.** The owner can replace the randomness
  provider. With a timelock, such a change is visible for the whole delay before
  it takes effect.
- **The source is verified on the block explorer**, so the deployed bytecode can
  be matched to this repository.
- **The code has been professionally audited.** Fair randomness does not protect
  against a bug elsewhere. See [AUDIT.md](AUDIT.md) for what has and has not
  been reviewed.

## Limits

- The Chainlink adapter has been tested against a simulated coordinator, not a
  live one.
- The vault raffle's draw is uniform over activated points. Points can be bought
  by trading with oneself, only activated points count, and whoever requests the
  draw closes activation for everyone else. A raffle is not a fair distribution
  among fee payers unless the prize is small against the fees behind the
  activated points; see "Raffle farming" in [SECURITY.md](../SECURITY.md).
- In a ticket raffle the creator can buy unsold tickets late and dilute other
  buyers; the draw itself is still uniform over tickets.
- The slot reels shown in the web app are an illustration of the roll. The
  payout comes from the contract.
