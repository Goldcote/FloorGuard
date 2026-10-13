// The demo simulator must follow the contracts' rules, through the same maths module as the live path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { DEMO_CLIENT, DEMO_COLLECTION, DEMO_DEPLOYMENT as d, demoReads, demoWrite, resetDemo } from "../src/demo/sim";
import { buyLotteryTicketsCall, playCall, sellCall, spinCall, acceptOfferCall, flushPointsCall } from "../src/lib/calls";
import { diceQuote, recomputeBet, slotsExposure, gameExposure } from "../src/lib/gameMath";
import { readGames, readOverview, readUserBets } from "../src/lib/reads";

const ETH = parseEther("1");

describe("demo simulator", () => {
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

  it("is reached through the ordinary read functions", async () => {
    const games = await readGames(DEMO_CLIENT, d, DEMO_COLLECTION);
    expect(games).toMatchObject({ bankroll: 50n * ETH, edgeBps: 200n, maxExposureBps: 100n, maxTotalExposureBps: 2_000n });
    expect((await readOverview(DEMO_CLIENT, d, DEMO_COLLECTION)).floorBid.budget).toBe(5n * ETH);
  });

  it("settles dice and slots with the shared maths, and keeps the money accounted for", async () => {
    const wager = parseEther("0.01");
    for (const call of [playCall(d, DEMO_COLLECTION, 5_000, wager), spinCall(d, DEMO_COLLECTION, wager), playCall(d, DEMO_COLLECTION, 9_500, wager), spinCall(d, DEMO_COLLECTION, wager)]) {
      const before = { balance: demoReads.balance(), games: demoReads.games(), budget: demoReads.floorBid().budget };
      await write(call);
      const pending = (await readUserBets(DEMO_CLIENT, d, d.owner, 0))[0];
      expect(pending.status).toBe("pending");
      const exposure = pending.kind === "slots" ? slotsExposure(wager, 200n) : gameExposure(wager, pending.chanceBps, 200n);
      expect(demoReads.games().reserved).toBe(exposure);
      expect(demoReads.balance()).toBe(before.balance - wager);

      await vi.advanceTimersByTimeAsync(2_000);
      const bet = demoReads.userBets()[0];
      expect(bet.roll).toBeGreaterThanOrEqual(0);
      const expected = recomputeBet({ wager, edgeBps: 200n, chanceBps: bet.chanceBps, roll: bet.roll! });
      expect(bet).toMatchObject({ payout: expected.payout, fee: expected.fee, status: expected.payout > 0n ? "won" : "lost" });
      expect(demoReads.balance()).toBe(before.balance - wager + expected.payout);
      // every wei is the player's, the house's, the buyback budget's or the project's share (10% of fees in the demo)
      expect(demoReads.games().reserved).toBe(0n);
      expect(demoReads.games().bankroll).toBe(before.games.bankroll + expected.stake - expected.payout);
      expect(demoReads.floorBid().budget).toBe(before.budget + expected.fee - expected.fee / 10n);
      // the Verify view works on demo bets too
      expect(demoReads.betProof(bet.requestId)).toMatchObject({ roll: bet.roll, paidPayout: expected.payout, edgeBps: 200n });
    }
  });

  it("quotes dice like Games.quote", () => {
    expect(demoReads.gameQuote(ETH, 5_000)).toEqual({ payout: parseEther("1.96"), fee: parseEther("0.02") });
    expect(diceQuote(parseEther("0.1"), 100, 200n)).toEqual({ payout: parseEther("9.8"), fee: parseEther("0.002") });
  });

  it("refuses what the contracts refuse, in plain words", async () => {
    await expect(write(playCall(d, DEMO_COLLECTION, 5_000, 5n * ETH))).rejects.toThrow(/limit per bet is 0\.5 ETH/);
    await expect(write(spinCall(d, DEMO_COLLECTION, 1n))).rejects.toThrow(/minimum bet/);
    await expect(write(sellCall(d, DEMO_COLLECTION, 99n, 0n))).rejects.toThrow(/do not own token #99/);
    await expect(write(buyLotteryTicketsCall(d, DEMO_COLLECTION, 2, parseEther("0.02")))).rejects.toThrow(/exactly 0\.02 ETH/);
  });

  it("runs the flywheel: a sale pays a fee into the budget, the bid buys a token into the vault", async () => {
    const start = demoReads.overview();
    await write(acceptOfferCall(d, 1n, 1n, 0n)); // sell token 1 into the 1 ETH collection offer
    // 2% fee: a tenth to the project, the rest to the budget; points are pending until activated
    expect(demoReads.floorBid().budget).toBe(start.floorBid.budget + parseEther("0.018"));
    expect(demoReads.points()).toEqual({ active: 0n, pending: parseEther("45") });
    await write(flushPointsCall(d, d.owner));
    expect(demoReads.points()).toEqual({ active: parseEther("45"), pending: 0n });

    const bid = demoReads.floorBid().currentBid;
    const balance = demoReads.balance();
    await write(sellCall(d, DEMO_COLLECTION, 2n, 0n));
    const paid = demoReads.balance() - balance;
    expect(paid).toBeGreaterThanOrEqual(bid);
    expect(demoReads.floorBid().basePrice).toBe((paid * 9_500n) / 10_000n);
    const vault = demoReads.holdings().holdings;
    expect(vault[0]).toMatchObject({ tokenId: 2n, purchasePrice: paid, status: 1 });
    expect(vault[0].lockedUntil - vault[0].acquiredAt).toBe(180 * 86_400);
  });

  it("lottery: exact payment, tickets counted, draw pays the pot less 5%", async () => {
    await write(buyLotteryTicketsCall(d, DEMO_COLLECTION, 3, parseEther("0.01")));
    const round = demoReads.lottery().current!;
    expect(round).toMatchObject({ ticketsSold: 15, userTickets: 3, pot: parseEther("0.15"), prize: parseEther("0.1425"), feeBps: 500 });
  });
});
