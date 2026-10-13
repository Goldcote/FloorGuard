import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useProtocol } from "../hooks";
import { spinCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import { parseEth } from "../lib/parse";
import {
  maxSlotsWager,
  SLOT_SYMBOLS,
  SLOTS_PAY_TABLE,
  slotsLine,
  slotsMultiplier,
  type GameBet,
  type SlotSymbol,
} from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx } from "../tx";
import { ActionButton, Card, Field, Notice, QueryView } from "../ui";
import { BetList, GAMES_NOTICE, HouseStats, OwedRow, SessionNet, useGames } from "./gamesShared";
import { RandomnessNotice } from "./Verify";

const REEL_STOP_DELAY_MS = 350;
const IDLE_LINE: [SlotSymbol, SlotSymbol, SlotSymbol] = ["7", "★", "◆"];
/** What the pay table shows next to each prize. */
const TIER_SYMBOL: Record<number, SlotSymbol | undefined> = { 50: "7", 10: "★", 5: "◆", 2: "●" };

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The symbol set, drawn for the identity: shield, star, gem, coin, lock, rising bid. */
export function SlotGlyph({ symbol }: { symbol: SlotSymbol }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg viewBox="0 0 48 48" className={`glyph glyph-${SLOT_SYMBOLS.indexOf(symbol)}`} aria-hidden="true" focusable="false">
      {symbol === "7" && (
        <>
          <path d="M24 5 39 10v11c0 9-6 16-15 20C15 37 9 30 9 21V10L24 5Z" {...common} fill="currentColor" fillOpacity="0.18" />
          <path d="M12 27h24" {...common} />
          <path d="m18 27 6-10 6 10" {...common} />
        </>
      )}
      {symbol === "★" && <path d="m24 6 5.300 11.400 12.200 1.500-9 8.500 2.400 12.300L24 33.500 13.100 39.700l2.400-12.300-9-8.500 12.200-1.500L24 6Z" {...common} fill="currentColor" fillOpacity="0.18" />}
      {symbol === "◆" && (
        <>
          <path d="M24 5 41 24 24 43 7 24 24 5Z" {...common} fill="currentColor" fillOpacity="0.18" />
          <path d="M7 24h34M24 5l-7 19 7 19 7-19-7-19Z" {...common} strokeWidth="2" />
        </>
      )}
      {symbol === "●" && (
        <>
          <circle cx="24" cy="24" r="17" {...common} fill="currentColor" fillOpacity="0.18" />
          <path d="M24 14v20M19 18h7.500a3.500 3.500 0 0 1 0 7H19h8.500a3.500 3.500 0 0 1 0 7H19" {...common} strokeWidth="2.500" />
        </>
      )}
      {symbol === "♣" && (
        <>
          <rect x="11" y="21" width="26" height="20" rx="4" {...common} fill="currentColor" fillOpacity="0.18" />
          <path d="M16 21v-5a8 8 0 0 1 16 0v5M24 29v5" {...common} />
        </>
      )}
      {symbol === "▲" && (
        <>
          <path d="M7 38h34" {...common} />
          <path d="m11 30 9-10 6 6 11-14M30 12h7v7" {...common} />
        </>
      )}
    </svg>
  );
}

function Reel({ symbol, spinning, index }: { symbol: SlotSymbol; spinning: boolean; index: number }) {
  return (
    <div className={spinning ? "reel spinning" : "reel landed"}>
      {spinning ? (
        <>
          {/* A strip of every symbol scrolling past; with reduced motion the CSS shows a still placeholder. */}
          <div className="reel-strip" style={{ animationDuration: `${420 + index * 70}ms` }} aria-hidden="true">
            {[...SLOT_SYMBOLS, ...SLOT_SYMBOLS].map((s, i) => (
              <span key={i}>
                <SlotGlyph symbol={s} />
              </span>
            ))}
          </div>
          <span className="reel-still" aria-hidden="true">
            ?
          </span>
        </>
      ) : (
        <span className="reel-face">
          <SlotGlyph symbol={symbol} />
        </span>
      )}
    </div>
  );
}

