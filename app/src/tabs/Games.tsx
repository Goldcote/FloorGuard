import { useState } from "react";
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { mockFulfillCall, playCall, refundBetCall, withdrawGamesCall } from "../lib/calls";
import { bps, dateTime, eth } from "../lib/format";
import { parseEth, randomWord } from "../lib/parse";
import { gameLimits, maxGameWager, readGameQuote, readGames, readUserBets, type GameBet } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Field, QueryView, Stat } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";

const STATUS: Record<GameBet["status"], { tone: "good" | "warn" | "bad" | "muted"; label: string }> = {
  pending: { tone: "warn", label: "Pending" },
  won: { tone: "good", label: "Won" },
  lost: { tone: "bad", label: "Lost" },
  refunded: { tone: "muted", label: "Refunded" },
};

export function Games({ collection }: { collection: Address }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const [chancePercent, setChancePercent] = useState(50);
  const [wagerText, setWagerText] = useState("");

  const chanceBps = chancePercent * 100;
  const wager = parseEth(wagerText);
  const isLocal = chainId === anvil.id;

  const games = useRead(["games", collection, user], (c, dep) => readGames(c, dep, collection, user));
  const quote = useRead(
    ["gameQuote", wager?.toString(), chanceBps],
    (c, dep) => readGameQuote(c, dep, wager!, chanceBps),
    wager !== undefined,
  );
  const refundTimeout = games.data?.refundTimeout;
  const bets = useRead(
    ["gameBets", user, refundTimeout],
    (c, dep) => readUserBets(c, dep, user!, refundTimeout!, LOGS_FROM_BLOCK),
    !!user && refundTimeout !== undefined,
  );

  const play = () => {
    if (!d || wager === undefined) return;
    void run(`Bet ${eth(wager)} ETH at ${chancePercent}%`, (send) => send("Play", playCall(d, collection, chanceBps, wager)));
  };
  const refund = (bet: GameBet) =>
    void run(`Refund bet #${bet.requestId}`, (send) => send("Refund", refundBetCall(d!, bet.requestId)));
  const withdraw = () => void run("Withdraw owed winnings", (send) => send("Withdraw", withdrawGamesCall(d!)));
  const settleLocally = (bet: GameBet) =>
    void run(`Settle bet #${bet.requestId} with mock randomness`, (send) =>
      send("Mock fulfil", mockFulfillCall(d!.gamesRandomness, bet.requestId, randomWord())),
    );

  return (
    <>
      <Card title="Dice and coinflip">
        <p className="notice">
          Games of chance are regulated or prohibited in many places. Check the law where you are before playing or
          operating this.
        </p>
        <QueryView query={games}>
          {(g) => {
            const maxWager = maxGameWager(g, chanceBps);
            const limits = gameLimits(g);
            const totalCapBinds = limits.totalRoom < limits.perBet;
            const blocked = !g.supported
              ? "Games are not enabled for this collection"
              : wager === undefined
                ? "Enter a wager"
                : wager < g.minBet
                  ? `The minimum bet is ${eth(g.minBet)} ETH`
                  : maxWager !== undefined && wager > maxWager && `The maximum wager at ${chancePercent}% is ${eth(maxWager)} ETH`;
            return (
              <>
                <p className="muted">
                  Pick your chance of winning and bet against the house bankroll. {bps(g.edgeBps)} of every wager is
                  taken as a fee for the selected collection's buybacks; the rest is played at fair odds. The result
                  arrives with the randomness provider's answer, usually a little after the bet.
                </p>
                <div className="stats">
                  <Stat label="Bankroll" value={`${eth(g.bankroll)} ETH`} hint="House funds not set aside for open bets" />
                  <Stat label="Edge" value={bps(g.edgeBps)} hint="Of each wager, to the buyback budget" />
                  <Stat
                    label="Max exposure per bet"
                    value={bps(g.maxExposureBps)}
                    hint={`Of the bankroll: ${eth(limits.perBet)} ETH at risk at most`}
                  />
                  <Stat
                    label="Reserved for open bets"
                    value={`${eth(g.reserved)} ETH`}
                    hint={`All open bets together may reserve ${bps(g.maxTotalExposureBps)} of the house funds; ${eth(limits.totalRoom)} ETH of room left`}
                  />
                  <Stat
                    label={`Max wager at ${chancePercent}%`}
                    value={maxWager !== undefined ? `${eth(maxWager)} ETH` : "–"}
                    hint={`Minimum ${eth(g.minBet)} ETH. ${totalCapBinds ? "Limited by the cap on all open bets together" : "Limited by the per-bet cap"}`}
                  />
                  <Stat
                    label="Collection"
                    value={g.supported ? <Badge tone="good">Enabled</Badge> : <Badge tone="warn">Not enabled</Badge>}
                    hint={g.supported ? "Fees fund this collection's buybacks" : "Bets cannot back this collection"}
                  />
                </div>
                <div className="form-row">
                  <Field label={`Chance of winning: ${chancePercent}%`}>
                    <input
                      type="range"
                      min={1}
                      max={95}
                      step={1}
                      value={chancePercent}
                      onChange={(e) => setChancePercent(Number(e.target.value))}
                    />
                  </Field>
                  <button className="secondary" onClick={() => setChancePercent(50)}>
                    Coinflip (50%)
                  </button>
                  <Field label="Wager (ETH)">
                    <input className="narrow" inputMode="decimal" value={wagerText} onChange={(e) => setWagerText(e.target.value)} />
                  </Field>
                  <ActionButton onClick={play} blocked={blocked}>
                    Play
                  </ActionButton>
                </div>
                <p className="muted quote">
                  {wager === undefined
                    ? "Enter a wager to see the payout."
                    : quote.data
                      ? `A win pays ${eth(quote.data.payout)} ETH (your wager included); the fee is ${eth(quote.data.fee)} ETH. A loss costs the whole wager.`
                      : quote.isError
                        ? "Could not load the quote."
                        : "Loading the quote…"}
                </p>
                {g.userOwed !== undefined && g.userOwed > 0n && (
                  <div className="form-row">
                    <p>
                      <strong>{eth(g.userOwed)} ETH</strong> could not be delivered to your account and is waiting.
                    </p>
                    <ActionButton onClick={withdraw}>Withdraw</ActionButton>
                  </div>
                )}
              </>
            );
          }}
        </QueryView>
      </Card>

      <Card title="Your recent bets">
        {!user ? (
          <p className="muted">Connect a wallet to see your bets.</p>
        ) : (
          <QueryView query={bets}>
            {(list) =>
              list.length === 0 ? (
                <p className="muted">No bets yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Collection</th>
                        <th>Wager</th>
                        <th>Chance</th>
                        <th>Status</th>
                        <th>Result</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((bet) => {
                        const refundable = bet.status === "pending" && bet.refundableAt !== undefined && now >= bet.refundableAt;
                        return (
                          <tr key={bet.requestId.toString()}>
                            <td>{bet.requestId.toString()}</td>
                            <td><Addr address={bet.collection} /></td>
                            <td>{eth(bet.wager)} ETH</td>
                            {/* A chance of 0 marks a slots spin, which this tab cannot place but may have to list. */}
                            <td>{bet.chanceBps === 0 ? "Slots" : bps(bet.chanceBps)}</td>
                            <td>
                              {refundable ? <Badge tone="warn">Refundable</Badge> : <Badge tone={STATUS[bet.status].tone}>{STATUS[bet.status].label}</Badge>}
                            </td>
                            <td className="wrap">
                              {bet.status === "won" && `Rolled ${bet.roll}, paid ${eth(bet.payout ?? 0n)} ETH`}
                              {bet.status === "lost" &&
                                (bet.chanceBps === 0 ? `Rolled ${bet.roll}, no payout` : `Rolled ${bet.roll}, needed below ${bet.chanceBps}`)}
                              {bet.status === "refunded" && "Wager returned"}
                              {bet.status === "pending" &&
                                (refundable
                                  ? "No randomness arrived"
                                  : `Waiting for randomness${bet.refundableAt ? `; refundable from ${dateTime(bet.refundableAt)}` : ""}`)}
                            </td>
                            <td className="actions">
                              {refundable && <ActionButton onClick={() => refund(bet)}>Refund</ActionButton>}
                              {bet.status === "pending" && isLocal && (
                                <ActionButton className="secondary local" onClick={() => settleLocally(bet)}>
                                  Local only: settle with mock randomness
                                </ActionButton>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </QueryView>
        )}
      </Card>
    </>
  );
}
