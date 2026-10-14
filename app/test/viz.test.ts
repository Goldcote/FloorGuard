// The pure maths behind the charts and the landing page's explainer model.
import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { auctionReachesReserveAt } from "../src/lib/reads";
import { bidState } from "../src/viz/charts";
import { auctionEndsAt, auctionPriceAt, auctionSeries, baseAfterFill, bidAt, bidPolyline, bidReachesCapAt, bidSegments, DAY, fillsCovered, maxFillCooldown, payableBid, priceLock, saleSplit, scale, ticks, timeLock, toEth, tokenPattern, unlockPrice, type BidConfig } from "../src/viz/curves";
import { advance, catchAuction, initialModel, modelAuctionPrice, modelBid, modelCurve, modelLock, raffle, RULES, sellIntoBid, setDay, setFloor, startAuction, trade, unlock, wager } from "../src/viz/flywheelModel";

const ETH = parseEther("1");
const config: BidConfig = { basePrice: parseEther("0.9"), maxPrice: parseEther("1.5"), lastReset: 1_000, growthBpsPerDay: 1_000, stepDownBps: 1_500 };

describe("the bid curve", () => {
  it("rises linearly from the base and stops at the cap (BuybackEngine.curvePrice)", () => {
    expect(bidAt(config, 1_000)).toBe(parseEther("0.9"));
    expect(bidAt(config, 1_000 + DAY)).toBe(parseEther("0.99"));
    expect(bidAt(config, 1_000 + DAY / 2)).toBe(parseEther("0.945"));
    expect(bidAt(config, 1_000 + 30 * DAY)).toBe(parseEther("1.5"));
    expect(bidAt(config, 0)).toBe(parseEther("0.9")); // never before its start
    // 0.6 above a 0.9 base at 0.09 a day: six and two thirds days
    expect(bidReachesCapAt(config)).toBe(1_000 + Math.ceil((DAY * 20) / 3));
    expect(bidAt(config, bidReachesCapAt(config)!)).toBe(parseEther("1.5"));
    expect(bidReachesCapAt({ ...config, growthBpsPerDay: 0 })).toBeUndefined();
  });

  it("the bid is the curve limited by the budget, and has a state for each case", () => {
    expect(payableBid(parseEther("0.95"), 5n * ETH)).toBe(parseEther("0.95"));
    expect(payableBid(parseEther("0.95"), parseEther("0.4"))).toBe(parseEther("0.4"));
    const bid = { ...config, active: true, nextFillAt: 0 };
    expect(bidState({ ...bid, budget: 5n * ETH }, 1_000 + DAY)).toBe("rising");
    expect(bidState({ ...bid, budget: parseEther("0.4") }, 1_000 + DAY)).toBe("budget");
    expect(bidState({ ...bid, budget: 0n }, 1_000 + DAY)).toBe("empty");
    expect(bidState({ ...bid, budget: 5n * ETH }, 1_000 + 30 * DAY)).toBe("capped");
    expect(bidState({ ...bid, budget: 5n * ETH, nextFillAt: 1_000 + 2 * DAY }, 1_000 + DAY)).toBe("cooldown");
    expect(bidState({ ...bid, budget: 5n * ETH, active: false }, 1_000 + DAY)).toBe("inactive");
    expect(fillsCovered(5n * ETH, parseEther("1.25"))).toBe(4);
    expect(fillsCovered(ETH, 0n)).toBe(0);
  });

  it("after a sale the base is one step below the higher of the sale and the old base less three steps", () => {
    expect(baseAfterFill(ETH, parseEther("0.9"), 1_500)).toBe(parseEther("0.85"));
    // a sale limited by a thin budget pulls the base down by three steps at most, then the usual one
    expect(baseAfterFill(parseEther("0.01"), parseEther("0.9"), 1_500)).toBe(parseEther("0.42075"));
    expect(baseAfterFill(parseEther("0.6"), parseEther("0.9"), 1_500)).toBe(parseEther("0.51"));
    expect(baseAfterFill(1n, 1n, 9_999)).toBe(1n);
    // the cooldown limit is the time the curve needs to regrow one step: 12.6 hours at 5% and 10% a day
    expect(maxFillCooldown(1_000, 500)).toBe(Math.floor((500 * 10_000 * DAY) / (9_500 * 1_000)));
    expect(maxFillCooldown(1_000, 500)! / 3_600).toBeCloseTo(12.63, 1);
    expect(maxFillCooldown(0, 500)).toBeUndefined();
  });

  it("builds the saw-tooth from sales and restarts", () => {
    const first = { time: 0, base: parseEther("0.9") };
    const events = [
      { time: DAY, kind: "fill" as const, price: parseEther("0.99") },
      { time: 2 * DAY, kind: "restart" as const, base: parseEther("0.8415") },
      { time: 3 * DAY, kind: "fill" as const, price: parseEther("0.2") }, // limited by the budget
    ];
    const now: BidConfig = { ...config, basePrice: parseEther("0.3934"), lastReset: 3 * DAY };
    const segments = bidSegments(now, events, first, 4 * DAY);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ from: 0, to: DAY, base: 0.9 });
    expect(segments[0].end).toBeCloseTo(0.99, 9);
    // after the sale at 0.99: 15% lower; the restart keeps that base and resets the clock
    expect(segments[1].base).toBeCloseTo(0.8415, 9);
    expect(segments[1]).toMatchObject({ restarted: true });
    expect(segments[2].base).toBeCloseTo(0.8415, 9);
    expect(segments[2].end).toBeCloseTo(0.8415 * 1.1, 9);
    expect(toEth(segments[2].fill!.price)).toBe(0.2);
    // the thin sale lowers the base by three steps and one more, to what the contract stored
    expect(0.8415 * 0.55 * 0.85).toBeCloseTo(toEth(now.basePrice), 4);
    // a restart that found more in the budget than the base lifts the base to it
    const lifted = bidSegments(now, [{ time: DAY, kind: "restart", base: parseEther("1.2") }, { time: 2 * DAY, kind: "restart" }], first, 4 * DAY);
    expect(lifted[1].base).toBeCloseTo(1.2, 9);
    expect(lifted[1].end).toBeCloseTo(1.32, 9);
    expect(segments[3]).toMatchObject({ from: 3 * DAY, to: 4 * DAY });
    const line = bidPolyline(segments);
    expect(line[0]).toEqual({ t: 0, p: 0.9 });
    expect(line.at(-1)!.p).toBeCloseTo(toEth(now.basePrice) * 1.1, 9);
    // without a recorded start only the running climb is drawn
    expect(bidSegments(now, events, undefined, 4 * DAY)).toHaveLength(1);
    // a climb that hit the cap gets a corner there
    const capped = bidSegments({ ...config, lastReset: 0 }, [], undefined, 10 * DAY);
    expect(capped[0].cappedAt).toBeCloseTo((DAY * 20) / 3, 0);
    expect(bidPolyline(capped)).toHaveLength(3);
  });
});

