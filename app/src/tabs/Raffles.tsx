import { anvil } from "wagmi/chains";
import { claimRaffleCall, drawRaffleCall, mockFulfillCall } from "../lib/calls";
import { randomWord } from "../lib/parse";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { dateTime, relative } from "../lib/format";
import { RAFFLE_STATUS_NAMES, RaffleStatus, readRaffles, type Raffle } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, QueryView } from "../ui";

const TONE = ["muted", "good", "warn", "good", "muted"] as const;

export function Raffles() {
  const { chainId, deployment: d, user } = useProtocol();
  const isLocal = chainId === anvil.id;
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["raffles"], readRaffles);

  const draw = (r: Raffle) =>
    void run(`Draw raffle #${r.id}`, (send) => send("Request draw", drawRaffleCall(d!, r.id)));
  const settleLocally = (r: Raffle) =>
    void run(`Answer raffle #${r.id} draw with mock randomness`, (send) =>
      send("Mock fulfil", mockFulfillCall(d!.randomness, r.requestId!, randomWord())),
    );
  const claim = (r: Raffle) =>
    void run(`Claim raffle #${r.id} prize`, (send) => send("Claim prize", claimRaffleCall(d!, r.id)));

  return (
    <Card title="Raffles">
      <QueryView query={query}>
        {({ raffles, totalPoints, nextDrawAt }) => (
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
                      // A draw needs both the raffle's own announce period and the contract-wide cooldown
                      // that follows any reset draw to have passed.
                      const drawableAt = Math.max(r.drawAfter, nextDrawAt);
                      const mine = won && !!user && r.winner.toLowerCase() === user.toLowerCase();
                      return (
                        <tr key={r.id.toString()}>
                          <td>{r.id.toString()}</td>
                          <td><Addr address={r.collection} /></td>
                          <td>#{r.tokenId.toString()}</td>
                          <td><Badge tone={TONE[r.status] ?? "muted"}>{RAFFLE_STATUS_NAMES[r.status] ?? r.status}</Badge></td>
                          <td title={dateTime(r.drawAfter)}>
                            {r.status === RaffleStatus.Open ? relative(drawableAt, now) : dateTime(r.drawAfter)}
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
                                  now < drawableAt
                                    ? `Draw possible from ${dateTime(drawableAt)}`
                                    : totalPoints === 0n && "Nobody holds active points yet"
                                }
                              >
                                Draw
                              </ActionButton>
                            )}
                            {r.status === RaffleStatus.Drawing && <span className="muted">Waiting for randomness</span>}
                            {r.status === RaffleStatus.Drawing && isLocal && r.requestId !== undefined && (
                              <ActionButton className="secondary local" onClick={() => settleLocally(r)}>
                                Local only: draw with mock randomness
                              </ActionButton>
                            )}
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
