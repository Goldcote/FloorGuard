# Security

**This code is unaudited and experimental. Do not deploy it with real funds.**

FloorGuard has had no professional audit, no formal verification and no testnet
soak. The test suite covers the behaviour described in `docs/ARCHITECTURE.md`,
which is not the same as being safe. Four automated review passes have been run
and their findings fixed; [docs/AUDIT.md](docs/AUDIT.md) records them. That is
not a professional audit.

## Known limitations

- **Owner trust.** Every contract has an owner that can change fees, oracles and
  the Treasury spender. A malicious or compromised owner can drain the Treasury.
  The owner must be a timelocked multisig before any real deployment.
- **Oracle manipulation.** `SalesFloorOracle` can be moved by four wash trades in
  a single transaction, whatever the organic volume. Pushing it down is free,
  because the fee on a 1 wei sale rounds to zero; pushing it up costs the fee on
  each inflated sale. Vault auctions do not rely on it for their sale price, but
  anything else that settles on this oracle is exposed. Do not point the
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
- **Buyback overpayment.** The rising bid is capped only by the owner-set
  `maxPrice`. If a collection's budget is empty for a long time and is then
  refilled, sellers may be paid more than the market floor. The bid only steps
  down by `stepDownBps` per fill, so several sellers in a row can benefit until
  the bid falls back to the floor or the budget runs out.
- **Raffle farming.** Points cost fees, so a raffle is safe only while the prize
  is worth less than the fees behind all outstanding points. If the Treasury is
  funded from outside (donations, owner allocations) rather than from fees, a
  self-dealer can buy a large share of the points just before a draw for less
  than the prize is worth. Points are not time-weighted.
- **Late information in prediction markets.** Betting closes at most halfway
  through a market and settlement needs a price published after the settlement
  time, but later bettors still see more recent prices than earlier ones.
- **Games and paid raffles.** Operating games of chance and paid raffles is
  regulated or prohibited in many jurisdictions; deploying `Games` or
  `TicketRaffle` is the operator's legal responsibility. The
  bankroll carries variance: a run of player wins can shrink it. The fairness of
  every bet rests on the randomness provider.
- **Shared randomness subscription.** The deploy script puts the raffle and the
  games on one Chainlink VRF subscription. Many minimum-size bets can drain it
  and stall raffle draws. Use separate subscriptions and a `minBet` that covers
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
- **Non-standard NFTs.** Collections with transfer hooks, blocklists or
  non-standard ERC-721 behaviour have not been considered.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a
vulnerability").
