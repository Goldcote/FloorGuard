// Pieces shared by the Dice and Slots pages, which both play against the same house bankroll.
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { mockFulfillCall, refundBetCall, withdrawGamesCall } from "../lib/calls";
import { bps, dateTime, eth } from "../lib/format";
import { randomWord } from "../lib/parse";
import { gameLimits, readGames, readUserBets, slotsMultiplier, type GameBet, type GamesState } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, QueryView, Stat } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";
import { VerifyButton } from "./Verify";

export const GAMES_NOTICE =
  "Games of chance are regulated or prohibited in many places. Check the law where you are before playing or operating this.";

/** House state for a collection, and the connected account's bets (all kinds, newest first). */
export function useGames(collection: Address) {
  const { user } = useProtocol();
  const games = useRead(["games", collection, user], (c, d) => readGames(c, d, collection, user));
  const refundTimeout = games.data?.refundTimeout;
  const bets = useRead(
    ["gameBets", user, refundTimeout],
    (c, d) => readUserBets(c, d, user!, refundTimeout!, LOGS_FROM_BLOCK),
    !!user && refundTimeout !== undefined,
  );
  return { games, bets };
}

export function HouseStats({ g, maxWager, maxLabel }: { g: GamesState; maxWager: bigint | undefined; maxLabel: string }) {
  const limits = gameLimits(g);
  return (
    <div className="stats">
      <Stat label="House bankroll" value={`${eth(g.bankroll)} ETH`} hint="Free funds, not set aside for open bets" />
      <Stat label="Edge" value={bps(g.edgeBps)} hint="Of each wager, to the collection's buyback budget" />
      <Stat
        label={maxLabel}
        value={maxWager !== undefined ? `${eth(maxWager)} ETH` : "–"}
        hint={`Minimum ${eth(g.minBet)} ETH. ${
          limits.totalRoom < limits.perBet ? "Limited by the cap on all open bets together" : `One bet may risk ${bps(g.maxExposureBps)} of the bankroll`
        }`}
      />
      <Stat
        label="Reserved for open bets"
        value={`${eth(g.reserved)} ETH`}
        hint={`Cap ${bps(g.maxTotalExposureBps)} of house funds; ${eth(limits.totalRoom)} ETH of room left`}
      />
    </div>
  );
}

/** Winnings that could not be delivered to the account wait in the contract. */
export function OwedRow({ g }: { g: GamesState }) {
  const { deployment: d } = useProtocol();
  const { run } = useTx();
  if (!d || g.userOwed === undefined || g.userOwed === 0n) return null;
  const owed = g.userOwed;
  return (
    <div className="callout">
      <p>
        <strong>{eth(owed)} ETH</strong> could not be delivered to your account and is waiting.
      </p>
      <ActionButton
        onClick={() =>
          void run("Withdraw owed winnings", (send) => send("Withdraw", withdrawGamesCall(d)), [`You receive ${eth(owed)} ETH from the Games contract.`])
        }
      >
        Withdraw
      </ActionButton>
    </div>
  );
}

function resultText(bet: GameBet): string {
  if (bet.status === "refunded") return "Wager returned";
  if (bet.status === "pending") return "Waiting for randomness";
  if (bet.kind === "slots") {
    const multiplier = slotsMultiplier(bet.roll ?? 0);
    return multiplier === 0 ? `Rolled ${bet.roll}: no prize` : `Rolled ${bet.roll}: ${multiplier}×, paid ${eth(bet.payout ?? 0n)} ETH`;
  }
  return bet.status === "won"
    ? `Rolled ${bet.roll}, below ${bet.chanceBps}: paid ${eth(bet.payout ?? 0n)} ETH`
    : `Rolled ${bet.roll}, needed below ${bet.chanceBps}`;
}

