// Pure maths behind the visualisations: the rising bid, the vault's two locks, the falling auction
// price and the split of a sale. Integer functions mirror the contracts (and src/demo/sim.ts) exactly;
// the series builders turn them into points to draw. No React, no DOM: test/viz.test.ts covers it.

export const DAY = 86_400;
const BPS = 10_000n;

/** Wei as a floating-point ETH amount. For drawing only, never for money. */
export const toEth = (wei: bigint): number => Number(wei) / 1e18;

// ---------------------------------------------------------------- the rising bid

export type BidConfig = {
  basePrice: bigint;
  maxPrice: bigint;
  lastReset: number;
  growthBpsPerDay: number;
  stepDownBps: number;
};

/**
 * `BuybackEngine.curvePrice`: min(maxPrice, basePrice * (1 + growth * elapsed / 1 day)). Where the
 * curve stands, whatever the budget can pay.
 */
export function bidAt(c: BidConfig, now: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor(now - c.lastReset)));
  const price = c.basePrice + (c.basePrice * BigInt(c.growthBpsPerDay) * elapsed) / (BPS * BigInt(DAY));
  return price > c.maxPrice ? c.maxPrice : price;
}

/** `BuybackEngine.currentBid`: the curve, limited by what the collection's budget can pay. */
export function payableBid(curve: bigint, budget: bigint): bigint {
  return curve < budget ? curve : budget;
}

/**
 * The base price right after a sale at `price` (`BuybackEngine.sell`): one step below the higher of
 * the sale price and the old base less three steps, never below 1 wei. A sale limited by a thin
 * budget therefore pulls the base down by at most three steps (plus the usual one).
 */
export function baseAfterFill(price: bigint, previousBase: bigint, stepDownBps: number): bigint {
  const drop = 3n * BigInt(stepDownBps);
  let anchor = drop >= BPS ? 0n : (previousBase * (BPS - drop)) / BPS;
  if (price > anchor) anchor = price;
  const next = (anchor * (BPS - BigInt(stepDownBps))) / BPS;
  return next === 0n ? 1n : next;
}

/** When the curve reaches its cap, or undefined if it never rises (no growth, or already capped). */
export function bidReachesCapAt(c: BidConfig): number | undefined {
  if (c.basePrice >= c.maxPrice) return c.lastReset;
  if (c.growthBpsPerDay <= 0 || c.basePrice <= 0n) return undefined;
  const gap = c.maxPrice - c.basePrice;
  const perDay = c.basePrice * BigInt(c.growthBpsPerDay);
  // seconds = gap * BPS * DAY / (base * growth), rounded up
  return c.lastReset + Number((gap * BPS * BigInt(DAY) + perDay - 1n) / perDay);
}

/** The longest pause between fills the engine accepts: the time the curve needs to regrow one step. */
export function maxFillCooldown(growthBpsPerDay: number, stepDownBps: number): number | undefined {
  if (growthBpsPerDay <= 0) return undefined;
  return Math.floor((stepDownBps * 10_000 * DAY) / ((10_000 - stepDownBps) * growthBpsPerDay));
}

export type Fill = { time: number; price: bigint };
/** Something that ended a climb of the curve: a sale into the bid, or a restart when money arrived late. */
export type BidEvent = { time: number; kind: "fill"; price: bigint } | { time: number; kind: "restart"; base?: bigint };
export type Point = { t: number; p: number };

/** One climb of the curve: from `from` at `base`, rising to `to`, where it ended or is now. */
export type BidSegment = {
  from: number;
  to: number;
  base: number;
  /** The curve's value at `to`. */
  end: number;
  /** Time at which the climb hit the cap inside this segment, if it did. */
  cappedAt?: number;
  /** A sale ended the climb, at this price: the curve's value, or less if the budget held less. */
  fill?: Fill;
  /** The climb was discarded because money reached a budget that could not cover it. */
  restarted?: boolean;
};

