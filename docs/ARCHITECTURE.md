# Architecture

This document describes what the contracts in `src/` do today. The original
concept documents are kept for history in
[WHITEPAPER-v0.1.md](WHITEPAPER-v0.1.md); where the two differ, this file and the
code are right. The differences are listed at the end.

## Contracts

| Contract | Role |
|---|---|
| `Marketplace` | Escrowed ETH offers on one token or on any token of a collection. A holder accepts to swap. 2% fee to the Treasury, ERC-2981 royalties honoured up to a cap. |
| `Treasury` | Holds fees as a separate buyback budget per collection, after an optional share for the NFT project. Only the BuybackEngine can spend. |
| `BuybackEngine` | Quotes a standing bid per collection that rises until a holder sells into it. Pays from the collection's budget and sends the NFT to the Vault. |
| `Vault` | Locks bought NFTs. Unlock needs 180 days and a floor at 130% of the purchase price. Then raffle, relock or Dutch auction. |
| `PredictionMarket` | Pooled higher/lower bets on a collection's floor. 3% fee on winnings to the Treasury. |
| `Games` | Dice, coinflip and slots against a house bankroll. Half of the edge on each wager goes to the Treasury; the bankroll keeps the other half. |
| `Lottery` | A pooled ETH lottery per collection. 5% of each pot goes to the Treasury. |
| `TicketRaffle` | Anyone raffles an NFT for paid tickets. 5% of ticket revenue goes to the Treasury. |
| `IPLicenseManager` | Sells time-limited licences for NFTs held in the Vault. Licence fees go to the Treasury. |
| `Points` | Non-transferable points earned per ETH of fees generated. Raffle weights. |
| `VaultRaffle` | Raffles vault NFTs to points holders using a randomness provider. |
| `SalesFloorOracle` | Floor from the protocol's own floor-type sales (lower median of the last 7). |
| `PushFloorOracle` | Floor pushed by trusted reporters from off-chain data. |
| `ChainlinkVRFRandomness` | Adapter from the randomness interface to Chainlink VRF v2.5. |

```mermaid
flowchart TD
    M[Marketplace<br/>2% fee] -->|fee, per collection| T[Treasury<br/>budget per collection]
    P[PredictionMarket<br/>3% of winnings] -->|fee, per collection| T
    T -->|pays the seller| B[BuybackEngine<br/>rising floor bid]
    H([Holder]) -->|sells any token| B
    B -->|NFT| V[Vault<br/>180 days and floor at 130%]
    V -->|Dutch auction proceeds| T
    V -->|prize| R[VaultRaffle]
    M -.->|points for fees| PT[Points]
    P -.->|points for fees| PT
    PT -.->|weights| R
    R -->|NFT| W([Winner])
    M -.->|collection-offer fills| O[SalesFloorOracle]
    B -.->|buyback fills| O
    O -.->|floor| V
```

## Marketplace

There are no listings. A buyer escrows ETH in an offer, either for one token
(`makeOffer`) or for any `quantity` tokens of a collection
(`makeCollectionOffer`). A holder calls `acceptOffer(offerId, tokenId,
minProceeds)` and the swap is atomic. The offerer can cancel the unfilled part at
any time.

On each sale the price is split three ways:

- **Fee** (`feeBps`, default 2%, hard cap 5%) goes to the Treasury as budget for
  that collection.
- **Royalty** is read from ERC-2981 and truncated at `royaltyCapBps` (default 5%,
  hard cap 10%). If the receiver cannot take ETH, the royalty is added to the
  protocol fee instead and treated like it.
- **The rest** goes to the seller. `minProceeds` protects the seller from a fee
  or royalty change between signing and inclusion.

Any ERC-721 contract can be traded, but only collections the owner marks as
supported take part in the flywheel. For an unsupported contract the fee goes to
the Treasury's unallocated pool, no points are earned and no sale is recorded in
the oracle. This stops someone deploying a throwaway collection to farm points.

## Treasury and budgets

Fees are not pooled. `deposit(collection)` credits that collection's budget, so
the fees from trading a collection are spent on buying that collection's tokens
and one collection cannot spend another's fees. ETH sent without a collection sits in
`unallocated` until the owner assigns it with `allocate`.

### Where the money sits

