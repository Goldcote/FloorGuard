// What "provably fair" means here, as a walkthrough you operate, and the live status of the
// conditions the claim depends on. The words follow docs/FAIRNESS.md.
import { useProtocol, useRead } from "../hooks";
import { bps, duration, eth } from "../lib/format";
import { readFairnessStatus, readGames, SLOTS_PAY_TABLE, type FairnessStatus } from "../lib/reads";
import { Addr, Badge, Notice, PageHead, Panel, QueryView } from "../ui";
import { FairnessWalk } from "../viz/FairnessWalk";

const RULES = [
  { game: "Dice and coinflip", rule: "roll = random mod 10000; the bet wins if the roll is below your chance", take: "The edge on the wager", ev: "−2% of the wager" },
  { game: "Slots", rule: `The same roll, looked up in a fixed table (${SLOTS_PAY_TABLE.filter((t) => t.multiplier > 0).map((t) => `${t.multiplier}× at ${bps(t.chanceBps)}`).join(", ")})`, take: "The edge on the wager", ev: "−2% of the wager" },
  { game: "Lottery", rule: "The winning ticket is random mod tickets sold", take: "5% of the pot", ev: "−5% of the ticket price" },
  { game: "Ticket raffle", rule: "The winning ticket is random mod tickets sold", take: "5% of ticket revenue", ev: "Depends on the prize against total ticket sales, which the creator sets; often well below −5%" },
  { game: "Vault raffle", rule: "The holder of point number random mod total points, with weights frozen when the draw is requested", take: "None", ev: "Not applicable: weights can be bought with fees" },
] as const;

type Verdict = "yes" | "no" | "unknown";
const VERDICT: Record<Verdict, { tone: "good" | "bad" | "warn"; text: string }> = { yes: { tone: "good", text: "Holds" }, no: { tone: "bad", text: "Does not hold" }, unknown: { tone: "warn", text: "Cannot be told from here" } };

function conditions(s: FairnessStatus, demo: boolean): { title: string; verdict: Verdict; text: string }[] {
  return [
    {
      title: "The randomness provider is the Chainlink adapter",
      verdict: demo || s.anyMock ? "no" : "unknown",
      text: demo
        ? "This is the demo: results come from a pseudo-random generator in your browser."
        : s.anyMock
          ? "At least one module uses the local mock, where whoever settles picks the number."
          : "No provider here is the local mock. That alone does not make it the Chainlink adapter: check each address yourself.",
    },
    {
      title: "The owner is behind a timelock",
      verdict: demo ? "no" : s.ownerIsContract ? "unknown" : "no",
      text: demo
        ? "The demo has no owner to trust or distrust; on a chain the owner can replace the randomness provider."
        : s.ownerIsContract
          ? "The owner of Games is a contract. It could be a timelock or a multisig; this app cannot tell which."
          : "The owner of Games is a plain account. It can replace the randomness provider at any moment.",
    },
    { title: "The source is verified on the block explorer", verdict: demo ? "no" : "unknown", text: demo ? "Nothing is deployed in the demo." : "This app cannot check that. Match the deployed bytecode to the repository on the explorer." },
    { title: "The code has been professionally audited", verdict: "no", text: "It has not been. Fair randomness does not protect against a bug elsewhere." },
  ];
}

