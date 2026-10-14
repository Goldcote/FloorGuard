// The gas limit the app asks for. A node estimates gas for the state at the moment of asking, but
// several of the protocol's paths cost more a block later: a storage slot that held this second's
// timestamp is rewritten (the bid curve's restart in `BuybackEngine.sell` and `onBudgetIncrease`,
// which any fee-paying transaction can reach through the Treasury), or a refund is sent because an
// auction price fell (`Vault.buy`). With the bare estimate such a transaction runs out of gas and
// reverts whenever a second boundary falls between the estimate and its block. Unused gas is not
// charged, so a margin costs nothing.

/** Extra gas for the Treasury's capped notice to the buyback engine (60,000) and a refund transfer. */
const GAS_HEADROOM = 80_000n;

/** The limit to send for a transaction whose estimate is `estimate`: a quarter more, plus headroom. */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 5n) / 4n + GAS_HEADROOM;
}
