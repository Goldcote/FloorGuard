// The house's share arithmetic must be the contract's (src/Games.sol: deposit, redeem, previewDeposit,
// previewRedeem), in the pure module the page uses and in the demo simulator.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { DEMO_COLLECTION, DEMO_DEPLOYMENT as d, demoReads, demoWrite, resetDemo } from "../src/demo/sim";
import { cancelDepositHouseCall, cancelRedeemHouseCall, depositHouseCall, executeDepositHouseCall, executeRedeemHouseCall, playCall, redeemHouseCall, spinCall } from "../src/lib/calls";
import { gameLimits, maxGameWager, maxSlotsWager } from "../src/lib/reads";
import {
  depositSpreadBps,
  depositWithinSpread,
  givenUpByRedeemingNow,
  houseGain,
  housePoints,
  lastHolderBlocked,
  previewDeposit,
  previewRedeem,
  quietDeposit,
  redeemRequestShares,
  redeemSpreadBps,
  redeemWithinSpread,
  sharePrice,
  shareValue,
  VIRTUAL_SHARES,
  type HouseFunds,
} from "../src/lib/house";

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

  it("bets open when a request is carried out are priced against whoever carries it out", () => {
    const shares = previewDeposit(empty, 1_000n * ETH);
    // a 10 ETH coinflip is open: 9.8 ETH of house money set aside, the 10 ETH wager in play
    const open: HouseFunds = { bankroll: 1_000n * ETH - parseEther("9.8"), reserved: parseEther("9.8"), openWagers: 10n * ETH, totalShares: shares };
    // a deposit as if the house wins it: assets * (totalShares + 1e6) / (bankroll + reserved + openWagers + 1)
    const bob = previewDeposit(open, 100n * ETH);
    expect(bob).toBe((100n * ETH * (shares + VIRTUAL_SHARES)) / (1_010n * ETH + 1n));
    // with no bet open the same deposit would get more
    expect(quietDeposit(open, 100n * ETH)).toBe((100n * ETH * (shares + VIRTUAL_SHARES)) / (1_000n * ETH + 1n));
    expect(quietDeposit(open, 100n * ETH)).toBeGreaterThan(bob);
    // if the player then loses (edge sent on), bob holds no more than he paid
    const lost = { bankroll: 1_100n * ETH + parseEther("9.8"), reserved: 0n, openWagers: 0n, totalShares: shares + bob };
    expect(shareValue(lost, bob)).toBeLessThanOrEqual(100n * ETH);

    // a redemption as if the house loses it: shares * (bankroll + 1) / (totalShares + 1e6)
    expect(previewRedeem(open, shares)).toBe((shares * (open.bankroll + 1n)) / (shares + VIRTUAL_SHARES));
    // the fair value counts what is set aside too: shares * (bankroll + reserved + 1) / (totalShares + 1e6)
    expect(shareValue(open, shares)).toBe((shares * (1_000n * ETH + 1n)) / (shares + VIRTUAL_SHARES));
    // what carrying it out now gives up to the holders who stay
    expect(givenUpByRedeemingNow(open, shares / 2n)).toBe(shareValue(open, shares / 2n) - previewRedeem(open, shares / 2n));
    expect(givenUpByRedeemingNow(open, shares / 2n)).toBeGreaterThan(parseEther("4.89"));
    // leaving just before a player wins gains nothing: the early price is no better than the price after the win
    const won = { bankroll: open.bankroll, reserved: 0n, openWagers: 0n, totalShares: shares };
    expect(previewRedeem(open, shares)).toBeLessThanOrEqual(shareValue(won, shares));
    // with no bet open all three agree
    const quiet = { ...open, bankroll: 1_000n * ETH, reserved: 0n, openWagers: 0n };
    expect(previewRedeem(quiet, shares)).toBe(shareValue(quiet, shares));
    expect(previewDeposit(quiet, ETH)).toBe(quietDeposit(quiet, ETH));
    expect(givenUpByRedeemingNow(quiet, shares)).toBe(0n);
    // whoever holds every share cannot redeem while bets are open
    expect(lastHolderBlocked(open, shares)).toBe(true);
    expect(lastHolderBlocked(open, shares - 1n)).toBe(false);
    expect(lastHolderBlocked(quiet, shares)).toBe(false);
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
  });

  it("the spread against fair value, and the contract's test of a tolerance (Games._executeDeposit / _executeRedeem)", () => {
    const shares = previewDeposit(empty, 1_000n * ETH);
    const quiet: HouseFunds = { bankroll: 1_000n * ETH, reserved: 0n, openWagers: 0n, totalShares: shares };
    // no bet open: no spread, and a tolerance of zero is enough ("fair value or wait")
    expect(depositSpreadBps(quiet, 100n * ETH)).toBe(0n);
    expect(redeemSpreadBps(quiet, shares / 2n)).toBe(0n);
    expect(depositWithinSpread(quiet, 100n * ETH, 0n)).toBe(true);
    expect(redeemWithinSpread(quiet, shares / 2n, 0n)).toBe(true);
    // a 10 ETH coinflip open: 9.8 ETH set aside (0.98% of the funds), 10 ETH in play (1%)
    const open: HouseFunds = { bankroll: 1_000n * ETH - parseEther("9.8"), reserved: parseEther("9.8"), openWagers: 10n * ETH, totalShares: shares };
    // redemption: 1 - (bankroll + 1) / (bankroll + reserved + 1) = 0.98%, rounded up to whole basis points
    expect(redeemSpreadBps(open, shares / 2n)).toBe(98n);
    expect(redeemWithinSpread(open, shares / 2n, 97n)).toBe(false);
    expect(redeemWithinSpread(open, shares / 2n, 98n)).toBe(true);
    // previewRedeem >= shareValue * (10000 - maxSpread) / 10000
    expect(previewRedeem(open, shares / 2n) >= (shareValue(open, shares / 2n) * 9_902n) / 10_000n).toBe(true);
    // deposit: 1 - 1000 / 1010 = 0.990099%, so 100 basis points when rounded up
    expect(depositSpreadBps(open, 100n * ETH)).toBe(100n);
    expect(depositWithinSpread(open, 100n * ETH, 99n)).toBe(false);
    expect(depositWithinSpread(open, 100n * ETH, 100n)).toBe(true);
    expect(previewDeposit(open, 100n * ETH) >= (quietDeposit(open, 100n * ETH) * 9_900n) / 10_000n).toBe(true);
    // a deposit too small for a single share is never carried out
    expect(depositWithinSpread({ ...open, totalShares: 0n }, 1n, 10_000n)).toBe(false);
  });

  it("a redemption that would leave dust is for the whole holding (Games.redeem)", () => {
    const held = 5n * VIRTUAL_SHARES;
    expect(redeemRequestShares(held, 3n * VIRTUAL_SHARES)).toBe(3n * VIRTUAL_SHARES);
    expect(redeemRequestShares(held, 4n * VIRTUAL_SHARES)).toBe(4n * VIRTUAL_SHARES); // exactly a million raw shares would remain
    expect(redeemRequestShares(held, 4n * VIRTUAL_SHARES + 1n)).toBe(held); // fewer than a million would remain
    expect(redeemRequestShares(held, held)).toBe(held);
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

  it("is seeded as one deposit; with no bet open a deposit and a redemption are carried out at once at fair value", async () => {
    const seeded = demoReads.house();
    expect(seeded).toMatchObject({ bankroll: 50n * ETH, reserved: 0n, openWagers: 0n, totalShares: 50n * ETH * VIRTUAL_SHARES, userShares: 0n, bankrollShareBps: 5_000n });
    expect(demoReads.houseEvents()).toHaveLength(1);

    const expected = previewDeposit(seeded, 2n * ETH);
    await expect(write(depositHouseCall(d, 2n * ETH, 10_001n))).rejects.toThrow(/Invalid parameters/);
    const balance = demoReads.balance();
    await write(depositHouseCall(d, 2n * ETH, 0n)); // a tolerance of zero: fair value or wait
    expect(demoReads.house()).toMatchObject({ bankroll: 52n * ETH, userShares: expected, totalShares: seeded.totalShares + expected, pendingDeposit: undefined });
    expect(demoReads.balance()).toBe(balance - 2n * ETH);

    await expect(write(redeemHouseCall(d, expected + 1n, 0n, d.owner))).rejects.toThrow(/do not hold that many shares/);
    const pays = previewRedeem(demoReads.house(), expected);
    await write(redeemHouseCall(d, expected, 0n, d.owner));
    expect(demoReads.balance()).toBe(balance - 2n * ETH + pays);
    expect(2n * ETH - pays).toBeLessThanOrEqual(1_000_000n);
    expect(demoReads.house()).toMatchObject({ userShares: 0n, totalShares: seeded.totalShares });
    expect(demoReads.houseEvents().map((e) => e.kind)).toEqual(["deposit", "deposit", "redeem"]);
  });

  it("a redemption that would leave dust takes the whole holding", async () => {
    await write(depositHouseCall(d, ETH, 0n));
    const shares = demoReads.house().userShares!;
    await write(redeemHouseCall(d, shares - 5n, 0n, d.owner));
    expect(demoReads.house().userShares).toBe(0n);
  });

  it("with a bet open a deposit waits, can be cancelled, and is priced after the bet (test_house_depositWaitsForOpenBetsAndIsPricedAfterThem)", async () => {
    await write(playCall(d, DEMO_COLLECTION, 5_000, parseEther("0.5"))); // 0.49 ETH of house money at risk; settles 1.3 s later
    const open = demoReads.house();
    expect(open).toMatchObject({ reserved: parseEther("0.49"), openWagers: parseEther("0.5"), bankroll: 50n * ETH - parseEther("0.49") });
    const balance = demoReads.balance();
    await write(depositHouseCall(d, 5n * ETH, 10_000n)); // however much is tolerated, it waits for the bet
    // the ETH has left the wallet but is held apart from the bankroll, and no shares exist yet
    expect(demoReads.balance()).toBe(balance - 5n * ETH);
    expect(demoReads.house()).toMatchObject({ bankroll: open.bankroll, totalShares: open.totalShares, userShares: 0n, totalPendingDeposits: 5n * ETH, pendingDeposit: { amount: 5n * ETH, ready: false, waitingFor: 1 } });
    await expect(write(executeDepositHouseCall(d, 10_000n))).rejects.toThrow(/has not finished/);
    // cancelling returns all of it
    await write(cancelDepositHouseCall(d));
    expect(demoReads.balance()).toBe(balance);
    expect(demoReads.house()).toMatchObject({ pendingDeposit: undefined, totalPendingDeposits: 0n });
    await vi.advanceTimersByTimeAsync(2_000); // the bet settles
    await expect(write(cancelDepositHouseCall(d))).rejects.toThrow(/no pending request/);
    const first = demoReads.userBets()[0];
    const firstGain = houseGain(first.wager, first.payout!, first.fee!, 5_000n);

    await write(playCall(d, DEMO_COLLECTION, 5_000, parseEther("0.5")));
    await write(depositHouseCall(d, 4n * ETH, 0n));
    // a second deposit adds to the pending one
    await write(depositHouseCall(d, ETH, 0n));
    expect(demoReads.house().pendingDeposit).toMatchObject({ amount: 5n * ETH, ready: false });
    await vi.advanceTimersByTimeAsync(2_000); // the bet settles
    const settled = demoReads.house();
    expect(settled).toMatchObject({ reserved: 0n, openWagers: 0n, pendingDeposit: { amount: 5n * ETH, ready: true, waitingFor: 0 } });
    const bet = demoReads.userBets()[0];
    const gain = houseGain(bet.wager, bet.payout!, bet.fee!, 5_000n);
    // the house's funds moved by exactly what the event says it gained or lost
    expect(settled.bankroll).toBe(50n * ETH + firstGain + gain);
    expect(demoReads.houseEvents().at(-1)).toMatchObject({ kind: "bet", gain });
    // carried out at the price after the bet: no bet is open, so at fair value with no tolerance
    const shares = previewDeposit(settled, 5n * ETH);
    await write(executeDepositHouseCall(d, 0n));
    expect(demoReads.house()).toMatchObject({ bankroll: settled.bankroll + 5n * ETH, userShares: shares, pendingDeposit: undefined, totalPendingDeposits: 0n });
    await expect(write(executeDepositHouseCall(d, 0n))).rejects.toThrow(/no pending request/);
  });

  it("with a bet open a redemption waits, shares the bet's result, and can be cancelled (test_house_redeemWaitsForOpenBetsAndSharesTheirResult)", async () => {
    await write(depositHouseCall(d, 5n * ETH, 0n));
    const shares = demoReads.house().userShares!;
    await write(spinCall(d, DEMO_COLLECTION, parseEther("0.01"))); // settles 1.7 s later
    const balance = demoReads.balance();
    await write(redeemHouseCall(d, shares, 10_000n, d.owner));
    // nothing is paid yet and the shares are still held: they stay at risk
    expect(demoReads.balance()).toBe(balance);
    expect(demoReads.house()).toMatchObject({ userShares: shares, pendingRedeem: { amount: shares, ready: false, waitingFor: 1 } });
    await expect(write(executeRedeemHouseCall(d, 10_000n, d.owner))).rejects.toThrow(/has not finished/);
    // a new request replaces the earlier one
    await write(redeemHouseCall(d, shares / 2n, 0n, d.owner));
    expect(demoReads.house().pendingRedeem).toMatchObject({ amount: shares / 2n });
    await write(cancelRedeemHouseCall(d));
    expect(demoReads.house().pendingRedeem).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(write(cancelRedeemHouseCall(d))).rejects.toThrow(/no pending request/);

    await write(playCall(d, DEMO_COLLECTION, 5_000, parseEther("0.5")));
    await write(redeemHouseCall(d, shares, 0n, d.owner));
    await vi.advanceTimersByTimeAsync(2_000);
    const settled = demoReads.house();
    expect(settled.pendingRedeem).toMatchObject({ amount: shares, ready: true });
    // paid at the house's funds per share after the bet: the holder took their part of its result
    const pays = previewRedeem(settled, shares);
    expect(pays).toBe(shareValue(settled, shares));
    const beforePaid = demoReads.balance();
    await write(executeRedeemHouseCall(d, 0n, d.owner));
    expect(demoReads.balance()).toBe(beforePaid + pays);
    expect(demoReads.house()).toMatchObject({ userShares: 0n, pendingRedeem: undefined, bankroll: settled.bankroll - pays });
    expect(demoReads.houseEvents().map((e) => e.kind)).toEqual(["deposit", "deposit", "bet", "bet", "redeem"]);
  });

  it("a ready request is carried out only within the tolerated spread while another bet is open (test_house_*Spread*)", async () => {
    await write(depositHouseCall(d, 5n * ETH, 0n));
    const shares = demoReads.house().userShares!;
    await write(playCall(d, DEMO_COLLECTION, 5_000, parseEther("0.1")));
    await write(redeemHouseCall(d, shares / 2n, 0n, d.owner)); // waits for that one bet
    await write(depositHouseCall(d, ETH, 0n)); // so does this
    await vi.advanceTimersByTimeAsync(1_000); // it settles 1.3 s after it was placed
    await write(spinCall(d, DEMO_COLLECTION, parseEther("0.01"))); // a later bet, open for the rest of this test (1.7 s)
    const house = demoReads.house();
    expect(house).toMatchObject({ reserved: parseEther("0.4802"), openWagers: parseEther("0.01"), openBets: 1 });
    // both requests are ready: they do not wait for the later bet
    expect(house.pendingRedeem).toMatchObject({ ready: true, waitingFor: 0 });
    expect(house.pendingDeposit).toMatchObject({ ready: true, waitingFor: 0 });
    // but that bet is priced against them: the redemption would pay less than fair value
    const pays = previewRedeem(house, shares / 2n);
    expect(pays).toBeLessThan(shareValue(house, shares / 2n));
    const spread = redeemSpreadBps(house, shares / 2n);
    expect(spread).toBeGreaterThan(0n);
    // beyond the tolerance executeRedeem refuses, and the request stays pending
    await expect(write(executeRedeemHouseCall(d, spread - 1n, d.owner))).rejects.toThrow(/more against fair value than the limit you set/);
    const balance = demoReads.balance();
    expect(demoReads.house().pendingRedeem).toMatchObject({ amount: shares / 2n, ready: true });
    // within the tolerance it is paid, in full
    await write(executeRedeemHouseCall(d, spread, d.owner));
    expect(demoReads.balance() - balance).toBe(pays);
    expect(demoReads.house()).toMatchObject({ userShares: shares - shares / 2n, pendingRedeem: undefined });
    // the deposit likewise
    const now = demoReads.house();
    const minted = previewDeposit(now, ETH);
    expect(minted).toBeLessThan(quietDeposit(now, ETH));
    const depositSpread = depositSpreadBps(now, ETH);
    await expect(write(executeDepositHouseCall(d, depositSpread - 1n))).rejects.toThrow(/more against fair value than the limit you set/);
    expect(demoReads.house().pendingDeposit).toMatchObject({ amount: ETH });
    await write(executeDepositHouseCall(d, depositSpread));
    expect(demoReads.house()).toMatchObject({ userShares: shares - shares / 2n + minted, openBets: 1 });
  });

  it("the wager limit is the smallest of four caps (Games._place), and the simulator reports the two new ones", () => {
    expect(demoReads.games()).toMatchObject({ openWagers: 0n, maxOpenWagersBps: 2_000n, betsResumeAt: 0, refundTimeout: 6 * 3_600 });
    const state = { bankroll: 100n * ETH, reserved: 0n, openWagers: 0n, maxExposureBps: 100n, maxTotalExposureBps: 2_000n, maxWagerBps: 100n, maxOpenWagersBps: 2_000n, edgeBps: 200n };
    // a near-certain bet risks little: the 1% wager cap binds
    expect(maxGameWager(state, 9_500)).toBe(ETH);
    expect(gameLimits(state)).toMatchObject({ perBet: ETH, totalRoom: 20n * ETH, wagerRoom: 20n * ETH });
    // 19.4 ETH is already in play: only 0.6 ETH of wagers fits under the 20% cap on all of them
    const busy = { ...state, openWagers: parseEther("19.4") };
    expect(gameLimits(busy).wagerRoom).toBe(parseEther("0.6"));
    expect(maxGameWager(busy, 9_500)).toBe(parseEther("0.6"));
    expect(maxSlotsWager(busy)!).toBeLessThan(parseEther("0.6")); // the 49-stake reserve still binds first for slots
    expect(maxSlotsWager({ ...busy, openWagers: parseEther("19.999") })).toBe(parseEther("0.001"));
    // nothing fits once the cap is reached
    expect(maxGameWager({ ...state, openWagers: 20n * ETH }, 9_500)).toBe(0n);
    // a long shot: the per-bet exposure cap binds (1 ETH at risk for a 1% chance is a tiny wager)
    expect(maxGameWager(state, 100)!).toBeLessThan(parseEther("0.0104"));
  });
});