export function Fairness() {
  const { demo, deployment } = useProtocol();
  const status = useRead(["fairness"], readFairnessStatus);
  const games = useRead(["fairnessGames"], (c, d) => readGames(c, d, (deployment?.demoCollection ?? d.treasury) as `0x${string}`));
  return (
    <>
      <PageHead eyebrow="Fairness" title="What can be checked, and what cannot">
        "Provably fair" here means only that the random draw can be checked. It says nothing about a player's expected return, which is negative in
        every game.
      </PageHead>

      <Panel title="Follow one result through">
        <FairnessWalk edgeBps={status.data?.games.edgeBps} />
        <p className="muted small walk-foot">
          Every settled bet, spin, lottery round and ticket raffle in this app has a Verify button that does this sum from the events, next to what the
          contract paid. For a draw the contract emits the winning ticket, and <code>ownerOfTicket</code> returns who held it. Vault raffle draws emit
          only the winner, so they cannot be recomputed.
        </p>
      </Panel>

      <Panel title="One number, one fixed rule">
        <div className="rule-cards">
          {RULES.map((r) => (
            <article key={r.game} className="rule-card">
              <h3>{r.game}</h3>
              <p>{r.rule}</p>
              <dl>
                <div>
                  <dt>House take</dt>
                  <dd>{r.take}</dd>
                </div>
                <div>
                  <dt>Player's expected return</dt>
                  <dd>{r.ev}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <p className="muted">
          In dice and slots the stake that remains after the edge is played at exactly fair odds: a dice win pays stake ÷ chance, and the slots table
          averages exactly 1×. The edge is split: by default half stays in the games bankroll, to pay for the risk it carries, and half goes to the
          Treasury as buyback budget{games.data ? ` (here the bankroll keeps ${bps(games.data.bankrollShareBps)})` : ""}. The owner sets that share and the price
          limits at which the budget is spent. The edge of a bet is stored with the bet, and the fees and minimum pots of a lottery round, a raffle
          and a prediction market are fixed when they are created, so a later change by the owner cannot reach them.
        </p>
      </Panel>

      <Panel title="This deployment, right now">
        <QueryView query={status} lines={6}>
          {(s) => (
            <>
              {demo ? (
                <Notice>Demo: this is a simulation in your browser. Its results come from a pseudo-random generator, not from a chain. Play money, not fair play.</Notice>
              ) : s.anyMock ? (
                <Notice>Local mock randomness: whoever settles picks the number. Not fair, for testing only.</Notice>
              ) : null}
              <p className="muted">The fairness claim holds only for a deployment where all four of these are true. None of them is true yet: nothing has been deployed to a public network.</p>
              <ol className="conditions">
                {conditions(s, demo).map((c) => (
                  <li key={c.title} className={`condition is-${c.verdict}`}>
                    <i className="condition-mark" aria-hidden="true" />
                    <div>
                      <strong>{c.title}</strong>
                      <p>{c.text}</p>
                    </div>
                    <Badge tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].text}</Badge>
                  </li>
                ))}
              </ol>

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
                        <td>
                          <Addr address={source.provider} />
                        </td>
                        <td>{source.isMock ? <Badge tone="bad">{demo ? "Simulated: not fair" : "Local mock: not fair"}</Badge> : <Badge tone="muted">Not the mock (verify it is the Chainlink adapter)</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="figures">
                <div className="figure">
                  <div className="figure-label">Owner of Games</div>
                  <div className="figure-value">
                    <Addr address={s.gamesOwner} />
                  </div>
                  <div className="figure-hint">
                    {s.ownerIsContract ? "A contract. It could be a timelock or multisig; this app cannot tell which. The owner can replace the randomness provider." : "A plain account, not a timelock. The owner can replace the randomness provider at any moment."}
                  </div>
                </div>
                <div className="figure">
                  <div className="figure-label">Games edge</div>
                  <div className="figure-value">{bps(s.games.edgeBps)}</div>
                  <div className="figure-hint">
                    Minimum bet {eth(s.games.minBet)} ETH; an unanswered bet is refundable after {duration(s.games.refundTimeout)}
                  </div>
                </div>
                <div className="figure">
                  <div className="figure-label">Games limits</div>
                  <div className="figure-value">{bps(s.games.maxExposureBps)} per bet</div>
                  <div className="figure-hint">
                    Of the bankroll at risk on one bet; {bps(s.games.maxTotalExposureBps)} of house funds across all open bets
                    {games.data ? `; one wager at most ${bps(games.data.maxWagerBps)} of the bankroll` : ""}
                  </div>
                </div>
                <div className="figure">
                  <div className="figure-label">Lottery fee</div>
                  <div className="figure-value">{bps(s.lottery.feeBps)}</div>
                  <div className="figure-hint">For new rounds; minimum pot {eth(s.lottery.minPot)} ETH</div>
                </div>
                <div className="figure">
                  <div className="figure-label">Ticket raffle fee</div>
                  <div className="figure-value">{bps(s.ticketRaffle.feeBps)}</div>
                  <div className="figure-hint">For new raffles; minimum pot {eth(s.ticketRaffle.minPot)} ETH</div>
                </div>
              </div>
            </>
          )}
        </QueryView>
      </Panel>

      <Panel title="Where the randomness comes from, and its limits">
        <div className="fair-notes">
          <p>
            The contracts are written to take each random number from Chainlink VRF v2.5. The oracle produces the number from a seed fixed at request
            time and delivers it with a cryptographic proof, which the VRF coordinator verifies on-chain before passing the number on. The operator,
            the player and the oracle cannot choose the number. The oracle knows it before delivering it, and so does anyone who sees the oracle's
            transaction before it is included in a block.
          </p>
          <p>
            An oracle can still withhold a number. A bet without an answer after a day is refunded, an unanswered draw can be reset and requested
            again, and an answer that arrives after its deadline is ignored, so nobody can choose between a late result and a refund. That does not
            cover a party able to hold a result back for the whole day after seeing it: the oracle operator, or on a rollup the sequencer, can turn a
            result it dislikes into a refund or a redraw. The claim rests on neither of them colluding with a player.
          </p>
          <ul className="plain-list">
            <li>The Chainlink adapter has been tested against a simulated coordinator, not a live one.</li>
            <li>
              The vault raffle's draw is uniform over activated points. Points can be bought by trading with oneself, only activated points count, and
              whoever requests the draw closes activation for everyone else. A raffle is not a fair distribution among fee payers unless the prize is
              small against the fees behind the activated points.
            </li>
            <li>In a ticket raffle the creator can buy unsold tickets late and dilute other buyers; the draw itself is still uniform over tickets.</li>
            <li>The slot reels in this app are an illustration of the roll; the payout comes from the contract.</li>
          </ul>
        </div>
      </Panel>
    </>
  );
}