describe("the vault's locks", () => {
  it("time lock and price lock", () => {
    expect(timeLock(0, 180 * DAY, 45 * DAY)).toEqual({ progress: 0.25, remaining: 135 * DAY, open: false });
    expect(timeLock(0, 180 * DAY, 200 * DAY)).toEqual({ progress: 1, remaining: 0, open: true });
    expect(unlockPrice(parseEther("0.8"))).toBe(parseEther("1.04"));
    expect(priceLock(parseEther("0.8"), ETH)).toMatchObject({ trigger: parseEther("1.04"), ratio: 1.25, open: false });
    expect(priceLock(parseEther("0.8"), ETH).progress).toBeCloseTo(0.8333, 3);
    expect(priceLock(parseEther("0.8"), parseEther("1.04")).open).toBe(true);
    expect(priceLock(parseEther("0.8"), undefined)).toMatchObject({ open: false, progress: 0 });
    expect(priceLock(ETH, parseEther("0.5")).progress).toBe(0);
  });
});

describe("the falling auction", () => {
  const auction = { startPrice: parseEther("16.64"), endPrice: parseEther("1.04"), startTime: 5_000 };
  it("halves every period, falls linearly inside one and holds at the reserve (Vault.auctionPrice)", () => {
    expect(auctionPriceAt(auction, 5_000)).toBe(parseEther("16.64"));
    expect(auctionPriceAt(auction, 5_000 + DAY)).toBe(parseEther("8.32"));
    expect(auctionPriceAt(auction, 5_000 + DAY / 2)).toBe(parseEther("12.48"));
    expect(auctionPriceAt(auction, 5_000 + 3 * DAY)).toBe(parseEther("2.08"));
    expect(auctionPriceAt(auction, 5_000 + 4 * DAY)).toBe(parseEther("1.04"));
    expect(auctionPriceAt(auction, 5_000 + 40 * DAY)).toBe(parseEther("1.04"));
    expect(auctionEndsAt(auction)).toBe(5_000 + 4 * DAY);
  });
  it("agrees with the app's own reserve-time function, also for a reserve inside a period", () => {
    for (const end of ["1.04", "1.5", "3", "16.64", "0.001"]) {
      const a = { ...auction, endPrice: parseEther(end) };
      expect(auctionEndsAt(a, DAY)).toBe(auctionReachesReserveAt(a, DAY));
      expect(auctionPriceAt(a, auctionEndsAt(a))).toBe(a.endPrice);
    }
  });
  it("samples the fall for drawing, monotonically, ending on the reserve", () => {
    const series = auctionSeries(auction, DAY, 8);
    expect(series[0]).toEqual({ t: 5_000, p: 16.64 });
    expect(series.at(-1)).toEqual({ t: 5_000 + 4 * DAY, p: 1.04 });
    for (let i = 1; i < series.length; i++) expect(series[i].p).toBeLessThanOrEqual(series[i - 1].p);
  });
});

