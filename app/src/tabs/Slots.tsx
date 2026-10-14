import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import {
  AmountCount,
  flash,
  glowPulse,
  IDLE_WINDOW,
  ParticleLayer,
  REEL_STOP_MS,
  reelWindow,
  resultTone,
  revealElapsed,
  shake,
  slotsTierIndex,
  thump,
  useParticles,
  type ParticleController,
  type ReelColumn,
  type ResultTone,
  type RevealPhase,
} from "../fx";
import { useChainTime, useMoney, useProtocol } from "../hooks";
import { spinCall } from "../lib/calls";
import { bps, duration, eth } from "../lib/format";
import { parseEth } from "../lib/parse";
import { maxSlotsWager, recomputeBet, SLOT_SYMBOLS, SLOTS_PAY_TABLE, slotsMultiplier, type GameBet, type SlotSymbol } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx, single } from "../tx";
import { ActionButton, Card, QueryView } from "../ui";
import { BetList, betPhase, edgeSplit, GAMES_NOTICE, HouseStats, OwedRow, PlayNotices, SessionNet, useGames, usePlacing, WagerControl, wagerBlocked } from "./gamesShared";

/** What the pay table shows next to each prize. */
const TIER_LINE: Record<number, readonly [SlotSymbol, SlotSymbol, SlotSymbol]> = {
  50: ["7", "7", "7"],
  10: ["★", "★", "★"],
  5: ["◆", "◆", "◆"],
  2: ["●", "●", "●"],
  1: ["♣", "♣", "▲"],
  0: ["◆", "♣", "●"],
};
const SYMBOL_NAME: Record<SlotSymbol, string> = { "7": "shield", "★": "star", "◆": "gem", "●": "coin", "♣": "lock", "▲": "rising bid" };

/**
 * The symbol set, drawn for the identity: the FloorGuard shield (top prize), a star, a cut gem, a
 * coin, a vault lock and the rising bid. Colour comes from the tokens through `currentColor`.
 */
export function SlotGlyph({ symbol }: { symbol: SlotSymbol }) {
  return (
    <svg viewBox="0 0 64 64" className={`glyph glyph-${SLOT_SYMBOLS.indexOf(symbol)}`} aria-hidden="true" focusable="false">
      {symbol === "7" && (
        <>
          <path className="gb" d="M32 5 53 12.5v15c0 13.5-8.500 23.500-21 30C19.500 51 11 41 11 27.500v-15L32 5Z" />
          <path className="gs" d="M32 5 53 12.500v15c0 13.500-8.500 23.500-21 30V5Z" />
          <path className="gh" d="M17 16.500 31 11.500" />
          <path className="gl glow" d="M5 38h54" />
          <path className="gl" d="m23 38 9-15 9 15" />
        </>
      )}
      {symbol === "★" && (
        <>
          <path className="gb" d="M32 8 38.200 24.500 55.800 25.300 42 36.200 46.700 53.200 32 43.500 17.300 53.200 22 36.200 8.200 25.300 25.800 24.500Z" />
          <path className="gs" d="M32 8 38.200 24.500 55.800 25.300 42 36.200 46.700 53.200 32 43.500Z" />
          <path className="gh" d="m27.500 26.500-9 .500" />
        </>
      )}
      {symbol === "◆" && (
        <>
          <path className="gb" d="M18 10h28l12 14-26 32L6 24l12-14Z" />
          <path className="gs" d="M40 24h18L32 56Z" />
          <path className="gs" d="M18 10 24 24 32 10Z" />
          <path className="gt" d="M6 24h52M18 10l6 14 8 32 8-32 6-14M24 24l8-14 8 14" />
          <path className="gh" d="m13 22 7-8.500" />
        </>
      )}
      {symbol === "●" && (
        <>
          <circle className="gb" cx="32" cy="32" r="25" />
          <path className="gs" d="M32 7a25 25 0 0 1 0 50 34 34 0 0 0 0-50Z" />
          <circle className="gt" cx="32" cy="32" r="18.500" />
          <path className="gl" d="M25 25.500h14M23 32h18M25 38.500h14" />
          <path className="gh" d="M14.500 24a19 19 0 0 1 8-9.500" />
        </>
      )}
      {symbol === "♣" && (
        <>
          <path className="gl" d="M21 29v-8a11 11 0 0 1 22 0v8" />
          <rect className="gb" x="13" y="28" width="38" height="28" rx="7" />
          <path className="gs" d="M32 28h12a7 7 0 0 1 7 7v14a7 7 0 0 1-7 7H32Z" />
          <circle className="gf" cx="32" cy="39.500" r="4" />
          <path className="gl" d="M32 41v7" />
          <path className="gh" d="M18.500 35v-2.500a3 3 0 0 1 3-3h6" />
        </>
      )}
      {symbol === "▲" && (
        <>
          <path className="gs" d="M10 45 22 33l9 8 16-20v32H10Z" />
          <path className="gl" d="M7 54h50" />
          <path className="gl" d="M10 45 22 33l9 8 16-20" />
          <path className="gl" d="M38 20.500h9.500V30" />
        </>
      )}
    </svg>
  );
}

