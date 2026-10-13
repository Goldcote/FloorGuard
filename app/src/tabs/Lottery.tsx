import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
import {
  AmountCount,
  Countdown,
  DRAW_REVEAL_MS,
  DrawTapeView,
  flash,
  observeReveal,
  ParticleLayer,
  percent,
  pop,
  potVessel,
  revealElapsed,
  ShareRing,
  useParticles,
  useRevealClock,
  type RevealPhase,
  type TapePhase,
} from "../fx";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { abortLotteryCall, buyLotteryTicketsCall, drawLotteryCall, mockFulfillCall, refundLotteryCall, resetLotteryDrawCall, withdrawLotteryCall } from "../lib/calls";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parseUint, randomWord } from "../lib/parse";
import { abortableAt, lotteryWouldRefund, LOTTERY_STATUS_NAMES, LotteryStatus as S, readDrawProof, readLottery, type DrawProof, type LotteryRound, type LotteryState } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, QueryView, Time } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";
import { PlayNotices } from "./gamesShared";
import { VerifyButton } from "./Verify";

const TONE = ["muted", "good", "warn", "accent", "warn"] as const;

function statusBadge(round: LotteryRound, now: number) {
  if (round.status === S.Open && now >= round.endTime) return <Badge tone="warn">Ended, not drawn</Badge>;
  return <Badge tone={TONE[round.status] ?? "muted"}>{LOTTERY_STATUS_NAMES[round.status] ?? round.status}</Badge>;
}

/** The buttons that apply to a round right now. Renders nothing when none does. */
function RoundActions({ round, state, big }: { round: LotteryRound; state: LotteryState; big?: boolean }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  if (!d) return null;
  const id = round.id;
  const ended = now >= round.endTime;
  const willRefund = lotteryWouldRefund(round, now, state.abortDelay);
  const tooLate = now >= round.endTime + state.abortDelay;
  const abortAt = abortableAt(round, round.status === S.Open ? "open" : round.status === S.Drawing ? "drawing" : "done", state);
  const abortable = abortAt !== undefined && now >= abortAt;
  const resettable = round.status === S.Drawing && now >= round.requestedAt + state.drawTimeout;
  const myRefund = round.status === S.Refunding && (round.userPaid ?? 0n) > 0n ? round.userPaid! : undefined;

  return (
    <>
      {round.status === S.Open && ended && (
        <ActionButton
          className={big ? "big" : undefined}
          onClick={() =>
            void run(`Draw lottery round #${id}`, (send) => send("Draw", drawLotteryCall(d, id)), [
              tooLate
                ? "The round ended over a week ago without a draw, so this opens refunds instead of drawing."
                : willRefund
                ? `The pot of ${eth(round.pot)} ETH is below the round's ${eth(round.minPot)} ETH minimum, so this opens refunds instead of a draw.`
                : `Requests a random draw among the ${round.ticketsSold} tickets. The winner will be owed ${eth(round.prize)} ETH.`,
              ...(willRefund ? [] : [`${eth(round.pot - round.prize)} ETH (${bps(round.feeBps)}) goes to the collection's buyback budget.`]),
              "Anyone may do this; you pay only the transaction fee.",
            ])
          }
        >
          {willRefund ? "End round (opens refunds)" : "Draw the winner"}
        </ActionButton>
      )}
      {round.status === S.Drawing && !resettable && (
        <span className="muted">
          Waiting for randomness{abortAt !== undefined && <>; if none arrives, refunds can be opened from {dateTime(abortAt)}</>}
        </span>
      )}
      {round.status === S.Drawing && chainId === anvil.id && round.requestId !== undefined && (
        <ActionButton
          className="secondary local"
          onClick={() =>
            void run(
              `Answer round #${id} draw with mock randomness`,
              (send) => send("Mock fulfil", mockFulfillCall(d.lotteryRandomness, round.requestId!, randomWord())),
              ["Local chain only: answers the draw's randomness request through the mock provider.", "The random word comes from this browser, so this is for testing, not a fair draw."],
            )
          }
        >
          Local only: draw with mock randomness
        </ActionButton>
      )}
      {resettable && !abortable && (
        <ActionButton
          className="secondary"
          onClick={() =>
            void run(`Reset the draw of round #${id}`, (send) => send("Reset draw", resetLotteryDrawCall(d, id)), [
              "No randomness arrived within a day. This reopens the round so the draw can be requested again.",
            ])
          }
        >
          Reset the draw
        </ActionButton>
      )}
      {abortable && (
        <ActionButton
          className="secondary"
          onClick={() =>
            void run(`Abort lottery round #${id}`, (send) => send("Abort", abortLotteryCall(d, id)), [
              "The round is still undrawn a week after its end. This turns it into refunds: every buyer can take back what they paid.",
            ])
          }
        >
          Abort: undrawn too long, open refunds
        </ActionButton>
      )}
      {myRefund !== undefined && user && (
        <ActionButton
          onClick={() =>
            void run(`Refund my tickets in round #${id}`, (send) => send("Refund", refundLotteryCall(d, id)), [`You receive ${eth(myRefund)} ETH back.`])
          }
        >
          Refund {eth(myRefund)} ETH
        </ActionButton>
      )}
    </>
  );
}

