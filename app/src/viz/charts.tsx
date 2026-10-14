// The two price curves of the protocol, drawn live: the bid that rises until someone sells into it,
// and the vault auction that falls until someone catches it. SVG laid out in real pixels (so labels
// stay readable at any width); the moving point is re-rendered about ten times a second while the
// chart is on screen, and once a second under reduced motion.
import { useMemo, useRef, useState } from "react";
import { duration } from "../lib/format";
import { auctionEndsAt, auctionPriceAt, auctionSeries, bidAt, bidPolyline, bidReachesCapAt, bidSegments, DAY, pathOf, scale, ticks, toEth, type AuctionShape, type BidConfig, type BidEvent } from "./curves";
import { useFrame, useInView, useReducedMotion, useWidth } from "./motion";

/** The clock's value, refreshed for drawing: ~10 Hz while visible, 1 Hz with reduced motion. */
export function useLiveNow(clock: () => number, active: boolean): number {
  const reduced = useReducedMotion();
  const [now, setNow] = useState(clock);
  const last = useRef(0);
  useFrame((elapsed) => {
    if (elapsed - last.current < (reduced ? 1_000 : 100)) return;
    last.current = elapsed;
    setNow(clock());
  }, active);
  return now;
}

const fmt = (n: number, digits = 4) => n.toFixed(digits);
const ago = (seconds: number) => (seconds < 60 ? "just now" : `${duration(seconds)} ago`);

export type BidState = "rising" | "capped" | "budget" | "empty" | "cooldown" | "inactive";
type BidInput = BidConfig & { budget: bigint; active: boolean; fillCooldown: number; nextFillAt: number; minBid?: bigint };

/**
 * Which state the bid is in. The curve and the bid are two things: the curve rises by its rule, the
 * bid is what a seller is paid, and when the budget holds less than the curve asks, the budget is
 * the bid.
 */
export function bidState(bid: Pick<BidInput, keyof BidConfig | "budget" | "active" | "nextFillAt" | "minBid">, now: number): BidState {
  if (!bid.active) return "inactive";
  // a bid below the collection's minimum is not a bid: nothing can be sold into it
  if (bid.budget === 0n || (bid.minBid !== undefined && bid.budget < bid.minBid)) return "empty";
  const curve = bidAt(bid, now);
  if (bid.budget < curve) return "budget";
  if (now < bid.nextFillAt) return "cooldown";
  return curve >= bid.maxPrice ? "capped" : "rising";
}

export const BID_STATE_TEXT: Record<BidState, string> = {
  rising: "Rising",
  capped: "At its cap",
  budget: "Limited by the budget",
  empty: "Below the minimum: no buyback",
  cooldown: "Pausing between sales",
  inactive: "No active bid",
};

