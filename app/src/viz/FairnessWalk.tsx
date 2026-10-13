// The verification story as something to operate: request, proof, roll, payout. The visitor sets a
// wager and a chance, draws a sample number and watches the same arithmetic the contract uses
// (lib/gameMath.ts, the module the Verify view and the demo share) turn it into a payout.
//
// The sample number comes from this browser. It shows the arithmetic; it is not a draw and no bet
// is placed, and the component says so.
import { useEffect, useRef, useState } from "react";
import { parseEther } from "viem";
import { eth } from "../lib/format";
import { recomputeBet, SLOTS_PAY_TABLE } from "../lib/gameMath";
import { useReducedMotion } from "./motion";

const STAGES = ["Request", "Proof", "Roll", "Payout"] as const;

function sampleWord(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((word, byte) => (word << 8n) | BigInt(byte), 0n);
}
const hex = (word: bigint) => word.toString(16).padStart(64, "0");

export function FairnessWalk({ edgeBps = 200n, compact = false }: { edgeBps?: bigint; compact?: boolean }) {
  const reduced = useReducedMotion();
  const [game, setGame] = useState<"dice" | "slots">("dice");
  const [wagerText, setWagerText] = useState("0.1");
  const [chance, setChance] = useState(50);
  const [word, setWord] = useState<bigint>(() => sampleWord());
  // how far the walk has got: 0 request, 1 proof, 2 roll, 3 payout
  const [stage, setStage] = useState(3);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  let wager = 0n;
  try {
    wager = parseEther(wagerText.trim() || "0");
  } catch {
    wager = 0n;
  }
  const chanceBps = game === "dice" ? chance * 100 : 0;
  const roll = Number(word % 10_000n);
  const result = recomputeBet({ wager, edgeBps, chanceBps, roll });
  const edgeText = `${Number(edgeBps) / 100}%`;

  const draw = () => {
    timers.current.forEach(clearTimeout);
    setWord(sampleWord());
    if (reduced) return setStage(3);
    setStage(0);
    timers.current = [1, 2, 3].map((n) => window.setTimeout(() => setStage(n), n * 520));
  };

  return (
    <div className={compact ? "walk compact" : "walk"}>
      <ol className="walk-rail" aria-label="The four steps of a result">
        {STAGES.map((name, i) => (
          <li key={name} className={i <= stage ? "on" : undefined} aria-current={i === stage ? "step" : undefined}>
            <span>{i + 1}</span>
            {name}
          </li>
        ))}
      </ol>

      <div className="walk-grid">
        <section className={stage >= 0 ? "walk-step on" : "walk-step"}>
          <h3>1. Request</h3>
          <p className="muted small">A bet stores its wager, its chance and the edge in force. A later change by the owner cannot reach it.</p>
          <div className="segmented" role="group" aria-label="Game">
            <button type="button" className={game === "dice" ? "on" : undefined} aria-pressed={game === "dice"} onClick={() => setGame("dice")}>
              Dice
            </button>
            <button type="button" className={game === "slots" ? "on" : undefined} aria-pressed={game === "slots"} onClick={() => setGame("slots")}>
              Slots
            </button>
          </div>
          <label className="field">
            <span>Wager (ETH)</span>
            <input inputMode="decimal" value={wagerText} onChange={(e) => setWagerText(e.target.value)} />
          </label>
          {game === "dice" && (
            <label className="field">
              <span>Chance of winning: {chance}%</span>
              <input type="range" min={1} max={95} value={chance} onChange={(e) => setChance(Number(e.target.value))} />
            </label>
          )}
        </section>

        <section className={stage >= 1 ? "walk-step on" : "walk-step"}>
          <h3>2. Proof</h3>
          <p className="muted small">
            The contracts are written for Chainlink VRF: the number arrives with a proof that the coordinator verifies on-chain before the game
            accepts it. Nobody can choose it. The oracle does know it before delivering it.
          </p>
          <code className="walk-word" aria-label="Sample 256-bit number">
            0x{hex(word).slice(0, 60)}
            <mark>{hex(word).slice(60)}</mark>
          </code>
          <p className="walk-note small">A sample number from your browser, to show the arithmetic. Not a draw, and no proof is involved here.</p>
          <button type="button" className="btn secondary" onClick={draw}>
            Draw another sample number
          </button>
        </section>

        <section className={stage >= 2 ? "walk-step on" : "walk-step"}>
          <h3>3. Roll</h3>
          <p className="muted small">
            roll = number mod 10000. {game === "dice" ? "The bet wins if the roll is below the chance." : "The roll is looked up in a fixed table."}
          </p>
          <p className="walk-roll">
            <strong>{roll.toString().padStart(4, "0")}</strong>
            <span className={result.won ? "badge badge-good" : "badge badge-muted"}>
              {game === "dice" ? (result.won ? `below ${chanceBps}: wins` : `not below ${chanceBps}: loses`) : result.multiplier ? `pays ${result.multiplier}×` : "pays nothing"}
            </span>
          </p>
          <div className="walk-track" aria-hidden="true">
            {game === "dice" ? (
              <span className="zone win" style={{ width: `${chance}%` }} />
            ) : (
              SLOTS_PAY_TABLE.map((tier, i) => <span key={tier.multiplier} className={i === result.tierIndex ? `zone tier t${i} hit` : `zone tier t${i}`} style={{ width: `${tier.chanceBps / 100}%` }} />)
            )}
            <i className="walk-marker" style={{ left: `${roll / 100}%` }} />
          </div>
          <div className="walk-scale small muted" aria-hidden="true">
            <span>0</span>
            <span>{game === "dice" ? `chance ${chanceBps}` : "50× 10× 5× 2× 1× then nothing"}</span>
            <span>9999</span>
          </div>
        </section>

        <section className={stage >= 3 ? "walk-step on" : "walk-step"}>
          <h3>4. Payout</h3>
          <p className="muted small">Anyone can redo this sum from the bet's events. The app's Verify button does it next to what the contract paid.</p>
          <dl className="walk-sum">
            <div>
              <dt>fee = wager × {edgeText}</dt>
              <dd>{eth(result.fee)} ETH</dd>
            </div>
            <div>
              <dt>stake = wager − fee</dt>
              <dd>{eth(result.stake)} ETH</dd>
            </div>
            <div className={result.payout > wager ? "total gold" : "total"}>
              <dt>{game === "dice" ? (result.won ? `payout = stake × 10000 ÷ ${chanceBps}` : "payout (roll not below chance)") : `payout = stake × ${result.multiplier ?? 0}`}</dt>
              <dd>{eth(result.payout)} ETH</dd>
            </div>
          </dl>
          <p className="small muted">
            By default half of the fee stays in the games bankroll and half goes to the Treasury as buyback budget for the collection the player
            backs. The player's expected return is minus the fee.
          </p>
        </section>
      </div>
    </div>
  );
}
