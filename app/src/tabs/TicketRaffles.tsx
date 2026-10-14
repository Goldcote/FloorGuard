import { LOCAL_CHAIN_ID, LOCAL_ENABLED } from "../local";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Address } from "viem";
import { Countdown, DRAW_REVEAL_MS, DrawTapeView, flash, observeReveal, ParticleLayer, percent, revealElapsed, ShareRing, TokenEmblem, useParticles, useRevealClock, type TapePhase } from "../fx";
import { useChainTime, useProtocol, useRead } from "../hooks";
import {
  abortTicketRaffleCall,
  approveCall,
  buyTicketsCall,
  cancelTicketRaffleCall,
  closeTicketRaffleCall,
  createTicketRaffleCall,
  mockFulfillCall,
  reclaimTicketRaffleCall,
  refundTicketsCall,
  resetTicketDrawCall,
  settleTicketRaffleCall,
  withdrawTicketRaffleCall,
  type Call,
} from "../lib/calls";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parseEth, parseUint, randomWord } from "../lib/parse";
import { abortableAt, readDrawProof, readTicketRaffles, readTokenState, TICKET_RAFFLE_STATUS_NAMES, TicketRaffleStatus as S, ticketRaffleWouldRefund, type TicketRaffle, type TicketRaffles as RafflesState } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx, single } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, Field, QueryView } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";
import { PlayNotices } from "./gamesShared";
import { VerifyButton } from "./Verify";

const TONE = ["muted", "good", "warn", "good", "muted", "warn", "muted"] as const;
const STRIP_CELLS = 60;

/**
 * Every ticket of a raffle as a strip: yours, other people's, unsold. It shows shares, not positions
 * (the app does not know which ticket numbers are yours), so yours are grouped at the start. The
 * notch marks the minimum that must sell for a draw.
 */
export function TicketStrip({ sold, max, min, mine }: { sold: number; max: number; min: number; mine: number }) {
  const label = `${sold} of ${max} tickets sold, ${mine} yours; at least ${min} must sell`;
  if (max > STRIP_CELLS) {
    const part = (n: number) => `${(n / max) * 100}%`;
    return (
      <div className="strip strip-bar" role="img" aria-label={label}>
        <span className="strip-mine" style={{ width: part(mine) }} />
        <span className="strip-sold" style={{ width: part(sold - mine) }} />
        {min > 0 && min <= max && <span className="strip-min" style={{ left: part(min) }} />}
      </div>
    );
  }
  return (
    <div className="strip" role="img" aria-label={label} style={{ "--cells": max } as CSSProperties}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={`${i < mine ? "is-mine" : i < sold ? "is-sold" : ""}${i === min - 1 && min < max ? " is-min" : ""}`} />
      ))}
    </div>
  );
}

