import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Address } from "viem";
import {
  bounceHeight,
  clamp,
  CountUp,
  DICE_TUMBLE_MS,
  DIE_ROTATION,
  diceMultiple,
  dieFace,
  ease,
  flash,
  ParticleLayer,
  prefersReducedMotion,
  resultTone,
  revealElapsed,
  shake,
  thump,
  useParticles,
  type DieFace,
  type ParticleController,
  type ResultTone,
  type RevealPhase,
} from "../fx";
import { useProtocol, useRead } from "../hooks";
import { playCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import { parseEth } from "../lib/parse";
import { maxGameWager, readGameQuote, recomputeBet, type GameBet } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx } from "../tx";
import { ActionButton, Card, QueryView } from "../ui";
import { BetList, betPhase, edgeSplit, GAMES_NOTICE, HouseStats, OwedRow, PlayNotices, SessionNet, useGames, usePlacing, WagerControl, wagerBlocked } from "./gamesShared";

type Mode = "dice" | "coin";
const PRESETS = [10, 25, 50, 75, 90];
const PIPS: Record<DieFace, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const FACES: DieFace[] = [1, 2, 3, 4, 5, 6];

// ---------------------------------------------------------------- the tumbling body

const TILT: readonly [number, number] = [-16, -20]; // how the body sits at rest, so its depth shows
const IDLE: readonly [number, number] = [-32, 42]; // before any roll: a corner view, not a result
const HOVER = 86; // px above the floor line while the result is on its way
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Where a unit vector ends up after rotateY(b), rotateX(a), then the resting tilt. */
function rotate([x, y, z]: number[], a: number, b: number): number[] {
  const step = (v: number[], ax: number, ay: number) => {
    const [x1, y1, z1] = [v[0] * Math.cos(ay) + v[2] * Math.sin(ay), v[1], -v[0] * Math.sin(ay) + v[2] * Math.cos(ay)];
    return [x1, y1 * Math.cos(ax) - z1 * Math.sin(ax), y1 * Math.sin(ax) + z1 * Math.cos(ax)];
  };
  return step(step([x, y, z], rad(a), rad(b)), rad(TILT[0]), rad(TILT[1]));
}
const NORMALS: Record<DieFace, number[]> = { 1: [0, 0, 1], 6: [0, 0, -1], 2: [1, 0, 0], 5: [-1, 0, 0], 3: [0, -1, 0], 4: [0, 1, 0] };
const LIGHT = [-0.41, -0.66, 0.63];

type Body = { x: number; h: number; a: number; b: number };

/** The first angle at or beyond `from + extra` that equals `target` modulo a full turn. */
const windTo = (from: number, target: number, extra: number) => target + 360 * Math.ceil((from + extra - target) / 360);

/**
 * Drives the die or coin: it idles on the floor line, lifts and spins while the result is on its way,
 * then falls, bounces and comes to rest on the roll's position showing the roll's face. The motion
 * is the same for every result; only where and on which face it ends comes from the roll.
 */
