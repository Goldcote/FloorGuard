# Security

**This code is unaudited and experimental. Do not deploy it with real funds.**

FloorGuard has had no professional audit, no formal verification and no testnet
soak. The test suite covers the behaviour described in `docs/ARCHITECTURE.md`,
which is not the same as being safe. One automated review pass has been run and
its findings fixed (`test/Regressions.t.sol`); that is not an audit.

## Known limitations

- **Owner trust.** Every contract has an owner that can change fees, oracles and
  the Treasury spender. A malicious or compromised owner can drain the Treasury.
  The owner must be a timelocked multisig before any real deployment.
- **Oracle manipulation.** `SalesFloorOracle` can be moved by four wash trades in
  a single transaction, whatever the organic volume. Pushing it down is free,
  because the fee on a 1 wei sale rounds to zero; pushing it up costs the fee on
  each inflated sale. The Vault defends against a low reading with an auction
  reserve, but anything else that settles on this oracle is exposed. Do not point
  the PredictionMarket at it. `PushFloorOracle` trusts its reporters completely.
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
- **Games.** Operating games of chance is regulated or prohibited in many
  jurisdictions; deploying `Games` is the operator's legal responsibility. The
  bankroll carries variance: a run of player wins can shrink it. The fairness of
  every bet rests on the randomness provider.
- **Non-standard NFTs.** Collections with transfer hooks, blocklists or
  non-standard ERC-721 behaviour have not been considered.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a
vulnerability").