| Pot | Filled by | Leaves to | Who decides |
|---|---|---|---|
| Collection budget (`budgetOf`) | Fees on that collection, vault auction proceeds, donations | Holders who sell into the floor bid | Nobody per payment; the owner sets the bid curve |
| Project share (`owedTo`) | The owner-set share of a collection's fees, at most 50% | The project's recipient address, when it claims | The owner sets recipient and share |
| Unallocated | Plain ETH transfers, fees from unsupported collections | A collection budget | The owner, with `allocate` |
| Games bankroll | Depositors, who receive shares; losing stakes; half of each edge | Winning players, and share holders who redeem | Share holders. The owner cannot withdraw it |
| Marketplace escrow | Open offers | The seller on acceptance, or back to the offerer | The offerer and the seller |
| Prediction pools | Bets | Winners, or refunds when void | The oracle price |
| Ticket raffle revenue | Ticket sales | The raffle's creator, 5% to the Treasury, or refunds | The raffle outcome |
| Lottery pots | Ticket sales | The round's winner, 5% to the Treasury, or refunds | The draw |

There is no team wallet, staking pool or token. Vault auction proceeds are
recycled capital and are not split with the project.

### Who controls it

Every contract has one `owner`, set at deployment. The owner cannot withdraw from
the Treasury, but it chooses the spender, the oracles and the randomness
providers, so it has to be fully trusted. Each NFT project can also deploy its
own instance of the protocol and be its own owner.

What the owner is, is the deployer's choice, and the contracts do not care:

- a single wallet, which is fine for a testnet and nothing else;
- a multisig, by setting `OWNER`;
- a multisig behind a timelock, by also setting `TIMELOCK_DELAY`. The deploy
  script then creates an OpenZeppelin `TimelockController` that owns every
  contract, with `OWNER` as its only proposer and executor, so each owner action
  is public for the delay before it can run.

Ownership transfers are two-step. `script/AcceptOwnership.s.sol` completes the
handover in either setup.

Adding a collection is an owner action: mark it supported on the Marketplace,
set its bid curve on the BuybackEngine, and optionally set a project share, a
minimum auction reserve, and enable predictions, games, ticket raffles and a
lottery. `script/AddCollection.s.sol` does all of that in one run; licence tiers
are set separately. The script has to be broadcast by the owner, so run it
before handing ownership to a multisig or timelock, or have that owner submit
the same calls. After that, no bot is needed to execute buybacks: holders sell into the bid
themselves. The owner still has to keep each collection's maximum price in line
with the market.

## BuybackEngine: the rising bid

The engine needs to buy at the lowest price a holder will accept without being
told what that price is. For each collection the owner configures a curve:

```
curve(t) = min(maxPrice, basePrice * (1 + growthBpsPerDay * elapsed / 1 day))
bid(t)   = min(curve(t), the collection's budget)
```

Any holder can call `sell(collection, tokenId, minPrice)` and is paid the current
bid from the collection's budget. After a sale the curve restarts one step
(`stepDownBps`) below the sale price.

Four rules keep the bid from running ahead of the market:

- **The bid is never more than the budget can pay.** With a thin budget the bid
  is the budget itself, rising as fees arrive, and a sale happens when it
  reaches the cheapest seller's price.
- **Late money does not inherit a rise nobody could have been paid.** The curve
  keeps drifting up while the budget cannot cover it, but whenever a budget
  grows the Treasury tells the engine, and if the budget could not cover the
  curve until then, the curve restarts from the higher of its base and the old
  budget. A deposit therefore never lowers the bid, and money arriving late or
  in a lump starts from where the bid really was.
- **The base follows a falling market.** A sale limited by a thin budget may be
  far below the base. It pulls the base down by up to three steps before the
  usual one, so a few such sales bring the base to the market without one cheap
  sale collapsing the curve.
- **No bid below a minimum.** `minBidOf` (a tenth of the base unless the owner
  sets it) stops a nearly empty budget from buying a token for dust from a
  seller who named no minimum price.

