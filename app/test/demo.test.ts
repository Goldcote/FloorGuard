// The demo simulator must follow the contracts' rules, through the same maths module as the live path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { DEMO_CLIENT, DEMO_COLLECTION, DEMO_DEPLOYMENT as d, baseAfterSale, demoBidFills, demoCurveRestarts, demoOwnedTokens, demoReads, demoWrite, resetDemo } from "../src/demo/sim";
import { buyCall, startAuctionCall, unlockCall, buyLotteryTicketsCall, claimMarketCall, createMarketCall, drawRaffleCall, placeBetCall, playCall, resolveMarketCall, sellCall, spinCall, acceptOfferCall, flushPointsCall } from "../src/lib/calls";
import { diceQuote, recomputeBet, slotsExposure, gameExposure } from "../src/lib/gameMath";
import { maxGameWager, readFloorBid, readGames, readOverview, readUserBets } from "../src/lib/reads";

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
      // every wei is the player's, the house's, the buyback budget's or the project's share: the
      // bankroll keeps half of the edge, the other half is a fee of which the project gets a tenth
      const kept = expected.fee / 2n;
      const toTreasury = expected.fee - kept;
      expect(demoReads.games().reserved).toBe(0n);
      expect(demoReads.games().bankroll).toBe(before.games.bankroll + expected.stake - expected.payout + kept);
      expect(demoReads.floorBid().budget).toBe(before.budget + toTreasury - toTreasury / 10n);
      // the Verify view works on demo bets too
      expect(demoReads.betProof(bet.requestId)).toMatchObject({ roll: bet.roll, paidPayout: expected.payout, edgeBps: 200n });
    }
  });

  it("quotes dice like Games.quote", () => {
    expect(demoReads.gameQuote(ETH, 5_000)).toEqual({ payout: parseEther("1.96"), fee: parseEther("0.02") });
    expect(diceQuote(parseEther("0.1"), 100, 200n)).toEqual({ payout: parseEther("9.8"), fee: parseEther("0.002") });
  });

  it("refuses what the contracts refuse, in plain words", async () => {
    await expect(write(playCall(d, DEMO_COLLECTION, 5_000, 5n * ETH))).rejects.toThrow(/largest wager is 0\.5 ETH/);
    // a wager within the cap can still put too much of the bankroll at risk
    await expect(write(playCall(d, DEMO_COLLECTION, 100, parseEther("0.4")))).rejects.toThrow(/limit per bet is 0\.5 ETH/);
    await expect(write(spinCall(d, DEMO_COLLECTION, 1n))).rejects.toThrow(/minimum bet/);
    await expect(write(sellCall(d, DEMO_COLLECTION, 99n, 0n))).rejects.toThrow(/do not own token #99/);
    await expect(write(buyLotteryTicketsCall(d, DEMO_COLLECTION, 2, parseEther("0.02")))).rejects.toThrow(/exactly 0\.02 ETH/);
  });

  it("runs the flywheel: a sale pays a fee into the budget, the bid buys a token into the vault", async () => {
    const start = demoReads.overview();
    await write(acceptOfferCall(d, 1n, 1n, 0n)); // sell token 1 into the 1 ETH collection offer
    // 2% fee: a tenth to the project, the rest to the budget. The fee is credited once: the seller
    // gets the points for half of what reached the budget, the buyer for the rest. Pending until activated.
    expect(demoReads.floorBid().budget).toBe(start.floorBid.budget + parseEther("0.018"));
    expect(demoReads.points()).toEqual({ active: 0n, pending: parseEther("22.5") });
    expect(demoReads.overview().totalPoints).toBe(start.totalPoints + parseEther("22.5"));
    await write(flushPointsCall(d, d.owner));
    expect(demoReads.points()).toEqual({ active: parseEther("22.5"), pending: 0n });

    const bid = demoReads.floorBid().currentBid;
    const balance = demoReads.balance();
    await write(sellCall(d, DEMO_COLLECTION, 2n, 0n));
    const paid = demoReads.balance() - balance;
    expect(paid).toBeGreaterThanOrEqual(bid);
    // the next climb starts one step (15% in the demo, the AddCollection default) below the sale
    expect(demoReads.floorBid().basePrice).toBe((paid * 8_500n) / 10_000n);
    const vault = demoReads.holdings().holdings;
    expect(vault[0]).toMatchObject({ tokenId: 2n, purchasePrice: paid, status: 1 });
    expect(vault[0].lockedUntil - vault[0].acquiredAt).toBe(180 * 86_400);
  });

  it("lottery: exact payment, tickets counted, draw pays the pot less 5%", async () => {
    await write(buyLotteryTicketsCall(d, DEMO_COLLECTION, 3, parseEther("0.01")));
    const round = demoReads.lottery().current!;
    expect(round).toMatchObject({ ticketsSold: 15, userTickets: 3, pot: parseEther("0.15"), prize: parseEther("0.1425"), feeBps: 500 });
  });

  /** Three sales, each after the bid has climbed for almost three simulated days, leave a thin budget. */
  const thinBudget = async () => {
    for (const token of demoOwnedTokens().slice(0, 3)) {
      await vi.advanceTimersByTimeAsync(400_000);
      await write(sellCall(d, DEMO_COLLECTION, token, 0n));
    }
    await vi.advanceTimersByTimeAsync(400_000);
  };

  it("floor bid: the bid is the curve limited by the budget", async () => {
    await thinBudget();
    const bid = await readFloorBid(DEMO_CLIENT, d, DEMO_COLLECTION);
    expect(bid.budget).toBeGreaterThan(0n);
    expect(bid.budget).toBeLessThan(bid.curvePrice);
    expect(bid.currentBid).toBe(bid.budget);
    expect(bid.isFillable).toBe(true);

    const [token] = demoOwnedTokens();
    const before = demoReads.balance();
    await write(sellCall(d, DEMO_COLLECTION, token, 0n));
    // the seller is paid what the budget holds, not what the curve says
    expect(demoReads.balance() - before).toBe(bid.budget);
    // the next base is one step below the sale (the sale was above the old base less three steps)
    expect(demoReads.floorBid().basePrice).toBe(baseAfterSale(bid.budget, bid.basePrice, 1_500));
    expect(demoReads.floorBid().basePrice).toBe((bid.budget * 8_500n) / 10_000n);
    expect(demoBidFills().at(-1)).toMatchObject({ price: bid.budget, tokenId: token });

    // nothing left: the bid is zero and a sale is refused
    expect(demoReads.floorBid()).toMatchObject({ budget: 0n, currentBid: 0n, isFillable: false });
    await expect(write(sellCall(d, DEMO_COLLECTION, demoOwnedTokens()[0], 0n))).rejects.toThrow(/nothing to bid with/);
  });

  it("floor bid: a thin sale pulls the base down by at most three steps, and a bid below the minimum is no bid", async () => {
    // BuybackEngine.sell: anchor = max(price, base * (1 - 3 * stepDown)); new base = anchor * (1 - stepDown)
    const base = parseEther("1");
    expect(baseAfterSale(parseEther("1.2"), base, 1_500)).toBe(parseEther("1.02")); // an ordinary sale: one step below it
    expect(baseAfterSale(parseEther("0.7"), base, 1_500)).toBe(parseEther("0.595")); // still above base less three steps (0.55)
    expect(baseAfterSale(parseEther("0.1"), base, 1_500)).toBe(parseEther("0.4675")); // floored at three steps, then one more
    expect(baseAfterSale(parseEther("0.1"), base, 4_000)).toBe(parseEther("0.06")); // three steps are more than the whole base: the sale is the anchor
    expect(baseAfterSale(1n, 1n, 9_999)).toBe(1n); // never below 1 wei

    await thinBudget();
    await write(sellCall(d, DEMO_COLLECTION, demoOwnedTokens()[0], 0n)); // empties the budget
    await write(playCall(d, DEMO_COLLECTION, 9_500, parseEther("0.5"))); // a 0.01 ETH edge: half stays in the bankroll, and 0.0045 of the rest reaches the budget
    await vi.advanceTimersByTimeAsync(2_000);
    const bid = demoReads.floorBid();
    // BuybackEngine.minBidOf: a tenth of the base the curve stands at, so it follows the base down
    expect(bid.minBid).toBe(bid.basePrice / 10n);
    expect(bid.minBid).toBeLessThan(parseEther("0.09"));
    expect(bid.currentBid).toBe(parseEther("0.0045"));
    // below the minimum: the bid cannot be sold into
    expect(bid.isFillable).toBe(false);
    await expect(write(sellCall(d, DEMO_COLLECTION, demoOwnedTokens()[0], 0n))).rejects.toThrow(/below the collection's minimum bid of 0\.08\d* ETH/);
  });

  it("floor bid: the curve restarts when money reaches a budget that could not cover it", async () => {
    await thinBudget();
    const stale = demoReads.floorBid();
    expect(stale.budget).toBeLessThan(stale.curvePrice);
    expect(stale.curvePrice).toBeGreaterThan(stale.basePrice);
    expect(demoCurveRestarts()).toEqual([]);

    // auction proceeds arrive in a lump: the rise that built up meanwhile is discarded
    const auction = demoReads.holdings().holdings.find((h) => h.auction)!;
    await write(buyCall(d, auction.id, auction.auction!.currentPrice));
    const fresh = demoReads.floorBid();
    expect(demoCurveRestarts()).toHaveLength(1);
    expect(fresh.lastReset).toBe(demoCurveRestarts()[0]);
    // the bid until then was the budget: the curve restarts from there if that is above the base, so
    // money arriving never lowers the bid
    const restartBase = stale.budget > stale.basePrice ? stale.budget : stale.basePrice;
    expect(fresh.basePrice).toBe(restartBase);
    expect(fresh.curvePrice).toBeGreaterThanOrEqual(restartBase); // climbing again from there
    expect(fresh.curvePrice).toBeGreaterThanOrEqual(stale.currentBid);
    expect(fresh.curvePrice).toBeLessThan(stale.curvePrice);
    expect(fresh.currentBid).toBe(fresh.curvePrice);

    // a budget that already covers the curve grows without a restart
    await write(spinCall(d, DEMO_COLLECTION, parseEther("0.01")));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(demoCurveRestarts()).toHaveLength(1);
  });

  it("games: a wager is capped against the bankroll as well as by exposure", async () => {
    const games = demoReads.games();
    expect(games).toMatchObject({ maxWagerBps: 100n, bankrollShareBps: 5_000n });
    // at a 95% chance the exposure cap alone would allow a wager of several times the bankroll's 1%
    expect(maxGameWager({ ...games, maxWagerBps: undefined }, 9_500)!).toBeGreaterThan(parseEther("0.5"));
    expect(maxGameWager(games, 9_500)).toBe(parseEther("0.5"));
    await expect(write(playCall(d, DEMO_COLLECTION, 9_500, parseEther("0.6")))).rejects.toThrow(/largest wager is 0\.5 ETH/);
    await write(playCall(d, DEMO_COLLECTION, 9_500, parseEther("0.5")));
  });

  it("predictions: a short betting window, a fresh start price, a dead band and points credited once", async () => {
    const DAY = 86_400;
    expect(demoReads.markets()).toMatchObject({ deadBandBps: 200n, maxStartPriceAge: 3_600 });
    // betting may last at most a tenth of the market's life
    await expect(write(createMarketCall(d, DEMO_COLLECTION, BigInt(DAY), BigInt(5 * DAY)))).rejects.toThrow(/ten times as long/);
    await write(createMarketCall(d, DEMO_COLLECTION, 3_600n, 36_000n));
    const market = demoReads.markets().markets[0];
    expect(market).toMatchObject({ deadBandBps: 200n, outcome: 0 });
    expect(market.closeTime - (market.resolveTime - 36_000)).toBe(3_600);
    // the seeded market follows the same rule: its betting period is a tenth of its life
    const seeded = demoReads.markets().markets[1];
    expect(seeded.resolveTime - seeded.closeTime).toBe(9 * (DAY / 3));

    // bet on both sides of the seeded market, let it resolve, and claim
    await write(placeBetCall(d, seeded.id, true, parseEther("0.1")));
    await write(placeBetCall(d, seeded.id, false, parseEther("0.1")));
    await vi.advanceTimersByTimeAsync(((10 * DAY) / 3 / 600 + 2) * 1_000);
    await write(resolveMarketCall(d, seeded.id));
    const resolved = demoReads.markets().markets.find((m) => m.id === seeded.id)!;
    const end = (await readOverview(DEMO_CLIENT, d, DEMO_COLLECTION)).pushFloor;
    const endPrice = end.ok ? end.price : 0n;
    const move = endPrice > resolved.startPrice ? endPrice - resolved.startPrice : resolved.startPrice - endPrice;
    const inBand = move * 10_000n < resolved.startPrice * 200n;
    expect(resolved.outcome).toBe(inBand ? 3 : endPrice > resolved.startPrice ? 1 : 2);

    const before = { balance: demoReads.balance(), points: demoReads.points().pending, budget: demoReads.floorBid().budget };
    await write(claimMarketCall(d, seeded.id));
    if (resolved.outcome === 3) {
      expect(demoReads.balance()).toBe(before.balance + parseEther("0.2"));
      expect(demoReads.points().pending).toBe(before.points);
    } else {
      const [winPool, losePool] = resolved.outcome === 1 ? [resolved.higherPool, resolved.lowerPool] : [resolved.lowerPool, resolved.higherPool];
      const profit = (parseEther("0.1") * losePool) / winPool;
      const fee = (profit * 300n) / 10_000n;
      expect(demoReads.balance()).toBe(before.balance + parseEther("0.1") + profit - fee);
      const toBudget = fee - fee / 10n;
      expect(demoReads.floorBid().budget).toBe(before.budget + toBudget);
      // (the winner's fee + the fee the losing stake funded) / 2, scaled to what reached the budget
      const pointsFee = (((fee + (parseEther("0.1") * 300n) / 10_000n) / 2n) * toBudget) / fee;
      expect(demoReads.points().pending).toBe(before.points + pointsFee * 2_500n);
    }
  });

  it("vault raffle: no draw below the minimum of activated points", async () => {
    expect(demoReads.raffles().minPointsToDraw).toBe(parseEther("100"));
    await expect(write(drawRaffleCall(d, 1n))).rejects.toThrow(/announce period/);
    await vi.advanceTimersByTimeAsync(40_000);
    await write(drawRaffleCall(d, 1n)); // 400 points are activated in the demo, above the minimum
    expect(demoReads.raffles().raffles[0].status).toBe(2);
  });

  it("vault: an unsold auction can be restarted once its price sits at the reserve, and a locked holding stays locked", async () => {
    const before = demoReads.holdings().holdings.find((h) => h.auction)!;
    await expect(write(startAuctionCall(d, before.id))).rejects.toThrow(/rested at the reserve for a day/);
    await vi.advanceTimersByTimeAsync(100_000); // the seeded auction reaches its reserve half a simulated day in...
    expect(demoReads.holdings().holdings.find((h) => h.id === before.id)!.auction).toMatchObject({ atReserve: true });
    // ...and has to rest there for a day before anyone can restart it (Vault.AUCTION_RESTART_DWELL)
    await expect(write(startAuctionCall(d, before.id))).rejects.toThrow(/rested at the reserve for a day/);
    expect(demoReads.holdings().auctionRestartDwell).toBe(86_400);
    await vi.advanceTimersByTimeAsync(120_000);
    await write(startAuctionCall(d, before.id));
    const after = demoReads.holdings().holdings.find((h) => h.id === before.id)!.auction!;
    // the floor is 1 ETH and the vault paid 0.8: the reserve is 130% of that, and it opens at 16 times it
    expect(after).toMatchObject({ endPrice: parseEther("1.04"), startPrice: parseEther("16.64"), atReserve: false });
    expect(after.startTime).toBeGreaterThan(before.auction!.startTime);
    const locked = demoReads.holdings().holdings.find((h) => h.status === 1)!;
    await expect(write(unlockCall(d, locked.id))).rejects.toThrow(/Unlock conditions are not met/);
  });
});