/**
 * The pot as a vessel that fills. It has no upper limit, so the vessel is sized in doublings of the
 * round's minimum pot (see potVessel) and says how much it holds; the dashed line is that minimum:
 * below it the round is refunded, not drawn.
 */
function PotVessel({ round, vesselRef }: { round: LotteryRound; vesselRef: RefObject<HTMLDivElement> }) {
  const { capacity, fill, minLine } = potVessel(round.pot, round.minPot);
  const reached = round.pot >= round.minPot;
  return (
    <div className="pot" ref={vesselRef}>
      <div className="pot-glass" role="img" aria-label={`The pot holds ${eth(round.pot)} ETH; the vessel is drawn to hold ${eth(capacity)} ETH`}>
        <span className="pot-fill" style={{ transform: `scaleY(${Math.max(fill, round.pot > 0n ? 0.03 : 0)})` }} />
        <span className="pot-shine" />
        {minLine > 0 && (
          <span className={reached ? "pot-min is-reached" : "pot-min"} style={{ bottom: `${minLine * 100}%` }}>
            <i>{reached ? "minimum reached" : `draw needs ${eth(round.minPot)} ETH`}</i>
          </span>
        )}
        <span className="pot-cap">{eth(capacity)} ETH</span>
      </div>
      <div className="pot-figures">
        <span className="eyebrow-s">Pot</span>
        <strong className="pot-amount">
          <AmountCount wei={round.pot} text={eth(round.pot)} /> <small>ETH</small>
        </strong>
        <span className="muted small">
          {round.ticketsSold} ticket{round.ticketsSold === 1 ? "" : "s"} at {eth(round.ticketPrice)} ETH
        </span>
        <span className="pot-prize">
          Winner takes <strong>{eth(round.prize)} ETH</strong>
        </span>
        <span className="muted small">
          {bps(round.feeBps)} of the pot ({eth(round.pot - round.prize)} ETH) funds buybacks
        </span>
      </div>
    </div>
  );
}

/** The tickets you hold in a round, as stubs in a hand. More than nine are stacked behind a count. */
function TicketHand({ count, roundId }: { count: number; roundId: bigint }) {
  const shown = Math.min(count, 9);
  return (
    <div className="hand" role="img" aria-label={`You hold ${count} ticket${count === 1 ? "" : "s"} in round ${roundId}`} style={{ "--n": shown } as CSSProperties}>
      {count === 0 ? (
        <span className="stub is-empty">no tickets yet</span>
      ) : (
        Array.from({ length: shown }, (_, i) => (
          <span className="stub" key={i} style={{ "--i": i } as CSSProperties}>
            <b>R{roundId.toString()}</b>
            <i />
          </span>
        ))
      )}
      {count > shown && <span className="hand-more">×{count}</span>}
    </div>
  );
}

