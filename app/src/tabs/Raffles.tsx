import { LOCAL_CHAIN_ID, LOCAL_ENABLED } from "../local";
import { useEffect, useRef } from "react";
import { Countdown, flash, observeReveal, ParticleLayer, ShareRing, TokenEmblem, useParticles, useRevealClock } from "../fx";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { claimRaffleCall, drawRaffleCall, mockFulfillCall } from "../lib/calls";
import { dateTime, points as formatPoints } from "../lib/format";
import { randomWord } from "../lib/parse";
import { RAFFLE_STATUS_NAMES, RaffleStatus, readPoints, readRaffles, type Raffle, type Raffles as RafflesState } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx, single } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, QueryView } from "../ui";
import { RandomnessNotice } from "./Verify";

const TONE = ["muted", "good", "warn", "good", "muted"] as const;
/** How long the lights hold before a drawn winner is shown. The same for every draw. */
const VAULT_DRAW_REVEAL_MS = 1_500;

/** A share of points as a percentage with up to two decimals. */
function share(part: bigint, whole: bigint): number {
  return whole > 0n ? Number((part * 1_000_000n) / whole) / 1_000_000 : 0;
}
const asPercent = (value: number) => `${Math.round(value * 10_000) / 100}%`;

function VaultRaffleCard({ r, state, myPoints }: { r: Raffle; state: RafflesState; myPoints: bigint | undefined }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const particles = useParticles();
  const card = useRef<HTMLElement>(null);
  const prize = useRef<HTMLDivElement>(null);
  const previous = useRef("idle");
  useRevealClock();
  const isLocal = chainId === LOCAL_CHAIN_ID;
  const { totalPoints, nextDrawAt, drawInFlight } = state;
  // `VaultRaffle.minPointsRequired`: the larger of the owner's minimum and the prize's cost times
  // `pointsPerPrizeWei`, so that the fees behind the points are large against the prize.
  const minPoints = r.minPointsRequired;

  const won = r.status === RaffleStatus.Won || r.status === RaffleStatus.Claimed;
  const phase = observeReveal(`vaultRaffle:${chainId}:${r.id}`, r.status === RaffleStatus.Open || r.status === RaffleStatus.Drawing ? "pending" : won ? "settled" : "other", VAULT_DRAW_REVEAL_MS);
  const revealed = won && phase === "done";
  const drawing = r.status === RaffleStatus.Drawing || phase === "revealing";
  // A draw needs both the raffle's own announce period and the contract-wide cooldown that follows any reset draw.
  const drawableAt = Math.max(r.drawAfter, nextDrawAt);
  const mine = revealed && !!user && r.winner.toLowerCase() === user.toLowerCase();
  // A won prize vests: it can be delivered only from `claimableAt`.
  const vesting = r.status === RaffleStatus.Won && now < r.claimableAt;
  const odds = myPoints !== undefined ? share(myPoints, totalPoints) : 0;

  useEffect(() => {
    if (!drawing) return;
    sound.drumStart();
    return () => sound.drumStop();
  }, [drawing]);

  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (phase !== "done" || before !== "revealing") return;
    sound.drawLand();
    flash(prize.current, mine ? "var(--gold)" : "var(--accent)", 0.3);
    if (!mine) return;
    particles.burst(prize.current ?? undefined, 1);
    particles.confetti(50);
    sound.win(10);
    sound.buzz([30, 40, 60, 40, 90]);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const draw = () =>
    void run(`Draw raffle #${r.id}`, single("Request draw", drawRaffleCall(d!, r.id)), [
      "Requests the random draw. The winner is picked among points holders, weighted by their active points at this moment.",
      "Points are frozen until the draw completes. No ETH is sent; you pay only the transaction fee.",
    ]);
  const settleLocally = () =>
    void run(`Answer raffle #${r.id} draw with mock randomness`, single("Mock fulfil", mockFulfillCall(d!.randomness, r.requestId!, randomWord())), [
      "Local chain only: answers the draw's randomness request through the mock provider.",
      "The random word comes from this browser, so this is for testing, not a fair draw.",
    ]);
  const claim = () =>
    void run(`Claim raffle #${r.id} prize`, single("Claim prize", claimRaffleCall(d!, r.id)), [
      `Sends token #${r.tokenId} to the winner, ${r.winner}. Anyone may do this now that it has vested; you pay only the transaction fee.`,
    ]);

  return (
    <article className={`raffle${mine ? " tone-win" : ""}${drawing ? " is-drawing" : ""}`} ref={card} aria-label={`Vault raffle ${r.id}`}>
      <div className="spotlight" ref={prize}>
        <span className="spot-beam" aria-hidden="true" />
        <TokenEmblem collection={r.collection} tokenId={r.tokenId} />
        <span className="spot-plinth" aria-hidden="true" />
        <span className="spot-caption">
          The prize: token #{r.tokenId.toString()}
          <br />
          <Addr address={r.collection} />
        </span>
      </div>
      <div className="raffle-body">
        <header className="stage-head">
          <h2>Vault raffle #{r.id.toString()}</h2>
          <Badge tone={TONE[r.status] ?? "muted"}>{RAFFLE_STATUS_NAMES[r.status] ?? r.status}</Badge>
        </header>
        <div className="raffle-figures">
          <div className="raffle-odds">
            <ShareRing share={r.status === RaffleStatus.Open || r.status === RaffleStatus.Drawing ? odds : 0} label={myPoints === undefined ? "Connect a wallet to see your share of points" : `Your share of all active points: ${asPercent(odds)}`}>
              <strong>{myPoints === undefined ? "–" : r.status === RaffleStatus.Open || r.status === RaffleStatus.Drawing ? asPercent(odds) : "–"}</strong>
              <span>your share of points</span>
            </ShareRing>
          </div>
          <dl className="raffle-facts">
            <div>
              <dt>Your active points</dt>
              <dd>{myPoints === undefined ? "connect a wallet" : formatPoints(myPoints)}</dd>
            </div>
            <div>
              <dt>All active points</dt>
              <dd>{formatPoints(totalPoints)}</dd>
            </div>
            {minPoints > 0n && r.status === RaffleStatus.Open && (
              <div>
                <dt>Needed for a draw</dt>
                <dd>{formatPoints(minPoints)}</dd>
              </div>
            )}
          </dl>
          {r.status === RaffleStatus.Open && (
            <div className="raffle-clock">
              <span className="eyebrow-s">{now < drawableAt ? "Draw possible in" : "Draw possible"}</span>
              <Countdown seconds={drawableAt - now} label="Time until the draw can be requested" done="Now" />
              <span className="muted small">{dateTime(drawableAt)}</span>
            </div>
          )}
        </div>
        {minPoints > 0n && r.status === RaffleStatus.Open && (
          <div className="points-progress">
            <div className="round-bar" role="img" aria-label={`${formatPoints(totalPoints)} of the ${formatPoints(minPoints)} activated points a draw needs`}>
              <span style={{ transform: `scaleX(${Math.min(1, share(totalPoints, minPoints))})` }} />
            </div>
            <p className="muted small">
              {totalPoints >= minPoints
                ? "Enough points are activated for a draw."
                : `Needs ${formatPoints(minPoints)} activated points (has ${formatPoints(totalPoints)}).`}
            </p>
          </div>
        )}
        <p className={`cab-lcd${mine ? " tone-win" : ""}`} aria-live="polite">
          {r.status === RaffleStatus.Drawing
            ? "The draw is running: waiting for the random number…"
            : phase === "revealing"
              ? " "
              : revealed
                ? mine
                  ? vesting
                    ? `You won token #${r.tokenId}. It vests until ${dateTime(r.claimableAt)}.`
                    : `You won token #${r.tokenId}.`
                  : vesting
                    ? `Token #${r.tokenId} is won. It vests until ${dateTime(r.claimableAt)}.`
                    : `Token #${r.tokenId} is won.`
                : "Nobody buys tickets: your chance is your share of all active points when the draw is requested."}
        </p>
        {revealed && (
          <p className="draw-winner">
            Winner: <Addr address={r.winner} /> {mine && <span className="badge badge-gold">You</span>}
          </p>
        )}
        <div className="form-row raffle-actions">
          {r.status === RaffleStatus.Open && (
            <ActionButton
              className="big"
              onClick={draw}
              blocked={
                now < drawableAt
                  ? `Draw possible from ${dateTime(drawableAt)}`
                  : drawInFlight
                    ? "Another raffle's draw is in flight; only one can run at a time"
                    : totalPoints === 0n
                      ? "Nobody holds active points yet"
                      : totalPoints < minPoints && `Needs ${formatPoints(minPoints)} activated points (has ${formatPoints(totalPoints)})`
              }
            >
              Draw
            </ActionButton>
          )}
          {r.status === RaffleStatus.Drawing && <span className="muted">Waiting for randomness</span>}
          {LOCAL_ENABLED && r.status === RaffleStatus.Drawing && isLocal && r.requestId !== undefined && (
            <ActionButton className="secondary local" onClick={settleLocally}>
              Local only: draw with mock randomness
            </ActionButton>
          )}
          {r.status === RaffleStatus.Won && revealed && (
            <ActionButton className="big" onClick={claim} blocked={vesting && `The prize vests until ${dateTime(r.claimableAt)}`}>
              Claim: deliver the prize
            </ActionButton>
          )}
          {r.status === RaffleStatus.Won && revealed && vesting && (
            <span className="muted small">
              Vests until {dateTime(r.claimableAt)}; anyone can deliver it from then.
            </span>
          )}
        </div>
      </div>
      <ParticleLayer controller={particles} />
    </article>
  );
}

