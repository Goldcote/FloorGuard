// Small display pieces shared by the stages: a countdown with weight, a share ring, a token emblem
// and the draw tape. Presentational only: they take numbers and draw them. Styled in fx.css
// (structure) and src/styles/play.css (the stage look).
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { drawTape, DRAW_TAPE_MS, hueOf, tapeProgress } from "./gameviz";
import { clamp, prefersReducedMotion } from "./motion";

// ---------------------------------------------------------------- countdown

const two = (n: number) => n.toString().padStart(2, "0");

/**
 * Time left as big tabular digits (days appear only when there are any). Each unit re-plays a short
 * roll when its value changes. `total` (seconds the whole period lasts) adds a bar that drains.
 * It is a `role="timer"`: assistive technology reads it on demand, not every second.
 */
export function Countdown({ seconds, total, label, done = "Ended" }: { seconds: number; total?: number; label?: string; done?: string }) {
  const s = Math.max(0, Math.floor(seconds));
  const units: [string, string][] = [];
  const days = Math.floor(s / 86_400);
  if (days > 0) units.push([String(days), "d"]);
  units.push([two(Math.floor((s % 86_400) / 3_600)), "h"], [two(Math.floor((s % 3_600) / 60)), "m"], [two(s % 60), "s"]);
  const spoken = s === 0 ? done : units.map(([value, unit]) => `${Number(value)}${unit}`).join(" ");
  const left = total && total > 0 ? clamp(s / total) : undefined;
  return (
    <div className={s === 0 ? "cd is-done" : "cd"} role="timer" aria-label={label ? `${label}: ${spoken}` : spoken}>
      <div className="cd-units" aria-hidden="true">
        {s === 0 ? (
          <span className="cd-done">{done}</span>
        ) : (
          units.map(([value, unit]) => (
            <span className="cd-unit" key={unit}>
              <span className="cd-digits" key={value}>
                {value}
              </span>
              <span className="cd-label">{unit}</span>
            </span>
          ))
        )}
      </div>
      {left !== undefined && (
        <div className="cd-bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${left})` }} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- share ring

const RING_R = 52;

/**
 * A ring that fills to `share` (0..1): odds you can see. `outer` (0..1) draws a second, thinner arc
 * outside it for a comparison, e.g. your share if every ticket sells. Children are the centre label.
 */
export function ShareRing({ share, outer, tone = "accent", label, children }: { share: number; outer?: number; tone?: "accent" | "gold" | "muted"; label: string; children?: ReactNode }) {
  const arc = (value: number, radius: number): CSSProperties => {
    const c = 2 * Math.PI * radius;
    return { strokeDasharray: `${c} ${c}`, strokeDashoffset: c * (1 - clamp(value)) };
  };
  return (
    <div className={`ring ring-${tone}`} role="img" aria-label={label}>
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <circle className="ring-track" cx="60" cy="60" r={RING_R} />
        {outer !== undefined && <circle className="ring-outer" cx="60" cy="60" r={RING_R + 5} style={arc(outer, RING_R + 5)} />}
        {share > 0 && <circle className="ring-value" cx="60" cy="60" r={RING_R} style={arc(share, RING_R)} />}
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- token emblem

/**
 * A generated emblem for an NFT the app has no artwork for: a symmetric tile pattern derived from the
 * collection and token id, with the id on it. It stands in for the token; it is not its image.
 */
export function TokenEmblem({ collection, tokenId, className }: { collection: string; tokenId: bigint; className?: string }) {
  const cells = useMemo(() => {
    let seed = (hueOf(`${collection.toLowerCase()}:${tokenId}`) + 1) * 2_654_435_761;
    const next = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2_246_822_519) + 0x9e3779b9) | 0), (seed >>> 8) & 0xff);
    const out: { x: number; y: number; level: number }[] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        const v = next();
        if (v < 110) continue;
        const level = v > 200 ? 2 : 1;
        out.push({ x, y, level });
        if (x < 2) out.push({ x: 4 - x, y, level });
      }
    }
    return out;
  }, [collection, tokenId]);
  const variant = hueOf(`${tokenId}`) % 3;
  return (
    <svg viewBox="0 0 100 100" className={`emblem emblem-${variant}${className ? ` ${className}` : ""}`} role="img" aria-label={`Token #${tokenId} (generated emblem, not the artwork)`}>
      <rect className="emblem-bg" x="1" y="1" width="98" height="98" rx="14" />
      {cells.map(({ x, y, level }) => (
        <rect key={`${x}-${y}`} className={`emblem-cell l${level}`} x={17 + x * 13.5} y={12 + y * 11} width="12" height="9.5" rx="2.5" />
      ))}
      <path className="emblem-floor" d="M10 72h80" />
      <text className="emblem-id" x="50" y="90" textAnchor="middle">
        #{tokenId.toString()}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- draw tape

export type TapePhase = "still" | "rolling" | "landing" | "landed";
const LEAD = 8; // cells kept to the left of the pointer so the tape never starts or ends empty
const LOOP = 24;

/**
 * The draw as a tape of ticket numbers under a pointer.
 *
 * - `still`: tickets 0, 1, 2 … at rest (nothing drawn yet);
 * - `rolling`: the tape runs while the draw waits for its random number;
 * - `landing`: it decelerates for DRAW_TAPE_MS and stops on `ticket`, the real winning number,
 *   counting tickets in their natural order (see drawTape);
 * - `landed`: at rest on `ticket`.
 *
 * `startedMs` resumes a landing that began that long ago. `onStep` fires as each ticket passes the
 * pointer (for a tick sound), `onLand` once when it rests.
 */
export function DrawTapeView({ count, ticket, phase, startedMs = 0, mine = false, onStep, onLand }: { count: number; ticket?: number; phase: TapePhase; startedMs?: number; mine?: boolean; onStep?: (progress: number) => void; onLand?: () => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const landing = (phase === "landing" || phase === "landed") && ticket !== undefined;
  const tape = useMemo(() => (landing ? drawTape(ticket!, count) : undefined), [landing, ticket, count]);
  const cells = useMemo(() => {
    if (tape) return tape.cells;
    if (phase === "rolling") return Array.from({ length: LOOP + LEAD * 2 + 2 }, (_, i) => (i % LOOP) % Math.max(1, count));
    return Array.from({ length: LEAD * 2 + 1 }, (_, i) => i - LEAD).map((n) => (count > 0 ? ((n % count) + count) % count : -1));
  }, [tape, phase, count]);
  const callbacks = useRef({ onStep, onLand });
  callbacks.current = { onStep, onLand };

  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const place = (position: number) => (element.style.transform = `translate3d(calc(var(--tape-cell) * ${-position}), 0, 0)`);
    if (!tape) {
      // still: parked on ticket 0; rolling: the CSS loop drives the strip
      if (phase === "still") place(LEAD);
      else element.style.transform = "";
      return;
    }
    if (phase === "landed" || prefersReducedMotion()) {
      place(tape.landIndex);
      if (phase === "landing") callbacks.current.onLand?.();
      return;
    }
    let frame = 0;
    let lastCell = -1;
    const begin = performance.now() - startedMs;
    const step = (now: number) => {
      const t = clamp((now - begin) / DRAW_TAPE_MS);
      const position = LEAD + (tape.landIndex - LEAD) * tapeProgress(t);
      place(position);
      const cell = Math.round(position);
      if (cell !== lastCell) {
        lastCell = cell;
        callbacks.current.onStep?.(t);
      }
      if (t < 1) frame = requestAnimationFrame(step);
      else callbacks.current.onLand?.();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [tape, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const label =
    phase === "landed" && ticket !== undefined ? `Winning ticket number ${ticket} of ${count}` : phase === "rolling" || phase === "landing" ? "The draw is running" : `${count} tickets, numbered 0 to ${Math.max(0, count - 1)}`;
  return (
    <div className={`tape is-${phase}${mine ? " is-mine" : ""}`} role="img" aria-label={label}>
      <div className="tape-window">
        <div className="tape-strip" ref={strip}>
          {cells.map((n, i) => (
            <span className={tape && i === tape.landIndex ? "tape-cell is-winner" : "tape-cell"} key={i}>
              {n < 0 ? "·" : n}
            </span>
          ))}
        </div>
      </div>
      <span className="tape-pointer" aria-hidden="true" />
    </div>
  );
}
