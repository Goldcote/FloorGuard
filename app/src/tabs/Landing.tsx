// The outward-facing page. Everything that moves here is drawn from the demo simulation running in
// this browser tab; nothing is fetched and nothing is real money.
import { useEffect, useRef, useState } from "react";
import { setMode } from "../demo/mode";
import { DEMO_COLLECTION, DEMO_DEPLOYMENT, demoReads, demoWrite, subscribeDemo } from "../demo/sim";
import { FloorLine } from "../brand";
import { spinCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import { SLOTS_PAY_TABLE } from "../lib/reads";
import { href } from "../routes";
import { Machine } from "./Slots";

/** A value from the simulation, re-read on every change and once a second (its clock runs fast). */
function useDemo<T>(read: () => T): T {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1_000);
    const off = subscribeDemo(() => tick((n) => n + 1));
    return () => {
      clearInterval(id);
      off();
    };
  }, []);
  return read();
}

const W = 560;
const H = 300;
const toNumber = (wei: bigint) => Number(wei / 10n ** 12n) / 1e6;

/** The hero picture: the floor line, vault tiles resting on it, and the bid rising towards it, live. */
function HeroScene() {
  const [points, setPoints] = useState<number[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const floor = toNumber(useDemo(() => demoReads.overview().salesFloor.ok ? (demoReads.overview().salesFloor as { price: bigint }).price : 0n));
  const bid = toNumber(useDemo(() => demoReads.floorBid().currentBid));

  useEffect(() => {
    const sample = () => setPoints((list) => [...list.slice(-59), toNumber(demoReads.floorBid().currentBid)]);
    sample();
    const id = setInterval(sample, 500);
    return () => clearInterval(id);
  }, []);

  // Pointer parallax: the scene's layers shift slightly with the pointer. Skipped for reduced motion in CSS.
  const onMove = (event: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    ref.current!.style.setProperty("--px", String((event.clientX - box.left) / box.width - 0.5));
    ref.current!.style.setProperty("--py", String((event.clientY - box.top) / box.height - 0.5));
  };

  const lo = 0.7;
  const hi = 1.25;
  const y = (value: number) => H - 40 - ((Math.min(hi, Math.max(lo, value)) - lo) / (hi - lo)) * (H - 90);
  const floorY = y(floor);
  const path = points.map((value, i) => `${i === 0 ? "M" : "L"}${((i / 59) * W).toFixed(1)},${y(value).toFixed(1)}`).join(" ");

  return (
    <div className="hero-scene" ref={ref} onPointerMove={onMove}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Demo: the floor is at ${floor.toFixed(3)} ETH and the protocol's bid is ${bid.toFixed(4)} ETH and rising`}>
        <defs>
          <linearGradient id="bid-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="layer back">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <line key={i} x1={i * 93} y1="0" x2={i * 93} y2={H} className="grid" />
          ))}
        </g>
        <g className="layer mid">
          {path && <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#bid-fill)" />}
          {path && <path d={path} className="bid-line" />}
        </g>
        <g className="layer front">
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} className={`tile tile-${i}`} x={40 + i * 100} y={floorY - 64 - (i % 2) * 6} width="68" height="64" rx="10" />
          ))}
          <line x1="0" y1={floorY} x2={W} y2={floorY} className="floor" />
          <text x={W - 8} y={floorY - 8} textAnchor="end" className="scene-label">
            floor {floor.toFixed(3)} ETH
          </text>
          <text x={W - 8} y={Math.min(H - 8, y(bid) + 18)} textAnchor="end" className="scene-label accent">
            bid {bid.toFixed(4)} ETH, rising
          </text>
        </g>
      </svg>
      <p className="scene-caption small">Live from the demo simulation in your browser. Simulated time runs fast.</p>
    </div>
  );
}

const STEPS = [
  ["Fees in", "Sales pay 2%. Prediction winnings pay 3%. Dice and slots pay their 2% edge. Lottery and raffle pots pay 5%. Licences pay their price."],
  ["A budget per collection", "Each collection's fees are kept apart. A budget can only ever buy that collection's floor."],
  ["A bid that rises", "The protocol quotes a standing bid. It climbs until a holder sells into it, then steps down and climbs again. No oracle decides it."],
  ["A vault that holds", "What the bid buys is locked for at least 180 days and until the floor is 30% above the purchase price."],
  ["Out again", "Unlocked NFTs are auctioned, with proceeds going back to the budget, or raffled to the people whose fees paid for them."],
] as const;