export function Raffles() {
  const { user } = useProtocol();
  const query = useRead(["raffles"], readRaffles);
  const mine = useRead(["points", user], (client, d) => readPoints(client, d, user!), !!user);

  return (
    <div className="play play-raffles">
      <div className="play-notices">
        <RandomnessNotice />
      </div>
      <QueryView query={query} lines={6}>
        {(state) => (
          <>
            {state.raffles.length === 0 ? (
              <Empty title="No vault raffles yet.">
                One vault purchase in five goes to players 30 days after it was bought; the owner can also send an unlocked holding.
              </Empty>
            ) : (
              state.raffles.map((r) => <VaultRaffleCard key={r.id.toString()} r={r} state={state} myPoints={user ? mine.data?.active : undefined} />)
            )}
            <Card title="Vault raffles (for points holders)">
              <p className="muted">
                Vault tokens raffled to points holders: the players' share (one purchase in five, after 30 days in the vault) and
                any unlocked holding the owner sends. Nobody buys tickets: the chance of winning is your share of all active points
                when the draw is requested (activate pending points on the Overview tab first). Anyone can request the draw after
                the announce period, once enough points are activated: the owner's minimum, or{" "}
                {formatPoints(state.pointsPerPrizeWei * 10n ** 18n)} points per ETH the vault paid for the prize if that is more, so that the fees behind the points are large against the prize. A won prize vests for {Math.round(state.vestingPeriod / 86_400)} days; then anyone can send it to its winner.
                Until then the winner cannot sell it; once delivered it is an ordinary NFT in their wallet. The draw emits only the
                winner, not the point number, so this draw cannot be recomputed in the browser; its transaction is on the chain.
              </p>
            </Card>
          </>
        )}
      </QueryView>
    </div>
  );
}
