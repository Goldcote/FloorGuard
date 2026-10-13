import { useState } from "react";
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
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
import { bps, dateTime, duration, eth, relative } from "../lib/format";
import { parseEth, parseUint, randomWord } from "../lib/parse";
import {
  abortableAt,
  readTicketRaffles,
  readTokenState,
  TICKET_RAFFLE_STATUS_NAMES,
  TicketRaffleStatus as S,
  ticketRaffleWouldRefund,
} from "../lib/reads";
import { useTx } from "../tx";
import { RandomnessNotice, VerifyButton } from "./Verify";
import { ActionButton, Addr, Badge, Card, Empty, Field, Notice, QueryView } from "../ui";

const TONE = ["muted", "good", "warn", "good", "muted", "warn", "muted"] as const;

/** A share as a percentage with up to two decimals. */
function percent(part: number, whole: number): string {
  return `${Math.round((part / whole) * 10_000) / 100}%`;
}

export function TicketRaffles({ collection }: { collection: Address }) {
  const { chainId, client, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const isLocal = chainId === anvil.id;
  const query = useRead(["ticketRaffles", user, collection], (c, dep) => readTicketRaffles(c, dep, user, collection));

  const [counts, setCounts] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ tokenId: "", price: "", min: "1", max: "", hours: "72" });

  const isMe = (address: Address) => !!user && address.toLowerCase() === user.toLowerCase();
  const act = (title: string, step: string, call: Call, details: string[]) =>
    void run(title, (send) => send(step, call), details);

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
    void run(`Raffle token #${tokenId}`, async (send) => {
      const token = await readTokenState(client, collection, tokenId, d.ticketRaffle);
      if (!isMe(token.owner)) throw new Error(`You do not own token #${tokenId}.`);
      if (!token.approved) await send("Approve raffle contract", approveCall(collection, d.ticketRaffle, tokenId));
      await send("Create raffle", createTicketRaffleCall(d, collection, tokenId, price, min, max, BigInt(seconds)));
    }, [
      `Token #${tokenId} moves from your wallet into escrow in the raffle contract for ${duration(seconds)}.`,
      `Up to ${max} tickets are sold at ${eth(price)} ETH. If at least ${min} sell (and the pot reaches the minimum), a random ticket wins the token and you can withdraw the ticket revenue less the platform fee.`,
      "Otherwise buyers are refunded and you take the token back. You can cancel while no ticket has been sold.",
      "If the raffle contract is not yet approved for this token, an approval transaction comes first.",
    ]);
  };

  return (
    <>
      <Card title="Ticket raffles">
        <Notice>
          Paid raffles are regulated or prohibited in many places. Check the law where you are before buying tickets,
          creating a raffle or operating this.
        </Notice>
        <RandomnessNotice />
        <QueryView query={query}>
          {(t) => (
            <>
              <p className="muted">
                Anyone can raffle an NFT of an enabled collection for paid tickets. When the raffle ends or sells out, a
                random ticket wins the NFT and the creator receives the ticket revenue less the platform fee, which
                funds the collection's buybacks. If fewer than the minimum number of tickets sell, or the pot is below
                the raffle's minimum ({eth(t.minPot)} ETH for new raffles), every buyer can take a full refund and the
                creator takes the NFT back.
              </p>
              <p className="muted">
                Odds are shown against the tickets sold so far and against the maximum. They can fall until the raffle
                closes: anyone, including the creator, can buy the unsold tickets late.
              </p>
              {t.userOwed !== undefined && t.userOwed > 0n && (
                <div className="form-row owed">
                  <p>
                    <strong>{eth(t.userOwed)} ETH</strong> of raffle revenue is waiting for you.
                  </p>
                  <ActionButton onClick={() => d && act("Withdraw raffle revenue", "Withdraw", withdrawTicketRaffleCall(d), [`You receive ${eth(t.userOwed!)} ETH of ticket revenue from the raffle contract.`])}>
                    Withdraw
                  </ActionButton>
                </div>
              )}
              {t.raffles.length === 0 && <Empty title="No raffles yet.">Create the first one below.</Empty>}
              {t.raffles.map((r) => {
                const key = r.id.toString();
                const selling = r.status === S.Open && now < r.endTime && r.ticketsSold < r.maxTickets;
                const closable = r.status === S.Open && !selling;
                const left = r.maxTickets - r.ticketsSold;
                const count = Number(parseUint(counts[key] ?? "1") ?? 0n);
                const mine = r.userTickets ?? 0;
                const abortAt = abortableAt(r, r.status === S.Open ? "open" : r.status === S.Drawing ? "drawing" : r.status === S.Won ? "won" : "done", t);
                const resetAt = r.status === S.Drawing ? r.requestedAt + t.drawTimeout : undefined;
                const wouldRefund = ticketRaffleWouldRefund(r, now, t.abortDelay);
                return (
                  <div className="item" key={key}>
                    <div className="item-head">
                      <strong>Raffle #{key}</strong>
                      <span>
                        Prize: token #{r.tokenId.toString()} of <Addr address={r.collection} />
                      </span>
                      <Badge tone={TONE[r.status] ?? "muted"}>{TICKET_RAFFLE_STATUS_NAMES[r.status] ?? r.status}</Badge>
                      {r.status === S.Open && !selling && (
                        <Badge tone="warn">{r.ticketsSold >= r.maxTickets ? "Sold out" : "Sales ended"}</Badge>
                      )}
                      {isMe(r.creator) && <Badge tone="muted">Your raffle</Badge>}
                    </div>
                    <table className="facts">
                      <tbody>
                        <tr>
                          <th>Ticket price</th>
                          <td>{eth(r.ticketPrice)} ETH</td>
                          <th>Tickets</th>
                          <td>
                            {r.ticketsSold} sold, minimum {r.minTickets}, maximum {r.maxTickets}
                          </td>
                        </tr>
                        <tr>
                          <th>{r.status === S.Open ? (now < r.endTime ? "Ends" : "Ended") : "End time"}</th>
                          <td title={dateTime(r.endTime)}>
                            {r.status === S.Open ? relative(r.endTime, now) : dateTime(r.endTime)}
                          </td>
                          <th>Creator</th>
                          <td>
                            <Addr address={r.creator} /> (fee {bps(r.feeBps)} of the pot)
                          </td>
                        </tr>
                        <tr>
                          <th>Your tickets</th>
                          <td>
                            {r.userTickets === undefined ? (
                              <span className="muted">Connect a wallet</span>
                            ) : r.status === S.Refunding ? (
                              mine > 0 ? `${mine}, refundable: ${eth(r.userPaid ?? 0n)} ETH` : "None, or already refunded"
                            ) : (
                              mine
                            )}
                          </td>
                          <th>Your odds</th>
                          <td>
                            {mine > 0 && r.ticketsSold > 0 && (r.status === S.Open || r.status === S.Drawing) ? (
                              <>
                                {percent(mine, r.ticketsSold)} of tickets sold
                                {selling && `; ${percent(mine, r.maxTickets)} if all ${r.maxTickets} sell`}
                              </>
                            ) : (
                              "–"
                            )}
                          </td>
                        </tr>
                        {(r.status === S.Won || r.status === S.Settled) && (
                          <tr>
                            <th>Winner</th>
                            <td colSpan={3}>
                              <Addr address={r.winner} /> {isMe(r.winner) && <Badge tone="good">You</Badge>}
                              {r.status === S.Won && " (prize not delivered yet: settle)"}{" "}
                              <VerifyButton kind="ticketRaffle" id={r.id} ticketPrice={r.ticketPrice} feeBps={r.feeBps} />
                            </td>
                          </tr>
                        )}
                        {(r.status === S.Refunding || r.status === S.Cancelled) && (
                          <tr>
                            <th>NFT</th>
                            <td colSpan={3}>{r.nftReturned ? "Returned to the creator" : "Still in escrow; the creator can reclaim it"}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    <div className="form-row">
                      {selling && (
                        <>
                          <Field label={`Tickets (${left} left)`}>
                            <input
                              className="narrow"
                              inputMode="numeric"
                              value={counts[key] ?? "1"}
                              onChange={(e) => setCounts((s) => ({ ...s, [key]: e.target.value }))}
                            />
                          </Field>
                          <ActionButton
                            onClick={() => d && act(`Buy ${count} ticket(s) in raffle #${key}`, "Buy tickets", buyTicketsCall(d, r.id, count, r.ticketPrice), [
                                `You pay ${eth(r.ticketPrice * BigInt(count))} ETH for ${count} ticket(s) at ${eth(r.ticketPrice)} ETH each.`,
                                `One random ticket wins token #${r.tokenId}. If fewer than ${r.minTickets} tickets sell, you can take a full refund.`,
                                "Your odds can fall until the raffle closes, as more tickets are bought.",
                              ])}
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
                        <ActionButton onClick={() => d && act(`Close raffle #${key}`, "Close", closeTicketRaffleCall(d, r.id), [
                              wouldRefund
                                ? "Too few tickets sold, the pot is below the minimum, or the raffle ended over a week ago: this opens refunds for buyers and lets the creator reclaim the token."
                                : `Ends ticket sales and requests the random draw among the ${r.ticketsSold} tickets sold.`,
                              "Anyone may do this; you pay only the transaction fee.",
                            ])}>
                          {wouldRefund ? "Close (opens refunds)" : "Close and request the draw"}
                        </ActionButton>
                      )}
                      {r.status === S.Drawing && (
                        <span className="muted">
                          Waiting for randomness
                          {abortAt !== undefined && now < abortAt && <>; if none arrives, refunds can be opened from {dateTime(abortAt)}</>}
                        </span>
                      )}
                      {r.status === S.Drawing && isLocal && r.requestId !== undefined && (
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
                      {r.status === S.Won && (
                        <ActionButton onClick={() => d && act(`Settle raffle #${key}`, "Settle", settleTicketRaffleCall(d, r.id), [
                              `Sends token #${r.tokenId} to the winner, ${r.winner}.`,
                              `Credits the creator with the ticket revenue less the ${bps(r.feeBps)} fee, which goes to the collection's buyback budget.`,
                              "Anyone may do this; you pay only the transaction fee.",
                            ])}>
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
                );
              })}
            </>
          )}
        </QueryView>
      </Card>

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
                  The token is held in escrow until the raffle ends. You can cancel while no ticket has been sold. The
                  platform fee for a new raffle is {bps(t.feeBps)} of the pot. The raffle contract is approved for the
                  token first if it is not already.
                </p>
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
                {price !== undefined && min >= 0 && price * BigInt(Math.max(min, 1)) < t.minPot && (
                  <p className="muted">
                    Note: {Math.max(min, 1)} ticket(s) at this price is below the {eth(t.minPot)} ETH minimum pot, so the
                    raffle is refunded unless more sell.
                  </p>
                )}
              </>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