The cooldown, if set, must be short: after a sale the curve needs
`stepDown / ((1 − stepDown) × growth)` days to regrow to its last price (12.6
hours at 5% and 10% a day, 42 hours at the onboarding script's 15%).
`setFillCooldown` rejects anything longer.

What these rules do not cover: if the market falls sharply while almost no
fees arrive, the base stays above the market, and a lump arriving then is spent
from that stale base. In a review's model, a floor that halved with no inflow
followed by a lump was overpaid by 15% at a 15% step. The owner or guardian
should lower the bid before a lump arrives in a fallen market.

Holders compete to be the first to accept once the bid reaches the lowest price
any of them will take. No oracle is involved. The owner's `maxPrice` is the
upper limit on what the engine pays. A `guardian` address, if set, can lower a
collection's base and maximum price or pause it. Each call also restarts the
curve, so a guardian can hold a bid down but never raise it: a fast key for a
falling market while the owner sits behind a timelock.

Buying the cheapest listing on another venue and selling it into the bid pays
only when the bid exceeds that listing by the buyer's costs, roughly 1 to 6%
plus gas. A bid that has settled at the lowest price holders accept is below
that, so it takes tokens off the market without lifting listings elsewhere.

These rules were added after an economics review found that the earlier design
drifted to `maxPrice` whenever fees arrived slowly; see
[ECONOMICS-REVIEW.md](ECONOMICS-REVIEW.md). A follow-up review simulated them:
with sellers who accept at the floor, the engine paid 1.00 times the floor in
every steady, rising and falling scenario. A single holder who dominates a
collection's supply can still wait for a higher bid (1.17 to 1.34 times the
floor in the model, with the cap at 1.5).

The bid only finds the true floor for a collection with a fixed supply. If
tokens can still be minted, the cheapest seller is the minter and the bid finds
the mint price instead. Only fully minted collections whose owner cannot mint
more should be supported.

## Vault

Each buyback creates a holding with its purchase price and time.

- `unlock` is permissionless and succeeds when the lock time has passed **and**
  the oracle floor is fresh and at least 130% of the purchase price.
- The owner can `governanceUnlock` early, or `relock` to extend.
- While a holding is unlocked, the owner can `sendToRaffle`, `relock` or
  `startAuction`. If it is still unlocked 30 days after it unlocked (or after an
  auction on it was cancelled), anyone can start the auction.
- The reserve of an oracle-priced auction is the highest of the oracle floor, the
  unlock price (130% of the purchase price) and an owner-set minimum for the
  collection (`minReserveOf`).
- The auction opens at 16 times its reserve, or 16 times the floor recorded when
  the holding unlocked if that is higher. The price halves every day and holds
  at the reserve. The opening price is deliberately far above the market, so the
  sale price is found by buyers competing on the way down. With a single
  interested buyer the sale price is the reserve. This matters because
  the sales oracle can be pushed down for free: a low reading lowers the reserve
  towards the unlock price but cannot make the auction open below market, unless
  the market is more than 16 times that opening basis. Whoever calls `unlock`
  can influence the oracle at that moment, so the recorded floor is a help, not
  a guarantee: the owner-set `minReserveOf` is the protection to rely on.
- An oracle-priced auction that has rested at its reserve for a day without a
  buyer can be restarted by anyone, at fresh oracle prices. Proceeds go to the
  collection's budget.
- `startAuctionWithPrices` lets the owner choose the prices, for example to exit
  a collection that has collapsed or whose oracle is dead. Only the owner can
  restart or replace such an auction. `cancelAuction` takes a holding off
  auction and starts the 30-day window again.

## PredictionMarket

Anyone can open a market on a supported collection. The floor is snapshotted at
creation, betting is open for `bettingPeriod` (at most a tenth of `duration`), and
the market settles on a floor price published at or after `duration`. A price
from before the settlement time is never accepted, so nobody can bet on the
price the market will settle on. A market can only be created on a price at
most an hour old. Later bettors still know more than earlier ones, which is why
the betting period is kept short.

- Winners split the losing pool in proportion to their stake. The fee is taken
  from their winnings, not their stake.
- A market is void, with full refunds, if one side has no bets, the price moved
  by less than the dead band (2% of the start price by default), or the oracle
  has no fresh price for three days after settlement.
- A market settles on the oracle price at the moment `resolve` is called, so
  someone has to call it promptly; see [SECURITY.md](../SECURITY.md).

## Games

`Games` has two games on one bankroll. In dice the player picks a chance of
winning from 1% to 95%, and a coinflip is a 50% roll. Slots pay a fixed table
from one roll: 50x at 0.2%, 10x at 1%, 5x at 4%, 2x at 15% and 1x at 30%, which
averages exactly 1x the stake. The edge (default 2%) is taken from the wager. Half of it is paid to the
Treasury as a fee for the collection the player chose to back, and half stays in
the bankroll. The
rest is played at fair odds against the house bankroll, so the stake itself gives the bankroll no expected gain or loss. The bankroll
keeps a share of the edge (`bankrollShareBps`, half by default) to pay for the
risk it carries; the other half goes to the Treasury as buyback budget. With
the share set to zero the whole edge funds buybacks, but the bankroll then
earns nothing, and its typical path is downward even though its average is
flat.

