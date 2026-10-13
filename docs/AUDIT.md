# Review record

This is a record of the automated security work done on FloorGuard so far. It is
**not a professional audit**. Every review below was carried out by AI agents in
a single working session on 13 October 2026, on code that was changing between
passes. A professional audit by an independent firm, and ideally a public
contest, is required before the contracts hold real funds.

## What was done

| Pass | Scope | Result |
|---|---|---|
| Review 1 | All contracts at the time | 2 High, 3 Medium, 4 Low |
| Review 2 | Games, project fee share, fixes from review 1 | 2 Medium, 7 Low |
| Review 3 | TicketRaffle, IPLicenseManager, deploy scripts, fixes from review 2 | 1 High, 5 Medium, 7 Low |
| Full-system audit | Core contracts and how all modules interact | 1 High, 3 Medium, 6 Low |
| Static analysis | Slither 0.11.6 on `src/` | No actionable medium or high finding |
| Web app | Every write flow clicked through with a local test account | 4 bugs fixed |

Each reviewer worked independently from the code, proved its High findings with
tests, and reported what it had not verified. No Critical finding was reported
in any pass.

Test suite at the time of writing: 152 tests (unit, fuzz, stateful invariant and
end-to-end), with 94% line coverage of `src/`.

## High findings, all fixed

| Finding | Fix | Regression test |
|---|---|---|
| A raffle could be steered by adding points after seeing the random word | Point weights are frozen from the draw request until the result | `test_raffleWeightsAreFrozenDuringDraw` |
| Vault NFTs could be bought for 1 wei by pushing the sales oracle down | Auction reserve of 130% of the purchase price | `test_auction_reserveIgnoresOracleBelowUnlockPrice` |
| Ticket money could be locked for ever when an NFT transfer failed | Refunds no longer depend on the transfer; stuck raffles can be aborted | `test_abort_whenAWonRaffleIsNeverSettled` |
| With a floor well above the reserve, a vault auction could still be bought far below market | Auctions open at 16 times the reserve and halve daily | `test_auctionCannotBeSnipedBelowMarketByPushingTheOracleDown` |

## Medium findings

Fixed:

- Prediction markets could be bet on with a price already known.
- Points could be farmed on a throwaway collection.
- Late randomness could be traded off against a refund or a reset, in Games and
  in both raffles.
- A games bet could be overwritten by a reused randomness request id.
- Any contract could be raffled, so a fake NFT could take buyers' money.
- A raffle with enough tickets but no randomness had no refund path.
- A randomness request could be triggered for one wei.
- A revoked licence could be bought again.
- A holding on auction could not be taken off auction.

Accepted and documented in [SECURITY.md](../SECURITY.md), not fixed:

- A raffle is only safe while the prize is worth less than the fees behind all
  outstanding points.
- A ticket raffle's creator can dilute buyers by buying unsold tickets late.
- A supported collection with open supply can have its budget taken by a minter.
  A buyback cooldown limits the speed, not the outcome.
- A prediction market settles on the price at the moment `resolve` is called, so
  it needs a keeper.
- The sales oracle can be moved with four wash trades.

## What the owner can and cannot take

The owner is fully trusted. A malicious or compromised owner can take:

| Contract | Through | What |
|---|---|---|
| Treasury | `setSpender` | Every collection budget and the unallocated pool |
| BuybackEngine | `configureBid` | A collection's budget, by setting a huge bid and selling a junk token |
| Vault | `startAuctionWithPrices`, `setRaffle` | Every NFT in the Vault |
| VaultRaffle, Games, TicketRaffle | `setRandomness` | Undrawn prizes and bet outcomes, by choosing the random word |
| Points | `setRate`, `setRaffle` | Unlimited points for itself |
| PredictionMarket | `setOracle` | Losing stakes, by dictating the price |

The owner cannot reach:

- ETH escrowed in open Marketplace offers;
- project shares that have already accrued;
- raffle prizes that already have a winner;
- stakes in a void prediction market;
- games funds reserved for open bets, other than through the randomness provider.

This is why the owner must be a multisig behind a timelock before real use, and
why the deploying key must hand over ownership before anything is funded.

## Invariants that are tested

Stateful invariant tests drive the contracts with random sequences of actions
and check after every step that:

- the Marketplace holds exactly the escrow of its open offers;
- the Treasury's balance equals budgets plus unallocated plus owed project shares;
- the BuybackEngine, Vault and VaultRaffle never hold ETH;
- every holding not yet released is owned by the Vault, and every released one is not;
- every auction started through `startAuction` has a reserve of at least 130% of
  the purchase price, and a buyer is charged exactly the auction price;
- every unclaimed raffle prize is in the raffle contract;
- the points freeze counter equals the number of draws in flight;
- a randomness request that is not current always reverts;
- the points tree total equals the sum of balances;
- the PredictionMarket covers every open claim;
- the Games contract holds exactly its bankroll, its reserved funds, open wagers
  and owed winnings.

## Not verified by anyone

- Behaviour against a live Chainlink VRF coordinator.
- Any deployment on a public network.
- A real browser wallet in the web app.
- NFT contracts with transfer hooks, blocklists or other non-standard behaviour.
- The web app's own security (it has been tested for function, not reviewed for
  attacks).
- The fixes made after the full-system audit have regression tests but have not
  been through another independent pass.