type ReelState = "rest" | "spin" | "land";

/**
 * One reel: a blurred loop of every symbol while it turns, and the three faces it rests on. The
 * faces are swapped only while the loop covers them, so what lands is exactly the given column.
 */
function Reel({ column, state, index, lit }: { column: ReelColumn; state: ReelState; index: number; lit: boolean }) {
  const loop = [...SLOT_SYMBOLS.slice(index * 2), ...SLOT_SYMBOLS.slice(0, index * 2)];
  return (
    <div className="reel" data-state={state} data-reel={index}>
      <div className="reel-blur" aria-hidden="true">
        <div className="reel-loop">
          {[...loop, ...loop].map((s, i) => (
            <span className="reel-cell" key={i}>
              <SlotGlyph symbol={s} />
            </span>
          ))}
        </div>
      </div>
      <div className="reel-faces">
        {column.map((s, row) => (
          <span className={row === 1 ? (lit ? "reel-cell on-line is-lit" : "reel-cell on-line") : "reel-cell off-line"} key={row}>
            <SlotGlyph symbol={s} />
          </span>
        ))}
      </div>
      <span className="reel-rolling" aria-hidden="true">
        Rolling
      </span>
    </div>
  );
}

function celebrate(tone: ResultTone, multiple: number, particles: ParticleController, cabinet: HTMLElement | null, glass: HTMLElement | null) {
  if (tone === "loss") return sound.loss();
  if (tone === "returned") return sound.returned();
  // Only a payout above the wager reaches this point.
  sound.win(multiple);
  if (tone === "win") {
    particles.burst(glass ?? undefined, multiple >= 5 ? 0.55 : 0.3);
    glowPulse(cabinet, "var(--gold)");
    sound.buzz([20, 30, 40]);
  } else if (tone === "big") {
    flash(glass, "var(--gold)", 0.3);
    shake(cabinet, 4);
    particles.burst(glass ?? undefined, 0.9);
    particles.coinShower(1500, 0.7);
    sound.coinTumble(1.3);
    sound.buzz([30, 40, 60, 40, 90]);
  } else {
    flash(cabinet, "var(--gold)", 0.5, 800);
    shake(cabinet, 7, 620);
    particles.burst(glass ?? undefined, 1);
    particles.confetti(90);
    particles.coinShower(4400, 1.25);
    setTimeout(() => particles.burst(glass ?? undefined, 0.8), 900);
    setTimeout(() => (particles.burst(glass ?? undefined, 0.8), shake(cabinet, 3)), 1800);
    sound.buzz([40, 40, 80, 40, 120, 60, 200]);
  }
}

const COUNT_MS: Record<ResultTone, number> = { loss: 0, returned: 0, win: 800, big: 1600, jackpot: 3600 };

/**
 * The machine for the account's latest spin. The reels turn from the click, keep turning while the
 * spin waits for its randomness and stop left to right, at fixed times, on the window that
 * `reelWindow` derives from the settled roll alone. Only a result that pays more than the wager is
 * shown as a win; a 1x result returns the stake after the edge, which is less than was wagered, so it
 * is shown plainly as "stake returned".
 */
