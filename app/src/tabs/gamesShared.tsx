// Pieces shared by the Dice and Slots stages, which both play against the same house bankroll:
// the bets query, the result clock (pending -> reveal -> outcome), the wager control, the session
// total and the history.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { anvil } from "wagmi/chains";
import { AmountCount, DICE_REVEAL_MS, observeReveal, SLOTS_REVEAL_MS, useRevealClock, type RevealPhase } from "../fx";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { mockFulfillCall, refundBetCall, withdrawGamesCall } from "../lib/calls";
import { bps, dateTime, eth } from "../lib/format";
import { parseEth, randomWord } from "../lib/parse";
import { gameLimits, readGames, readUserBets, slotsMultiplier, type GameBet, type GamesState } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, Notice, QueryView, Stat } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";
import { RandomnessNotice, VerifyButton } from "./Verify";

export const GAMES_NOTICE =
  "Games of chance are regulated or prohibited in many places. Check the law where you are before playing or operating this.";

/** The regulatory line and the randomness notice, together above every stage. */
export function PlayNotices({ children }: { children: ReactNode }) {
  return (
    <div className="play-notices">
      <Notice>{children}</Notice>
      <RandomnessNotice />
    </div>
  );
}

// ---------------------------------------------------------------- result clock

const REVEAL_MS = { slots: SLOTS_REVEAL_MS, dice: DICE_REVEAL_MS } as const;
const isSettled = (bet: GameBet) => bet.status === "won" || bet.status === "lost";

/**
 * Where a bet is in its result moment. "revealing" means the result is known to the app but the stage
 * is still showing it arrive: nothing else may display it yet.
 */
export function betPhase(chainId: number, bet: GameBet): RevealPhase {
  return observeReveal(`bet:${chainId}:${bet.requestId}`, bet.status === "pending" ? "pending" : isSettled(bet) ? "settled" : "other", REVEAL_MS[bet.kind]);
}

/** House state for a collection, and the connected account's bets (all kinds, newest first). */
export function useGames(collection: Address) {
  const { user, chainId } = useProtocol();
  const games = useRead(["games", collection, user], (c, d) => readGames(c, d, collection, user));
  const refundTimeout = games.data?.refundTimeout;
  const bets = useRead(
    ["gameBets", user, refundTimeout],
    (c, d) => readUserBets(c, d, user!, refundTimeout!, LOGS_FROM_BLOCK),
    !!user && refundTimeout !== undefined,
  );
  useRevealClock();
  // Start the clock for every bet the moment its state is seen, whichever stage is on screen.
  bets.data?.forEach((bet) => betPhase(chainId, bet));
  return { games, bets };
}

/**
 * True from a click that places a quick demo bet until the bet shows up (or is refused). The stage
 * starts moving at the click instead of waiting for the simulated transaction.
 */
export function usePlacing(latest: GameBet | undefined): { placing: boolean; refused: boolean; begin: () => void; end: () => void } {
  const since = useRef<bigint | null>();
  const [refused, setRefused] = useState(false);
  const [, render] = useState(0);
  const latestId = latest?.requestId ?? null;
  const current = useRef(latestId);
  current.current = latestId;
  return {
    placing: since.current !== undefined && latestId === since.current,
    refused,
    begin: () => {
      since.current = latestId;
      setRefused(false);
      render((n) => n + 1);
    },
    end: () => {
      // Give the new bet a moment to reach the screen; if none did, the action was refused (the
      // reason is in the dialog).
      setTimeout(() => {
        const was = since.current;
        since.current = undefined;
        if (was !== undefined && current.current === was) (setRefused(true), sound.error());
        render((n) => n + 1);
      }, 350);
    },
  };
}

// ---------------------------------------------------------------- wager

/**
 * The wager: a field and four touch-sized chips (minimum, half, double, maximum). `max` is what the
 * house accepts right now for this game.
 */
