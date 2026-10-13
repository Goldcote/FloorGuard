import { useProtocol, useRead } from "../hooks";
import { bps, duration, eth } from "../lib/format";
import { readFairnessStatus, SLOTS_PAY_TABLE } from "../lib/reads";
import { Addr, Badge, Card, Notice, QueryView, Stat } from "../ui";

export function Fairness() {
  const { demo } = useProtocol();
  const status = useRead(["fairness"], readFairnessStatus);
  return (
    <>
      <Card title="How outcomes are decided">
        <p className="muted">
          Every game takes one random number and applies a rule that is fixed in the contract. Nothing about a result
          is decided by this website.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Game</th>
                <th>Rule</th>
                <th>House take</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Dice and coinflip</td>
                <td className="wrap">roll = random mod 10000; the bet wins if the roll is below your chance</td>
                <td className="wrap">The edge on the wager</td>
              </tr>
              <tr>
                <td>Slots</td>
                <td className="wrap">The same roll, looked up in a fixed table ({SLOTS_PAY_TABLE.filter((t) => t.multiplier > 0).map((t) => `${t.multiplier}× at ${bps(t.chanceBps)}`).join(", ")})</td>
                <td className="wrap">The edge on the wager</td>
              </tr>
              <tr>
                <td>Lottery</td>
                <td className="wrap">The winning ticket is random mod tickets sold</td>
                <td className="wrap">A share of the pot</td>
              </tr>
              <tr>
                <td>Ticket raffle</td>
                <td className="wrap">The winning ticket is random mod tickets sold</td>
                <td className="wrap">A share of ticket revenue</td>
              </tr>
              <tr>
                <td>Vault raffle</td>
                <td className="wrap">The holder of point number random mod total points, with weights frozen when the draw is requested</td>
                <td className="wrap">None</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted">
          In dice and slots the stake that remains after the edge is played at exactly fair odds: a dice win pays
          stake ÷ chance, and the slots table averages exactly 1×. The edge is not kept by an operator; it goes to the
          Treasury as buyback budget. The edge of a bet is stored with the bet, and the fees and minimum pots of a
          lottery round, a raffle and a prediction market are fixed when they are created, so a later change by the
          owner cannot reach them.
        </p>
      </Card>

      <Card title="Where the randomness comes from">
        <p>
          The contracts are written to take each random number from Chainlink VRF v2.5. The oracle produces the number
          from a seed fixed at request time and delivers it with a cryptographic proof, which the VRF coordinator
          verifies on-chain before passing the number on. In that setup the operator, the player and the oracle cannot
          choose the number, and nobody can know it before it is delivered.
        </p>
        <p className="muted">
          An oracle can still withhold a number. The contracts handle that: a bet without an answer after a day is
          refunded, an unanswered draw can be reset and requested again, and an answer that arrives after its deadline
          is ignored, so withholding or delaying a result gives nobody a choice of outcome.
        </p>
      </Card>

      <Card title="This deployment, right now">
        <QueryView query={status} lines={6}>
          {(s) => (
            <>
              {demo ? (
                <Notice>Demo: this is a simulation in your browser. Its results come from a pseudo-random generator, not from a chain. Play money, not fair play.</Notice>
              ) : s.anyMock ? (
                <Notice>Local mock randomness: whoever settles picks the number. Not fair, for testing only.</Notice>
              ) : (
                <p className="muted">
                  No provider here is the local mock. That alone does not make the deployment fair: check the other
                  conditions below yourself.
                </p>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>Randomness provider</th>
                      <th>Kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.sources.map((source) => (
                      <tr key={source.module}>
                        <td>{source.module}</td>
                        <td><Addr address={source.provider} /></td>
                        <td>
                          {source.isMock ? <Badge tone="bad">Local mock: not fair</Badge> : <Badge tone="muted">Not the mock (verify it is the Chainlink adapter)</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="stats">
                <Stat
                  label="Owner of Games"
                  value={<Addr address={s.gamesOwner} />}
                  hint={
                    s.ownerIsContract
                      ? "A contract. It could be a timelock or multisig; this app cannot tell which. The owner can replace the randomness provider."
                      : "A plain account, not a timelock. The owner can replace the randomness provider at any moment."
                  }
                />
                <Stat label="Games edge" value={bps(s.games.edgeBps)} hint={`Minimum bet ${eth(s.games.minBet)} ETH; an unanswered bet is refundable after ${duration(s.games.refundTimeout)}`} />
                <Stat
                  label="Games limits"
                  value={`${bps(s.games.maxExposureBps)} per bet`}
                  hint={`Of the bankroll at risk on one bet; ${bps(s.games.maxTotalExposureBps)} of house funds across all open bets`}
                />
                <Stat label="Lottery fee" value={bps(s.lottery.feeBps)} hint={`For new rounds; minimum pot ${eth(s.lottery.minPot)} ETH`} />
                <Stat label="Ticket raffle fee" value={bps(s.ticketRaffle.feeBps)} hint={`For new raffles; minimum pot ${eth(s.ticketRaffle.minPot)} ETH`} />
              </div>
            </>
          )}
        </QueryView>
      </Card>

      <Card title="Checking a result yourself">
        <ol className="plain-list">
          <li>Every settled bet, spin, lottery round and ticket raffle in this app has a Verify button. It shows the roll or winning ticket and recomputes the payout in your browser, step by step, next to what the contract paid.</li>
          <li>For a bet: fee = wager × edge ÷ 10000, stake = wager − fee, and the payout is stake × 10000 ÷ chance for a dice win, or stake × the table's multiplier for slots. Both can also be called on the contract.</li>
          <li>For a draw: the contract emits the winning ticket, and <code>ownerOfTicket</code> returns who held it.</li>
          <li>The settlement transaction is where the random number arrived. With Chainlink VRF, the coordinator only delivers a number whose proof it has verified.</li>
        </ol>
      </Card>

      <Card title="When the claim holds, and its limits">
        <p>The fairness claim holds only for a deployment where all of the following are true. None of them is true yet: nothing has been deployed to a public network.</p>
        <ul className="plain-list">
          <li><strong>The randomness provider is the Chainlink adapter.</strong> The mock used on local chains lets whoever calls it pick the number.</li>
          <li><strong>The owner is behind a timelock.</strong> The owner can replace the randomness provider; with a timelock such a change is visible for the whole delay before it takes effect.</li>
          <li><strong>The source is verified on the block explorer</strong>, so the deployed bytecode can be matched to the repository.</li>
          <li><strong>The code has been professionally audited.</strong> Fair randomness does not protect against a bug elsewhere. It has not been.</li>
        </ul>
        <p className="muted">
          Limits: the Chainlink adapter has been tested against a simulated coordinator, not a live one. Fairness of
          the vault raffle also depends on points, which can be bought with fees. In a ticket raffle the creator can
          buy unsold tickets late and dilute other buyers; the draw itself is still uniform over tickets. The slot
          reels in this app are an illustration of the roll; the payout comes from the contract.
        </p>
      </Card>
    </>
  );
}