describe("who receives what", () => {
  it("splits a sale: fee, project share from the fee, royalty, the rest to the seller", () => {
    const split = saleSplit(ETH, 200n, parseEther("0.05"), 1_000);
    expect(split).toEqual({ seller: parseEther("0.93"), royalty: parseEther("0.05"), fee: parseEther("0.02"), toProject: parseEther("0.002"), toBudget: parseEther("0.018") });
    expect(split.seller + split.royalty + split.toProject + split.toBudget).toBe(ETH);
    expect(saleSplit(ETH, 200n, 0n, 0).toBudget).toBe(parseEther("0.02"));
  });
});

describe("drawing helpers", () => {
  it("scales, ticks and token patterns", () => {
    const s = scale(0, 10, 100, 200);
    expect(s(5)).toBe(150);
    expect(scale(0, 10, 0, 1, true)(25)).toBe(1);
    expect(ticks(0.9, 1.5, 4)).toEqual([1, 1.2, 1.4]);
    expect(ticks(1, 1)).toEqual([1]);
    const a = tokenPattern(7n);
    expect(a).toEqual(tokenPattern(7));
    expect(a.cells).toHaveLength(25);
    // mirrored left to right
    for (let row = 0; row < 5; row++) expect(a.cells[row * 5]).toBe(a.cells[row * 5 + 4]);
    expect(tokenPattern(8n).cells.join()).not.toBe(a.cells.join());
  });
});

