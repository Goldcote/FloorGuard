import { useState } from "react";
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
import { useChainTime, useProtocol, useRead } from "../hooks";
import {
  abortLotteryCall,
  buyLotteryTicketsCall,
  drawLotteryCall,
  mockFulfillCall,
  refundLotteryCall,
  resetLotteryDrawCall,
  withdrawLotteryCall,
} from "../lib/calls";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parseUint, randomWord } from "../lib/parse";
import { abortableAt, lotteryWouldRefund, LOTTERY_STATUS_NAMES, LotteryStatus as S, readLottery, type LotteryRound, type LotteryState } from "../lib/reads";
import { useTx } from "../tx";
import { RandomnessNotice, VerifyButton } from "./Verify";
import { ActionButton, Addr, Badge, Card, Empty, Field, Notice, QueryView, Stat, Time } from "../ui";

const TONE = ["muted", "good", "warn", "accent", "warn"] as const;

/** A share as a percentage with up to two decimals. */
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 10_000) / 100}%`;

function statusBadge(round: LotteryRound, now: number) {
  if (round.status === S.Open && now >= round.endTime) return <Badge tone="warn">Ended, not drawn</Badge>;
  return <Badge tone={TONE[round.status] ?? "muted"}>{LOTTERY_STATUS_NAMES[round.status] ?? round.status}</Badge>;
}

/** The buttons that apply to a round right now. Renders nothing when none does. */
function RoundActions({ round, state }: { round: LotteryRound; state: LotteryState }) {
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

export function Lottery({ collection }: { collection: Address }) {
  const { deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["lottery", collection, user], (c, dep) => readLottery(c, dep, collection, user));
  const [countText, setCountText] = useState("1");

  return (
    <>
      <Card title="Lottery">
        <Notice>
          Lotteries are regulated or prohibited in many places. Check the law where you are before buying tickets or
          operating this.
        </Notice>
        <RandomnessNotice />
        <QueryView query={query} lines={5}>
          {(t) => {
            const round = t.current;
            const selling = !!round && round.status === S.Open && now < round.endTime;
            // Tickets land in the open round at its price, or open the next round at the configured price.
            const price = selling ? round.ticketPrice : t.config.ticketPrice;
            const count = Number(parseUint(countText) ?? 0n);
            const canBuy = selling || t.config.active;
            const nextRoundFee = selling ? round.feeBps : Number(t.feeBps);
            const buy = () => {
              if (!d || count < 1) return;
              const cost = price * BigInt(count);
              void run(`Buy ${count} lottery ticket${count === 1 ? "" : "s"}`, (send) => send("Buy tickets", buyLotteryTicketsCall(d, collection, count, price)), [
                `You pay ${eth(cost)} ETH for ${count} ticket${count === 1 ? "" : "s"} at ${eth(price)} ETH each.`,
                selling
                  ? `They join round #${round.id}, which ends ${dateTime(round.endTime)}.`
                  : `The latest round has ended, so this opens a new round lasting ${duration(t.config.duration)}.`,
                `One random ticket wins the pot less ${bps(nextRoundFee)}, which goes to the collection's buyback budget.`,
                `If the round's pot ends below ${eth(selling ? round.minPot : t.minPot)} ETH, or it is never drawn, you can take a full refund.`,
              ]);
            };
            return (
              <>
                <p className="muted">
                  Each round sells tickets at a fixed price for a fixed time. Then one random ticket wins the pot, less
                  a fee that funds the selected collection's buybacks. The first ticket bought after a round has ended
                  opens the next one. More tickets sold means a bigger pot and lower odds per ticket.
                </p>
                {t.userOwed !== undefined && t.userOwed > 0n && d && (
                  <div className="callout good">
                    <p>
                      <strong>{eth(t.userOwed)} ETH</strong> of lottery winnings is waiting for you.
                    </p>
                    <ActionButton
                      onClick={() =>
                        void run("Withdraw lottery winnings", (send) => send("Withdraw", withdrawLotteryCall(d)), [`You receive ${eth(t.userOwed!)} ETH from the Lottery contract.`])
                      }
                    >
                      Withdraw
                    </ActionButton>
                  </div>
                )}

                {!round ? (
                  <Empty title={t.config.active ? "No round yet." : "No lottery for this collection."}>
                    {t.config.active
                      ? `The first ticket opens a round of ${duration(t.config.duration)} at ${eth(t.config.ticketPrice)} ETH a ticket.`
                      : "The owner has not configured a lottery for this collection."}
                  </Empty>
                ) : (
                  <div className="round">
                    <div className="item-head">
                      <h3>Round #{round.id.toString()}</h3>
                      {statusBadge(round, now)}
                    </div>
                    <div className="stats">
                      <Stat label="Pot" value={`${eth(round.pot)} ETH`} hint={`${round.ticketsSold} tickets at ${eth(round.ticketPrice)} ETH`} />
                      <Stat
                        label="Prize after fee"
                        value={`${eth(round.prize)} ETH`}
                        hint={`${bps(round.feeBps)} of the pot (${eth(round.pot - round.prize)} ETH) funds buybacks`}
                      />
                      <Stat
                        label={now < round.endTime ? "Ends" : "Ended"}
                        value={<Time at={round.endTime} now={now} />}
                        hint={dateTime(round.endTime)}
                      />
                      <Stat
                        label="Your tickets"
                        value={round.userTickets === undefined ? <span className="muted">Connect a wallet</span> : round.userTickets}
                        hint={
                          round.userTickets && round.ticketsSold > 0 && (round.status === S.Open || round.status === S.Drawing)
                            ? `Odds now: ${percent(round.userTickets, round.ticketsSold)}${selling ? "; they fall as more tickets sell" : ""}`
                            : round.status === S.Refunding && (round.userPaid ?? 0n) > 0n
                              ? `Refundable: ${eth(round.userPaid!)} ETH`
                              : undefined
                        }
                      />
                    </div>
                    {round.status === S.Won && (
                      <p>
                        Winner: <Addr address={round.winner} />{" "}
                        {user && round.winner.toLowerCase() === user.toLowerCase() && <Badge tone="good">You</Badge>} won{" "}
                        {eth(round.prize)} ETH. <VerifyButton kind="lottery" id={round.id} ticketPrice={round.ticketPrice} feeBps={BigInt(round.feeBps)} />
                      </p>
                    )}
                    {round.status === S.Open && now >= round.endTime && (
                      <p className="muted">
                        {round.pot < round.minPot
                          ? `The pot is below the round's ${eth(round.minPot)} ETH minimum, so ending the round opens refunds.`
                          : "The round is over. Anyone can request the draw."}
                      </p>
                    )}
                    <div className="form-row">
                      <RoundActions round={round} state={t} />
                    </div>
                  </div>
                )}

                {canBuy && (
                  <div className="buy-box">
                    <h3>{selling ? "Buy tickets" : round ? `Buy tickets (opens round #${(round.id + 1n).toString()} or later)` : "Buy the first tickets"}</h3>
                    <div className="form-row">
                      <Field label={`Tickets at ${eth(price)} ETH each`}>
                        <input className="narrow" inputMode="numeric" value={countText} onChange={(e) => setCountText(e.target.value)} />
                      </Field>
                      <ActionButton onClick={buy} blocked={count < 1 && "Enter how many tickets to buy"}>
                        Buy for {count >= 1 ? eth(price * BigInt(count)) : "–"} ETH
                      </ActionButton>
                      {selling && round.ticketsSold + count > 0 && count >= 1 && (
                        <p className="muted grow">
                          With {count} more, {round.userTickets !== undefined ? `you would hold ${round.userTickets + count} of ` : ""}
                          {round.ticketsSold + count} tickets
                          {round.userTickets !== undefined ? `: ${percent(round.userTickets + count, round.ticketsSold + count)} odds at that moment.` : "."}
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {!canBuy && round && <p className="muted">The owner has turned the lottery off for this collection; no new round will open.</p>}
              </>
            );
          }}
        </QueryView>
      </Card>

      <Card title="Earlier rounds">
        <QueryView query={query}>
          {(t) =>
            t.past.length === 0 ? (
              <Empty title="No earlier rounds." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Ended</th>
                      <th>Tickets</th>
                      <th>Pot</th>
                      <th>Status</th>
                      <th>Winner</th>
                      <th>Yours</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.past.map((round) => (
                      <tr key={round.id.toString()}>
                        <td>#{round.id.toString()}</td>
                        <td><Time at={round.endTime} now={now} /></td>
                        <td>{round.ticketsSold}</td>
                        <td>{eth(round.pot)} ETH</td>
                        <td>{statusBadge(round, now)}</td>
                        <td>
                          {round.status === S.Won ? (
                            <>
                              <Addr address={round.winner} /> <span className="muted">won {eth(round.prize)} ETH</span>
                            </>
                          ) : (
                            "–"
                          )}
                        </td>
                        <td>{round.userTickets ?? "–"}</td>
                        <td className="actions">
                          {round.status === S.Won && <VerifyButton kind="lottery" id={round.id} ticketPrice={round.ticketPrice} feeBps={BigInt(round.feeBps)} />}
                          <RoundActions round={round} state={t} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
