# Security

**This code is unaudited and experimental. Do not deploy it with real funds.**

FloorGuard has had no professional audit, no formal verification and no testnet
soak. The test suite covers the behaviour described in `docs/ARCHITECTURE.md`,
which is not the same as being safe. Six automated code review passes and one
economics review have been run and their findings acted on;
[docs/AUDIT.md](docs/AUDIT.md) and
[docs/ECONOMICS-REVIEW.md](docs/ECONOMICS-REVIEW.md) record them. That is not a
professional audit.

## Known limitations

- **Owner trust.** Every contract has an owner that can change fees, oracles and
  the Treasury spender. A malicious or compromised owner can drain the Treasury.
  The owner must be a timelocked multisig before any real deployment.
- **Oracle manipulation.** `SalesFloorOracle` can be moved by four wash trades in
  a single transaction, whatever the organic volume. Pushing it down is free,
  because the fee on a 1 wei sale rounds to zero; pushing it up costs the fee on
  each inflated sale. Vault auctions use it for their reserve and opening price:
  a low reading cannot open an auction below 16 times the unlock price, but a
  high reading can hold an auction above the market until it is restarted.
  Anything else that settles on this oracle is exposed. Do not point the
  PredictionMarket at it. `PushFloorOracle` trusts its reporters completely.
- **Vault unlock timing.** Because the oracle can be pushed down for free, anyone
  can keep a holding from unlocking on its own; the owner can still unlock it.
  Pushing the oracle up to force an early unlock costs fees and only works after
  the 180-day lock.
- **Collections with open supply.** If tokens of a supported collection can still
  be minted, whoever can mint below the bid can sell fresh tokens into it and
  take the collection's whole budget. Support only fully minted collections
  whose owner cannot mint more, and set a buyback cooldown.
- **Prediction settlement needs a keeper.** A market settles on the oracle price
  at the moment `resolve` is called, provided it was published after the
  settlement time. If nobody resolves promptly, whoever benefits can wait for a
  price they like. Someone has to call `resolve` as soon as the first price after
  settlement is published.
- **Points need activating.** Pending points do not count in a raffle. Someone
  has to call `flushMany` for holders before each draw, or holders must activate
  their own.
- **Buyback overpayment.** The bid is limited by the collection's budget and
  only rises while the budget covers it, which removes the drift to `maxPrice`
  that an economics review found in the first design. What remains: the owner's
  `maxPrice` is the only upper limit, a holder who dominates a collection's
  supply can wait for the bid to reach it, and these rules are new and have not
  been independently reviewed. Keep `maxPrice` close to the market.
- **Raffle farming.** Points cost fees (one point per unit of fee, and a farmer
  who also sells into the bid gets part of the fee back), only activated points
  count, and whoever calls `draw` closes activation for everyone else. A raffle
  is safe only while the prize is worth much less than the fees behind the
  activated points: as a rule of thumb, at most a quarter. Set
  `minPointsToDraw` accordingly, run `flushMany` for holders before each draw,
  and prefer an auction, which always returns more to the budget. Points are
  not time-weighted and are shared across collections.
- **Late information in prediction markets.** Betting closes at most halfway
  through a market and settlement needs a price published after the settlement
  time, but later bettors still see more recent prices than earlier ones.
- **Games and paid raffles.** Operating games of chance and paid raffles is
  regulated or prohibited in many jurisdictions; deploying `Games`, `Lottery`
  or `TicketRaffle` is the operator's legal responsibility. The same question
  applies to `VaultRaffle`, where the chance of a prize is earned by paying
  fees, and to `PredictionMarket`, which takes bets on a price reported by a
  party the operator appoints. The
  bankroll carries variance: a run of player wins can shrink it. By default it
  earns nothing for that risk, whoever funds it cannot take it back, and its
  typical path is downward. On Ethereum mainnet a randomness request can cost
  many times the fee on a small wager: set `minBet` so the fee covers it. The fairness of
  every bet rests on the randomness provider.
- **Shared randomness subscription.** The deploy script puts all four randomness
  consumers (vault raffle, games, ticket raffle and lottery) on one Chainlink
  VRF subscription. Many minimum-size bets can drain it and stall every draw
  until it is refilled. Use separate subscriptions and a `minBet` that covers
  the cost of a request.
- **No slippage guard on bets.** The owner can change the games edge (up to 10%)
  between a player signing a bet and it being mined.
- **Ticket raffle dilution.** A raffle's creator can buy most of the unsold
  tickets just before the end. Their own ticket money comes back to them less
  the fee, so this cheaply cuts other buyers' odds. Judge odds against the
  maximum number of tickets, not the number sold so far.
- **Deployer power until handover.** The deploying key owns every contract until
  the final owner accepts ownership, which with a timelock takes at least the
  timelock delay. Complete the handover before funding anything.
- **IP licences are records, not rights.** `IPLicenseManager` records payments.
  Whether the Vault can sublicense a collection's artwork depends on that
  collection's terms.
- **Owner changes that reach open positions.** A licence tier's duration can be
  changed between a buyer signing and the purchase being mined; only the price
  is checked. Fees and minimum pots are fixed per market, raffle and round when
  they are created.
- **Stranded ETH.** Rounding dust in the PredictionMarket is never swept. Games,
  ticket raffle and lottery payouts go only to the account that earned them, so
  a contract that cannot receive ETH cannot collect.
- **Non-standard NFTs.** Collections with transfer hooks, blocklists or
  non-standard ERC-721 behaviour have not been considered.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a
vulnerability").
