// Small visual parts shared by the pages: a token's stand-in face, the vault's lock mechanisms,
// the bar that shows who receives what, and a few glyphs. All SVG and CSS; nothing is fetched.
import type { CSSProperties, ReactNode } from "react";
import { duration, eth } from "../lib/format";
import { priceLock, timeLock, toEth, tokenPattern } from "./curves";

export type TileState = "locked" | "unlocked" | "auction" | "released" | "plain";

/**
 * A stand-in face for a token: a symmetric pattern generated from its id. The app loads no artwork
 * (no network calls), so this is a placeholder and says so in its tooltip.
 */
export function TokenTile({ tokenId, size = 64, state = "plain", label = true }: { tokenId: bigint | number; size?: number; state?: TileState; label?: boolean }) {
  const { hue, cells } = tokenPattern(tokenId);
  return (
    <span className={`token-tile is-${state}`} style={{ "--h": hue, width: size, height: size } as CSSProperties} title={`Token #${tokenId}. Placeholder pattern generated from the token id; the app does not load artwork.`}>
      <svg viewBox="0 0 7 7" aria-hidden="true" focusable="false">
        {cells.map((on, i) => (on ? <rect key={i} x={1 + (i % 5)} y={1 + Math.floor(i / 5)} width="1.04" height="1.04" /> : null))}
      </svg>
      {label && <span className="token-id">#{tokenId.toString()}</span>}
      {state === "locked" && (
        <span className="token-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/** Under a day, in one unit that fits a dial's centre: "8h", "40m". */
const short = (seconds: number) => (seconds >= 3_600 ? `${Math.ceil(seconds / 3_600)}h` : `${Math.max(1, Math.ceil(seconds / 60))}m`);

export function Shackle({ open, size = 22 }: { open: boolean; size?: number }) {
  return (
    <svg className={open ? "shackle open" : "shackle"} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="shackle-bow" d="M7.500 11V8a4.500 4.500 0 0 1 9 0v3" />
      <rect x="5" y="11" width="14" height="10" rx="2.500" />
      <circle cx="12" cy="16" r="1.500" className="shackle-key" />
    </svg>
  );
}

/**
 * A time lock as a dial: the ring closes as the lock passes. `title` and the texts name the lock
 * (the 90 days before a holding joins the unlock draw, or a players' holding's 30 days).
 */
export function TimeLockDial({
  acquiredAt,
  lockedUntil,
  now,
  size = 92,
  title = "Time lock",
  waitText = (left) => `Opens in ${left}.`,
  openText = "The lock period has passed.",
}: {
  acquiredAt: number;
  lockedUntil: number;
  now: number;
  size?: number;
  title?: string;
  waitText?: (left: string) => ReactNode;
  openText?: ReactNode;
}) {
  const lock = timeLock(acquiredAt, lockedUntil, now);
  const r = 40;
  const length = 2 * Math.PI * r;
  const days = Math.ceil(lock.remaining / 86_400);
  return (
    <div className={lock.open ? "lock-mech is-open" : "lock-mech"}>
      <svg className="dial" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={lock.open ? `${title}: over` : `${title}: ${duration(lock.remaining)} left`}>
        <circle className="dial-track" cx="50" cy="50" r={r} />
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} className="dial-tick" x1="50" y1="4" x2="50" y2={i % 3 === 0 ? 9 : 7} transform={`rotate(${i * 30} 50 50)`} />
        ))}
        <circle className="dial-arc" cx="50" cy="50" r={r} strokeDasharray={length} strokeDashoffset={length * (1 - lock.progress)} transform="rotate(-90 50 50)" />
        <text className="dial-value" x="50" y="52" textAnchor="middle">
          {lock.open ? "open" : days > 1 ? `${days}d` : short(lock.remaining)}
        </text>
        <text className="dial-unit" x="50" y="66" textAnchor="middle">
          {lock.open ? "time" : "left"}
        </text>
      </svg>
      <div className="lock-text">
        <strong>{title}</strong>
        <span>{lock.open ? openText : waitText(duration(lock.remaining))}</span>
      </div>
    </div>
  );
}

/**
 * The daily unlock draw as a dial: the ring fills with the holding's age up to a year, and the
 * centre shows its chance in today's draw (or the days until it joins).
 */
export function DrawDial({ age, chanceBps, eligibleIn, picked, size = 92, children }: { age: number; chanceBps: number; eligibleIn: number; picked: boolean; size?: number; children: ReactNode }) {
  const r = 40;
  const length = 2 * Math.PI * r;
  const progress = Math.min(1, Math.max(0, age / (365 * 86_400)));
  const days = Math.ceil(eligibleIn / 86_400);
  return (
    <div className={picked ? "lock-mech is-open" : "lock-mech"}>
      <svg
        className="dial"
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="img"
        aria-label={eligibleIn > 0 ? `Daily draw: joins in ${duration(eligibleIn)}` : `Daily draw: ${(chanceBps / 100).toFixed(2)}% chance a day${picked ? ", picked today" : ""}`}
      >
        <circle className="dial-track" cx="50" cy="50" r={r} />
        {/* 90 days, the earliest draw, and the year at which the chance stops rising */}
        <line className="dial-tick" x1="50" y1="4" x2="50" y2="12" transform={`rotate(${(90 / 365) * 360} 50 50)`} />
        <circle className="dial-arc" cx="50" cy="50" r={r} strokeDasharray={length} strokeDashoffset={length * (1 - progress)} transform="rotate(-90 50 50)" />
        <text className="dial-value" x="50" y="52" textAnchor="middle">
          {eligibleIn > 0 ? (days > 1 ? `${days}d` : short(eligibleIn)) : `${Number((chanceBps / 100).toFixed(2))}%`}
        </text>
        <text className="dial-unit" x="50" y="66" textAnchor="middle">
          {eligibleIn > 0 ? "to draw" : "a day"}
        </text>
      </svg>
      <div className="lock-text">
        <strong>Daily draw</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

/**
 * The price condition as a gauge: a floor against the multiple of what the vault paid that unlocks
 * it (130% unless `requiredBps` says otherwise). `floorLabel` names the floor ("Median floor").
 */
export function PriceLockGauge({
  purchasePrice,
  floor,
  floorNote,
  requiredBps = 13_000,
  title = "Price lock",
  floorLabel = "Floor",
}: {
  purchasePrice: bigint;
  floor: bigint | undefined;
  floorNote?: string;
  requiredBps?: number;
  title?: string;
  floorLabel?: string;
}) {
  const lock = priceLock(purchasePrice, floor, requiredBps);
  const needed = `${Number((requiredBps / 100).toFixed(1))}%`;
  // the gauge runs from 80% to 160% of the purchase price
  const at = (ratio: number) => `${Math.min(100, Math.max(0, ((ratio - 0.8) / 0.8) * 100))}%`;
  return (
    <div className={lock.open ? "lock-mech is-open" : "lock-mech"}>
      <div className="gauge" role="img" aria-label={floor === undefined ? `${title}: no floor price` : `${title}: the ${floorLabel.toLowerCase()} is at ${(lock.ratio * 100).toFixed(0)}% of the purchase price; it opens at ${needed}`}>
        <div className="gauge-track">
          <span className="gauge-zone" style={{ left: at(requiredBps / 10_000) }} />
          <span className="gauge-fill" style={{ left: at(1), width: `calc(${at(Math.max(1, Math.min(lock.ratio, 1.6)))} - ${at(1)})` }} />
          <span className={requiredBps / 10_000 - 1 < 0.2 ? "gauge-mark is-near" : "gauge-mark"} style={{ left: at(1) }}>
            <em>paid</em>
          </span>
          <span className="gauge-mark trigger" style={{ left: at(requiredBps / 10_000) }}>
            <em>{needed}</em>
          </span>
          {floor !== undefined && <span className="gauge-needle" style={{ left: at(lock.ratio) }} />}
        </div>
      </div>
      <div className="lock-text">
        <strong>{title}</strong>
        <span>
          {floor === undefined
            ? (floorNote ?? "The sales oracle has no floor price right now, so this lock stays shut.")
            : lock.open
              ? `${floorLabel} ${eth(floor, 4)} ETH is at or above the ${eth(lock.trigger, 4)} ETH needed.`
              : `${floorLabel} ${eth(floor, 4)} ETH; needs ${eth(lock.trigger, 4)} ETH.`}
        </span>
      </div>
    </div>
  );
}

export type SplitPart = { key: string; label: ReactNode; value: bigint; tone: "you" | "budget" | "project" | "royalty" | "other"; hint?: string };

/** Who receives what, as one bar cut in proportion and a line for each part. */
export function SplitBar({ parts, unit = "ETH", title }: { parts: SplitPart[]; unit?: string; title?: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0n);
  const shown = parts.filter((part) => part.value > 0n);
  return (
    <div className="split">
      {title && <p className="split-title">{title}</p>}
      <div className="split-bar" aria-hidden="true">
        {shown.map((part) => (
          <span key={part.key} className={`split-seg tone-${part.tone}`} style={{ flexGrow: Math.max(0.0001, toEth(part.value)) }} />
        ))}
      </div>
      <dl className="split-rows">
        {parts.map((part) => (
          <div key={part.key} className={part.value === 0n ? "split-row is-zero" : "split-row"}>
            <dt>
              <i className={`split-dot tone-${part.tone}`} aria-hidden="true" />
              {part.label}
              {part.hint && <span className="split-hint">{part.hint}</span>}
            </dt>
            <dd>
              <strong>{eth(part.value, 6)}</strong> {unit}
              {total > 0n && <span className="split-pct">{(Number((part.value * 10_000n) / total) / 100).toFixed(part.value * 100n < total ? 2 : 1)}%</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const STATE_LABEL: Record<Exclude<TileState, "plain">, string> = { locked: "Locked", unlocked: "Unlocked", auction: "On auction", released: "Released" };

/** A holding's state as a plate you can read at a glance: shape, colour and word. */
export function StatePlate({ state }: { state: Exclude<TileState, "plain"> }) {
  return (
    <span className={`state-plate is-${state}`}>
      {state === "locked" && <Shackle open={false} size={14} />}
      {state === "unlocked" && <Shackle open size={14} />}
      {state === "auction" && (
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5c5 0 5 6 8 9s5 4 8 4" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" />
          <circle cx="12" cy="14" r="2.600" fill="currentColor" />
        </svg>
      )}
      {state === "released" && (
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h12m-4-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {STATE_LABEL[state]}
    </span>
  );
}

/** A live dot: "this figure is moving". Purely decorative, still under reduced motion. */
export function LiveDot() {
  return <i className="live-dot" aria-hidden="true" />;
}