### The house

Anyone can fund the bankroll and receives shares in it; the holders of shares
are the house. Shares gain value from the bankroll's half of the edge and from
players' losses, and lose value when players win. The owner has no way to
withdraw the bankroll.

Deposits and redemptions are requests:

- `deposit` and `redeem` record the request. If no bet is open, it is carried
  out at once. Otherwise it can be carried out, with `executeDeposit` or
  `executeRedeem`, once every bet that was open when it was made has been
  settled or refunded.
- A request is priced when it is carried out, at the house's funds (free and set
  aside) per share at that moment.
- A pending deposit is held apart from the bankroll and can be cancelled. Shares
  with a pending redemption stay at risk until it is carried out.
- A redemption is paid from the free bankroll. If funds set aside for open bets
  leave too little, it redeems what it can and the rest stays pending. Open bets
  can lock up at most a fifth of the house's funds when they are placed.

The waiting rule is what keeps this fair. Whoever asks cannot know the result of
any bet their price depends on, because those bets have to finish first. And
bets opened afterwards do not enter the price in a way someone else can use:
piling up wagers or locking up the reserve in front of another person's request
changes nothing for them. An earlier design priced deposits and redemptions
immediately at conservative values; a review showed that an existing holder
could manufacture a bad price for someone else that way.

What remains: whoever carries out a request chooses the moment, and a bet opened
after the request may have a result they can see coming. That is worth at most
one bet's exposure, 1% of the bankroll, times their share. If randomness stops
arriving, a request waits until the open bets are refunded, which anyone can do
a day after each bet.

The house's side of each bet is set aside when the bet is placed, so every
outcome can always be paid. One wager can be at most 1% of the free bankroll, one bet can risk at most 1% of
it, and
all open bets together at most 20% of the house's funds. Both limits are checked
when a bet is placed; a later win or redemption can leave open bets
above 20% of what remains, but their payouts stay fully set aside. A bet whose randomness
has not arrived within a day is refunded, and randomness that arrives later than
that is ignored, so nobody can choose between a late result and a refund.

Each bet costs the operator one randomness request, which on Ethereum mainnet is
likely to exceed the fee on a small wager. Set `minBet` accordingly.

## Lottery

`Lottery` runs rounds per collection. The owner sets a ticket price and a round
length for a collection; the first ticket bought opens a round, and the first
ticket bought after a round has ended opens the next. When a round ends, anyone
can `draw` it: one random ticket wins the pot, 5% of which goes to the
collection's buyback budget. A round whose pot is below `minPot` is refunded
instead of drawn, and a round still undrawn a week after its end can be aborted
into refunds by anyone, though never while an answer to a pending draw would
still be accepted. From that time on, `draw` itself opens refunds instead of
requesting randomness again. Ticket price, fee and minimum pot are fixed for a round when
it opens.

## Ticket raffles

`TicketRaffle` lets anyone raffle an NFT they own, from a collection the owner
has approved. The creator sets a ticket price, a minimum and maximum number of
tickets and a duration, and the NFT is held in escrow. When the raffle ends,
anyone can `close` it:

- if the minimum was reached and the ticket revenue is at least `minPot`, a
  random ticket wins the NFT, the creator receives the ticket revenue and 5%
  goes to the Treasury as a fee for the collection (so the project share, if
  any, is taken from it first);
- if not, every buyer can take a refund and the creator can reclaim the NFT.

The creator can cancel only while no ticket has been sold, and the fee is fixed
when the raffle is created. Late randomness is ignored, as in the other modules.

Buyers can always reach either a draw or a refund. If a raffle cannot finish,
because its randomness never arrives or the NFT cannot be transferred, anyone
can `abort` it into refunds a week after it ended (its scheduled end, or the
moment it was closed if it sold out earlier), or a week after its draw was
requested if a winner was drawn but nobody could settle. A raffle cannot be
aborted while an answer to its pending draw would still be accepted, and once
the abort time has passed `close` opens refunds instead of requesting a draw.

## IP licensing

`IPLicenseManager` sells time-limited licences for the artwork of NFTs held in
the Vault. The owner defines numbered tiers per collection, each with a price
and a duration. The licence fee goes to the Treasury as a fee for that
collection, so the project share, if any, is taken from it first. Only locked
holdings can be licensed, and licences are tracked per tier: holding one tier
never hides or shortens another.

