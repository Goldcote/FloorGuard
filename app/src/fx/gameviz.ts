// What the game stages draw for a settled result, as pure functions of that result.
//
// Everything a reel, a die, a draw tape or a tug-of-war shows is derived here from numbers the
// contract (or the demo simulator) produced. Nothing takes the outcome's value into account to make
// a loss look close: timings are constants, the faces around the payline never contain the top
// symbol, the draw tape counts tickets in their natural order. test/gameviz.test.ts checks these
// properties over every possible roll.
import { SLOT_SYMBOLS, slotsLine, slotsMultiplier, type SlotSymbol } from "../lib/gameMath";

// ---------------------------------------------------------------- slots

/** One reel's visible column: the symbol above the payline, on it, and below it. */
export type ReelColumn = readonly [above: SlotSymbol, line: SlotSymbol, below: SlotSymbol];

/** The symbols that may appear off the payline: every symbol but the top one. */
const FILLER: readonly SlotSymbol[] = SLOT_SYMBOLS.slice(1);

/**
 * The 3 x 3 window the reels rest on for a settled roll. The middle row is exactly `slotsLine(roll)`,
 * the line the pay table reads. The rows above and below are decoration with rules:
 *
 * - they never show the top symbol, so the top prize is never "just off the line";
 * - each is three different symbols, so no winning line ever sits one step away;
 * - a reel never repeats its payline symbol directly above or below it.
 *
 * They are chosen by the roll alone, so the same roll always draws the same window.
 */
export function reelWindow(roll: number): readonly [ReelColumn, ReelColumn, ReelColumn] {
  const line = slotsLine(roll);
  const n = FILLER.length;
  const at = (symbol: SlotSymbol) => FILLER.indexOf(symbol); // -1 for the top symbol: clashes with nothing
  // Row above: FILLER[k + i]. Three consecutive entries of a 5-cycle are distinct.
  let k = roll % n;
  while ([0, 1, 2].some((i) => (k + i) % n === at(line[i]))) k = (k + 1) % n;
  const above = [0, 1, 2].map((i) => FILLER[(k + i) % n]);
  // Row below: FILLER[m + 2i], also distinct. Prefer one that differs from the row above too.
  const fits = (m: number, strict: boolean) =>
    [0, 1, 2].every((i) => {
      const symbol = FILLER[(m + 2 * i) % n];
      return symbol !== line[i] && (!strict || symbol !== above[i]);
    });
  const first = Math.floor(roll / n) % n;
  const candidates = [0, 1, 2, 3, 4].map((step) => (first + step) % n);
  const m = candidates.find((c) => fits(c, true)) ?? candidates.find((c) => fits(c, false))!;
  const column = (i: number): ReelColumn => [above[i], line[i], FILLER[(m + 2 * i) % n]];
  return [column(0), column(1), column(2)];
}

/** What the reels show before the first spin: a display, not a result. */
export const IDLE_WINDOW: readonly [ReelColumn, ReelColumn, ReelColumn] = [
  ["♣", "7", "▲"],
  ["●", "★", "♣"],
  ["▲", "◆", "●"],
];

/**
 * When each reel stops, in milliseconds after the result is known. Constants: the pause before the
 * last reel is the same for every spin, whatever it is about to show.
 */
export const REEL_STOP_MS = [240, 620, 1260] as const;
/** How long a reel takes to overshoot and settle once it stops. */
export const REEL_SETTLE_MS = 460;
/** From the result being known to the outcome being shown. */
export const SLOTS_REVEAL_MS = REEL_STOP_MS[2] + REEL_SETTLE_MS;

export type ResultTone = "win" | "big" | "jackpot" | "returned" | "loss";

/**
 * How a settled result is presented. Only a payout above the wager is a win of any size; a payout
 * that is positive but not above the wager is "returned" (neutral), and nothing is a loss.
 * `multiple` (payout / stake) only scales a win; it can never turn a non-win into one.
 */
export function resultTone(payout: bigint, wager: bigint, multiple: number): ResultTone {
  if (payout === 0n) return "loss";
  if (payout <= wager) return "returned";
  return multiple >= 50 ? "jackpot" : multiple >= 10 ? "big" : "win";
}

/** Index of the pay-table row a roll falls in (0 = top prize). */
export const slotsTierIndex = (roll: number) => [50, 10, 5, 2, 1, 0].indexOf(slotsMultiplier(roll));

// ---------------------------------------------------------------- dice

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The face the die lands on: which sixth of the 0..9999 range the roll fell in, lowest sixth = 1.
 * Low rolls win, so low faces are the good ones; at a 50% chance faces 1 to 3 win, exactly like a
 * real die. The exact roll is always shown next to it.
 */
export function dieFace(roll: number): DieFace {
  return (Math.min(5, Math.floor((roll * 6) / 10_000)) + 1) as DieFace;
}