export function WagerControl({ value, onChange, min, max, disabled, onEnter }: { value: string; onChange: (text: string) => void; min: bigint; max: bigint | undefined; disabled?: boolean; onEnter?: () => void }) {
  const wager = parseEth(value);
  const set = (wei: bigint) => {
    sound.click();
    const capped = max !== undefined && wei > max ? max : wei < min ? min : wei;
    onChange(eth(capped, 6).replace("<", ""));
  };
  const invalid = value.trim() !== "" && (wager === undefined || wager < min || (max !== undefined && wager > max));
  return (
    <div className="wager">
      <label className="wager-field">
        <span className="wager-label">Wager</span>
        <span className="wager-input">
          <input inputMode="decimal" autoComplete="off" value={value} placeholder="0.00" aria-invalid={invalid || undefined} disabled={disabled} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter?.()} />
          <span aria-hidden="true">ETH</span>
        </span>
      </label>
      <div className="chips" role="group" aria-label="Set the wager">
        <button type="button" className="chip" disabled={disabled} onClick={() => set(min)} title={`Minimum: ${eth(min)} ETH`}>
          Min
        </button>
        <button type="button" className="chip" disabled={disabled || wager === undefined} onClick={() => wager !== undefined && set(wager / 2n)} aria-label="Halve the wager">
          ½
        </button>
        <button type="button" className="chip" disabled={disabled || wager === undefined} onClick={() => wager !== undefined && set(wager * 2n)} aria-label="Double the wager">
          2×
        </button>
        <button type="button" className="chip" disabled={disabled || max === undefined} onClick={() => max !== undefined && set(max)} title={max !== undefined ? `Maximum now: ${eth(max)} ETH` : undefined}>
          Max
        </button>
      </div>
    </div>
  );
}

/** Why a wager cannot be placed right now, or false. */
export function wagerBlocked(g: GamesState, wager: bigint | undefined, max: bigint | undefined, context = ""): string | false {
  if (!g.supported) return "Games are not enabled for this collection";
  if (wager === undefined) return "Enter a wager";
  if (wager < g.minBet) return `The minimum bet is ${eth(g.minBet)} ETH`;
  if (max !== undefined && wager > max) return `The maximum wager${context} is ${eth(max)} ETH`;
  return false;
}

// ---------------------------------------------------------------- house

/**
 * Where the edge goes, in words, from `Games.bankrollShareBps` (the share of each edge the bankroll
 * keeps; the rest funds the collection's buybacks). Read from the contract, never assumed.
 */
export function edgeSplit(g: Pick<GamesState, "edgeBps"> & { bankrollShareBps?: bigint }): string {
  const kept = g.bankrollShareBps ?? 0n;
  if (kept === 0n) return "it funds buybacks for this collection";
  if (kept >= 10_000n) return "it stays in the house bankroll";
  if (kept === 5_000n) return "half funds buybacks for this collection, half stays in the house bankroll";
  return `${bps(kept)} of it stays in the house bankroll, the rest funds buybacks for this collection`;
}