A licence is in force until its term ends or it is revoked, while the Vault
holds the NFT outside an auction. It is suspended while the NFT is on auction,
in force again if the auction is cancelled, and over for good once the NFT is
sold or raffled, which can happen before the term is up. Revoking any licence
bans that licensee from the holding: none of their licences for it is valid and
they cannot buy another until the owner lifts the ban.

The contract records who paid for which licence and nothing more. Whether the
Vault may sublicense a collection's artwork depends on that collection's own
terms, and the licence text has to exist off-chain.

## Points and raffles

Points are credited per ETH of **fees that reach the buyback budget**, not per
ETH of volume, at a rate set per module. A project's share of a fee earns no
points. Three modules credit points: the Marketplace, the PredictionMarket and
Games. Ticket raffle, lottery and licence fees fund buybacks but earn none. Each fee is credited once. On the Marketplace it is split equally between buyer
and seller, in Games the player is credited for the edge on each wager, and on
the PredictionMarket half goes to the winners who pay the fee and half to the
losers whose stakes funded it. Points follow fees, so farming them pays into
buyback budgets, but a farmer who also sells into the bid takes part of that
back.

Earning points is a single storage write to `pendingOf`, which keeps trades
cheap enough for Ethereum mainnet. Pending points do not count in raffles until
they are activated with `flush(user)`, which anyone can call for anyone. The
seven-day announce period before each draw is the time to do it. Activation
stops for everyone the moment anyone calls `draw`, which can be the first block
after the announce period, so someone should run `flushMany` for holders before
then. The owner can require a minimum of activated points before any draw
(`minPointsToDraw`); a raffle is only a fair distribution when the fees behind
the activated points are large against the prize.

Activated balances are the leaves of a 16-ary sum tree, six levels deep (about
16.7 million holders). Activating writes seven slots. Picking the holder of a
random point reads at most 96 slots and never loops over users.

`VaultRaffle.draw` requests randomness once the seven-day announce period has
passed, and freezes point weights until the randomness arrives. Only one draw
can be in flight at a time, and after any draw ends there is an hour before the
next can be requested, so points can be activated in between. Points cannot be
activated in that window, so they count from the next raffle. Without the
freeze, anyone who saw the random word before it landed could add just enough
points to steer the result. The winner keeps 20% of their points. Randomness
that arrives more than a day late resets the draw instead of picking a winner,
a request abandoned through `resetDraw` is never accepted later, and a reset
draw cannot be requested again for an hour.

## Oracles

Both implement `IFloorOracle.floorPrice(collection) -> (price, updatedAt)` and
revert when they have no price. Consumers apply their own staleness limit.

- `SalesFloorOracle` records only floor-type sales: collection-offer fills and
  buyback fills. In both, the seller chooses which token to give up, so the price
  reflects the cheapest token. Sales of specific tokens are ignored because they
  may be rares.
- `PushFloorOracle` stores what its reporters push.

Deployed defaults: the Vault reads the sales oracle and the PredictionMarket
reads the push oracle.

## Differences from the v0.1 whitepaper

| Whitepaper | Code | Why |
|---|---|---|
| Engine "accepts an offer" to buy | Engine quotes a rising bid that holders sell into | The marketplace has bids only, so there was nothing for the engine to buy from |
| Treasury triggers a buyback inside `receive()` | Buybacks happen when a holder calls `sell` | Every fee payment would have carried the gas and reentrancy risk of a purchase |
| One shared treasury | A budget per collection | Fees from a collection defend that collection |
| Chainlink NFT floor feeds, Reservoir | Pluggable oracle with two implementations | Avoids depending on one external feed |
| Points per ETH of volume | Points per ETH of fees | Volume can be wash traded for free in some modules; fees cannot |
| Snapshot of points at raffle time | Weights frozen from the draw request until randomness arrives | Same effect as a snapshot without copying every balance |
| Royalties not mentioned | ERC-2981 honoured, capped | The 2024 paper's starting point was zero-royalty venues |

## Chains

The contracts are plain Solidity 0.8.28 compiled for the Cancun EVM, pay in
native ETH and trade standard ERC-721 tokens. They deploy unchanged to Ethereum
mainnet and to EVM rollups such as Base, Arbitrum and Optimism. The largest
contract is under 10 KB, well under the 24 KB limit.

## Not built yet

- Revenue-share and exclusive licences
- A governance token; the owner is a single address, meant to be a multisig
- Burning vault NFTs
- Streak, referral and daily bonuses for points
- A share of prediction fees for the NFT project
- AI or bot strategies and pooled strategies from the 2024 paper
- The desktop (Tauri) shell around the web app