type Preview = { round: LotteryRound; proof?: DrawProof };

function RoundStage({ round, t, collection, preview }: { round: LotteryRound; t: LotteryState; collection: Address; preview?: Preview }) {
  const { deployment: d, user, chainId } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const particles = useParticles();
  const stage = useRef<HTMLDivElement>(null);
  const vessel = useRef<HTMLDivElement>(null);
  const [countText, setCountText] = useState("1");
  useRevealClock();

  const won = round.status === S.Won;
  const proofQuery = useRead(["drawProof", "lottery", round.id.toString()], (c, dep) => readDrawProof(c, dep, "lottery", round.id, LOGS_FROM_BLOCK), won && !preview);
  const proof = preview ? preview.proof : proofQuery.data;
  const key = `lottery:${chainId}:${round.id}`;
  const phase: RevealPhase = observeReveal(key, round.status === S.Open || round.status === S.Drawing ? "pending" : won && proof ? "settled" : "other", DRAW_REVEAL_MS);
  const tapePhase: TapePhase = round.status === S.Drawing || (won && !proof) ? "rolling" : phase === "revealing" ? "landing" : won && proof ? "landed" : "still";
  const revealed = won && phase === "done";
  const mine = round.userTickets ?? 0;
  const iWon = revealed && !!user && round.winner.toLowerCase() === user.toLowerCase();
  // Only a prize above what the tickets cost is a win worth gold.
  const ahead = iWon && round.prize > (round.userPaid ?? 0n);

  const selling = round.status === S.Open && now < round.endTime;
  const price = selling ? round.ticketPrice : t.config.ticketPrice;
  const count = Number(parseUint(countText) ?? 0n);
  const canBuy = selling || t.config.active;
  const nextRoundFee = selling ? round.feeBps : Number(t.feeBps);

  // Tickets arriving (yours or anyone's) drop into the pot.
  const sold = useRef(round.ticketsSold);
  useEffect(() => {
    if (round.ticketsSold > sold.current) {
      particles.drop(vessel.current?.querySelector(".pot-glass") ?? undefined, Math.min(10, round.ticketsSold - sold.current) + 2);
      pop(vessel.current?.querySelector(".pot-amount"), 1.08);
      sound.stake();
    }
    sold.current = round.ticketsSold;
  }, [round.ticketsSold, particles]);

  const drawing = tapePhase === "rolling" || tapePhase === "landing";
  useEffect(() => {
    if (!drawing) return;
    sound.drumStart();
    return () => sound.drumStop();
  }, [drawing]);

  const landed = () => {
    sound.drumStop();
    sound.drawLand();
    if (!user || round.winner.toLowerCase() !== user.toLowerCase() || round.prize <= (round.userPaid ?? 0n)) return;
    flash(stage.current, "var(--gold)", 0.3);
    particles.coinFountain(vessel.current?.querySelector(".pot-glass") ?? undefined, 34);
    particles.confetti(60);
    sound.win(10);
    sound.buzz([30, 40, 60, 40, 90]);
  };

  const buy = () => {
    if (!d || count < 1) return;
    const cost = price * BigInt(count);
    sound.ticket();
    void run(`Buy ${count} lottery ticket${count === 1 ? "" : "s"}`, (send) => send("Buy tickets", buyLotteryTicketsCall(d, collection, count, price)), [
      `You pay ${eth(cost)} ETH for ${count} ticket${count === 1 ? "" : "s"} at ${eth(price)} ETH each.`,
      selling ? `They join round #${round.id}, which ends ${dateTime(round.endTime)}.` : `The latest round has ended, so this opens a new round lasting ${duration(t.config.duration)}.`,
      `One random ticket wins the pot less ${bps(nextRoundFee)}, which goes to the collection's buyback budget.`,
      `If the round's pot ends below ${eth(selling ? round.minPot : t.minPot)} ETH, or it is never drawn, you can take a full refund.`,
    ]);
  };
  const step = (by: number) => (sound.tick(), setCountText(String(Math.max(1, count + by))));

  return (
    <div className={`stage stage-lottery${ahead ? " tone-win" : ""}${drawing ? " is-drawing" : ""}`} ref={stage}>
      <header className="stage-head">
        <h2>Round #{round.id.toString()}</h2>
        {statusBadge(round, now)}
        {preview && <Badge tone="warn">Development preview</Badge>}
      </header>

      <div className="lottery-top">
        <PotVessel round={round} vesselRef={vessel} />
        <div className="lottery-clock">
          <span className="eyebrow-s">{round.status !== S.Open ? "Sales closed" : now < round.endTime ? "Draw possible in" : "Sales ended"}</span>
          <Countdown seconds={round.status === S.Open ? round.endTime - now : 0} total={t.config.duration} label="Time left in the round" done={round.status === S.Open ? "Ready to draw" : LOTTERY_STATUS_NAMES[round.status]} />
          <span className="muted small">
            {now < round.endTime ? "Ends" : "Ended"} {dateTime(round.endTime)}
          </span>
        </div>
      </div>

      <div className="draw">
        <DrawTapeView count={round.ticketsSold} ticket={proof ? Number(proof.ticket) : undefined} phase={tapePhase} startedMs={revealElapsed(key) ?? 0} mine={ahead} onStep={(p) => sound.tick(1 - p)} onLand={landed} />
        <p className={`cab-lcd${ahead ? " tone-win" : ""}`} aria-live="polite">
          {round.status === S.Drawing || (won && !proof)
            ? "The draw is running: waiting for the random number…"
            : phase === "revealing"
              ? " "
              : revealed && proof
                ? iWon
                  ? `Ticket ${proof.ticket} wins, and it is yours: ${eth(round.prize)} ETH.`
                  : `Ticket ${proof.ticket} wins ${eth(round.prize)} ETH.`
                : round.status === S.Refunding
                  ? "This round was not drawn. Every buyer can take a full refund."
                  : round.status === S.Open && now >= round.endTime
                    ? round.pot < round.minPot
                      ? `The pot is below the round's ${eth(round.minPot)} ETH minimum, so ending the round opens refunds.`
                      : "The round is over. Anyone can request the draw."
                    : `Tickets are numbered 0 to ${Math.max(0, round.ticketsSold - 1)}. One of them will be drawn.`}
        </p>
        {revealed && (
          <p className="draw-winner">
            Winner: <Addr address={round.winner} /> {iWon && <span className="badge badge-gold">You</span>}{" "}
            <VerifyButton kind="lottery" id={round.id} ticketPrice={round.ticketPrice} feeBps={BigInt(round.feeBps)} />
          </p>
        )}
        <div className="form-row center">
          <RoundActions round={round} state={t} big />
        </div>
      </div>

      <div className="lottery-yours">
        <div className="yours-hand">
          <span className="eyebrow-s">Your tickets</span>
          {round.userTickets === undefined ? <p className="muted">Connect a wallet</p> : <TicketHand count={mine} roundId={round.id} />}
        </div>
        <ShareRing share={round.ticketsSold > 0 && round.status !== S.Refunding ? mine / round.ticketsSold : 0} label={`Your odds: ${percent(mine, round.ticketsSold)} of the tickets sold`}>
          <strong>{mine > 0 && round.status !== S.Refunding ? percent(mine, round.ticketsSold) : "–"}</strong>
          <span>your odds now</span>
        </ShareRing>
        <p className="muted small yours-note">
          {round.status === S.Refunding && (round.userPaid ?? 0n) > 0n
            ? `Refundable: ${eth(round.userPaid!)} ETH.`
            : mine > 0 && selling
              ? `You hold ${mine} of ${round.ticketsSold} tickets. Your odds fall as more tickets sell.`
              : mine > 0
                ? `You hold ${mine} of ${round.ticketsSold} tickets.`
                : "Each ticket is one chance among all tickets sold. More tickets sold means a bigger pot and lower odds per ticket."}
        </p>
      </div>

      {canBuy ? (
        <div className="buy-bar">
          <span className="eyebrow-s buy-title">{selling ? "Buy tickets" : `Buy tickets: opens round #${(round.id + 1n).toString()} or later`}</span>
          <div className="stepper" role="group" aria-label="Number of tickets">
            <button type="button" className="chip" onClick={() => step(-1)} disabled={count <= 1} aria-label="One ticket fewer">
              −
            </button>
            <input inputMode="numeric" aria-label={`Tickets at ${eth(price)} ETH each`} value={countText} onChange={(e) => setCountText(e.target.value)} />
            <button type="button" className="chip" onClick={() => step(1)} aria-label="One ticket more">
              +
            </button>
            {[5, 10].map((n) => (
              <button type="button" className="chip" key={n} onClick={() => (sound.click(), setCountText(String(n)))}>
                {n}
              </button>
            ))}
          </div>
          <ActionButton className="big" onClick={buy} blocked={count < 1 && "Enter how many tickets to buy"}>
            Buy for {count >= 1 ? eth(price * BigInt(count)) : "–"} ETH
          </ActionButton>
          <p className="muted small buy-note">
            {eth(price)} ETH each.{" "}
            {selling && count >= 1
              ? `With ${count} more${round.userTickets !== undefined ? ` you would hold ${mine + count} of ${round.ticketsSold + count} tickets: ${percent(mine + count, round.ticketsSold + count)} odds at that moment` : `, ${round.ticketsSold + count} tickets would be sold`}.`
              : !selling && `The first ticket opens a round of ${duration(t.config.duration)}.`}
          </p>
        </div>
      ) : (
        <p className="muted">The owner has turned the lottery off for this collection; no new round will open.</p>
      )}
      <ParticleLayer controller={particles} />
    </div>
  );
}

