// The game and fee arithmetic of the contracts, in one place. The live app uses it for previews and
// for the Verify views; the demo simulator (src/demo/sim.ts) uses it to settle. Tests check it against
// the contracts' own numbers (test/anvil.test.ts) and by hand (test/fairness.test.ts).
// Integer arithmetic throughout, rounding down exactly where Solidity does.

export const BPS = 10_000n;

/** `Games.quote`: what a winning dice bet pays (wager included) and the fee taken from the wager. */
export function diceQuote(wager: bigint, chanceBps: number, edgeBps: bigint): { payout: bigint; fee: bigint } {
  const fee = (wager * edgeBps) / BPS;
  return { fee, payout: ((wager - fee) * BPS) / BigInt(chanceBps) };
}

/** House money a bet puts at risk. Mirrors the arithmetic of `Games.play`. */
export function gameExposure(wager: bigint, chanceBps: number, edgeBps: bigint): bigint {
  const fee = (wager * edgeBps) / BPS;
  const payout = ((wager - fee) * BPS) / BigInt(chanceBps);
  return payout - (wager - fee);
}

/** `Games.SLOTS_MAX_MULTIPLIER`: the house reserves the top prize less the stake for every spin. */
export const SLOTS_MAX_MULTIPLIER = 50n;

/**
 * The pay table of `Games.slotsMultiplier`, best prize first. A roll is uniform in 0..9999 and pays
 * the first tier whose `below` it is under; `chanceBps` is the width of that band.
 */
export const SLOTS_PAY_TABLE = [
  { multiplier: 50, below: 20, chanceBps: 20 },
  { multiplier: 10, below: 120, chanceBps: 100 },
  { multiplier: 5, below: 520, chanceBps: 400 },
  { multiplier: 2, below: 2_020, chanceBps: 1_500 },
  { multiplier: 1, below: 5_020, chanceBps: 3_000 },
  { multiplier: 0, below: 10_000, chanceBps: 4_980 },
] as const;

/** Mirror of `Games.slotsMultiplier`: what a roll pays, as a multiple of the stake after the edge. */
export function slotsMultiplier(roll: number): number {
  return SLOTS_PAY_TABLE.find((tier) => roll < tier.below)!.multiplier;
}

/** House money a spin reserves: 49 times the stake after the edge. Mirrors `Games.spin`. */
export function slotsExposure(wager: bigint, edgeBps: bigint): bigint {
  return (wager - (wager * edgeBps) / BPS) * (SLOTS_MAX_MULTIPLIER - 1n);
}

export const SLOT_SYMBOLS = ["7", "★", "◆", "●", "♣", "▲"] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

/**
 * The three symbols shown for a settled roll. Purely cosmetic: the payout is decided by the contract
 * from the roll, and this only draws a line that matches it.
 *
 * It must never suggest a near miss. So: three of a kind only for the four prizes that pay more than
 * the stake (the better the prize, the better the symbol); a pair, always of one of the two plainest
 * symbols, for a stake-back; and three different symbols, never including the top one, for nothing.
 */
export function slotsLine(roll: number): [SlotSymbol, SlotSymbol, SlotSymbol] {
  const multiplier = slotsMultiplier(roll);
  const triple = { 50: "7", 10: "★", 5: "◆", 2: "●" } as const;
  if (multiplier in triple) {
    const symbol = triple[multiplier as keyof typeof triple];
    return [symbol, symbol, symbol];
  }
  if (multiplier === 1) {
    const [pair, odd]: [SlotSymbol, SlotSymbol] = roll % 2 === 0 ? ["♣", "▲"] : ["▲", "♣"];
    const line: [SlotSymbol, SlotSymbol, SlotSymbol] = [pair, pair, pair];
    line[Math.floor(roll / 2) % 3] = odd; // which reel shows the odd symbol also follows the roll
    return line;
  }
  // three different symbols out of the five below the top one, chosen by the roll
  const pool: SlotSymbol[] = ["★", "◆", "●", "♣", "▲"];
  const first = pool.splice(roll % 5, 1)[0];
  const second = pool.splice(Math.floor(roll / 5) % 4, 1)[0];
  const third = pool[Math.floor(roll / 20) % 3];
  return [first, second, third];
}

export type BetInputs = {
  wager: bigint;
  /** The edge stored with the bet when it was placed, in basis points. */
  edgeBps: bigint;
  /** Chance of winning in basis points; 0 marks a slots spin. */
  chanceBps: number;
  /** The settled roll, 0..9999. */
  roll: number;
};

export type BetRecomputation = {
  /** `wager * edge / 10000`, rounded down. */
  fee: bigint;
  /** `wager - fee`: what is actually played. */
  stake: bigint;
  kind: "dice" | "slots";
  /** Dice: whether `roll < chance`. Slots: whether the multiplier is above zero. */
  won: boolean;
  /** Slots only: the multiplier of the pay-table row the roll falls in, and that row's index. */
  multiplier?: number;
  tierIndex?: number;
  /** What the contract must have paid the player. */
  payout: bigint;
};

export function recomputeBet({ wager, edgeBps, chanceBps, roll }: BetInputs): BetRecomputation {
  const fee = (wager * edgeBps) / BPS;
  const stake = wager - fee;
  if (chanceBps === 0) {
    const tierIndex = SLOTS_PAY_TABLE.findIndex((tier) => roll < tier.below);
    const multiplier = SLOTS_PAY_TABLE[tierIndex].multiplier;
    return { fee, stake, kind: "slots", won: multiplier > 0, multiplier, tierIndex, payout: stake * BigInt(multiplier) };
  }
  const won = roll < chanceBps;
  // A win pays the stake at fair odds: stake * 10000 / chance, rounded down.
  return { fee, stake, kind: "dice", won, payout: won ? (stake * BPS) / BigInt(chanceBps) : 0n };
}

/**
 * The edge implied by the fee a settled bet paid, when the stored edge can no longer be read (the
 * bet's record is deleted at settlement). Exact whenever `wager * edge` divides evenly by 10000;
 * otherwise the smallest edge that produces that fee.
 */
export function edgeFromFee(wager: bigint, fee: bigint): bigint {
  if (wager === 0n) return 0n;
  let edge = (fee * BPS) / wager;
  while ((wager * edge) / BPS < fee) edge++;
  return edge;
}

/** What a lottery round or ticket raffle pays out of its pot: the fee and the rest. */
export function splitPot(ticketPrice: bigint, ticketsSold: number, feeBps: bigint): { pot: bigint; fee: bigint; rest: bigint } {
  const pot = ticketPrice * BigInt(ticketsSold);
  const fee = (pot * feeBps) / BPS;
  return { pot, fee, rest: pot - fee };
}