export function BidChart({
  bid,
  events,
  first,
  clock,
  floor,
  height = 330,
}: {
  bid: BidInput;
  /** Sales into the bid and curve restarts on record (the demo keeps them; a chain read does not). */
  events: readonly BidEvent[];
  first: { time: number; base: bigint } | undefined;
  clock: () => number;
  /** The sales-oracle floor, as a reference line. */
  floor?: bigint;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 640);
  const inView = useInView(box);
  const now = useLiveNow(clock, inView);
  const small = width < 520;
  const H = small ? Math.min(height, 270) : height;
  const m = { l: small ? 44 : 56, r: small ? 14 : 22, t: 26, b: 30 };

  const segments = useMemo(() => bidSegments(bid, events, first, now), [bid, events, first, now]);
  const line = bidPolyline(segments);
  const cap = toEth(bid.maxPrice);
  const budget = toEth(bid.budget);
  const curveNow = toEth(bidAt(bid, now));
  const state = bidState(bid, now);
  const limited = state === "budget" || state === "empty";
  // What a seller is actually paid: never more than the budget holds.
  const payable = Math.min(curveNow, budget);

  const t0 = Math.min(segments[0].from, now - 2 * DAY);
  const span = now - t0;
  const capAt = bidReachesCapAt(bid);
  const t1 = now + Math.max(span * 0.18, Math.min(span * 0.6, capAt && capAt > now ? (capAt - now) * 1.1 : 0));
  const paid = segments.flatMap((s) => (s.fill ? [toEth(s.fill.price)] : []));
  const minBid = bid.minBid !== undefined ? toEth(bid.minBid) : undefined;
  const lo = Math.max(0, Math.min(...line.map((pt) => pt.p), ...paid, limited ? Math.min(budget, minBid ?? budget) : Infinity, floor !== undefined ? toEth(floor) : Infinity) * 0.95 - cap * 0.02);
  const hi = cap * 1.06;
  const x = scale(t0, t1, m.l, width - m.r);
  const y = scale(lo, hi, H - m.b, m.t);
  const baseY = H - m.b;
  const budgetY = y(Math.max(lo, Math.min(budget, hi)));

  const d = pathOf(line, x, y);
  const last = segments[segments.length - 1];
  // Where the rule takes the curve next. While the budget cannot cover it the rise does not count:
  // the next money in restarts it from its base, so no projection is drawn.
  const projection = limited
    ? undefined
    : capAt !== undefined && capAt > now
      ? `M${x(now)},${y(curveNow)} L${x(Math.min(capAt, t1))},${y(toEth(bidAt(bid, Math.min(capAt, t1))))} L${x(t1)},${y(toEth(bidAt(bid, t1)))}`
      : `M${x(now)},${y(curveNow)} L${x(t1)},${y(curveNow)}`;
  const cooling = now < bid.nextFillAt && bid.fillCooldown > 0;
  const dayTicks: number[] = [];
  const dayStep = Math.max(1, Math.ceil((t1 - t0) / DAY / (small ? 4 : 8)));
  for (let k = -Math.floor(span / DAY / dayStep) * dayStep; now + k * DAY <= t1; k += dayStep) dayTicks.push(k);
  const px = x(now);
  const py = y(payable);
  const labelLeft = px > width - 170;
  const fills = segments.filter((s) => s.fill).length;
  const restarts = segments.filter((s) => s.restarted).length;

  return (
    <div className={`chart bid-chart state-${state}`} ref={box}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`The floor bid over time. The curve is at ${fmt(curveNow)} ETH${limited ? `, but the budget can pay ${fmt(budget)} ETH, so the bid is ${fmt(payable)} ETH` : `, and the budget covers it, so the bid is ${fmt(payable)} ETH`}. The cap is ${fmt(cap, 3)} ETH. ${fills} sale${fills === 1 ? "" : "s"} and ${restarts} restart${restarts === 1 ? "" : "s"} of the curve on this chart.`}
      >
        <defs>
          <linearGradient id="bid-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.3" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          <clipPath id="bid-clip">
            <rect x={m.l} y={0} width={Math.max(0, width - m.l - m.r)} height={H} />
          </clipPath>
          <pattern id="bid-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" className="hatch" />
          </pattern>
        </defs>
        {ticks(lo, hi, small ? 3 : 5).map((v) => (
          <g key={v} className="axis">
            <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
            <text x={m.l - 8} y={y(v) + 4} textAnchor="end">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        {dayTicks.map((k) => (
          <text key={k} className="axis-x" x={x(now + k * DAY)} y={H - 9} textAnchor="middle">
            {k === 0 ? "now" : `${k > 0 ? "+" : "−"}${Math.abs(k)}d`}
          </text>
        ))}
        <g clipPath="url(#bid-clip)">
          {cooling && <rect className="cool-band" x={x(bid.nextFillAt - bid.fillCooldown)} width={Math.max(0, x(bid.nextFillAt) - x(bid.nextFillAt - bid.fillCooldown))} y={m.t} height={baseY - m.t} />}
          {floor !== undefined && (
            <g className="ref-floor">
              <line x1={m.l} x2={width - m.r} y1={y(toEth(floor))} y2={y(toEth(floor))} />
              <text x={m.l + 6} y={y(toEth(floor)) - 5}>
                last sales floor {fmt(toEth(floor), 3)}
              </text>
            </g>
          )}
          <g className="ref-cap">
            <line x1={m.l} x2={width - m.r} y1={y(cap)} y2={y(cap)} />
            <text x={width - m.r - 6} y={y(cap) - 6} textAnchor="end">
              cap {fmt(cap, 3)} ETH
            </text>
          </g>
          {minBid !== undefined && minBid > lo && (
            <g className="ref-min">
              <line x1={m.l} x2={width - m.r} y1={y(minBid)} y2={y(minBid)} />
              <text x={m.l + 6} y={y(minBid) - 5}>
                minimum bid {fmt(minBid, 3)} ETH: no buyback below this
              </text>
            </g>
          )}
          <path className="bid-fill" d={`${d} L${x(last.to)},${baseY} L${x(segments[0].from)},${baseY} Z`} fill="url(#bid-area)" />
          {/* The budget as a ceiling: everything above it is price the protocol cannot pay. */}
          {budget < hi && (
            <g className="ref-budget">
              <rect x={m.l} width={Math.max(0, width - m.l - m.r)} y={m.t} height={Math.max(0, budgetY - m.t)} fill="url(#bid-hatch)" />
              <line x1={m.l} x2={width - m.r} y1={budgetY} y2={budgetY} />
              <text x={small ? m.l + 6 : width - m.r - 6} y={budgetY + 15} textAnchor={small ? "start" : "end"}>
                budget {fmt(budget, 3)} ETH{small ? "" : ": the most the bid can pay"}
              </text>
            </g>
          )}
          {projection && <path className="proj" d={projection} />}
          <path className={limited ? "curve unpaid" : "curve"} d={d} />
          {segments.map((s) =>
            s.fill ? (
              <g key={`f${s.to}`} className="fill-mark">
                <line x1={x(s.to)} x2={x(s.to)} y1={y(toEth(s.fill.price))} y2={baseY} />
                <circle cx={x(s.to)} cy={y(toEth(s.fill.price))} r="5" />
                <text x={x(s.to)} y={y(Math.max(s.end, toEth(s.fill.price))) - 10} textAnchor="middle">
                  sold at {fmt(toEth(s.fill.price), 3)}
                </text>
              </g>
            ) : s.restarted ? (
              <g key={`r${s.to}`} className="restart-mark">
                <line x1={x(s.to)} x2={x(s.to)} y1={y(s.end)} y2={y(s.base)} />
                <path d={`M${x(s.to) - 5},${y(s.end) - 5} l10,10 m0,-10 l-10,10`} />
                <text x={x(s.to)} y={y(s.end) - 12} textAnchor="middle">
                  restarted
                </text>
              </g>
            ) : null,
          )}
          {limited && <line className="held" x1={px} x2={px} y1={y(curveNow)} y2={py} />}
        </g>
        <line className="now-line" x1={px} x2={px} y1={m.t} y2={baseY} />
        <line className="base-line" x1={m.l} x2={width - m.r} y1={baseY} y2={baseY} />
        {limited && (
          <g className="ghost-point">
            <circle cx={px} cy={y(curveNow)} r="5" />
            <text x={labelLeft ? px - 12 : px + 12} y={y(curveNow) - 8} textAnchor={labelLeft ? "end" : "start"}>
              curve {fmt(curveNow)}
            </text>
          </g>
        )}
        <circle className="live-halo" cx={px} cy={py} r="12" />
        <circle className="live-point" cx={px} cy={py} r="5" />
        <g transform={`translate(${labelLeft ? px - 12 : px + 12},${limited ? Math.min(baseY - 6, py + 22) : Math.max(m.t + 14, py - 12)})`} className="live-label">
          <text textAnchor={labelLeft ? "end" : "start"}>
            {limited ? "bid " : ""}
            {fmt(payable)} ETH
          </text>
        </g>
      </svg>
      <p className="chart-foot">
        {first
          ? `${fills === 0 ? "Nobody has sold into the bid on this chart" : `${fills} sale${fills === 1 ? "" : "s"} into the bid`}${restarts > 0 ? `, ${restarts} restart${restarts === 1 ? "" : "s"} of the curve` : ""}. This climb began ${ago(now - last.from)}.`
          : `The climb that is running now, which began ${ago(now - last.from)}. Earlier sales are not drawn.`}{" "}
        After a sale the curve restarts {bid.stepDownBps / 100}% lower.
      </p>
    </div>
  );
}

/**
 * A vault auction as a falling price to catch. The scale is logarithmic, so every halving is one
 * equal step down and the reserve is the floor line the price comes to rest on.
 */
export function AuctionChart({ auction, halfLife, clock, height = 280 }: { auction: AuctionShape; halfLife: number; clock: () => number; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 640);
  const inView = useInView(box);
  const now = useLiveNow(clock, inView);
  const small = width < 520;
  const H = small ? Math.min(height, 240) : height;
  const m = { l: small ? 50 : 62, r: small ? 14 : 24, t: 22, b: 34 };

  const end = auctionEndsAt(auction, halfLife);
  const series = useMemo(() => auctionSeries(auction, halfLife, 12), [auction, halfLife]);
  const start = toEth(auction.startPrice);
  const reserve = toEth(auction.endPrice);
  const price = toEth(auctionPriceAt(auction, now, halfLife));
  const atReserve = now >= end;
  const t1 = end + (end - auction.startTime) * 0.12;
  const x = scale(auction.startTime, t1, m.l, width - m.r, true);
  const log = scale(Math.log2(reserve), Math.log2(Math.max(start, reserve * 1.01)), H - m.b, m.t);
  const y = (p: number) => log(Math.log2(Math.max(p, reserve)));
  const past = series.filter((pt) => pt.t <= now).concat(atReserve ? [] : [{ t: now, p: price }]);
  const future = [{ t: Math.min(now, end), p: price }].concat(series.filter((pt) => pt.t > now));
  const halvings: { t: number; p: number }[] = [];
  for (let k = 0, p = start; p > reserve && k < 12; k++, p /= 2) halvings.push({ t: auction.startTime + k * halfLife, p });
  const px = x(Math.min(now, t1));
  const py = y(price);
  const labelLeft = px > width - 150;

  return (
    <div className={atReserve ? "chart auction-chart at-reserve" : "chart auction-chart"} ref={box}>
      <svg width={width} height={H} role="img" aria-label={`Auction price: it opened at ${fmt(start, 3)} ETH, halves every ${duration(halfLife)} and is ${fmt(price)} ETH now. The reserve is ${fmt(reserve, 3)} ETH${atReserve ? ", which it has reached" : `, reached in ${duration(end - now)}`}.`}>
        <defs>
          <linearGradient id="auction-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--text)" stopOpacity="0.14" />
            <stop offset="1" stopColor="var(--text)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {halvings.map((h, k) => (
          <g key={k} className="axis">
            <line x1={m.l} x2={width - m.r} y1={y(h.p)} y2={y(h.p)} />
            <text x={m.l - 8} y={y(h.p) + 4} textAnchor="end">
              {h.p >= 10 ? h.p.toFixed(1) : h.p.toFixed(2)}
            </text>
            {(!small || k % 2 === 0) && (
              <text className="axis-x" x={x(h.t)} y={H - 10} textAnchor={k === 0 ? "start" : "middle"}>
                {k === 0 ? "opened" : `${duration(k * halfLife)}`}
              </text>
            )}
          </g>
        ))}
        <path className="past-fill" d={`${pathOf(past, x, y)} L${px},${H - m.b} L${m.l},${H - m.b} Z`} fill="url(#auction-area)" />
        <path className="future" d={pathOf(future, x, y)} />
        <path className="past" d={pathOf(past, x, y)} />
        <g className="reserve-line">
          <line x1={m.l} x2={width - m.r} y1={H - m.b} y2={H - m.b} />
          <text x={width - m.r} y={H - m.b - 7} textAnchor="end">
            reserve {fmt(reserve, 3)} ETH
          </text>
          <text className="axis-label" x={m.l - 8} y={H - m.b + 4} textAnchor="end">
            {reserve.toFixed(2)}
          </text>
        </g>
        <line className="drop-line" x1={px} x2={px} y1={py} y2={H - m.b} />
        <circle className="live-halo" cx={px} cy={py} r="13" />
        <circle className="live-point" cx={px} cy={py} r="6" />
        <g transform={`translate(${labelLeft ? px - 14 : px + 14},${Math.max(m.t + 12, py - 10)})`} className="live-label">
          <text textAnchor={labelLeft ? "end" : "start"}>{fmt(price)} ETH</text>
        </g>
      </svg>
    </div>
  );
}