export function BetList({ bets, kind, title }: { bets: ReturnType<typeof useGames>["bets"]; kind: GameBet["kind"]; title: string }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const isLocal = chainId === anvil.id;

  const refund = (bet: GameBet) =>
    void run(`Refund bet #${bet.requestId}`, (send) => send("Refund", refundBetCall(d!, bet.requestId)), [
      `The ${eth(bet.wager)} ETH wager returns to the account that placed the bet.`,
      "No fee is taken on a refunded bet.",
    ]);
  const settleLocally = (bet: GameBet) =>
    void run(
      `Settle bet #${bet.requestId} with mock randomness`,
      (send) => send("Mock fulfil", mockFulfillCall(d!.gamesRandomness, bet.requestId, randomWord())),
      [
        "Local chain only: answers the bet's randomness request through the mock provider.",
        "The random word comes from this browser, so this is for testing, not a fair game.",
      ],
    );

  return (
    <Card title={title}>
      {!user ? (
        <Empty title="Connect a wallet to see your bets." />
      ) : (
        <QueryView query={bets}>
          {(all) => {
            const list = all.filter((bet) => bet.kind === kind);
            if (list.length === 0) return <Empty title="Nothing here yet.">Your bets appear here once placed.</Empty>;
            return (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Backing</th>
                      <th>Wager</th>
                      {kind === "dice" && <th>Chance</th>}
                      <th>Status</th>
                      <th>Result</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((bet) => {
                      const refundable = bet.status === "pending" && bet.refundableAt !== undefined && now >= bet.refundableAt;
                      const net = bet.status === "won" && (bet.payout ?? 0n) > bet.wager;
                      return (
                        <tr key={bet.requestId.toString()}>
                          <td>{bet.requestId.toString()}</td>
                          <td><Addr address={bet.collection} /></td>
                          <td>{eth(bet.wager)} ETH</td>
                          {kind === "dice" && <td>{bps(bet.chanceBps)}</td>}
                          <td>
                            {refundable ? (
                              <Badge tone="warn">Refundable</Badge>
                            ) : bet.status === "pending" ? (
                              <Badge tone="warn">Pending</Badge>
                            ) : bet.status === "refunded" ? (
                              <Badge tone="muted">Refunded</Badge>
                            ) : bet.status === "won" ? (
                              <Badge tone={net ? "good" : "muted"}>{net ? "Won" : "Stake back"}</Badge>
                            ) : (
                              <Badge tone="bad">Lost</Badge>
                            )}
                          </td>
                          <td className="wrap">
                            {refundable ? "No randomness arrived" : resultText(bet)}
                            {bet.status === "pending" && !refundable && bet.refundableAt && (
                              <span className="muted small"> (refundable from {dateTime(bet.refundableAt)})</span>
                            )}
                          </td>
                          <td className="actions">
                            {(bet.status === "won" || bet.status === "lost") && <VerifyButton kind="bet" requestId={bet.requestId} />}
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
            );
          }}
        </QueryView>
      )}
    </Card>
  );
}

// The highest bet id that existed when this page session first saw an account's bets. Bets above it
// were placed in this session.
const sessionStart = new Map<string, bigint>();

/**
 * What the account's dice and slots bets of this page session add up to: wagered, paid back, net.
 * Always shown next to the game, whatever the result of the last bet.
 */
export function SessionNet({ bets }: { bets: GameBet[] | undefined }) {
  const { user, chainId } = useProtocol();
  if (!user || !bets) return null;
  const key = `${chainId}:${user}`;
  if (!sessionStart.has(key)) sessionStart.set(key, bets.reduce((max, bet) => (bet.requestId > max ? bet.requestId : max), 0n));
  const since = sessionStart.get(key)!;
  const settled = bets.filter((bet) => bet.requestId > since && (bet.status === "won" || bet.status === "lost"));
  const wagered = settled.reduce((sum, bet) => sum + bet.wager, 0n);
  const returned = settled.reduce((sum, bet) => sum + (bet.payout ?? 0n), 0n);
  const net = returned - wagered;
  return (
    <div className="session" role="status" aria-label="Your session so far">
      <span>
        This session: <strong>{settled.length}</strong> settled
      </span>
      <span>
        wagered <strong>{eth(wagered)}</strong>
      </span>
      <span>
        paid back <strong>{eth(returned)}</strong>
      </span>
      <span className={net > 0n ? "net up" : net < 0n ? "net down" : "net"}>
        net <strong>{net > 0n ? "+" : net < 0n ? "−" : ""}{eth(net < 0n ? -net : net)} ETH</strong>
      </span>
    </div>
  );
}