describe("the explainer model follows the contracts' rules", () => {
  it("fees reach the budget: 2% of a sale, half of the 2% edge of a wager", () => {
    const start = { ...initialModel(), budget: 5 };
    expect(trade(start, 1).model.budget).toBeCloseTo(5.02, 12);
    expect(trade(start, 1).events).toEqual([{ flow: "trade", amount: 0.02 }]);
    expect(wager(start, 1).model.budget).toBeCloseTo(5.01, 12);
  });

  it("the bid is limited by the budget, and late money restarts the curve", () => {
    let m = advance(initialModel(), 2); // budget 0.6, curve 0.9 * 1.2
    expect(modelCurve(m)).toBeCloseTo(1.08, 12);
    expect(modelBid(m)).toBe(0.6);
    const fed = trade(m, 25); // +0.5: the budget could not cover the curve, so the clock restarts
    expect(fed.events.at(-1)).toEqual({ flow: "restart" });
    expect(modelCurve(fed.model)).toBeCloseTo(0.9, 12);
    expect(modelBid(fed.model)).toBeCloseTo(0.9, 12);
    // a budget that already covers the curve grows without a restart
    expect(trade(fed.model, 1).events).toHaveLength(1);

    // a thin sale pays the budget; the base falls to one step below the sale (0.6 is above 0.9 less three steps)
    m = advance(initialModel(), 2);
    const thin = sellIntoBid(m);
    expect(thin.events).toEqual([{ flow: "pay", amount: 0.6 }, { flow: "deposit", id: 1 }]);
    expect(thin.model.budget).toBe(0);
    expect(thin.model.bidBase).toBeCloseTo(0.6 * (1 - RULES.stepDown), 12);
    // with less in the budget the base stops at three steps down, then the usual one
    expect(sellIntoBid({ ...m, budget: 0.1 }).model.bidBase).toBeCloseTo(0.9 * (1 - 3 * RULES.stepDown) * (1 - RULES.stepDown), 12);
    // a budget below the minimum bid is no bid
    expect(sellIntoBid({ ...m, budget: 0.05 }).refused).toMatch(/minimum bid/);
    // money reaching a budget that held more than the base restarts the curve from what it held
    const rich = trade({ ...advance(initialModel(), 5), budget: 1.2 }, 5);
    expect(rich.events.at(-1)).toEqual({ flow: "restart" });
    expect(rich.model.bidBase).toBeCloseTo(1.2, 12);
    expect(modelBid(rich.model)).toBeCloseTo(1.2, 12);
    expect(sellIntoBid(thin.model).refused).toMatch(/nothing to bid with/);
  });

  it("locks for 180 days and until the floor is 30% up, then auctions from 16 times the reserve", () => {
    let m = sellIntoBid({ ...initialModel(), budget: 5 }).model;
    const h = m.holdings[0];
    expect(h).toMatchObject({ price: 0.9, status: "locked" });
    expect(unlock(m, 1).refused).toMatch(/180 days left/);
    m = setDay(m, 180);
    expect(modelLock(m, m.holdings[0])).toMatchObject({ time: true, price: false });
    expect(unlock(m, 1).refused).toMatch(/1\.170 ETH/);
    m = setFloor(m, 1.17);
    m = unlock(m, 1).model;
    expect(m.holdings[0].status).toBe("unlocked");
    expect(setDay(m, 3).day).toBe(180); // time does not run back past something that already happened
    const started = startAuction(m, 1);
    const a = started.model.holdings[0].auction!;
    expect(a.reserve).toBeCloseTo(1.17, 12);
    expect(a.start).toBeCloseTo(18.72, 12);
    expect(modelAuctionPrice(a, 181)).toBeCloseTo(9.36, 12);
    expect(modelAuctionPrice(a, 181.5)).toBeCloseTo(7.02, 12);
    expect(modelAuctionPrice(a, 300)).toBeCloseTo(1.17, 12);
    const caught = catchAuction(advance(started.model, 3), 1);
    expect(caught.events[0]).toMatchObject({ flow: "proceeds" });
    expect(caught.model.holdings[0]).toMatchObject({ status: "sold" });
    expect(caught.model.budget).toBeCloseTo(started.model.budget + 18.72 / 8, 9);
    // or the raffle: no ETH moves
    const raffled = raffle(m, 1);
    expect(raffled.events).toEqual([{ flow: "toRaffle", id: 1 }]);
    expect(raffled.model.budget).toBe(m.budget);
  });
});