/**
 * The curve's saw-tooth so far. `first` is where the first climb on record began; without it (a live
 * chain keeps no history the app reads) only the climb that is running now is drawn. Each climb ends
 * in a sale (the next base is one step below the higher of the sale price and the old base less
 * three steps) or in a restart (clock back to zero; the base stays, or rises to what the budget held).
 */
export function bidSegments(config: BidConfig, events: readonly BidEvent[], first: { time: number; base: bigint } | undefined, now: number): BidSegment[] {
  const growth = config.growthBpsPerDay / 10_000;
  const step = config.stepDownBps / 10_000;
  const cap = toEth(config.maxPrice);
  const segments: BidSegment[] = [];
  if (first) {
    const sorted = [...events].filter((e) => e.time <= config.lastReset && e.time >= first.time).sort((a, b) => a.time - b.time);
    let from = first.time;
    let base = toEth(first.base);
    for (const event of sorted) {
      const end = Math.min(cap, base * (1 + (growth * (event.time - from)) / DAY));
      const segment: BidSegment = { from, to: event.time, base, end, cappedAt: capTime(from, base, growth, cap, event.time) };
      if (event.kind === "fill") {
        segment.fill = { time: event.time, price: event.price };
        base = Math.max(toEth(event.price), 3 * step >= 1 ? 0 : base * (1 - 3 * step)) * (1 - step);
      } else {
        segment.restarted = true;
        // a restart keeps the base, or lifts it to what the budget held: money arriving never lowers the bid
        if (event.base !== undefined) base = toEth(event.base);
      }
      segments.push(segment);
      from = event.time;
    }
  }
  const base = toEth(config.basePrice);
  const to = Math.max(now, config.lastReset);
  const end = Math.min(cap, base * (1 + (growth * (to - config.lastReset)) / DAY));
  segments.push({ from: config.lastReset, to, base, end, cappedAt: capTime(config.lastReset, base, growth, cap, to) });
  return segments;
}

function capTime(from: number, base: number, growth: number, cap: number, to: number): number | undefined {
  if (base >= cap) return from;
  if (growth <= 0 || base <= 0) return undefined;
  const at = from + ((cap / base - 1) / growth) * DAY;
  return at < to ? at : undefined;
}

/** The segments as one polyline: climbs, flat stretches at the cap and the vertical drop after each. */
export function bidPolyline(segments: readonly BidSegment[]): Point[] {
  const points: Point[] = [];
  for (const s of segments) {
    points.push({ t: s.from, p: s.base });
    if (s.cappedAt !== undefined && s.cappedAt > s.from) points.push({ t: s.cappedAt, p: s.end });
    points.push({ t: s.to, p: s.end });
  }
  return points;
}

/** How many fills at the current bid the budget covers. */
export function fillsCovered(budget: bigint, bid: bigint): number {
  return bid === 0n ? 0 : Number((budget * 100n) / bid) / 100;
}

// ---------------------------------------------------------------- the vault's locks

/** A holding unlocks only at a floor of 130% of its purchase price (`Vault`). */
export const UNLOCK_BPS = 13_000n;
export const unlockPrice = (purchasePrice: bigint): bigint => (purchasePrice * UNLOCK_BPS) / BPS;

/** The time lock: how far through it the holding is, and what is left. */
export function timeLock(acquiredAt: number, lockedUntil: number, now: number): { progress: number; remaining: number; open: boolean } {
  const total = Math.max(1, lockedUntil - acquiredAt);
  const progress = Math.min(1, Math.max(0, (now - acquiredAt) / total));
  return { progress, remaining: Math.max(0, lockedUntil - now), open: now >= lockedUntil };
}

/**
 * The price lock: the floor against the 130% trigger. `ratio` is floor / purchase price (1.3 opens
 * it); `progress` is how far the floor has come from the purchase price to the trigger, 0..1.
 */
export function priceLock(purchasePrice: bigint, floor: bigint | undefined): { trigger: bigint; ratio: number; progress: number; open: boolean } {
  const trigger = unlockPrice(purchasePrice);
  if (floor === undefined || purchasePrice === 0n) return { trigger, ratio: 0, progress: 0, open: false };
  const ratio = Number((floor * 10_000n) / purchasePrice) / 10_000;
  return { trigger, ratio, progress: Math.min(1, Math.max(0, (ratio - 1) / 0.3)), open: floor >= trigger };
}

