// The house's share arithmetic must be the contract's (src/Games.sol: deposit, redeem, previewDeposit,
// previewRedeem), in the pure module the page uses and in the demo simulator.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { DEMO_COLLECTION, DEMO_DEPLOYMENT as d, demoReads, demoWrite, resetDemo } from "../src/demo/sim";
import { depositHouseCall, playCall, redeemHouseCall } from "../src/lib/calls";
import { houseGain, housePoints, leftBehind, previewDeposit, previewRedeem, sharePrice, VIRTUAL_SHARES, withTolerance, type HouseFunds } from "../src/lib/house";

const ETH = parseEther("1");
const empty: HouseFunds = { bankroll: 0n, reserved: 0n, openWagers: 0n, totalShares: 0n };

describe("house share maths (mirrors Games.sol)", () => {
  it("the first deposit mints a million shares per wei and redeems for what was put in", () => {
    // shares = value * (totalShares + 1e6) / (bankroll + reserved + openWagers + 1)
    const shares = previewDeposit(empty, 1_000n * ETH);
    expect(shares).toBe(1_000n * ETH * VIRTUAL_SHARES);
    const funded = { ...empty, bankroll: 1_000n * ETH, totalShares: shares };
    // assets = shares * (bankroll + 1) / (totalShares + 1e6)
    expect(previewRedeem(funded, shares)).toBe((shares * (1_000n * ETH + 1n)) / (shares + VIRTUAL_SHARES));
    expect(1_000n * ETH - previewRedeem(funded, shares)).toBeLessThanOrEqual(1n);
  });

  it("a later deposit buys in at the going price (test_house_depositMintsSharesAndRedeemPaysThemBack)", () => {
    const first = previewDeposit(empty, 1_000n * ETH);
    const house = { ...empty, bankroll: 1_000n * ETH, totalShares: first };
    const bob = previewDeposit(house, 100n * ETH);
    const after = { ...house, bankroll: 1_100n * ETH, totalShares: first + bob };
    const back = previewRedeem(after, bob);
    expect(100n * ETH - back).toBeGreaterThanOrEqual(0n);
    expect(100n * ETH - back).toBeLessThanOrEqual(1_000_000n);
  });

  it("shares gain when players lose and fall when they win (test_house_sharesGainWhen...)", () => {
    const shares = previewDeposit(empty, 1_000n * ETH);
    // a 1 ETH coinflip lost by the player, with the whole edge sent on: the 0.98 ETH stake joins the bankroll
    const afterLoss = { ...empty, bankroll: 1_000n * ETH + parseEther("0.98"), totalShares: shares };
    expect(parseEther("1000.98") - previewRedeem(afterLoss, shares)).toBeLessThanOrEqual(1_000_000n);
    expect(houseGain(ETH, 0n, parseEther("0.02"), 0n)).toBe(parseEther("0.98"));
    // with the default share, the bankroll also keeps half of the edge
    expect(houseGain(ETH, 0n, parseEther("0.02"), 5_000n)).toBe(parseEther("0.99"));
    // a win pays 1.96 ETH: the house is down its 0.98 ETH exposure, less the half of the edge it keeps
    expect(houseGain(ETH, parseEther("1.96"), parseEther("0.02"), 5_000n)).toBe(-parseEther("0.97"));
  });

  it("deposits are priced as if the house wins every open bet, redemptions as if it loses them all", () => {
    const shares = previewDeposit(empty, 1_000n * ETH);
    // a 10 ETH coinflip is open: 9.8 ETH of house money set aside, the 10 ETH wager in play
    const open: HouseFunds = { bankroll: 1_000n * ETH - parseEther("9.8"), reserved: parseEther("9.8"), openWagers: 10n * ETH, totalShares: shares };
    const bob = previewDeposit(open, 100n * ETH);
    // priced against 1,010 ETH (everything the house would hold if it won), not the 990.2 ETH that is free
    expect(bob).toBe((100n * ETH * (shares + VIRTUAL_SHARES)) / (1_010n * ETH + 1n));
    // if the player then loses (edge sent on), bob holds no more than he paid
    const lost = { bankroll: 1_100n * ETH + parseEther("9.8"), reserved: 0n, openWagers: 0n, totalShares: shares + bob };
    expect(previewRedeem(lost, bob)).toBeLessThanOrEqual(100n * ETH);

    // redeeming while the bet is open shares out the free bankroll only
    expect(previewRedeem(open, shares)).toBe((shares * (open.bankroll + 1n)) / (shares + VIRTUAL_SHARES));
    // what stays behind is the redeemer's part of the reserve and of the wager in play
    expect(leftBehind(open, shares)).toBe((shares * parseEther("19.8")) / (shares + VIRTUAL_SHARES));
    expect(leftBehind({ ...open, reserved: 0n, openWagers: 0n }, shares)).toBe(0n);
    // leaving just before a player wins gains nothing: the early price is no better than the price after the win
    const won = { bankroll: open.bankroll, reserved: 0n, openWagers: 0n, totalShares: shares };
    expect(previewRedeem(open, shares)).toBeLessThanOrEqual(previewRedeem(won, shares));
  });

  it("builds the realised share price from events, and a tolerance sits a little under a preview", () => {
    const shares = previewDeposit(empty, 10n * ETH);
    const points = housePoints([
      { kind: "bet", gain: -ETH, order: 2 },
      { kind: "deposit", amount: 10n * ETH, shares, order: 0 },
      { kind: "bet", gain: parseEther("0.5"), order: 1 },
      { kind: "redeem", amount: parseEther("4.75"), shares: shares / 2n, order: 3 },
    ]);
    expect(points.map((p) => p.kind)).toEqual(["deposit", "bet", "bet", "redeem"]);
    expect(points.map((p) => p.equity)).toEqual([10n * ETH, parseEther("10.5"), parseEther("9.5"), parseEther("4.75")]);
    expect(points[0].price).toBeCloseTo(1, 7);
    expect(points[1].price).toBeCloseTo(1.05, 7);
    expect(points[2].price).toBeCloseTo(0.95, 7);
    // a redemption at the going price leaves the price where it was
    expect(points[3].price).toBeCloseTo(0.95, 6);
    // an empty house prices a share unit at exactly what 1 wei buys: 1
    expect(sharePrice(0n, 0n)).toBe(1);
    expect(withTolerance(1_000_000n, 50n)).toBe(995_000n);
  });
});