function useTumble({ mode, phase, placing, roll, betKey, width, onBounce, onRest }: { mode: Mode; phase: RevealPhase; placing: boolean; roll: number | undefined; betKey: string | undefined; width: number; onBounce: (n: number) => void; onRest: () => void }) {
  const actor = useRef<HTMLDivElement>(null);
  const solid = useRef<HTMLDivElement>(null);
  const shadow = useRef<HTMLSpanElement>(null);
  const body = useRef<Body>({ x: 0.5, h: 0, a: IDLE[0], b: IDLE[1] });
  const handlers = useRef({ onBounce, onRest });
  handlers.current = { onBounce, onRest };
  const airborne = placing || phase === "pending";
  const landing = phase === "revealing" && roll !== undefined;
  const state = airborne ? "air" : landing ? "land" : "rest";

  const restPose = (): Body => {
    if (roll === undefined || (phase !== "done" && phase !== "revealing")) return { x: 0.5, h: 0, a: mode === "coin" ? 0 : IDLE[0], b: mode === "coin" ? 0 : IDLE[1] };
    if (mode === "coin") return { x: roll / 10_000, h: 0, a: roll < 5_000 ? 0 : 180, b: 0 };
    const [a, b] = DIE_ROTATION[dieFace(roll)];
    return { x: roll / 10_000, h: 0, a, b };
  };

  const paint = () => {
    const { x, h, a, b } = body.current;
    if (actor.current) actor.current.style.transform = `translate3d(${(x * width).toFixed(1)}px, ${(-h).toFixed(1)}px, 0)`;
    if (solid.current) {
      solid.current.style.transform = `rotateX(${TILT[0]}deg) rotateY(${TILT[1]}deg) rotateX(${a.toFixed(1)}deg) rotateY(${b.toFixed(1)}deg)`;
      if (mode === "dice") {
        // Light each face by how squarely it meets the lamp: the cube reads as a solid while it turns.
        for (const face of FACES) {
          const n = rotate(NORMALS[face], a, b);
          const lit = clamp(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
          (solid.current.children[face - 1] as HTMLElement | undefined)?.style.setProperty("--shade", (0.72 * (1 - lit)).toFixed(3));
        }
      }
    }
    if (shadow.current) {
      const lift = clamp(h / 140);
      shadow.current.style.transform = `translate3d(${(x * width).toFixed(1)}px, 0, 0) scale(${(1 - lift * 0.45).toFixed(3)})`;
      shadow.current.style.opacity = (0.55 * (1 - lift * 0.7)).toFixed(3);
    }
  };

  useEffect(() => {
    if (state === "rest" || prefersReducedMotion()) {
      body.current = state === "air" ? { ...restPose(), x: 0.5 } : restPose();
      paint();
      return;
    }
    let frame = 0;
    let last = performance.now();
    const from = { ...body.current };
    const to = restPose();
    const target = { a: windTo(from.a, to.a, 620), b: mode === "coin" ? 0 : windTo(from.b, to.b, 420) };
    const begin = performance.now() - (state === "land" && betKey ? (revealElapsed(betKey) ?? 0) : 0);
    const startHeight = Math.max(from.h, 40);
    let wasDown = false;
    let bounces = 0;
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const b = body.current;
      if (state === "air") {
        // lifted and turning: nothing is decided yet
        b.h += (HOVER + Math.sin(now / 260) * 7 - b.h) * Math.min(1, dt * 7);
        b.x += (0.5 - b.x) * Math.min(1, dt * 3);
        b.a += (mode === "coin" ? 1080 : 540) * dt;
        if (mode === "dice") b.b += 410 * dt;
        paint();
        frame = requestAnimationFrame(step);
        return;
      }
      const t = clamp((now - begin) / DICE_TUMBLE_MS);
      const turn = ease.outCubic(clamp(t / 0.84));
      b.x = from.x + (to.x - from.x) * ease.outCubic(t);
      b.h = startHeight * bounceHeight(t, 3, 0.34);
      b.a = from.a + (target.a - from.a) * turn;
      b.b = from.b + (target.b - from.b) * turn;
      const down = b.h < 1.2;
      if (down && !wasDown && t < 1) handlers.current.onBounce(bounces++);
      wasDown = down;
      if (t >= 1) {
        body.current = to;
        paint();
        handlers.current.onRest();
        return;
      }
      paint();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [state, mode, betKey, width, roll]); // eslint-disable-line react-hooks/exhaustive-deps

  return { actor, solid, shadow, state };
}

function Die() {
  return (
    <>
      {FACES.map((face) => (
        <span className={`die-face die-face-${face}`} key={face}>
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} className={PIPS[face].includes(i) ? "pip-dot on" : "pip-dot"} />
          ))}
        </span>
      ))}
    </>
  );
}

function Coin() {
  return (
    <>
      {[-4, -2.4, -0.8, 0.8, 2.4, 4].map((z) => (
        <span className="coin-rim" key={z} style={{ transform: `translateZ(${z}px)` }} />
      ))}
      <span className="coin-side heads">
        <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <path className="gb" d="M32 9 49 15v12c0 11-7 19-17 24-10-5-17-13-17-24V15L32 9Z" />
          <path className="gl" d="M10 36h44M25 36l7-12 7 12" />
        </svg>
      </span>
      <span className="coin-side tails">
        <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <circle className="gt" cx="32" cy="32" r="20" />
          <path className="gl" d="M20 32h24" />
        </svg>
      </span>
    </>
  );
}

// ---------------------------------------------------------------- the track

/**
 * The roll as a track from 0 to 9999. The lit part wins: it is exactly as wide as the chance, so
 * raising the multiplier visibly shrinks it. The slider's handle is the edge of the win zone.
 */