/**
 * The house's share price after each event, as steps: it moves when a bet settles, and stays put
 * through deposits and redemptions made at the going price. Realised history only; nothing is
 * projected.
 */
export function HouseChart({ points, height = 260 }: { points: readonly { order: number; kind: "deposit" | "redeem" | "bet"; price: number; change: bigint }[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 640);
  const small = width < 520;
  const H = small ? Math.min(height, 220) : height;
  const m = { l: small ? 46 : 58, r: 16, t: 18, b: 28 };
  // the first deposit sets the price; the series starts there
  const series = points.slice(-240);
  if (series.length === 0) return <div className="chart house-chart" ref={box} />;
  const prices = series.map((p) => p.price);
  const lo = Math.min(...prices, 1);
  const hi = Math.max(...prices, 1);
  const pad = Math.max((hi - lo) * 0.2, 0.0005);
  const x = scale(0, Math.max(1, series.length - 1), m.l, width - m.r);
  const y = scale(lo - pad, hi + pad, H - m.b, m.t);
  let d = "";
  series.forEach((p, i) => {
    d += i === 0 ? `M${x(0).toFixed(1)},${y(p.price).toFixed(1)}` : `H${x(i).toFixed(1)}V${y(p.price).toFixed(1)}`;
  });
  const last = series[series.length - 1];
  const bets = series.filter((p) => p.kind === "bet").length;
  return (
    <div className="chart house-chart" ref={box}>
      <svg width={width} height={H} role="img" aria-label={`The house's share price after each of its last ${series.length} events: ${bets} settled bets, the rest deposits and redemptions. It is ${last.price.toFixed(5)} now; 1 is the price of the first deposit.`}>
        {ticks(lo - pad, hi + pad, 4).map((v) => (
          <g key={v} className="axis">
            <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
            <text x={m.l - 8} y={y(v) + 4} textAnchor="end">
              {v.toFixed(4)}
            </text>
          </g>
        ))}
        <g className="ref-cap">
          <line x1={m.l} x2={width - m.r} y1={y(1)} y2={y(1)} />
          <text x={width - m.r - 4} y={y(1) - 6} textAnchor="end">
            first deposit: 1.0000
          </text>
        </g>
        <path className="house-line" d={d} />
        {series.map((p, i) =>
          p.kind === "bet" ? (
            <circle key={p.order} className={p.change >= 0n ? "house-dot up" : "house-dot down"} cx={x(i)} cy={y(p.price)} r={series.length > 80 ? 2 : 3.5} />
          ) : (
            <path key={p.order} className={`house-mark ${p.kind}`} d={p.kind === "deposit" ? `M${x(i) - 5},${y(p.price) + 12}h10l-5,-8z` : `M${x(i) - 5},${y(p.price) - 12}h10l-5,8z`} />
          ),
        )}
        <text className="axis-x" x={m.l} y={H - 8}>
          oldest
        </text>
        <text className="axis-x" x={width - m.r} y={H - 8} textAnchor="end">
          latest event
        </text>
        <circle className="live-point" cx={x(series.length - 1)} cy={y(last.price)} r="5" />
      </svg>
    </div>
  );
}