/** Earlier rounds as a wall of stubs: the pot as a bar against the largest pot shown. */
function PastRounds({ t }: { t: LotteryState }) {
  const { user } = useProtocol();
  const now = useChainTime();
  if (t.past.length === 0) return <Empty title="No earlier rounds." />;
  const largest = t.past.reduce((max, r) => (r.pot > max ? r.pot : max), 1n);
  return (
    <ol className="rounds">
      {t.past.map((round) => {
        const mine = !!user && round.status === S.Won && round.winner.toLowerCase() === user.toLowerCase();
        return (
          <li key={round.id.toString()} className={mine && round.prize > (round.userPaid ?? 0n) ? "round-stub is-mine" : "round-stub"}>
            <div className="round-stub-id">
              <span>Round</span>
              <strong>#{round.id.toString()}</strong>
            </div>
            <div className="round-stub-body">
              <div className="round-stub-line">
                <strong>{eth(round.pot)} ETH</strong>
                <span className="muted">
                  {round.ticketsSold} tickets · ended <Time at={round.endTime} now={now} />
                </span>
                {statusBadge(round, now)}
              </div>
              <div className="round-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${Number((round.pot * 1000n) / largest) / 1000})` }} />
              </div>
              <div className="round-stub-line">
                {round.status === S.Won ? (
                  <span>
                    <Addr address={round.winner} /> {mine && <span className="badge badge-gold">You</span>} <span className="muted">won {eth(round.prize)} ETH</span>
                  </span>
                ) : (
                  <span className="muted">No winner</span>
                )}
                <span className="muted">Your tickets: {round.userTickets ?? "–"}</span>
                <span className="round-actions">
                  {round.status === S.Won && <VerifyButton kind="lottery" id={round.id} ticketPrice={round.ticketPrice} feeBps={BigInt(round.feeBps)} />}
                  <RoundActions round={round} state={t} />
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Lottery({ collection }: { collection: Address }) {
  const { deployment: d, user } = useProtocol();
  const { run } = useTx();
  const query = useRead(["lottery", collection, user], (c, dep) => readLottery(c, dep, collection, user));
  const [preview, setPreview] = useState<Preview>();

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hooks = (window.__fgPreview ??= {});
    let n = 0;
    hooks.lottery = (ticket: number, sold = 40, mine = 0) => {
      const base: LotteryRound = {
        id: 900n + BigInt(++n), collection, ticketPrice: 10n ** 16n, ticketsSold: sold, endTime: 0, requestedAt: 0, feeBps: 500, status: S.Drawing,
        winner: "0x00000000000000000000000000000000000a11ce", minPot: 5n * 10n ** 16n, pot: BigInt(sold) * 10n ** 16n, prize: (BigInt(sold) * 10n ** 16n * 95n) / 100n, userTickets: mine, userPaid: BigInt(mine) * 10n ** 16n,
      };
      setPreview({ round: base });
      setTimeout(() => {
        const winner = (mine > 0 && user ? user : base.winner) as Address;
        setPreview({ round: { ...base, status: S.Won, winner }, proof: { ticketsSold: sold, ticket: BigInt(ticket), winner, ticketHolder: winner, drawTx: `0x${"0".repeat(64)}` } });
      }, 2500);
    };
    hooks.lotteryOff = () => setPreview(undefined);
    return () => void (delete hooks.lottery, delete hooks.lotteryOff);
  }, [collection, user]);

  return (
    <div className="play play-lottery">
      <PlayNotices>Lotteries are regulated or prohibited in many places. Check the law where you are before buying tickets or operating this.</PlayNotices>
      <QueryView query={query} lines={8}>
        {(t) => {
          const round = preview?.round ?? t.current;
          return (
            <>
              {t.userOwed !== undefined && t.userOwed > 0n && d && (
                <div className="callout prize-callout">
                  <p>
                    <strong>{eth(t.userOwed)} ETH</strong> of lottery winnings is waiting for you.
                  </p>
                  <ActionButton onClick={() => void run("Withdraw lottery winnings", (send) => send("Withdraw", withdrawLotteryCall(d)), [`You receive ${eth(t.userOwed!)} ETH from the Lottery contract.`])}>
                    Withdraw
                  </ActionButton>
                </div>
              )}
              {round ? (
                <RoundStage key={round.id.toString()} round={round} t={t} collection={collection} preview={preview} />
              ) : (
                <FirstRound t={t} collection={collection} />
              )}
              <Card title="How it works">
                <p className="muted">
                  Each round sells tickets at a fixed price for a fixed time. Then one random ticket wins the pot, less a fee
                  that funds the selected collection's buybacks. The first ticket bought after a round has ended opens the
                  next one. More tickets sold means a bigger pot and lower odds per ticket.
                </p>
              </Card>
              <Card title="Earlier rounds">
                <PastRounds t={t} />
              </Card>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

/** No round has ever been opened for this collection. */
function FirstRound({ t, collection }: { t: LotteryState; collection: Address }) {
  const { deployment: d } = useProtocol();
  const { run } = useTx();
  if (!t.config.active) return <Empty title="No lottery for this collection.">The owner has not configured a lottery for this collection.</Empty>;
  const price = t.config.ticketPrice;
  return (
    <div className="stage stage-lottery">
      <Empty title="No round yet.">
        The first ticket opens a round of {duration(t.config.duration)} at {eth(price)} ETH a ticket.
      </Empty>
      <div className="form-row center">
        <ActionButton
          className="big"
          onClick={() =>
            d &&
            void run("Buy 1 lottery ticket", (send) => send("Buy tickets", buyLotteryTicketsCall(d, collection, 1, price)), [
              `You pay ${eth(price)} ETH for 1 ticket.`,
              `This opens a new round lasting ${duration(t.config.duration)}.`,
              `One random ticket wins the pot less ${bps(t.feeBps)}, which goes to the collection's buyback budget.`,
              `If the round's pot ends below ${eth(t.minPot)} ETH, or it is never drawn, you can take a full refund.`,
            ])
          }
        >
          Buy the first ticket for {eth(price)} ETH
        </ActionButton>
      </div>
    </div>
  );
}