function RiskTrack({ mode, chance, onChance, locked, marker, ghosts }: { mode: Mode; chance: number; onChance: (percent: number) => void; locked: boolean; marker?: { roll: number; tone: ResultTone; chanceBps: number }; ghosts: GameBet[] }) {
  return (
    <div className={`risk-track mode-${mode}`} style={{ "--chance": chance } as CSSProperties}>
      <div className="risk-zone" aria-hidden="true">
        <span className="risk-zone-label">win below {chance * 100}</span>
      </div>
      <div className="risk-ticks" aria-hidden="true">
        {mode === "dice" ? FACES.map((face) => <span key={face}>{face}</span>) : ["shield side wins", "blank side"].map((text) => <span key={text}>{text}</span>)}
      </div>
      <div className="risk-ghosts" aria-hidden="true">
        {ghosts.map((bet) => (
          <i key={bet.requestId.toString()} className={(bet.payout ?? 0n) > bet.wager ? "up" : undefined} style={{ left: `${(bet.roll ?? 0) / 100}%` }} />
        ))}
      </div>
      {marker && (
        <div className={`risk-marker tone-${marker.tone}`} style={{ left: `${marker.roll / 100}%` }} key={marker.roll}>
          <span>{marker.roll}</span>
        </div>
      )}
      {mode === "dice" && (
        <input
          className="risk-slider"
          type="range"
          min={1}
          max={95}
          step={1}
          value={chance}
          disabled={locked}
          aria-label="Chance of winning, in percent"
          aria-valuetext={`${chance}% chance, a win pays ${(98 / chance).toFixed(2)} times the wager`}
          onChange={(e) => (sound.tick(1 - Number(e.target.value) / 95), onChance(Number(e.target.value)))}
        />
      )}
      <div className="risk-scale" aria-hidden="true">
        <span>0</span>
        <span>roll</span>
        <span>9999</span>
      </div>
    </div>
  );
}

function celebrate(tone: ResultTone, multiple: number, particles: ParticleController, stage: HTMLElement | null, actor: HTMLElement | null) {
  if (tone === "loss") return sound.loss();
  if (tone === "returned") return sound.returned();
  sound.win(multiple);
  particles.burst(actor ?? undefined, tone === "win" ? clamp(0.25 + multiple / 12) : 1);
  sound.buzz(tone === "win" ? [20, 30, 40] : [30, 40, 60, 40, 90]);
  if (tone === "win") return;
  flash(stage, "var(--gold)", tone === "jackpot" ? 0.45 : 0.28);
  shake(stage, tone === "jackpot" ? 6 : 4);
  particles.coinShower(tone === "jackpot" ? 3200 : 1500, tone === "jackpot" ? 1.1 : 0.7);
  sound.coinTumble(tone === "jackpot" ? 2.4 : 1.2);
}