function RaffleCard({ r, t }: { r: TicketRaffle; t: RafflesState }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const particles = useParticles();
  const card = useRef<HTMLElement>(null);
  const prize = useRef<HTMLDivElement>(null);
  const [countText, setCountText] = useState("1");
  useRevealClock();
  const isLocal = chainId === LOCAL_CHAIN_ID;
  const isMe = (address: Address) => !!user && address.toLowerCase() === user.toLowerCase();
  const act = (title: string, step: string, call: Call, details: string[]) => void run(title, single(step, call), details);

  const key = r.id.toString();
  const selling = r.status === S.Open && now < r.endTime && r.ticketsSold < r.maxTickets;
  const closable = r.status === S.Open && !selling;
  const left = r.maxTickets - r.ticketsSold;
  const count = Number(parseUint(countText) ?? 0n);
  const mine = r.userTickets ?? 0;
  const abortAt = abortableAt(r, r.status === S.Open ? "open" : r.status === S.Drawing ? "drawing" : r.status === S.Won ? "won" : "done", t);
  const resetAt = r.status === S.Drawing ? r.requestedAt + t.drawTimeout : undefined;
  const wouldRefund = ticketRaffleWouldRefund(r, now, t.abortDelay);

  const drawn = r.status === S.Won || r.status === S.Settled;
  const proof = useRead(["drawProof", "ticketRaffle", key], (c, dep) => readDrawProof(c, dep, "ticketRaffle", r.id, LOGS_FROM_BLOCK), drawn).data;
  const revealKey = `raffle:${chainId}:${key}`;
  const phase = observeReveal(revealKey, r.status === S.Open || r.status === S.Drawing ? "pending" : drawn && proof ? "settled" : "other", DRAW_REVEAL_MS);
  const tapePhase: TapePhase = r.status === S.Drawing || (drawn && !proof) ? "rolling" : phase === "revealing" ? "landing" : drawn && proof ? "landed" : "still";
  const revealed = drawn && phase === "done";
  const iWon = revealed && isMe(r.winner);
  const running = tapePhase === "rolling" || tapePhase === "landing";
  const showTape = r.status === S.Drawing || drawn;

  useEffect(() => {
    if (!running) return;
    sound.drumStart();
    return () => sound.drumStop();
  }, [running]);

  const landed = () => {
    sound.drumStop();
    sound.drawLand();
    if (!isMe(r.winner)) return;
    flash(card.current, "var(--gold)", 0.28);
    particles.burst(prize.current ?? undefined, 1);
    particles.confetti(50);
    sound.win(10);
    sound.buzz([30, 40, 60, 40, 90]);
  };

  return (
    <article className={`raffle${iWon ? " tone-win" : ""}${running ? " is-drawing" : ""}`} ref={card} aria-label={`Raffle ${key}`}>
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
          <h2>Raffle #{key}</h2>
          <Badge tone={TONE[r.status] ?? "muted"}>{TICKET_RAFFLE_STATUS_NAMES[r.status] ?? r.status}</Badge>
          {r.status === S.Open && !selling && <Badge tone="warn">{r.ticketsSold >= r.maxTickets ? "Sold out" : "Sales ended"}</Badge>}
          {isMe(r.creator) && <Badge tone="muted">Your raffle</Badge>}
        </header>

        <div className="raffle-figures">
          <div className="raffle-odds">
            <ShareRing
              share={mine > 0 && r.ticketsSold > 0 && (r.status === S.Open || r.status === S.Drawing) ? mine / r.ticketsSold : 0}
              outer={mine > 0 && selling ? mine / r.maxTickets : undefined}
              label={mine > 0 ? `Your odds: ${percent(mine, r.ticketsSold)} of tickets sold${selling ? `, ${percent(mine, r.maxTickets)} if all ${r.maxTickets} sell` : ""}` : "You hold no tickets"}
            >
              <strong>{mine > 0 && r.ticketsSold > 0 && (r.status === S.Open || r.status === S.Drawing) ? percent(mine, r.ticketsSold) : "–"}</strong>
              <span>your odds now</span>
            </ShareRing>
          </div>
          <dl className="raffle-facts">
            <div>
              <dt>Ticket</dt>
              <dd>{eth(r.ticketPrice)} ETH</dd>
            </div>
            <div>
              <dt>Sold</dt>
              <dd>
                {r.ticketsSold} / {r.maxTickets}
              </dd>
            </div>
            <div>
              <dt>Yours</dt>
              <dd>
                {r.userTickets === undefined ? "connect a wallet" : r.status === S.Refunding ? (mine > 0 ? `${mine}, refundable ${eth(r.userPaid ?? 0n)} ETH` : "none, or refunded") : mine}
              </dd>
            </div>
            <div>
              <dt>Creator</dt>
              <dd>
                <Addr address={r.creator} />
              </dd>
            </div>
          </dl>
          {r.status === S.Open && (
            <div className="raffle-clock">
              <span className="eyebrow-s">{now < r.endTime ? "Sales end in" : "Sales ended"}</span>
              <Countdown seconds={r.endTime - now} label="Time left to buy tickets" done="Ready to close" />
            </div>
          )}
        </div>

        <div className="strip-wrap">
          <TicketStrip sold={r.ticketsSold} max={r.maxTickets} min={r.minTickets} mine={mine} />
          <p className="strip-legend">
            <span className="strip-key k-mine">yours {mine}</span>
            <span className="strip-key k-sold">others {r.ticketsSold - mine}</span>
            <span className="strip-key">unsold {left}</span>
            <span className="strip-key k-min">draw needs {r.minTickets} sold</span>
          </p>
          <p className="muted small">
            {mine > 0 && selling && `If all ${r.maxTickets} sell your odds are ${percent(mine, r.maxTickets)}. `}
            The fee is {bps(r.feeBps)} of the pot; the rest goes to the creator.
            {selling && " Odds can fall until the raffle closes: anyone, the creator included, can buy the unsold tickets late."}
          </p>
        </div>

        {showTape && (
          <div className="draw">
            <DrawTapeView count={r.ticketsSold} ticket={proof ? Number(proof.ticket) : undefined} phase={tapePhase} startedMs={revealElapsed(revealKey) ?? 0} mine={iWon} onStep={(p) => sound.tick(1 - p)} onLand={landed} />
            <p className={`cab-lcd${iWon ? " tone-win" : ""}`} aria-live="polite">
              {running && tapePhase === "rolling"
                ? "The draw is running: waiting for the random number…"
                : !revealed || !proof
                  ? " "
                  : iWon
                    ? `Ticket ${proof.ticket} wins, and it is yours: token #${r.tokenId}.`
                    : `Ticket ${proof.ticket} wins token #${r.tokenId}.`}
            </p>
            {revealed && (
              <div className="draw-winner">
                Winner: <Addr address={r.winner} /> {isMe(r.winner) && <span className="badge badge-gold">You</span>}
                {r.status === S.Won && " (prize not delivered yet: settle)"} <VerifyButton kind="ticketRaffle" id={r.id} ticketPrice={r.ticketPrice} feeBps={r.feeBps} />
              </div>
            )}
          </div>
        )}
        {(r.status === S.Refunding || r.status === S.Cancelled) && <p className="muted">NFT: {r.nftReturned ? "returned to the creator" : "still in escrow; the creator can reclaim it"}.</p>}

        <div className="form-row raffle-actions">
          {selling && (
            <>
              <div className="stepper" role="group" aria-label={`Number of tickets (${left} left)`}>
                <button type="button" className="chip" disabled={count <= 1} onClick={() => (sound.tick(), setCountText(String(Math.max(1, count - 1))))} aria-label="One ticket fewer">
                  −
                </button>
                <input inputMode="numeric" aria-label={`Tickets (${left} left)`} value={countText} onChange={(e) => setCountText(e.target.value)} />
                <button type="button" className="chip" disabled={count >= left} onClick={() => (sound.tick(), setCountText(String(Math.min(left, count + 1))))} aria-label="One ticket more">
                  +
                </button>
              </div>
              <ActionButton
                className="big"
                onClick={() =>
                  d &&
                  (sound.ticket(),
                  act(`Buy ${count} ticket(s) in raffle #${key}`, "Buy tickets", buyTicketsCall(d, r.id, count, r.ticketPrice), [
                    `You pay ${eth(r.ticketPrice * BigInt(count))} ETH for ${count} ticket(s) at ${eth(r.ticketPrice)} ETH each.`,
                    `One random ticket wins token #${r.tokenId}. If fewer than ${r.minTickets} tickets sell, you can take a full refund.`,
                    "Your odds can fall until the raffle closes, as more tickets are bought.",
                  ]))
                }
                blocked={count < 1 ? "Enter how many tickets to buy" : count > left && `Only ${left} ticket(s) are left`}
              >
                Buy for {count >= 1 ? eth(r.ticketPrice * BigInt(count)) : "–"} ETH
              </ActionButton>
            </>
          )}
          {selling && isMe(r.creator) && r.ticketsSold === 0 && (
            <ActionButton className="secondary" onClick={() => d && act(`Cancel raffle #${key}`, "Cancel", cancelTicketRaffleCall(d, r.id), [`Ends the raffle and returns token #${r.tokenId} from escrow to you.`])}>
              Cancel and take the NFT back
            </ActionButton>
          )}
          {closable && (
            <ActionButton
              className="big"
              onClick={() =>
                d &&
                act(`Close raffle #${key}`, "Close", closeTicketRaffleCall(d, r.id), [
                  wouldRefund
                    ? "Too few tickets sold, the pot is below the minimum, or the raffle ended over a week ago: this opens refunds for buyers and lets the creator reclaim the token."
                    : `Ends ticket sales and requests the random draw among the ${r.ticketsSold} tickets sold.`,
                  "Anyone may do this; you pay only the transaction fee.",
                ])
              }
            >
              {wouldRefund ? "Close (opens refunds)" : "Close and request the draw"}
            </ActionButton>
          )}
          {r.status === S.Drawing && (
            <span className="muted">
              Waiting for randomness
              {abortAt !== undefined && now < abortAt && <>; if none arrives, refunds can be opened from {dateTime(abortAt)}</>}
            </span>
          )}
          {LOCAL_ENABLED && r.status === S.Drawing && isLocal && r.requestId !== undefined && (
            <ActionButton
              className="secondary local"
              onClick={() =>
                d &&
                act(`Answer raffle #${key} draw with mock randomness`, "Mock fulfil", mockFulfillCall(d.ticketRaffleRandomness, r.requestId!, randomWord()), [
                  "Local chain only: answers the draw's randomness request through the mock provider.",
                  "The random word comes from this browser, so this is for testing, not a fair draw.",
                ])
              }
            >
              Local only: draw with mock randomness
            </ActionButton>
          )}
          {resetAt !== undefined && now >= resetAt && (
            <ActionButton className="secondary" onClick={() => d && act(`Reset the draw of raffle #${key}`, "Reset draw", resetTicketDrawCall(d, r.id), ["No randomness arrived within a day. This reopens the raffle so the draw can be requested again."])}>
              Reset the draw (no randomness arrived)
            </ActionButton>
          )}
          {r.status === S.Won && revealed && (
            <ActionButton
              className="big"
              onClick={() =>
                d &&
                act(`Settle raffle #${key}`, "Settle", settleTicketRaffleCall(d, r.id), [
                  `Sends token #${r.tokenId} to the winner, ${r.winner}.`,
                  `Credits the creator with the ticket revenue less the ${bps(r.feeBps)} fee, which goes to the collection's buyback budget.`,
                  "Anyone may do this; you pay only the transaction fee.",
                ])
              }
            >
              Settle: deliver the prize
            </ActionButton>
          )}
          {r.status === S.Refunding && mine > 0 && (
            <ActionButton onClick={() => d && act(`Refund my tickets in raffle #${key}`, "Refund", refundTicketsCall(d, r.id), [`You receive ${eth(r.userPaid ?? 0n)} ETH back.`])}>
              Refund {eth(r.userPaid ?? 0n)} ETH
            </ActionButton>
          )}
          {r.status === S.Refunding && isMe(r.creator) && !r.nftReturned && (
            <ActionButton onClick={() => d && act(`Reclaim the NFT of raffle #${key}`, "Reclaim", reclaimTicketRaffleCall(d, r.id), [`Returns token #${r.tokenId} from escrow to you, the raffle's creator.`])}>
              Reclaim the NFT
            </ActionButton>
          )}
          {abortAt !== undefined && now >= abortAt && (
            <ActionButton className="secondary" onClick={() => d && act(`Abort raffle #${key}`, "Abort", abortTicketRaffleCall(d, r.id), ["The raffle has been stuck for a week. This turns it into refunds: every buyer can take back what they paid, and the creator can reclaim the token."])}>
              Abort: stuck too long, open refunds
            </ActionButton>
          )}
        </div>
      </div>
      <ParticleLayer controller={particles} />
    </article>
  );
}