export function Machine({ bet, placing = false, refused = false, particles: shared, children }: { bet: GameBet | undefined; placing?: boolean; refused?: boolean; particles?: ParticleController; children?: ReactNode }) {
  const { chainId } = useProtocol();
  const money = useMoney();
  // Used on its own (the landing page shows one), the machine brings its own particle layer.
  const own = useParticles();
  const particles = shared ?? own;
  const cabinet = useRef<HTMLElement>(null);
  const glass = useRef<HTMLDivElement>(null);
  const phase: RevealPhase = bet ? betPhase(chainId, bet) : "idle";
  const settledRoll = bet && (bet.status === "won" || bet.status === "lost") ? bet.roll : undefined;
  const id = bet?.requestId;

  // Reels stopped so far in the reveal of bet `id`.
  const [stopped, setStopped] = useState<{ id?: bigint; n: number }>({ n: 0 });
  const lastWindow = useRef(IDLE_WINDOW);
  const previousPhase = useRef<RevealPhase>("idle");
  // The spin whose reveal this machine played: its prize counts up; a result found on arrival does not.
  const watched = useRef<bigint>();

  const spinning = placing || phase === "pending";
  const revealing = phase === "revealing" && settledRoll !== undefined;
  const shown = settledRoll !== undefined && (phase === "done" || revealing);
  const window3 = shown ? reelWindow(settledRoll) : lastWindow.current;
  if (phase === "done" && settledRoll !== undefined) lastWindow.current = reelWindow(settledRoll);

  const payout = bet?.payout ?? 0n;
  const multiple = settledRoll !== undefined ? slotsMultiplier(settledRoll) : 0;
  const tone = phase === "done" && settledRoll !== undefined && !placing && !refused ? resultTone(payout, bet!.wager, multiple) : undefined;
  const isWin = tone === "win" || tone === "big" || tone === "jackpot";

  useEffect(() => {
    if (spinning) {
      sound.spinStart();
      return () => sound.spinStop();
    }
  }, [spinning]);

  useEffect(() => {
    if (!revealing || id === undefined) return;
    sound.spinStart();
    const elapsed = revealElapsed(`bet:${chainId}:${id}`) ?? 0;
    setStopped({ id, n: REEL_STOP_MS.filter((ms) => ms <= elapsed).length });
    // Fixed stop times: the pause before the last reel is the same whatever it is about to show.
    const timers = REEL_STOP_MS.map((ms, i) =>
      setTimeout(() => {
        setStopped({ id, n: i + 1 });
        sound.reelStop(i);
        thump(glass.current, 3);
        if (i === 2) sound.spinStop();
      }, Math.max(0, ms - elapsed)),
    );
    return () => (timers.forEach(clearTimeout), sound.spinStop());
  }, [revealing, id, chainId]);

  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (phase !== "done" || before !== "revealing" || !bet || settledRoll === undefined) return;
    celebrate(resultTone(payout, bet.wager, multiple), multiple, particles, cabinet.current, glass.current);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const reelState = (i: number): ReelState => (spinning ? "spin" : revealing ? (stopped.id === id && i < stopped.n ? "land" : "spin") : "rest");
  const line = window3.map((column) => column[1]);
  if (revealing) watched.current = id;
  const live = id !== undefined && watched.current === id;

  return (
    <section className={`cabinet${spinning || revealing ? " is-spinning" : ""}${tone ? ` tone-${tone}` : ""}`} ref={cabinet} aria-label="Slot machine">
      <header className="cab-top">
        <div className="cab-bulbs" aria-hidden="true">
          {Array.from({ length: 11 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
        <div className="cab-marquee" aria-hidden="true">
          <span>Vault</span> Slots
        </div>
      </header>
      <svg className="fx-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <filter id="fg-reel-blur" x="0" y="-10%" width="100%" height="120%">
          <feGaussianBlur stdDeviation="0 7" />
        </filter>
      </svg>
      <div className="cab-glass" ref={glass}>
        <div className="reels" role="img" aria-label={spinning || revealing ? "Reels spinning" : `Payline shows ${line.map((s) => SYMBOL_NAME[s]).join(", ")}`}>
          {window3.map((column, i) => (
            <Reel key={i} column={column} state={reelState(i)} index={i} lit={isWin} />
          ))}
        </div>
        <span className="payline" aria-hidden="true" />
        <span className="payline-mark left" aria-hidden="true" />
        <span className="payline-mark right" aria-hidden="true" />
        <span className="glass-shine" aria-hidden="true" />
        {isWin && (
          <div className={`win-banner tone-${tone}`} aria-hidden="true">
            {tone === "jackpot" && <span className="win-title">Top prize</span>}
            <span className="win-multiple">{multiple}×</span>
            <span className="win-amount">
              +<AmountCount key={id?.toString()} wei={payout} from={live ? 0n : undefined} text={eth(payout)} duration={COUNT_MS[tone!]} onTick={live ? sound.countTick : undefined} /> ETH
            </span>
          </div>
        )}
      </div>
      <p className={`cab-lcd${tone ? ` tone-${tone}` : ""}`} aria-live="polite">
        {placing
          ? "Placing the spin…"
          : refused
            ? "Not placed: nothing was wagered."
          : !bet
            ? "Set a wager and spin."
            : phase === "pending"
              ? `Spin #${bet.requestId}: waiting for its random roll…`
              : bet.status === "refunded"
                ? `Spin #${bet.requestId} was refunded: the wager came back.`
                : revealing
                  ? " "
                  : tone === "loss"
                    ? "No prize."
                    : tone === "returned"
                      ? money(`Stake returned: ${eth(payout)} ETH back of ${eth(bet.wager)} ETH wagered.`)
                      : money(`${multiple}× the stake: ${eth(payout)} ETH paid.`)}
        {tone && <span className="lcd-roll"> Roll {settledRoll}</span>}
      </p>
      {children}
      {!shared && <ParticleLayer controller={own} />}
    </section>
  );
}

/** The odds as one bar: every possible roll from 0 to 9999, each prize as wide as its chance. */
function RollBand({ roll }: { roll: number | undefined }) {
  return (
    <div className="roll-band" role="img" aria-label={roll === undefined ? "The 10000 possible rolls, by prize" : `Roll ${roll} of 0 to 9999`}>
      <div className="roll-band-bar">
        {SLOTS_PAY_TABLE.map((tier) => (
          <span key={tier.multiplier} className={`band band-${tier.multiplier}`} style={{ flexGrow: tier.chanceBps }} />
        ))}
        {roll !== undefined && <span className="roll-band-mark" style={{ left: `${roll / 100}%` }} />}
      </div>
      <div className="roll-band-scale" aria-hidden="true">
        <span>0</span>
        <span>roll</span>
        <span>9999</span>
      </div>
    </div>
  );
}

function PayTable({ stake, hit, roll }: { stake: bigint | undefined; hit: number | undefined; roll: number | undefined }) {
  return (
    <aside className="paytable" aria-label="Pay table">
      <h2>Pay table</h2>
      <ol className="pay-rows">
        {SLOTS_PAY_TABLE.map((tier, i) => {
          const from = i === 0 ? 0 : SLOTS_PAY_TABLE[i - 1].below;
          const isHit = hit === i;
          return (
            <li key={tier.multiplier} className={`pay-row pay-${tier.multiplier}${isHit ? " is-hit" : ""}`} aria-current={isHit ? "true" : undefined}>
              <span className="pay-line" aria-hidden="true">
                {TIER_LINE[tier.multiplier].map((s, n) => (
                  <SlotGlyph key={n} symbol={s} />
                ))}
              </span>
              <span className="pay-prize">
                <strong>{tier.multiplier === 0 ? "0" : `${tier.multiplier}×`}</strong>
                <span>{tier.multiplier === 0 ? "no match: nothing" : tier.multiplier === 1 ? "a pair: stake back" : `three ${SYMBOL_NAME[TIER_LINE[tier.multiplier][0]]}s`}</span>
              </span>
              <span className="pay-odds">
                <strong>{bps(tier.chanceBps)}</strong>
                <span>
                  rolls {from}–{tier.below - 1}
                </span>
              </span>
              <span className="pay-amount">{stake !== undefined ? `${eth(stake * BigInt(tier.multiplier))} ETH` : "–"}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted small">Amounts are for the stake at the edge in force when the spin is mined.</p>
      <RollBand roll={roll} />
      <p className="muted small">
        One random roll from 0 to 9999 decides the prize, as a multiple of the stake after the fee. The symbols are only
        a picture of the roll; the contract pays by the roll.
      </p>
    </aside>
  );
}

declare global {
  interface Window {
    /** Development builds only: play a stage's reveal for a chosen result, to look at every state. */
    __fgPreview?: Record<string, (...args: number[]) => void>;
  }
}

export function Slots({ collection }: { collection: Address }) {
  const { deployment: d, demo, chainId } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const [wagerText, setWagerText] = useState("0.01");
  const { games, bets } = useGames(collection);
  const particles = useParticles();
  const [preview, setPreview] = useState<GameBet>();
  const wager = parseEth(wagerText);
  const latest = preview ?? bets.data?.find((bet) => bet.kind === "slots");
  const { placing, refused, begin, end } = usePlacing(latest);
  const phase = latest ? betPhase(chainId, latest) : "idle";
  const busy = placing || phase === "pending" || phase === "revealing";

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const preview = (window.__fgPreview ??= {});
    let n = 0;
    preview.slots = (roll: number) => {
      const wager = 10n ** 16n;
      const requestId = 900_000_000n + BigInt(++n);
      const base = { requestId, collection, wager, kind: "slots", chanceBps: 0 } as const;
      setPreview({ ...base, status: "pending" });
      setTimeout(() => {
        const r = recomputeBet({ wager, edgeBps: 200n, chanceBps: 0, roll });
        setPreview({ ...base, status: r.payout > 0n ? "won" : "lost", roll, payout: r.payout, fee: r.fee });
      }, 1200);
    };
    return () => void delete preview.slots;
  }, [collection]);

  return (
    <div className="play play-slots">
      <PlayNotices>{GAMES_NOTICE}</PlayNotices>
      <QueryView query={games} lines={8}>
        {(g) => {
          const maxWager = maxSlotsWager(g);
          const fee = wager !== undefined ? (wager * g.edgeBps) / 10_000n : 0n;
          const stake = wager !== undefined ? wager - fee : undefined;
          const blocked = wagerBlocked(g, wager, maxWager, "", now);
          const spin = async () => {
            if (!d || wager === undefined || stake === undefined || busy) return;
            setPreview(undefined);
            sound.lever();
            if (demo) begin();
            await run(`Spin the slots for ${eth(wager)} ETH`, single("Spin", spinCall(d, collection, wager)), [
              `You pay ${eth(wager)} ETH now.`,
              `${eth(fee)} ETH of it is the fee (the ${bps(g.edgeBps)} edge): ${edgeSplit(g)}.`,
              `The remaining ${eth(stake)} ETH is your stake, at the edge in force when the spin is mined (${bps(g.edgeBps)} now; the owner can change it for later spins). The prize is 0, 1, 2, 5, 10 or 50 times the stake: at most ${eth(stake * 50n)} ETH.`,
              "About half of all spins (49.8%) pay nothing.",
              `The result arrives with the randomness provider's answer. If none arrives within ${duration(g.refundTimeout)}, the spin can be refunded.`,
            ], { quickInDemo: true });
            end();
          };
          const settled = latest && phase === "done" && latest.roll !== undefined && !placing && !refused ? latest.roll : undefined;
          return (
            <>
              <div className="stage stage-slots">
                <Machine bet={latest} placing={placing} refused={refused} particles={particles}>
                  <div className="cab-controls">
                    <WagerControl value={wagerText} onChange={setWagerText} min={g.minBet} max={maxWager} onEnter={() => !blocked && void spin()} />
                    <ActionButton className="spin-btn" onClick={() => void spin()} blocked={blocked} aria-disabled={busy || undefined}>
                      <span className="spin-btn-label">{busy ? "Spinning" : "Spin"}</span>
                    </ActionButton>
                  </div>
                  <dl className="cab-cost">
                    <div>
                      <dt>Stake</dt>
                      <dd>{stake !== undefined ? `${eth(stake)} ETH` : "–"}</dd>
                    </div>
                    <div>
                      <dt>Fee ({bps(g.edgeBps)})</dt>
                      <dd>{wager !== undefined ? `${eth(fee)} ETH` : "–"}</dd>
                    </div>
                    <div>
                      <dt>Top prize</dt>
                      <dd>{stake !== undefined ? `${eth(stake * 50n)} ETH` : "–"}</dd>
                    </div>
                    <div>
                      <dt>Pays nothing</dt>
                      <dd>49.8% of spins</dd>
                    </div>
                  </dl>
                  <p className="cab-note">
                    The reels illustrate the roll. The payout comes from the contract. The {bps(g.edgeBps)} edge: {edgeSplit(g)}.
                    {!g.supported && " The owner has not enabled games for this collection."}
                    {preview && " Development preview: not a real spin."}
                  </p>
                </Machine>
                <div className="stage-side">
                  <PayTable stake={stake} hit={settled !== undefined ? slotsTierIndex(settled) : undefined} roll={settled} />
                  <SessionNet bets={bets.data} />
                </div>
                <ParticleLayer controller={particles} />
              </div>
              <OwedRow g={g} />
              <Card title="The house">
                <HouseStats g={g} maxWager={maxWager} maxLabel="Max wager per spin" />
                <p className="muted small">
                  The house sets aside 49 stakes for every spin so that it can always pay the top prize, which is why the
                  maximum wager is much lower than for dice.
                </p>
              </Card>
            </>
          );
        }}
      </QueryView>
      <BetList bets={bets} kind="slots" title="Your spins" />
    </div>
  );
}
