# Security

**This code is unaudited and experimental. Do not deploy it with real funds.**

FloorGuard has had no professional audit, no formal verification and no testnet
soak. The test suite covers the behaviour described in `docs/ARCHITECTURE.md`,
which is not the same as being safe.

## Known limitations

- **Owner trust.** Every contract has an owner that can change fees, oracles and
  the Treasury spender. A malicious or compromised owner can drain the Treasury.
  The owner must be a timelocked multisig before any real deployment.
- **Oracle manipulation.** `SalesFloorOracle` can be moved with a handful of wash
  trades when volume is thin. `PushFloorOracle` trusts its reporters completely.
  Prediction markets and vault unlocks settle on these prices.
- **Buyback overpayment.** The rising bid is capped only by the owner-set
  `maxPrice`. If a collection's budget is empty for a long time and is then
  refilled, the first seller may be paid more than the market floor.
- **Non-standard NFTs.** Collections with transfer hooks, blocklists or
  non-standard ERC-721 behaviour have not been considered.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a
vulnerability").