/**
 * Three reels for the account's latest spin. They spin while the bet waits for its randomness and
 * stop one after another on the line that matches the settled roll. The line is derived from the
 * roll alone (lib/gameMath.ts): it never stages a near miss.
 *
 * Only a result that pays more than the wager is shown as a win. A 1x result returns the stake after
 * the edge, which is less than was wagered, so it is shown plainly as "stake returned".
 */
export function Machine({ bet }: { bet: GameBet | undefined }) {
  const pending = bet?.status === "pending";
  const settledRoll = bet && (bet.status === "won" || bet.status === "lost") ? bet.roll : undefined;
  // How many reels have stopped. A spin seen while pending stops reel by reel; anything else is shown at once.
  const [stopped, setStopped] = useState(3);
  const sawPending = useRef<bigint>();
  const payout = bet?.payout ?? 0n;
  const outcome = settledRoll === undefined ? undefined : payout > bet!.wager ? "win" : payout > 0n ? "returned" : "nothing";

  useEffect(() => {
    if (!bet) return;
    if (pending) {
      sawPending.current = bet.requestId;
      setStopped(0);
      return;
    }
    if (sawPending.current !== bet.requestId || prefersReducedMotion()) {
      setStopped(3);
      return;
    }
    sawPending.current = undefined;
    // The last reel takes a little longer: weight, not a tease. Its face is already fixed by the roll.
    const timers = [1, 2, 3].map((n) =>
      setTimeout(() => {
        setStopped(n);
        sound.stop();
        if (n === 3) {
          if (outcome === "win") (sound.win(), sound.buzz());
          else sound.settle();
        }
      }, n * REEL_STOP_DELAY_MS + (n === 3 ? 180 : 0)),
    );
    return () => timers.forEach(clearTimeout);
  }, [bet?.requestId, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const line = settledRoll !== undefined ? slotsLine(settledRoll) : IDLE_LINE;
  const revealed = stopped === 3 && settledRoll !== undefined;
  const multiplier = settledRoll !== undefined ? slotsMultiplier(settledRoll) : undefined;

  return (
    <div className={`slot-machine ${revealed ? `is-${outcome}` : pending ? "is-spinning" : ""}`}>
      <div className="machine-top" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="reels" role="img" aria-label={pending ? "Reels spinning" : `Reels show ${line.join(" ")}`}>
        {line.map((symbol, i) => (
          <Reel key={i} symbol={symbol} spinning={pending || (settledRoll !== undefined && i >= stopped)} index={i} />
        ))}
        <div className="payline" aria-hidden="true" />
      </div>
      <p className="game-result" aria-live="polite">
        {!bet
          ? "Spin to play."
          : pending
            ? `Spin #${bet.requestId} is waiting for its random roll…`
            : bet.status === "refunded"
              ? `Spin #${bet.requestId} was refunded.`
              : !revealed
                ? "…"
                : outcome === "win"
                  ? `${multiplier}× the stake: ${eth(payout)} ETH paid.`
                  : outcome === "returned"
                    ? `Stake returned: ${eth(payout)} ETH back of ${eth(bet.wager)} ETH wagered.`
                    : "No prize."}
        {revealed && <span className="muted small"> Roll {settledRoll}.</span>}
      </p>
    </div>
  );
}

export function Slots({ collection }: { collection: Address }) {
  const { deployment: d } = useProtocol();
  const { run } = useTx();
  const [wagerText, setWagerText] = useState("");
  const { games, bets } = useGames(collection);
  const wager = parseEth(wagerText);
  const latest = bets.data?.find((bet) => bet.kind === "slots");

  return (
    <>
      <Card title="Slots">
        <Notice>{GAMES_NOTICE}</Notice>
        <RandomnessNotice />
        <QueryView query={games} lines={5}>
          {(g) => {
            const maxWager = maxSlotsWager(g);
            const fee = wager !== undefined ? (wager * g.edgeBps) / 10_000n : 0n;
            const stake = wager !== undefined ? wager - fee : 0n;
            const blocked = !g.supported
              ? "Games are not enabled for this collection"
              : wager === undefined
                ? "Enter a wager"
                : wager < g.minBet
                  ? `The minimum bet is ${eth(g.minBet)} ETH`
                  : maxWager !== undefined && wager > maxWager && `The maximum wager is ${eth(maxWager)} ETH`;
            const spin = () => {
              if (!d || wager === undefined) return;
              void run(`Spin the slots for ${eth(wager)} ETH`, (send) => send("Spin", spinCall(d, collection, wager)), [
                `You pay ${eth(wager)} ETH now.`,
                `${eth(fee)} ETH of it is the fee, which goes to this collection's buyback budget when the spin settles.`,
                `The remaining ${eth(stake)} ETH is your stake. The prize is 0, 1, 2, 5, 10 or 50 times the stake: at most ${eth(stake * 50n)} ETH.`,
                "About half of all spins (49.8%) pay nothing.",
                "The result arrives with the randomness provider's answer. If none arrives within a day, the spin can be refunded.",
              ], { quickInDemo: true });
            };
            return (
              <>
                <Machine bet={latest} />
                <p className="muted small center-text">The reels illustrate the roll. The payout comes from the contract.</p>
                <div className="form-row center">
                  <Field label="Wager (ETH)">
                    <input className="narrow" inputMode="decimal" value={wagerText} onChange={(e) => setWagerText(e.target.value)} />
                  </Field>
                  {maxWager !== undefined && (
                    <button type="button" className="btn secondary" onClick={() => setWagerText(eth(maxWager, 6))}>
                      Max {eth(maxWager)}
                    </button>
                  )}
                  <ActionButton className="spin" onClick={spin} blocked={blocked}>
                    Spin
                  </ActionButton>
                </div>
                <p className="muted quote center-text">
                  {wager === undefined
                    ? "Enter a wager to see what a spin can pay."
                    : `Stake after the ${bps(g.edgeBps)} fee: ${eth(stake)} ETH. Top prize: ${eth(stake * 50n)} ETH.`}
                  {!g.supported && " The owner has not enabled games for this collection."}
                </p>
                <SessionNet bets={bets.data} />
                <OwedRow g={g} />
                <h3>Pay table</h3>
                <p className="muted small">
                  One random roll from 0 to 9999 decides the prize, as a multiple of the stake after the fee. The
                  symbols are only a picture of the roll; the contract pays by the roll.
                </p>
                <div className="table-wrap">
                  <table className="pay-table">
                    <thead>
                      <tr>
                        <th>Line</th>
                        <th>Prize</th>
                        <th>Chance</th>
                        <th>{wager !== undefined ? "Pays" : "Rolls"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SLOTS_PAY_TABLE.map((tier, i) => (
                        <tr key={tier.multiplier}>
                          <td className="symbols">
                            {TIER_SYMBOL[tier.multiplier] ? (
                              [0, 1, 2].map((n) => <SlotGlyph key={n} symbol={TIER_SYMBOL[tier.multiplier]!} />)
                            ) : (
                              <span className="muted">{tier.multiplier === 1 ? "a pair" : "no match"}</span>
                            )}
                          </td>
                          <td>{tier.multiplier === 0 ? "nothing" : tier.multiplier === 1 ? "1× (stake back)" : `${tier.multiplier}×`}</td>
                          <td>{bps(tier.chanceBps)}</td>
                          <td>
                            {wager !== undefined
                              ? `${eth(stake * BigInt(tier.multiplier))} ETH`
                              : `${i === 0 ? 0 : SLOTS_PAY_TABLE[i - 1].below} to ${tier.below - 1}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <HouseStats g={g} maxWager={maxWager} maxLabel="Max wager per spin" />
                <p className="muted small">
                  The house sets aside 49 stakes for every spin so that it can always pay the top prize, which is why
                  the maximum wager is much lower than for dice.
                </p>
              </>
            );
          }}
        </QueryView>
      </Card>
      <BetList bets={bets} kind="slots" title="Your spins" />
    </>
  );
}