export function HouseStats({ g, maxWager, maxLabel }: { g: GamesState; maxWager: bigint | undefined; maxLabel: string }) {
  const limits = gameLimits(g);
  return (
    <div className="stats house-stats">
      <Stat label="House bankroll" value={`${eth(g.bankroll)} ETH`} hint="Free funds, not set aside for open bets" />
      <Stat label="Edge" value={bps(g.edgeBps)} hint={`Of each wager: ${edgeSplit(g)}`} />
      <Stat
        label={maxLabel}
        value={maxWager !== undefined ? `${eth(maxWager)} ETH` : "–"}
        hint={`Minimum ${eth(g.minBet)} ETH. ${
          limits.totalRoom < limits.perBet ? "Limited by the cap on all open bets together" : `One bet may risk ${bps(g.maxExposureBps)} of the bankroll`
        }${g.maxWagerBps !== undefined ? `, and no wager may exceed ${bps(g.maxWagerBps)} of it` : ""}`}
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

// ---------------------------------------------------------------- session

// The highest bet id that existed when this page session first saw an account's bets. Bets above it
// were placed in this session.
const sessionStart = new Map<string, bigint>();

/**
 * What the account's dice and slots bets of this page session add up to: wagered, paid back, net.
 * Always on screen next to the game, whatever the last result was. A result still being revealed on
 * the stage is not counted until the stage has shown it.
 */
export function SessionNet({ bets }: { bets: GameBet[] | undefined }) {
  const { user, chainId } = useProtocol();
  useRevealClock();
  const netRef = useRef<HTMLSpanElement>(null);
  const key = `${chainId}:${user}`;
  if (user && bets && !sessionStart.has(key)) sessionStart.set(key, bets.reduce((max, bet) => (bet.requestId > max ? bet.requestId : max), 0n));
  const since = sessionStart.get(key) ?? 0n;
  // A simulated chain that starts over numbers its bets from 1 again.
  if (user && bets && bets.length === 0 && since > 0n) sessionStart.set(key, 0n);
  const settled = (bets ?? []).filter((bet) => bet.requestId > (sessionStart.get(key) ?? 0n) && isSettled(bet) && betPhase(chainId, bet) === "done");
  const wagered = settled.reduce((sum, bet) => sum + bet.wager, 0n);
  const returned = settled.reduce((sum, bet) => sum + (bet.payout ?? 0n), 0n);
  const net = returned - wagered;
  const magnitude = net < 0n ? -net : net;
  const count = settled.length;
  useEffect(() => {
    // the figure nudges when it changes; colour says which way it stands
    if (count > 0) netRef.current?.animate?.([{ transform: "translateY(-2px)" }, { transform: "translateY(0)" }], { duration: 260, easing: "ease-out" });
  }, [count]);
  if (!user) return null;
  return (
    <div className="session-bar" role="status" aria-label="Your session so far">
      <span className="session-title">This session</span>
      <span className="session-item">
        <span>Settled</span>
        <strong>{count}</strong>
      </span>
      <span className="session-item">
        <span>Wagered</span>
        <strong>
          <AmountCount wei={wagered} text={eth(wagered)} duration={500} />
        </strong>
      </span>
      <span className="session-item">
        <span>Paid back</span>
        <strong>
          <AmountCount wei={returned} text={eth(returned)} duration={500} />
        </strong>
      </span>
      <span className={net > 0n ? "session-item session-net up" : net < 0n ? "session-item session-net down" : "session-item session-net"} ref={netRef}>
        <span>Net</span>
        <strong>
          {net > 0n ? "+" : net < 0n ? "−" : ""}
          <AmountCount wei={magnitude} text={eth(magnitude)} duration={700} /> ETH
        </strong>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- history

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

/** The last results as a row of pips, newest first: gold paid more than the wager, grey did not. */
function RecentPips({ list }: { list: GameBet[] }) {
  const { chainId } = useProtocol();
  const shown = list.filter((bet) => isSettled(bet) && betPhase(chainId, bet) === "done").slice(0, 28);
  if (shown.length === 0) return null;
  return (
    <ol className="pips" aria-label="Recent results, newest first">
      {shown.map((bet) => {
        const payout = bet.payout ?? 0n;
        const tone = payout > bet.wager ? "up" : payout > 0n ? "even" : "down";
        const text = payout > bet.wager ? `paid ${eth(payout)} ETH on ${eth(bet.wager)}` : payout > 0n ? `stake back: ${eth(payout)} of ${eth(bet.wager)} ETH` : `lost ${eth(bet.wager)} ETH`;
        return (
          <li key={bet.requestId.toString()} className={`pip pip-${tone}`} title={`#${bet.requestId}: roll ${bet.roll}, ${text}`}>
            <span className="fx-sr">
              #{bet.requestId.toString()}: {text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function BetList({ bets, kind, title }: { bets: ReturnType<typeof useGames>["bets"]; kind: GameBet["kind"]; title: string }) {
  const { chainId, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  useRevealClock();
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
    <Card title={title} className="history-card">
      {!user ? (
        <Empty title="Connect a wallet to see your bets." />
      ) : (
        <QueryView query={bets}>
          {(all) => {
            const list = all.filter((bet) => bet.kind === kind);
            if (list.length === 0) return <Empty title="Nothing here yet.">Your bets appear here once placed.</Empty>;
            return (
              <>
                <RecentPips list={list} />
                <div className="table-wrap">
                  <table className="history">
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
                        // The stage is still showing this result arrive: do not give it away here.
                        const revealing = betPhase(chainId, bet) === "revealing";
                        return (
                          <tr key={bet.requestId.toString()} className={net && !revealing ? "row-up" : undefined}>
                            <td>{bet.requestId.toString()}</td>
                            <td><Addr address={bet.collection} /></td>
                            <td>{eth(bet.wager)} ETH</td>
                            {kind === "dice" && <td>{bps(bet.chanceBps)}</td>}
                            <td>
                              {revealing ? (
                                <Badge tone="accent">Revealing</Badge>
                              ) : refundable ? (
                                <Badge tone="warn">Refundable</Badge>
                              ) : bet.status === "pending" ? (
                                <Badge tone="warn">Pending</Badge>
                              ) : bet.status === "refunded" ? (
                                <Badge tone="muted">Refunded</Badge>
                              ) : bet.status === "won" ? (
                                net ? <span className="badge badge-gold">Won</span> : <Badge tone="muted">Stake back</Badge>
                              ) : (
                                <Badge tone="bad">Lost</Badge>
                              )}
                            </td>
                            <td className="wrap">
                              {revealing ? "…" : refundable ? "No randomness arrived" : resultText(bet)}
                              {bet.status === "pending" && !refundable && bet.refundableAt && (
                                <span className="muted small"> (refundable from {dateTime(bet.refundableAt)})</span>
                              )}
                            </td>
                            <td className="actions">
                              {isSettled(bet) && !revealing && <VerifyButton kind="bet" requestId={bet.requestId} collection={bet.collection} />}
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
              </>
            );
          }}
        </QueryView>
      )}
    </Card>
  );
}
