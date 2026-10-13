import { useState } from "react";
import type { Address } from "viem";
import { useProtocol, useRead } from "../hooks";
import { playCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import { parseEth } from "../lib/parse";
import { maxGameWager, readGameQuote } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Badge, Card, Field, Notice, QueryView } from "../ui";
import { BetList, GAMES_NOTICE, HouseStats, OwedRow, SessionNet, useGames } from "./gamesShared";
import { RandomnessNotice } from "./Verify";

/**
 * The roll as a track from 0 to 10000: the shaded part wins. The marker sits on the latest settled
 * roll and sweeps while a bet is waiting for its randomness.
 */
function RollTrack({ chanceBps, roll, pending, won }: { chanceBps: number; roll?: number; pending: boolean; won?: boolean }) {
  return (
    <div className="roll-track" role="img" aria-label={pending ? "Rolling" : roll !== undefined ? `Rolled ${roll} of 10000` : "No roll yet"}>
      <div className="roll-win" style={{ width: `${chanceBps / 100}%` }}>
        <span>win below {chanceBps}</span>
      </div>
      {pending ? (
        <div className="roll-marker rolling" />
      ) : (
        roll !== undefined && (
          <div className={won ? "roll-marker won" : "roll-marker lost"} style={{ left: `${roll / 100}%` }}>
            <span>{roll}</span>
          </div>
        )
      )}
    </div>
  );
}

export function Dice({ collection }: { collection: Address }) {
  const { deployment: d } = useProtocol();
  const { run } = useTx();
  const [chancePercent, setChancePercent] = useState(50);
  const [wagerText, setWagerText] = useState("");
  const { games, bets } = useGames(collection);

  const chanceBps = chancePercent * 100;
  const wager = parseEth(wagerText);
  const quote = useRead(
    ["gameQuote", wager?.toString(), chanceBps],
    (c, dep) => readGameQuote(c, dep, wager!, chanceBps),
    wager !== undefined,
  );
  const latest = bets.data?.find((bet) => bet.kind === "dice");

  const play = () => {
    if (!d || wager === undefined || !quote.data) return;
    const { payout, fee } = quote.data;
    void run(`Bet ${eth(wager)} ETH at ${chancePercent}%`, (send) => send("Play", playCall(d, collection, chanceBps, wager)), [
      `You pay ${eth(wager)} ETH now.`,
      `${eth(fee)} ETH of it is the fee, which goes to this collection's buyback budget when the bet settles.`,
      `If the roll is below ${chanceBps} of 10000 (${chancePercent}%): you receive ${eth(payout)} ETH.`,
      "Otherwise you receive nothing and the stake goes to the house bankroll.",
      "The result arrives with the randomness provider's answer. If none arrives within a day, the bet can be refunded.",
    ], { quickInDemo: true });
  };

  return (
    <>
      <Card title="Dice and coinflip">
        <Notice>{GAMES_NOTICE}</Notice>
        <RandomnessNotice />
        <QueryView query={games} lines={5}>
          {(g) => {
            const maxWager = maxGameWager(g, chanceBps);
            const blocked = !g.supported
              ? "Games are not enabled for this collection"
              : wager === undefined
                ? "Enter a wager"
                : wager < g.minBet
                  ? `The minimum bet is ${eth(g.minBet)} ETH`
                  : maxWager !== undefined && wager > maxWager
                    ? `The maximum wager at ${chancePercent}% is ${eth(maxWager)} ETH`
                    : !quote.data && "Loading the quote";
            return (
              <>
                <p className="muted">
                  Pick your chance of winning and bet against the house. {bps(g.edgeBps)} of every wager is a fee for
                  the selected collection's buybacks; the rest is played at fair odds, so a lower chance pays more.
                  {!g.supported && " The owner has not enabled games for this collection."}
                </p>
                <div className="game-stage">
                  <div className="dice-head">
                    <div className={`coin ${latest?.status === "pending" ? "flipping" : latest?.status === "won" ? "heads" : latest?.status === "lost" ? "tails" : ""}`} aria-hidden="true">
                      <span className="coin-face front">WIN</span>
                      <span className="coin-face back">–</span>
                    </div>
                    <div className="multiplier" aria-label={`A win pays ${(98 / chancePercent).toFixed(2)} times the wager`}>
                      <span className="multiplier-value">×{((100 - Number(g.edgeBps) / 100) / chancePercent).toFixed(2)}</span>
                      <span className="muted small">
                        of your wager on a win, {chancePercent}% of the time
                      </span>
                    </div>
                  </div>
                  <RollTrack
                    chanceBps={latest && latest.status !== "refunded" ? latest.chanceBps : chanceBps}
                    roll={latest?.roll}
                    pending={latest?.status === "pending"}
                    won={latest?.status === "won"}
                  />
                  <p className="game-result" aria-live="polite">
                    {!latest
                      ? "Place a bet to roll."
                      : latest.status === "pending"
                        ? `Bet #${latest.requestId} is rolling…`
                        : latest.status === "refunded"
                          ? `Bet #${latest.requestId} was refunded.`
                          : latest.status === "won"
                            ? `Bet #${latest.requestId} won ${eth(latest.payout ?? 0n)} ETH.`
                            : `Bet #${latest.requestId} lost.`}{" "}
                    {latest && latest.status !== "pending" && latest.status !== "refunded" && (
                      <Badge tone={latest.status === "won" ? "good" : "bad"}>rolled {latest.roll}</Badge>
                    )}
                  </p>
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
                  <button type="button" className="btn secondary" onClick={() => setChancePercent(50)}>
                    Coinflip (50%)
                  </button>
                  <Field label="Wager (ETH)">
                    <input className="narrow" inputMode="decimal" value={wagerText} onChange={(e) => setWagerText(e.target.value)} />
                  </Field>
                  <ActionButton onClick={play} blocked={blocked}>
                    Roll
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
                <SessionNet bets={bets.data} />
                <OwedRow g={g} />
                <HouseStats g={g} maxWager={maxWager} maxLabel={`Max wager at ${chancePercent}%`} />
              </>
            );
          }}
        </QueryView>
      </Card>
      <BetList bets={bets} kind="dice" title="Your dice bets" />
    </>
  );
}