export function Dice({ collection }: { collection: Address }) {
  const { deployment: d, demo, chainId } = useProtocol();
  const { run } = useTx();
  const [mode, setMode] = useState<Mode>("dice");
  const [chanceChoice, setChance] = useState(50);
  const [wagerText, setWagerText] = useState("0.01");
  const [preview, setPreview] = useState<GameBet>();
  const [width, setWidth] = useState(0);
  const { games, bets } = useGames(collection);
  const particles = useParticles();
  const stage = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const previousPhase = useRef<RevealPhase>("idle");

  const chancePercent = mode === "coin" ? 50 : chanceChoice;
  const chanceBps = chancePercent * 100;
  const wager = parseEth(wagerText);
  const quote = useRead(["gameQuote", wager?.toString(), chanceBps], (c, dep) => readGameQuote(c, dep, wager!, chanceBps), wager !== undefined);
  const dice = bets.data?.filter((bet) => bet.kind === "dice") ?? [];
  const latest = preview ?? dice[0];
  const { placing, refused, begin, end } = usePlacing(latest);
  const phase: RevealPhase = latest ? betPhase(chainId, latest) : "idle";
  const busy = placing || phase === "pending" || phase === "revealing";
  const betKey = latest ? `bet:${chainId}:${latest.requestId}` : undefined;
  // The coin only pictures an even-chance bet; a die result at another chance is not shown as a coin.
  const pictured = latest && (mode === "dice" || latest.chanceBps === 5_000);
  const settled = latest && pictured && (latest.status === "won" || latest.status === "lost") && latest.roll !== undefined ? latest : undefined;
  const result = settled && phase === "done" && !placing && !refused ? settled : undefined;
  const multipleOf = (bet: GameBet) => Number(((bet.payout ?? 0n) * 100n) / (bet.wager || 1n)) / 100;
  const tone = result ? resultTone(result.payout ?? 0n, result.wager, multipleOf(result)) : undefined;

  useEffect(() => {
    const element = arena.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [games.data !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const tumble = useTumble({
    mode,
    phase,
    placing,
    roll: settled?.roll,
    betKey,
    width,
    onBounce: (n) => (mode === "coin" ? n === 0 && sound.coinLand() : sound.dieBounce(n), n === 0 && thump(arena.current, 3)),
    onRest: () => undefined,
  });

  useEffect(() => {
    if (!busy) return;
    if (placing || phase === "pending") mode === "coin" ? sound.coinToss() : sound.dieRoll();
  }, [placing || phase === "pending"]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (phase !== "done" || before !== "revealing" || !settled) return;
    celebrate(resultTone(settled.payout ?? 0n, settled.wager, multipleOf(settled)), multipleOf(settled), particles, stage.current, tumble.actor.current);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hooks = (window.__fgPreview ??= {});
    let n = 0;
    hooks.dice = (roll: number, percent = 50) => {
      const wager = 10n ** 16n;
      const base = { requestId: 800_000_000n + BigInt(++n), collection, wager, kind: "dice", chanceBps: percent * 100 } as const;
      setChance(percent);
      setPreview({ ...base, status: "pending" });
      setTimeout(() => {
        const r = recomputeBet({ wager, edgeBps: 200n, chanceBps: percent * 100, roll });
        setPreview({ ...base, status: r.payout > 0n ? "won" : "lost", roll, payout: r.payout, fee: r.fee });
      }, 1100);
    };
    return () => void delete hooks.dice;
  }, [collection]);

  return (
    <div className="play play-dice">
      <PlayNotices>{GAMES_NOTICE}</PlayNotices>
      <QueryView query={games} lines={8}>
        {(g) => {
          const maxWager = maxGameWager(g, chanceBps);
          const multiple = diceMultiple(chanceBps, g.edgeBps);
          const blocked = wagerBlocked(g, wager, maxWager, ` at ${chancePercent}%`) || (!quote.data && "Loading the quote");
          const play = async () => {
            if (!d || wager === undefined || !quote.data || busy) return;
            const { payout, fee } = quote.data;
            setPreview(undefined);
            sound.stake();
            if (demo) begin();
            await run(`Bet ${eth(wager)} ETH at ${chancePercent}%`, (send) => send("Play", playCall(d, collection, chanceBps, wager)), [
              `You pay ${eth(wager)} ETH now.`,
              `${eth(fee)} ETH of it is the fee (the ${bps(g.edgeBps)} edge): ${edgeSplit(g)}.`,
              `If the roll is below ${chanceBps} of 10000 (${chancePercent}%): you receive ${eth(payout)} ETH.`,
              "Otherwise you receive nothing and the stake goes to the house bankroll.",
              "The result arrives with the randomness provider's answer. If none arrives within a day, the bet can be refunded.",
            ], { quickInDemo: true });
            end();
          };
          // While a bet is in play (and until the next one) the track shows the chance that bet was placed at.
          const shownChance = busy && latest ? latest.chanceBps / 100 : chancePercent;
          const isWin = tone === "win" || tone === "big" || tone === "jackpot";
          return (
            <>
              <div className={`stage stage-dice${tone ? ` tone-${tone}` : ""}${busy ? " is-busy" : ""}`} ref={stage}>
                <div className="dice-top">
                  <div className="segmented mode-tabs" role="group" aria-label="Game">
                    {(["dice", "coin"] as const).map((m) => (
                      <button key={m} type="button" className={mode === m ? "on" : undefined} aria-pressed={mode === m} disabled={busy} onClick={() => (sound.click(), setMode(m))}>
                        {m === "dice" ? "Dice" : "Coinflip"}
                      </button>
                    ))}
                  </div>
                  <div className="multiple" aria-label={`A win pays ${multiple.toFixed(2)} times the wager, ${shownChance}% of the time`}>
                    <CountUp className="multiple-value" value={diceMultiple(shownChance * 100, g.edgeBps)} format={(v) => `×${v.toFixed(2)}`} duration={260} />
                    <span className="multiple-sub">
                      on a win · <strong>{shownChance}%</strong> chance
                    </span>
                  </div>
                </div>

                <div className={`arena actor-${mode} is-${tumble.state}`} ref={arena}>
                  <span className="actor-shadow" ref={tumble.shadow} aria-hidden="true" />
                  <div className="actor" ref={tumble.actor} role="img" aria-label={busy ? (mode === "coin" ? "The coin is in the air" : "The die is in the air") : result ? (mode === "coin" ? `The coin shows the ${result.roll! < 5_000 ? "shield" : "blank"} side` : `The die shows ${dieFace(result.roll!)}`) : mode === "coin" ? "A coin" : "A die"}>
                    <div className={mode === "coin" ? "coin3d" : "die3d"} ref={tumble.solid}>
                      {mode === "coin" ? <Coin /> : <Die />}
                    </div>
                  </div>
                  <span className="arena-still" aria-hidden="true">
                    Rolling…
                  </span>
                </div>
                <RiskTrack
                  mode={mode}
                  chance={shownChance}
                  onChance={setChance}
                  locked={busy}
                  marker={result && tone ? { roll: result.roll!, tone, chanceBps: result.chanceBps } : undefined}
                  ghosts={dice.filter((bet) => bet.roll !== undefined && bet !== latest && betPhase(chainId, bet) === "done").slice(0, 14)}
                />

                <p className={`cab-lcd${tone ? ` tone-${tone}` : ""}`} aria-live="polite">
                  {placing
                    ? "Placing the bet…"
                    : refused
                      ? "Not placed: nothing was wagered."
                    : !latest
                      ? mode === "coin"
                        ? "Set a wager and flip."
                        : "Drag the edge of the win zone, set a wager and roll."
                      : phase === "pending"
                        ? `Bet #${latest.requestId} is in the air…`
                        : latest.status === "refunded"
                          ? `Bet #${latest.requestId} was refunded: the wager came back.`
                          : !result
                            ? " "
                            : isWin
                              ? `Rolled ${result.roll}, below ${result.chanceBps}: ${eth(result.payout ?? 0n)} ETH paid.`
                              : tone === "returned"
                                ? `Rolled ${result.roll}, below ${result.chanceBps}: ${eth(result.payout ?? 0n)} ETH back of ${eth(result.wager)} ETH wagered.`
                                : `Rolled ${result.roll}. It needed to be below ${result.chanceBps}. No payout.`}
                  {result && mode === "dice" && <span className="lcd-roll"> die {dieFace(result.roll!)} = rolls {Math.ceil(((dieFace(result.roll!) - 1) * 10_000) / 6)}–{Math.ceil((dieFace(result.roll!) * 10_000) / 6) - 1}</span>}
                </p>

                <div className="dice-controls">
                  {mode === "dice" && (
                    <div className="chips presets" role="group" aria-label="Chance of winning">
                      {PRESETS.map((p) => (
                        <button key={p} type="button" className={chanceChoice === p ? "chip on" : "chip"} aria-pressed={chanceChoice === p} disabled={busy} onClick={() => (sound.click(), setChance(p))}>
                          {p}%<small>×{diceMultiple(p * 100, g.edgeBps).toFixed(2)}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="cab-controls">
                    <WagerControl value={wagerText} onChange={setWagerText} min={g.minBet} max={maxWager} onEnter={() => !blocked && void play()} />
                    <ActionButton className="spin-btn" onClick={() => void play()} blocked={blocked} aria-disabled={busy || undefined}>
                      <span className="spin-btn-label">{busy ? "Rolling" : mode === "coin" ? "Flip" : "Roll"}</span>
                    </ActionButton>
                  </div>
                </div>
                <dl className="cab-cost">
                  <div>
                    <dt>Win pays</dt>
                    <dd>{wager === undefined ? "–" : quote.data ? `${eth(quote.data.payout)} ETH` : quote.isError ? "no quote" : "…"}</dd>
                  </div>
                  <div>
                    <dt>Chance</dt>
                    <dd>{chancePercent}% to win</dd>
                  </div>
                  <div>
                    <dt>Fee ({bps(g.edgeBps)})</dt>
                    <dd>{wager === undefined ? "–" : quote.data ? `${eth(quote.data.fee)} ETH` : "…"}</dd>
                  </div>
                  <div>
                    <dt>A loss costs</dt>
                    <dd>{wager !== undefined ? `${eth(wager)} ETH` : "–"}</dd>
                  </div>
                </dl>
                <p className="cab-note">
                  {mode === "coin"
                    ? "The coin shows the roll: shield side for a roll below 5000, blank side otherwise. The payout comes from the contract."
                    : "The die shows which sixth of the range the roll fell in; the marker shows the roll itself. The payout comes from the contract."}
                  {" "}The {bps(g.edgeBps)} edge: {edgeSplit(g)}.
                  {!g.supported && " The owner has not enabled games for this collection."}
                  {preview && " Development preview: not a real bet."}
                </p>
                <ParticleLayer controller={particles} />
              </div>
              <SessionNet bets={bets.data} />
              <OwedRow g={g} />
              <Card title="The house">
                <p className="muted">
                  Pick your chance of winning and bet against the house. {bps(g.edgeBps)} of every wager is the edge
                  ({edgeSplit(g)}); the rest is played at fair odds, so a lower chance pays more.
                </p>
                <HouseStats g={g} maxWager={maxWager} maxLabel={`Max wager at ${chancePercent}%`} />
              </Card>
            </>
          );
        }}
      </QueryView>
      <BetList bets={bets} kind="dice" title="Your dice bets" />
    </div>
  );
}