/** Cube rotation (degrees about X then Y) that turns `face` towards the viewer. Opposite faces sum to 7. */
export const DIE_ROTATION: Record<DieFace, readonly [x: number, y: number]> = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

/** From the result being known to the die (or coin) lying still on its mark. */
export const DICE_TUMBLE_MS = 1350;
export const DICE_REVEAL_MS = DICE_TUMBLE_MS + 120;

/** Payout multiple of a winning dice bet: `(1 - edge) / chance`. */
export function diceMultiple(chanceBps: number, edgeBps: bigint | number): number {
  return (10_000 - Number(edgeBps)) / chanceBps;
}

// ---------------------------------------------------------------- draws (lottery, ticket raffles)

export type DrawTape = {
  /** Ticket numbers in the order they pass the pointer. */
  cells: number[];
  /** Index in `cells` the pointer comes to rest on; `cells[landIndex]` is the winning ticket. */
  landIndex: number;
};

/**
 * The tape a draw runs: tickets pass the pointer in their natural order (…, 7, 8, 9, 0, 1, …) and it
 * stops on the winning ticket after `travel` steps. The order is fixed by the ticket numbers, so the
 * tape cannot be arranged to make any ticket look like a narrow miss. `tail` cells follow the winner
 * so the tape does not end at the pointer.
 */
export function drawTape(ticket: number, ticketsSold: number, travel = 48, tail = 6): DrawTape {
  const count = Math.max(1, ticketsSold);
  const cells: number[] = [];
  for (let i = -travel; i <= tail; i++) cells.push((((ticket + i) % count) + count) % count);
  return { cells, landIndex: travel };
}

/** How long the tape decelerates before it rests on the winner. Constant for every draw. */
export const DRAW_TAPE_MS = 4200;
export const DRAW_REVEAL_MS = DRAW_TAPE_MS + 250;

/**
 * Position of the tape (in cells travelled, 0..1 of the way) at normalised time t: fast, then a long
 * deceleration, like a wheel running out of momentum.
 */
export const tapeProgress = (t: number) => (t >= 1 ? 1 : t <= 0 ? 0 : 1 - (1 - t) ** 3.4);

/**
 * A vessel for a pot that has no upper limit: its capacity is the smallest of 2, 4, 8, … times the
 * round's minimum pot that still holds the pot, so the level only rescales when the pot doubles.
 * Returns the capacity and the fill (0..1), and where the minimum-pot line sits.
 */
export function potVessel(pot: bigint, minPot: bigint): { capacity: bigint; fill: number; minLine: number } {
  const unit = minPot > 0n ? minPot : pot > 0n ? pot : 1n;
  let capacity = unit * 2n;
  while (capacity < pot) capacity *= 2n;
  const ratio = (value: bigint) => Number((value * 10_000n) / capacity) / 10_000;
  return { capacity, fill: ratio(pot), minLine: minPot > 0n ? ratio(minPot) : 0 };
}

// ---------------------------------------------------------------- predictions

/** The higher pool's share of both pools, 0..1; 0.5 when both are empty. */
export function tugShare(higherPool: bigint, lowerPool: bigint): number {
  const total = higherPool + lowerPool;
  return total === 0n ? 0.5 : Number((higherPool * 10_000n) / total) / 10_000;
}

/**
 * What `stake` on one side would be paid if that side won with the pools as they are now plus this
 * stake: the stake, plus its pro-rata share of the other pool, less the fee on that profit. The same
 * arithmetic as `PredictionMarket.claim`. Pools keep moving until betting closes.
 */
export function stakePayout(stake: bigint, sidePool: bigint, otherPool: bigint, feeBps: bigint): bigint {
  if (stake <= 0n) return 0n;
  const profit = (stake * otherPool) / (sidePool + stake);
  return stake + profit - (profit * feeBps) / 10_000n;
}

/** What the user's existing stakes are worth for a resolved outcome (1 higher, 2 lower, 3 void). */
export function claimValue(outcome: number, stake: { higher: bigint; lower: bigint }, higherPool: bigint, lowerPool: bigint, feeBps: bigint): bigint {
  if (outcome === 3) return stake.higher + stake.lower;
  const [won, winPool, losePool] = outcome === 1 ? [stake.higher, higherPool, lowerPool] : [stake.lower, lowerPool, higherPool];
  if (won === 0n || winPool === 0n) return 0n;
  const profit = (won * losePool) / winPool;
  return won + profit - (profit * feeBps) / 10_000n;
}

// ---------------------------------------------------------------- shares

/** A share as a percentage with up to two decimals, e.g. "12.5%". */
export const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 10_000) / 100}%` : "–");

/** A stable hue (0..359) for an address or id: colours a winner's dot or a token emblem. */
export function hueOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}