/** The flywheel as a path with value flowing along it; the live demo numbers sit in the steps. */
function Flywheel() {
  const overview = useDemo(() => demoReads.overview());
  const live = [
    undefined,
    `${eth(overview.floorBid.budget, 3)} ETH in the demo budget`,
    `${eth(overview.floorBid.currentBid, 4)} ETH bid right now`,
    `${overview.collectionHoldingsInVault} in the demo vault`,
    undefined,
  ];
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const items = ref.current?.querySelectorAll("li") ?? [];
    const observer = new IntersectionObserver((entries) => entries.forEach((e) => e.target.classList.toggle("in", e.isIntersecting)), { threshold: 0.4 });
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);
  return (
    <ol className="story" ref={ref}>
      {STEPS.map(([title, text], i) => (
        <li key={title}>
          <span className="story-dot" aria-hidden="true" />
          <div>
            <h3>{title}</h3>
            <p>{text}</p>
            {live[i] && <p className="story-live">{live[i]}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const MINI_WAGER = 10n ** 16n; // 0.01 play ETH

/** A playable slot machine on play money. The same simulation and the same pay table as the app. */
function MiniSlots() {
  const bets = useDemo(() => demoReads.userBets().find((bet) => bet.kind === "slots"));
  const balance = useDemo(() => demoReads.balance());
  const [error, setError] = useState<string>();
  const pending = bets?.status === "pending";
  const spin = () => {
    setError(undefined);
    demoWrite(spinCall(DEMO_DEPLOYMENT, DEMO_COLLECTION, MINI_WAGER)).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="mini">
      <Machine bet={bets} />
      <button type="button" className="btn spin" onClick={spin} disabled={pending}>
        {pending ? "Spinning…" : "Spin 0.01 play ETH"}
      </button>
      <p className="muted small center-text" aria-live="polite">
        {error ?? `Demo balance: ${eth(balance, 4)} play ETH. The 2% edge is taken from every wager; about half of all spins pay nothing.`}
      </p>
    </div>
  );
}

export function Landing() {
  const launch = (path: string) => () => {
    setMode("demo", false);
    window.location.hash = path;
  };
  return (
    <div className="landing-page">
      <section className="l-hero">
        <div className="l-hero-copy">
          <p className="eyebrow">An NFT marketplace protocol</p>
          <h1>
            Every fee <span className="accent-text">guards the floor.</span>
          </h1>
          <p className="lede">
            Marketplaces without royalties reward sellers for undercutting each other. FloorGuard turns the fees it
            earns on a collection into a standing bid for that collection's floor.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn big" onClick={launch("/app")}>
              Launch the demo
            </button>
            <a className="btn secondary big" href="#how" onClick={(e) => (e.preventDefault(), document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }))}>
              See how it works
            </a>
          </div>
          <p className="muted small">No wallet needed. The demo is a simulation with play money; there is no public deployment yet.</p>
        </div>
        <HeroScene />
      </section>
      <FloorLine />

      <section id="how" className="l-section">
        <p className="eyebrow">The flywheel</p>
        <h2>Fees become a bid. The bid becomes a vault.</h2>
        <Flywheel />
      </section>

      <section className="l-section l-split">
        <div>
          <p className="eyebrow">Play</p>
          <h2>Games that pay the floor, not an operator.</h2>
          <p className="lede">
            Dice, coinflip, slots, a lottery and raffles. The house edge is 2% on dice and slots and goes to the buyback
            budget of the collection you back; the rest of your stake is played at exactly fair odds.
          </p>
          <table className="pay-table">
            <thead>
              <tr>
                <th>Slots prize</th>
                <th>Chance</th>
              </tr>
            </thead>
            <tbody>
              {SLOTS_PAY_TABLE.map((tier) => (
                <tr key={tier.multiplier}>
                  <td>{tier.multiplier === 0 ? "nothing" : `${tier.multiplier}× the stake`}</td>
                  <td>{bps(tier.chanceBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Games of chance are regulated or prohibited in many places. Play only with what you can afford to lose.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn" onClick={launch("/play/slots")}>
              Open the games in the demo
            </button>
          </div>
        </div>
        <MiniSlots />
      </section>

      <section className="l-section">
        <p className="eyebrow">Fairness</p>
        <h2>Outcomes you can recompute.</h2>
        <div className="l-cards">
          <div>
            <h3>One number, one fixed rule</h3>
            <p>A bet wins if a roll from 0 to 9999 is below your chance. Slots look the same roll up in a fixed table. A draw is the random number modulo the tickets sold.</p>
          </div>
          <div>
            <h3>Check it yourself</h3>
            <p>Every settled bet and draw has a Verify view that recomputes the payout in your browser, step by step, next to what was paid.</p>
          </div>
          <div>
            <h3>Only as fair as its randomness</h3>
            <p>The contracts are written for Chainlink VRF. The demo, and local test chains, use pseudo-random numbers and are not fair play. The app says which one you are on.</p>
          </div>
        </div>
        <a className="btn secondary" href={href("/fairness")}>
          Read the fairness page
        </a>
      </section>

      <section className="l-section">
        <p className="eyebrow">Status</p>
        <h2>Where this honestly stands.</h2>
        <ul className="status-list">
          <li><strong>Unaudited.</strong> No professional audit, no formal verification, no testnet soak. Five automated review passes were run and their findings fixed; that is not an audit.</li>
          <li><strong>Not deployed publicly.</strong> It runs on a local chain. A Base Sepolia deployment has been simulated, not broadcast.</li>
          <li><strong>The owner must be trusted.</strong> The owner can change fees, oracles, the randomness provider and the Treasury spender. It must be a timelocked multisig before any real use.</li>
          <li><strong>The Chainlink adapter is untested live.</strong> It has only run against a simulated coordinator.</li>
          <li><strong>No token, no promise.</strong> There is no governance token and nothing here is an investment or a promise of profit.</li>
        </ul>
        <div className="hero-actions">
          <button type="button" className="btn big" onClick={launch("/app")}>
            Launch the demo
          </button>
        </div>
      </section>
    </div>
  );
}