export function TicketRaffles({ collection }: { collection: Address }) {
  const { client, deployment: d, user } = useProtocol();
  const { run } = useTx();
  const query = useRead(["ticketRaffles", user, collection], (c, dep) => readTicketRaffles(c, dep, user, collection));
  const [form, setForm] = useState({ tokenId: "", price: "", min: "1", max: "", hours: "72" });

  const isMe = (address: Address) => !!user && address.toLowerCase() === user.toLowerCase();
  const input = {
    tokenId: parseUint(form.tokenId),
    price: parseEth(form.price),
    min: Number(parseUint(form.min) ?? -1n),
    max: Number(parseUint(form.max) ?? -1n),
    seconds: Math.round(Number(form.hours) * 3_600),
  };

  const create = () => {
    const { tokenId, price, min, max, seconds } = input;
    if (!client || !d || !user || tokenId === undefined || price === undefined) return;
    const creation = createTicketRaffleCall(d, collection, tokenId, price, min, max, BigInt(seconds));
    void run(`Raffle token #${tokenId}`, async (send) => {
      const token = await readTokenState(client, collection, tokenId, d.ticketRaffle);
      if (!isMe(token.owner)) throw new Error(`You do not own token #${tokenId}.`);
      if (!token.approved) await send("Approve raffle contract", approveCall(collection, d.ticketRaffle, tokenId));
      await send("Create raffle", creation);
    }, [
      `Token #${tokenId} moves from your wallet into escrow in the raffle contract for ${duration(seconds)}.`,
      `Up to ${max} tickets are sold at ${eth(price)} ETH. If at least ${min} sell (and the pot reaches the minimum), a random ticket wins the token and you can withdraw the ticket revenue less the platform fee.`,
      "Otherwise buyers are refunded and you take the token back. You can cancel while no ticket has been sold.",
      "If the raffle contract is not yet approved for this token, an approval transaction comes first.",
    ], {
      plan: [
        { step: "Approve raffle contract (only if it is not approved for this token yet)", call: approveCall(collection, d.ticketRaffle, tokenId) },
        { step: "Create raffle", call: creation },
      ],
    });
  };

  return (
    <div className="play play-raffles">
      <PlayNotices>Paid raffles are regulated or prohibited in many places. Check the law where you are before buying tickets, creating a raffle or operating this.</PlayNotices>
      <QueryView query={query} lines={8}>
        {(t) => (
          <>
            {t.userOwed !== undefined && t.userOwed > 0n && (
              <div className="callout">
                <p>
                  <strong>{eth(t.userOwed)} ETH</strong> of raffle revenue is waiting for you.
                </p>
                <ActionButton onClick={() => d && void run("Withdraw raffle revenue", single("Withdraw", withdrawTicketRaffleCall(d)), [`You receive ${eth(t.userOwed!)} ETH of ticket revenue from the raffle contract.`])}>
                  Withdraw
                </ActionButton>
              </div>
            )}
            {t.raffles.length === 0 && <Empty title="No raffles yet.">Create the first one below.</Empty>}
            {t.raffles.map((r) => (
              <RaffleCard key={r.id.toString()} r={r} t={t} />
            ))}
            <Card title="How it works">
              <p className="muted">
                Anyone can raffle an NFT of an enabled collection for paid tickets. When the raffle ends or sells out, a random
                ticket wins the NFT and the creator receives the ticket revenue less the platform fee, which funds the
                collection's buybacks. If fewer than the minimum number of tickets sell, or the pot is below the raffle's
                minimum ({eth(t.minPot)} ETH for new raffles), every buyer can take a full refund and the creator takes the NFT
                back.
              </p>
              <p className="muted">
                Odds are shown against the tickets sold so far and against the maximum. They can fall until the raffle closes:
                anyone, including the creator, can buy the unsold tickets late.
              </p>
            </Card>
          </>
        )}
      </QueryView>

      <Card title="Raffle a token of the selected collection">
        <QueryView query={query}>
          {(t) => {
            const { tokenId, price, min, max, seconds } = input;
            const blocked = !t.collectionSupported
              ? "The owner has not enabled this collection for raffles"
              : tokenId === undefined || price === undefined
                ? "Enter a token id and a ticket price"
                : max < 1
                  ? "Enter the maximum number of tickets"
                  : min < 0 || min > max
                    ? "The minimum cannot exceed the maximum"
                    : !(seconds >= t.minDuration)
                      ? `A raffle must run for at least ${duration(t.minDuration)}`
                      : seconds > t.maxDuration && `A raffle can run for at most ${duration(t.maxDuration)}`;
            return (
              <>
                <p className="muted">
                  The token is held in escrow until the raffle ends. You can cancel while no ticket has been sold. The platform
                  fee for a new raffle is {bps(t.feeBps)} of the pot. The raffle contract is approved for the token first if it
                  is not already.
                </p>
                <div className="create-raffle">
                  <div className="create-preview" aria-hidden="true">
                    {tokenId !== undefined ? <TokenEmblem collection={collection} tokenId={tokenId} /> : <span className="create-blank">?</span>}
                  </div>
                  <div className="form-row">
                    <Field label="Token id">
                      <input className="narrow" inputMode="numeric" value={form.tokenId} onChange={(e) => setForm({ ...form, tokenId: e.target.value })} />
                    </Field>
                    <Field label="Ticket price (ETH)">
                      <input className="narrow" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
                    </Field>
                    <Field label="Minimum tickets">
                      <input className="narrow" inputMode="numeric" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
                    </Field>
                    <Field label="Maximum tickets">
                      <input className="narrow" inputMode="numeric" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
                    </Field>
                    <Field label="Runs for (hours)">
                      <input className="narrow" inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
                    </Field>
                    <ActionButton onClick={create} blocked={blocked}>
                      Create raffle
                    </ActionButton>
                  </div>
                </div>
                {max >= 1 && min >= 0 && min <= max && max <= 200 && <TicketStrip sold={0} max={max} min={min} mine={0} />}
                {price !== undefined && min >= 0 && price * BigInt(Math.max(min, 1)) < t.minPot && (
                  <p className="muted">
                    Note: {Math.max(min, 1)} ticket(s) at this price is below the {eth(t.minPot)} ETH minimum pot, so the raffle is
                    refunded unless more sell.
                  </p>
                )}
              </>
            );
          }}
        </QueryView>
      </Card>
    </div>
  );
}