// ---------------------------------------------------------------- the falling auction

export type AuctionShape = { startPrice: bigint; endPrice: bigint; startTime: number };

/**
 * `Vault.auctionPrice`: the price halves every `halfLife`, falls linearly within each period and
 * holds at the reserve.
 */
export function auctionPriceAt(a: AuctionShape, now: number, halfLife = DAY): bigint {
  const elapsed = Math.max(0, Math.floor(now - a.startTime));
  let price = a.startPrice >> BigInt(Math.min(127, Math.floor(elapsed / halfLife)));
  price -= ((price / 2n) * BigInt(elapsed % halfLife)) / BigInt(halfLife);
  return price > a.endPrice ? price : a.endPrice;
}

/** When the price reaches the reserve (same result as lib/reads.ts auctionReachesReserveAt). */
export function auctionEndsAt(a: AuctionShape, halfLife = DAY): number {
  let price = a.startPrice;
  let periods = 0;
  while (periods < 128 && price / 2n > a.endPrice) {
    price /= 2n;
    periods++;
  }
  if (price <= a.endPrice) return a.startTime + periods * halfLife;
  const half = price / 2n;
  const seconds = half === 0n ? 0n : ((price - a.endPrice) * BigInt(halfLife) + half - 1n) / half;
  return a.startTime + periods * halfLife + Number(seconds);
}

/** The whole fall as points, `perPeriod` samples to each halving, ending exactly at the reserve. */
export function auctionSeries(a: AuctionShape, halfLife = DAY, perPeriod = 8): Point[] {
  const end = auctionEndsAt(a, halfLife);
  const points: Point[] = [];
  const step = halfLife / perPeriod;
  for (let t = a.startTime; t < end; t += step) points.push({ t, p: toEth(auctionPriceAt(a, t, halfLife)) });
  points.push({ t: end, p: toEth(a.endPrice) });
  return points;
}

// ---------------------------------------------------------------- who receives what

export type SaleSplit = { seller: bigint; royalty: bigint; fee: bigint; toProject: bigint; toBudget: bigint };

/**
 * A marketplace sale: the fee and the (already capped) royalty come off the price and the seller
 * keeps the rest; the project's share is taken from the fee and the remainder is buyback budget.
 */
export function saleSplit(price: bigint, feeBps: bigint, royalty: bigint, projectShareBps: bigint | number): SaleSplit {
  const fee = (price * feeBps) / BPS;
  const toProject = (fee * BigInt(projectShareBps)) / BPS;
  return { seller: price - fee - royalty, royalty, fee, toProject, toBudget: fee - toProject };
}

// ---------------------------------------------------------------- drawing helpers

/** A linear scale from a domain to a range; `clamp` keeps the result inside the range. */
export function scale(d0: number, d1: number, r0: number, r1: number, clamp = false): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v) => {
    let k = (v - d0) / span;
    if (clamp) k = Math.min(1, Math.max(0, k));
    return r0 + k * (r1 - r0);
  };
}

/** Points as an SVG path through the two scales. */
export function pathOf(points: readonly Point[], x: (t: number) => number, y: (p: number) => number): string {
  return points.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join("");
}

/** Round axis ticks: about `count` of them between lo and hi. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** A small deterministic hash, for procedural token tiles. */
export function hash32(n: bigint | number): number {
  let h = Number(BigInt(n) % 4294967291n) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A 5×5 left-right symmetric pattern and a hue for a token id: a stand-in face, not its artwork. */
export function tokenPattern(tokenId: bigint | number): { hue: number; cells: boolean[] } {
  const h = hash32(tokenId);
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const mirrored = col < 3 ? col : 4 - col;
      cells.push(((h >>> (row * 3 + mirrored)) & 1) === 1);
    }
  }
  return { hue: h % 360, cells };
}
