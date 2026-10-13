import { claimRaffleCall, drawRaffleCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { dateTime, relative } from "../lib/format";
import { RAFFLE_STATUS_NAMES, RaffleStatus, readRaffles, type Raffle } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, QueryView } from "../ui";

const TONE = ["muted", "good", "warn", "good", "muted"] as const;

export function Raffles() {
  const { deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["raffles"], readRaffles);

  const draw = (r: Raffle) =>
    void run(`Draw raffle #${r.id}`, (send) => send("Request draw", drawRaffleCall(d!, r.id)));
  const claim = (r: Raffle) =>
    void run(`Claim raffle #${r.id} prize`, (send) => send("Claim prize", claimRaffleCall(d!, r.id)));

  return (
    <Card title="Raffles">
      <QueryView query={query}>
        {({ raffles, totalPoints }) => (
          <>
            <p className="muted">
              Unlocked vault tokens raffled to points holders. Nobody buys tickets: the chance of winning is your share
              of all active points when the draw is requested (activate pending points on the Overview tab first). Anyone can request the draw after the announce period, and
              anyone can send a drawn prize to its winner.
            </p>
            {raffles.length === 0 ? (
              <p className="muted">No raffles yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Collection</th>
                      <th>Token</th>
                      <th>Status</th>
                      <th>Draw possible</th>
                      <th>Winner</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {raffles.map((r) => {
                      const won = r.status === RaffleStatus.Won || r.status === RaffleStatus.Claimed;
                      const mine = won && !!user && r.winner.toLowerCase() === user.toLowerCase();
                      return (
                        <tr key={r.id.toString()}>
                          <td>{r.id.toString()}</td>
                          <td><Addr address={r.collection} /></td>
                          <td>#{r.tokenId.toString()}</td>
                          <td><Badge tone={TONE[r.status] ?? "muted"}>{RAFFLE_STATUS_NAMES[r.status] ?? r.status}</Badge></td>
                          <td title={dateTime(r.drawAfter)}>
                            {r.status === RaffleStatus.Open ? relative(r.drawAfter, now) : dateTime(r.drawAfter)}
                          </td>
                          <td>
                            {won ? (
                              <>
                                <Addr address={r.winner} /> {mine && <Badge tone="good">You</Badge>}
                              </>
                            ) : (
                              "–"
                            )}
                          </td>
                          <td className="actions">
                            {r.status === RaffleStatus.Open && (
                              <ActionButton
                                onClick={() => draw(r)}
                                blocked={
                                  now < r.drawAfter
                                    ? `Draw possible from ${dateTime(r.drawAfter)}`
                                    : totalPoints === 0n && "Nobody holds active points yet"
                                }
                              >
                                Draw
                              </ActionButton>
                            )}
                            {r.status === RaffleStatus.Drawing && <span className="muted">Waiting for randomness</span>}
                            {r.status === RaffleStatus.Won && <ActionButton onClick={() => claim(r)}>Claim</ActionButton>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </QueryView>
    </Card>
  );
}