describe("the house in the demo simulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDemo();
  });
  const write = async (call: Parameters<typeof demoWrite>[0]) => {
    const outcome = demoWrite(call).then(
      () => undefined,
      (error: Error) => error,
    );
    await vi.advanceTimersByTimeAsync(400);
    const error = await outcome;
    if (error) throw error;
  };

  it("is seeded as one deposit, and a deposit and a redemption follow the contract's formulas", async () => {
    const seeded = demoReads.house();
    expect(seeded).toMatchObject({ bankroll: 50n * ETH, reserved: 0n, openWagers: 0n, totalShares: 50n * ETH * VIRTUAL_SHARES, userShares: 0n, bankrollShareBps: 5_000n });
    expect(demoReads.houseEvents()).toHaveLength(1);

    const expected = previewDeposit(seeded, 2n * ETH);
    await expect(write(depositHouseCall(d, 2n * ETH, expected + 1n))).rejects.toThrow(/moved past your limit/);
    const balance = demoReads.balance();
    await write(depositHouseCall(d, 2n * ETH, withTolerance(expected, 50n)));
    expect(demoReads.house()).toMatchObject({ bankroll: 52n * ETH, userShares: expected, totalShares: seeded.totalShares + expected });
    expect(demoReads.balance()).toBe(balance - 2n * ETH);

    await expect(write(redeemHouseCall(d, expected + 1n, 0n, d.owner))).rejects.toThrow(/do not hold that many shares/);
    await expect(write(redeemHouseCall(d, expected, 3n * ETH, d.owner))).rejects.toThrow(/moved past your limit/);
    const pays = previewRedeem(demoReads.house(), expected);
    await write(redeemHouseCall(d, expected, withTolerance(pays, 50n), d.owner));
    expect(demoReads.balance()).toBe(balance - 2n * ETH + pays);
    expect(2n * ETH - pays).toBeLessThanOrEqual(1_000_000n);
    expect(demoReads.house()).toMatchObject({ userShares: 0n, totalShares: seeded.totalShares });
    expect(demoReads.houseEvents().map((e) => e.kind)).toEqual(["deposit", "deposit", "redeem"]);
  });

  it("sets funds aside while a bet is open, and redeeming then leaves a part behind", async () => {
    await write(depositHouseCall(d, 5n * ETH, 0n));
    const shares = demoReads.house().userShares!;
    const calm = previewRedeem(demoReads.house(), shares);

    await write(playCall(d, DEMO_COLLECTION, 5_000, parseEther("0.5"))); // 0.49 ETH of house money at risk
    const open = demoReads.house();
    expect(open).toMatchObject({ reserved: parseEther("0.49"), openWagers: parseEther("0.5"), bankroll: 55n * ETH - parseEther("0.49") });
    expect(previewRedeem(open, shares)).toBeLessThan(calm);
    expect(leftBehind(open, shares)).toBe((shares * parseEther("0.99")) / (open.totalShares + VIRTUAL_SHARES));

    await vi.advanceTimersByTimeAsync(2_000);
    const settled = demoReads.house();
    expect(settled).toMatchObject({ reserved: 0n, openWagers: 0n });
    const bet = demoReads.userBets()[0];
    const gain = houseGain(bet.wager, bet.payout!, bet.fee!, 5_000n);
    // the house's funds moved by exactly what the event says it gained or lost
    expect(settled.bankroll).toBe(55n * ETH + gain);
    expect(demoReads.houseEvents().at(-1)).toMatchObject({ kind: "bet", gain });
    expect(leftBehind(settled, shares)).toBe(0n);
  });
});
