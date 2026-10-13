// Pure unit tests: no chain needed.
import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { edgeFromFee, recomputeBet, splitPot } from "../src/lib/fairness";
import { SLOTS_PAY_TABLE } from "../src/lib/reads";

const ETH = parseEther("1");

describe("recomputeBet", () => {
  it("dice: a win pays the stake at fair odds, a loss pays nothing", () => {
    // 2% edge leaves 0.98; a coinflip pays 1.96
    expect(recomputeBet({ wager: ETH, edgeBps: 200n, chanceBps: 5_000, roll: 4_999 })).toEqual({
      fee: parseEther("0.02"),
      stake: parseEther("0.98"),
      kind: "dice",
      won: true,
      payout: parseEther("1.96"),
    });
    expect(recomputeBet({ wager: ETH, edgeBps: 200n, chanceBps: 5_000, roll: 5_000 })).toMatchObject({ won: false, payout: 0n });
    // a 1% long shot pays 98 times the stake
    expect(recomputeBet({ wager: parseEther("0.1"), edgeBps: 200n, chanceBps: 100, roll: 99 }).payout).toBe(parseEther("9.8"));
    expect(recomputeBet({ wager: parseEther("0.1"), edgeBps: 200n, chanceBps: 100, roll: 100 }).payout).toBe(0n);
    // the roll must be strictly below the chance
    expect(recomputeBet({ wager: ETH, edgeBps: 200n, chanceBps: 9_500, roll: 9_499 }).won).toBe(true);
    expect(recomputeBet({ wager: ETH, edgeBps: 200n, chanceBps: 9_500, roll: 9_500 }).won).toBe(false);
  });

  it("dice: no edge, and an edge that is the whole wager", () => {
    expect(recomputeBet({ wager: ETH, edgeBps: 0n, chanceBps: 2_500, roll: 0 })).toMatchObject({ fee: 0n, stake: ETH, payout: 4n * ETH });
    expect(recomputeBet({ wager: ETH, edgeBps: 10_000n, chanceBps: 2_500, roll: 0 })).toMatchObject({ fee: ETH, stake: 0n, payout: 0n });
  });

  it("rounds down like the contract: the fee first, then the payout", () => {
    // 1001 wei at 2%: fee floor(20.02) = 20, stake 981; at 33%: floor(981 * 10000 / 3300) = 2972
    expect(recomputeBet({ wager: 1_001n, edgeBps: 200n, chanceBps: 3_300, roll: 0 })).toMatchObject({ fee: 20n, stake: 981n, payout: 2_972n });
    // 49 wei at 2%: the fee rounds down to nothing
    expect(recomputeBet({ wager: 49n, edgeBps: 200n, chanceBps: 5_000, roll: 0 })).toMatchObject({ fee: 0n, stake: 49n, payout: 98n });
    // 7 wei stake at 3 bps of chance does not divide evenly
    expect(recomputeBet({ wager: 7n, edgeBps: 0n, chanceBps: 300, roll: 0 }).payout).toBe(233n);
  });

  it("slots: every tier of the pay table, at both edges of its band", () => {
    const stake = parseEther("0.0098");
    let from = 0;
    SLOTS_PAY_TABLE.forEach((tier, index) => {
      for (const roll of [from, tier.below - 1]) {
        expect(recomputeBet({ wager: parseEther("0.01"), edgeBps: 200n, chanceBps: 0, roll })).toEqual({
          fee: parseEther("0.0002"),
          stake,
          kind: "slots",
          won: tier.multiplier > 0,
          multiplier: tier.multiplier,
          tierIndex: index,
          payout: stake * BigInt(tier.multiplier),
        });
      }
      from = tier.below;
    });
    expect(from).toBe(10_000);
  });

  it("slots: the table averages exactly one stake over all 10000 rolls", () => {
    let total = 0n;
    for (let roll = 0; roll < 10_000; roll++) total += recomputeBet({ wager: 10_000n, edgeBps: 0n, chanceBps: 0, roll }).payout;
    expect(total).toBe(10_000n * 10_000n);
  });
});

describe("edgeFromFee", () => {
  it("recovers the edge from the fee a bet paid", () => {
    for (const edge of [0n, 1n, 200n, 333n, 1_000n]) {
      for (const wager of [ETH, parseEther("0.01"), parseEther("0.123456789")]) {
        expect(edgeFromFee(wager, (wager * edge) / 10_000n)).toBe(edge);
      }
    }
    expect(edgeFromFee(0n, 0n)).toBe(0n);
  });

  it("gives an edge that reproduces the fee even when the wager is tiny", () => {
    const wager = 49n;
    const fee = (wager * 200n) / 10_000n; // rounds to 0
    const edge = edgeFromFee(wager, fee);
    expect((wager * edge) / 10_000n).toBe(fee);
  });
});

describe("splitPot", () => {
  it("takes the fee from the pot, rounded down", () => {
    expect(splitPot(parseEther("0.01"), 5, 500n)).toEqual({ pot: parseEther("0.05"), fee: parseEther("0.0025"), rest: parseEther("0.0475") });
    expect(splitPot(3n, 7, 500n)).toEqual({ pot: 21n, fee: 1n, rest: 20n });
    expect(splitPot(ETH, 0, 500n)).toEqual({ pot: 0n, fee: 0n, rest: 0n });
  });
});
