// Parity: the demo simulator against the contracts. Each scenario runs the same sequence through
// src/demo/sim.ts and through a seeded anvil chain, with the same transaction builders, and compares
// the numbers to the wei. Where they disagree the contract is right and the simulator is wrong.
//
// The demo's settings differ from the local seed in two places (a 15% step after a sale, a 10%
// project share), so the chain is given the demo's settings first. The demo draws its own rolls
// from a seeded generator; the chain's mock randomness provider is then answered with the same roll.
// The simulator runs on fake timers and is finished before the chain is touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther, type Address } from "viem";
import { DEMO_COLLECTION, DEMO_DEPLOYMENT as demo, DEMO_USER, demoBidFills, demoReads, demoWithholdRandomness, demoWrite, resetDemo } from "../src/demo/sim";
import { buybackEngineAbi, erc721Abi, gamesAbi, treasuryAbi } from "../src/generated/abis";
import {
  acceptOfferCall,
  approveCall,
  buyLotteryTicketsCall,
  depositHouseCall,
  drawLotteryCall,
  executeDepositHouseCall,
  executeRedeemHouseCall,
  mockFulfillCall,
  playCall,
  redeemHouseCall,
  refundBetCall,
  sellCall,
  spinCall,
  type Call,
} from "../src/lib/calls";
import { depositSpreadBps, housePoints, previewDeposit, quietDeposit, readHouse, readHouseEvents, redeemSpreadBps } from "../src/lib/house";
import { gameLimits, maxGameWager, readBetProof, readDrawProof, readExpectedProceeds, readFloorBid, readGames, readHoldings, readLottery, readPoints, readUserBets, type GameBet } from "../src/lib/reads";
import { client, DAY, deployment, gained, raw, ready, revertOf, send, timeOf, warpTo } from "./anvilHarness";

if (!ready) console.warn("SKIPPED: needs anvil on 127.0.0.1:8545 with Deploy.s.sol and SeedLocal.s.sol run, and `npm run sync`.");

const ETH = parseEther("1");

describe.skipIf(!ready)("the demo simulator agrees with the contracts", () => {
  // Vitest collects a skipped suite too: without a local deployment `d` is empty and nothing runs.
  const d = (deployment ?? {}) as NonNullable<typeof deployment>;
  const collection = d.demoCollection as Address;
  let owner: Address, seller: Address, buyer: Address, user: Address;
  let outer: `0x${string}`;
  let inner: `0x${string}`;
  /** The demo's project, standing in on the chain as an address nobody else uses. */
  const project = "0x00000000000000000000000000000000000face0" as Address;

  /** Run `body` in the simulator on fake timers; `write` applies a call as the page does. */
  async function simulate<T>(body: (write: (call: Call) => Promise<void>) => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      resetDemo();
      return await body(async (call) => {
        const outcome = demoWrite(call).then(
          () => undefined,
          (error: Error) => error,
        );
        await vi.advanceTimersByTimeAsync(400);
        const error = await outcome;
        if (error) throw error;
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    [owner, seller, buyer, user] = await client.getAddresses();
    outer = await client.snapshot();
    // the demo's settings: a tenth of every fee goes to the project
    await send(owner, raw(d.treasury, treasuryAbi, "setProjectShare", [collection, project, 1_000]));
  });
  afterAll(async () => {
    await client.revert({ id: outer });
  });
  beforeEach(async () => {
    inner = await client.snapshot();
  });
  afterEach(async () => {
    await client.revert({ id: inner });
  });

  const budgetOf = async () => (await readFloorBid(client, d, collection)).budget;
  const pendingOf = async (who: Address) => (await readPoints(client, d, who)).pending;
  const projectOwed = () => client.readContract({ address: d.treasury, abi: treasuryAbi, functionName: "owedTo", args: [project] });

  it("a marketplace sale: proceeds, fee split and points", async () => {
    // both start with a 1 ETH collection offer for three tokens and a 2% fee
    const sim = await simulate(async (write) => {
      const before = { balance: demoReads.balance(), budget: demoReads.floorBid().budget, points: demoReads.points().pending, total: demoReads.overview().totalPoints };
      const expected = demoReads.expectedProceeds(ETH);
      await write(acceptOfferCall(demo, 1n, 1n, expected.proceeds));
      const sellerPoints = demoReads.points().pending - before.points;
      return {
        expected,
        proceeds: demoReads.balance() - before.balance,
        toBudget: demoReads.floorBid().budget - before.budget,
        sellerPoints,
        // the simulated offerer activates its points at once, so they show in the total; the
        // visitor's stay pending, as on the chain
        offererPoints: demoReads.overview().totalPoints - before.total,
        remaining: demoReads.openOffers().offers.find((o) => o.id === 1n)!.remaining,
      };
    });

    await send(owner, raw(collection, erc721Abi, "transferFrom", [owner, seller, 1n]));
    await send(seller, approveCall(collection, d.marketplace, 1n));
    const expected = await readExpectedProceeds(client, d, collection, 1n, ETH);
    const before = { balance: await client.getBalance({ address: seller }), budget: await budgetOf(), seller: await pendingOf(seller), offerer: await pendingOf(owner) };
    const receipt = await send(seller, acceptOfferCall(d, 1n, 1n, expected.proceeds));
    const chain = {
      expected,
      proceeds: await gained(seller, before.balance, receipt),
      toBudget: (await budgetOf()) - before.budget,
      sellerPoints: (await pendingOf(seller)) - before.seller,
      offererPoints: (await pendingOf(owner)) - before.offerer,
    };

    expect(sim.expected).toEqual(chain.expected);
    expect(sim.proceeds).toBe(chain.proceeds);
    expect(sim.toBudget).toBe(chain.toBudget);
    expect(sim.sellerPoints).toBe(chain.sellerPoints);
    expect(sim.offererPoints).toBe(chain.offererPoints);
    // and they are the contract's numbers: 0.98 to the seller, 0.02 fee of which 0.002 is the
    // project's, 0.018 to the budget, credited once at 2,500 points per ETH, half to each side
    expect(chain).toMatchObject({ proceeds: parseEther("0.98"), toBudget: parseEther("0.018"), sellerPoints: parseEther("22.5"), offererPoints: parseEther("22.5") });
    expect(await projectOwed()).toBe(parseEther("0.002"));
    expect(sim.remaining).toBe(2);
  });

  it("sales into the floor bid: the price, the new base, and a sale limited by a thin budget", async () => {
    // Four sales, each after the curve has climbed for almost three days. Both start with 5 ETH.
    const sim = await simulate(async (write) => {
      const start = demoReads.floorBid();
      const sales = [];
      for (const token of [1n, 2n, 3n, 4n]) {
        await vi.advanceTimersByTimeAsync(400_000);
        const before = demoReads.floorBid();
        const balance = demoReads.balance();
        await write(sellCall(demo, DEMO_COLLECTION, token, 0n));
        const after = demoReads.floorBid();
        const fill = demoBidFills().at(-1)!;
        sales.push({ elapsed: fill.time - before.lastReset, price: demoReads.balance() - balance, base: after.basePrice, budget: after.budget, limited: demoReads.balance() - balance === before.budget });
      }
      return { start, sales, vault: demoReads.holdings().holdings.slice(0, 4).map((h) => h.purchasePrice) };
    });

    // the demo's curve on the chain: the same base, cap and growth, and its 15% step
    const { start } = sim;
    let lastReset = await timeOf(
      await send(owner, raw(d.buybackEngine, buybackEngineAbi, "configureBid", [collection, start.basePrice, start.maxPrice, start.growthBpsPerDay, start.stepDownBps, true])),
    );
    expect(await readFloorBid(client, d, collection)).toMatchObject({ budget: start.budget, basePrice: start.basePrice, minBid: start.minBid, stepDownBps: 1_500 });
    const chain = [];
    for (const [i, token] of [1n, 2n, 3n, 4n].entries()) {
      // the owner's tokens are approved for the engine by the seed
      const balance = await client.getBalance({ address: owner });
      await client.setNextBlockTimestamp({ timestamp: BigInt(lastReset + sim.sales[i].elapsed) });
      const receipt = await send(owner, sellCall(d, collection, token, 0n));
      const after = await readFloorBid(client, d, collection);
      expect(await timeOf(receipt)).toBe(lastReset + sim.sales[i].elapsed);
      lastReset = after.lastReset;
      chain.push({ price: await gained(owner, balance, receipt), base: after.basePrice, budget: after.budget });
    }

    for (const [i, sale] of sim.sales.entries()) {
      expect({ sale: i + 1, price: sale.price, base: sale.base, budget: sale.budget }).toEqual({ sale: i + 1, ...chain[i] });
    }
    // the first three are paid the curve; the fourth is paid what the budget holds, which pulls
    // the base down by the three-step rule
    expect(sim.sales.map((s) => s.limited)).toEqual([false, false, false, true]);
    expect(chain[3].budget).toBe(0n);
    expect(chain[3].price).toBe(chain[2].budget);
    expect((await readHoldings(client, d)).holdings.slice(0, 4).map((h) => h.purchasePrice)).toEqual(sim.vault);
  });

  /** What one settled bet did, in the same shape for both sides. */
  type Settled = { roll: number; status: GameBet["status"]; payout: bigint; fee: bigint; kept: bigint | undefined; toTreasury: bigint | undefined; bankroll: bigint; toBudget: bigint; points: bigint; received: bigint };

  for (const [name, wager, build] of [
    ["a dice bet", parseEther("0.1"), (dep: typeof demo, c: Address, w: bigint) => playCall(dep, c, 5_000, w)],
    ["a slots spin", parseEther("0.01"), (dep: typeof demo, c: Address, w: bigint) => spinCall(dep, c, w)],
  ] as const) {
    it(`${name}: payout, fee split, bankroll and points`, async () => {
      const sim = await simulate(async (write): Promise<Settled & { reserved: bigint }> => {
        const before = { balance: demoReads.balance(), budget: demoReads.floorBid().budget, points: demoReads.points().pending };
        await write(build(demo, DEMO_COLLECTION, wager));
        const reserved = demoReads.games().reserved;
        await vi.advanceTimersByTimeAsync(2_000);
        const bet = demoReads.userBets()[0];
        const proof = demoReads.betProof(bet.requestId)!;
        return {
          reserved,
          roll: bet.roll!,
          status: bet.status,
          payout: bet.payout!,
          fee: bet.fee!,
          kept: proof.feeKeptByBankroll,
          toTreasury: proof.feeToTreasury,
          bankroll: demoReads.games().bankroll,
          toBudget: demoReads.floorBid().budget - before.budget,
          points: demoReads.points().pending - before.points,
          received: demoReads.balance() - before.balance + wager,
        };
      });

      const before = { budget: await budgetOf(), points: await pendingOf(user) };
      await send(user, build(d, collection, wager));
      const placed = (await readUserBets(client, d, user, DAY))[0];
      expect((await readGames(client, d, collection)).reserved).toBe(sim.reserved);
      const balance = await client.getBalance({ address: user });
      // the chain's mock provider is answered with the roll the demo drew
      await send(seller, mockFulfillCall(d.gamesRandomness, placed.requestId, 10_000n * 31n + BigInt(sim.roll)));
      const bet = (await readUserBets(client, d, user, DAY))[0];
      const proof = (await readBetProof(client, d, placed.requestId))!;
      const chain: Settled = {
        roll: bet.roll!,
        status: bet.status,
        payout: bet.payout!,
        fee: bet.fee!,
        kept: proof.feeKeptByBankroll,
        toTreasury: proof.feeToTreasury,
        bankroll: (await readGames(client, d, collection)).bankroll,
        toBudget: (await budgetOf()) - before.budget,
        points: (await pendingOf(user)) - before.points,
        received: (await client.getBalance({ address: user })) - balance,
      };
      const { reserved: _reserved, ...simulated } = sim;
      expect(simulated).toEqual(chain);
      // the edge is 2% of the wager; the bankroll keeps half; a tenth of the rest is the project's
      expect(chain.fee).toBe(wager / 50n);
      expect(chain.kept).toBe(wager / 100n);
      expect(chain.toBudget).toBe((wager / 100n) * 9n / 10n);
      expect(chain.points).toBe(chain.toBudget * 2_500n);
      // the house's history says the same on both sides
      const events = (await readHouseEvents(client, d))!;
      expect(events.at(-1)).toMatchObject({ kind: "bet", gain: wager - chain.payout - (chain.fee - chain.kept!) });
    });
  }

  it("a lottery round: pot, prize, fee, the winning ticket's holder", async () => {
    // The demo's round: 7 tickets with one simulated player, 5 with another, then 3 bought here.
    const sim = await simulate(async (write) => {
      const budget = demoReads.floorBid().budget;
      const price = demoReads.lottery().config.ticketPrice;
      await write(buyLotteryTicketsCall(demo, DEMO_COLLECTION, 3, price));
      const open = demoReads.lottery().current!;
      await vi.advanceTimersByTimeAsync(((open.endTime - demoReads.chainTime()) / 600 + 2) * 1_000);
      await write(drawLotteryCall(demo, open.id));
      await vi.advanceTimersByTimeAsync(3_000);
      const round = demoReads.lottery().current!;
      const proof = demoReads.drawProof("lottery", round.id)!;
      return { price, round, proof, userWon: round.winner === DEMO_USER, owed: demoReads.lottery().userOwed!, toBudget: demoReads.floorBid().budget - budget, firstBuyerTickets: 7, secondBuyerTickets: 5 };
    });

    // On the chain the seeded round is left to end; the next one is bought in the demo's order.
    const seeded = (await readLottery(client, d, collection)).current!;
    await warpTo(seeded.endTime);
    await send(seller, buyLotteryTicketsCall(d, collection, sim.firstBuyerTickets, sim.price));
    await send(buyer, buyLotteryTicketsCall(d, collection, sim.secondBuyerTickets, sim.price));
    await send(user, buyLotteryTicketsCall(d, collection, 3, sim.price));
    let round = (await readLottery(client, d, collection, user)).current!;
    expect(round).toMatchObject({ ticketsSold: sim.round.ticketsSold, ticketPrice: sim.round.ticketPrice, pot: sim.round.pot, prize: sim.round.prize, feeBps: sim.round.feeBps, minPot: sim.round.minPot, userTickets: sim.round.userTickets });
    await warpTo(round.endTime);
    await send(seller, drawLotteryCall(d, round.id));
    const budget = await budgetOf();
    const request = (await readLottery(client, d, collection)).current!.requestId!;
    await send(seller, mockFulfillCall(d.lotteryRandomness, request, BigInt(sim.round.ticketsSold) * 1_000n + sim.proof.ticket));
    round = (await readLottery(client, d, collection, user)).current!;
    const proof = (await readDrawProof(client, d, "lottery", round.id))!;

    expect(proof.ticket).toBe(sim.proof.ticket);
    expect(proof.ticketsSold).toBe(sim.proof.ticketsSold);
    expect(proof.winner).toBe(proof.ticketHolder);
    expect(sim.proof.winner).toBe(sim.proof.ticketHolder);
    // the same ticket belongs to the same buyer: first, second or the visitor
    const role = (ticket: bigint) => (ticket < 7n ? "first" : ticket < 12n ? "second" : "visitor");
    expect({ [seller]: "first", [buyer]: "second", [user]: "visitor" }[proof.winner]).toBe(role(sim.proof.ticket));
    expect(sim.userWon).toBe(proof.winner === user);
    expect(round).toMatchObject({ status: sim.round.status, pot: sim.round.pot, prize: sim.round.prize });
    // the winner is owed the pot less 5%; nine tenths of the fee reach the budget
    expect((await readLottery(client, d, collection, proof.winner)).userOwed).toBe(sim.round.prize);
    if (sim.userWon) expect(sim.owed).toBe(sim.round.prize);
    else expect(sim.owed).toBe(0n);
    expect((await budgetOf()) - budget).toBe(sim.toBudget);
    expect(sim.round.prize).toBe(parseEther("0.1425"));
    expect(sim.toBudget).toBe(parseEther("0.00675"));
  });

  it("the house: a deposit and a redemption at once, waiting for an open bet, and within or beyond the tolerated spread with another bet open", async () => {
    const half = (shares: bigint) => shares / 2n;
    const sim = await simulate(async (write) => {
      await write(depositHouseCall(demo, 2n * ETH, 0n)); // no bet open: at once, at fair value
      const first = demoReads.house().userShares!;
      await write(playCall(demo, DEMO_COLLECTION, 5_000, parseEther("0.1"))); // settles 1.3 s later
      await write(depositHouseCall(demo, ETH, 10_000n)); // waits for the bet, whatever the tolerance
      await write(redeemHouseCall(demo, half(first), 10_000n, DEMO_USER)); // waits for the bet
      const waiting = demoReads.house();
      await vi.advanceTimersByTimeAsync(2_000);
      const firstBet = demoReads.userBets()[0];
      const ready = demoReads.house();
      // a later bet is open when the requests are carried out: it is priced against them
      demoWithholdRandomness(true);
      await write(spinCall(demo, DEMO_COLLECTION, parseEther("0.01")));
      const priced = demoReads.house();
      const depositSpread = depositSpreadBps(priced, ETH);
      const depositRefused = await write(executeDepositHouseCall(demo, depositSpread - 1n)).then(
        () => false,
        () => true,
      );
      await write(executeDepositHouseCall(demo, depositSpread));
      const second = demoReads.house().userShares! - first;
      const before = demoReads.house();
      const redeemSpread = redeemSpreadBps(before, half(first));
      const redeemRefused = await write(executeRedeemHouseCall(demo, redeemSpread - 1n, DEMO_USER)).then(
        () => false,
        () => true,
      );
      const balance = demoReads.balance();
      await write(executeRedeemHouseCall(demo, redeemSpread, DEMO_USER));
      const paid = demoReads.balance() - balance;
      return { first, second, waiting, ready, priced, depositSpread, depositRefused, redeemSpread, redeemRefused, roll: firstBet.roll!, paid, end: demoReads.house(), events: demoReads.houseEvents() };
    });

    const mine = () => readHouse(client, d, user);
    const pick = ({ bankroll, reserved, openWagers, totalShares, totalPendingDeposits, openBets, userShares, pendingDeposit, pendingRedeem }: typeof sim.end) => ({ bankroll, reserved, openWagers, totalShares, totalPendingDeposits, openBets, userShares, pendingDeposit, pendingRedeem });
    const funds = async () => pick(await mine());

    await send(user, depositHouseCall(d, 2n * ETH, 0n));
    const first = (await mine()).userShares!;
    expect(first).toBe(sim.first);
    await send(user, playCall(d, collection, 5_000, parseEther("0.1")));
    const bet = (await readUserBets(client, d, user, DAY))[0];
    await send(user, depositHouseCall(d, ETH, 10_000n));
    await send(user, redeemHouseCall(d, half(first), 10_000n, user));
    expect(await funds()).toEqual(pick(sim.waiting));
    await send(seller, mockFulfillCall(d.gamesRandomness, bet.requestId, BigInt(sim.roll)));
    expect(await funds()).toEqual(pick(sim.ready));
    await send(user, spinCall(d, collection, parseEther("0.01")));
    expect(await funds()).toEqual(pick(sim.priced));
    expect(sim.priced).toMatchObject({ openBets: 1, pendingDeposit: { ready: true }, pendingRedeem: { ready: true } });

    // beyond the tolerance both refuse; at it both carry the deposit out, for the same shares
    expect(depositSpreadBps(await mine(), ETH)).toBe(sim.depositSpread);
    expect(sim.depositSpread).toBeGreaterThan(0n);
    expect(sim.depositRefused).toBe(true);
    expect(await revertOf(user, executeDepositHouseCall(d, sim.depositSpread - 1n))).toMatchObject({ name: "SlippageExceeded" });
    await send(user, executeDepositHouseCall(d, sim.depositSpread));
    expect((await mine()).userShares! - first).toBe(sim.second);
    expect(sim.second).toBe(previewDeposit(sim.priced, ETH));
    expect(sim.second).toBeLessThan(quietDeposit(sim.priced, ETH));
    // and the redemption, for the same ETH
    expect(redeemSpreadBps(await mine(), half(first))).toBe(sim.redeemSpread);
    expect(sim.redeemRefused).toBe(true);
    expect(await revertOf(user, executeRedeemHouseCall(d, sim.redeemSpread - 1n, user))).toMatchObject({ name: "SlippageExceeded" });
    const balance = await client.getBalance({ address: user });
    const paid = await gained(user, balance, await send(user, executeRedeemHouseCall(d, sim.redeemSpread, user)));
    expect(paid).toBe(sim.paid);
    expect(await funds()).toEqual(pick(sim.end));
    expect(await client.readContract({ address: d.games, abi: gamesAbi, functionName: "sharesOf", args: [user] })).toBe(sim.end.userShares);

    // the same history, event for event
    const strip = (events: NonNullable<Awaited<ReturnType<typeof readHouseEvents>>>) => housePoints(events).map(({ kind, change, equity, shares, price }) => ({ kind, change, equity, shares, price }));
    expect(strip((await readHouseEvents(client, d))!)).toEqual(strip(sim.events));
    expect(sim.events.map((e) => e.kind)).toEqual(["deposit", "deposit", "bet", "deposit", "redeem"]);
  });

  /** The parts of the games' state the four caps depend on. */
  const capState = ({ bankroll, reserved, openWagers, maxWager, betsResumeAt }: Awaited<ReturnType<typeof readGames>>) => ({ bankroll, reserved, openWagers, maxWager, paused: betsResumeAt !== 0 });
  const refusal = (attempt: Promise<void>) =>
    attempt.then(
      () => "accepted",
      (error: Error) => error.message,
    );

  it("a bet refused by each of the four caps", async () => {
    // With the simulated provider silent, bets stay open on both sides.
    const sim = await simulate(async (write) => {
      demoWithholdRandomness(true);
      const start = demoReads.games();
      // 1. the wager cap: 1% of the free bankroll
      const overWager = await refusal(write(playCall(demo, DEMO_COLLECTION, 9_500, start.maxWager + 1n)));
      // 2. the exposure of one bet: 1% of the free bankroll
      const longShot = maxGameWager(start, 100)!;
      const overExposure = await refusal(write(playCall(demo, DEMO_COLLECTION, 100, longShot + parseEther("0.001"))));
      // 3. the exposure of all open bets: fill up at a 25% chance until the room is smaller than one bet's cap
      const exposureSteps = [];
      for (;;) {
        const games = demoReads.games();
        const limits = gameLimits(games);
        if (limits.totalRoom < limits.perBet) break;
        const wager = maxGameWager(games, 2_500)!;
        await write(playCall(demo, DEMO_COLLECTION, 2_500, wager));
        exposureSteps.push(wager);
      }
      const full = demoReads.games();
      const fits = maxGameWager(full, 2_500)!;
      const overTotal = await refusal(write(playCall(demo, DEMO_COLLECTION, 2_500, fits + parseEther("0.0001"))));
      return { start: capState(start), overWager, longShot, overExposure, exposureSteps, full: capState(full), fits, overTotal };
    });
    // 4. all wagers in play: on a fresh simulation, near-certain bets at the wager cap
    const sim2 = await simulate(async (write) => {
      demoWithholdRandomness(true);
      const wagerSteps = [];
      for (;;) {
        const games = demoReads.games();
        if (gameLimits(games).wagerRoom! < games.maxWager) break;
        await write(playCall(demo, DEMO_COLLECTION, 9_500, games.maxWager));
        wagerSteps.push(games.maxWager);
      }
      const full = demoReads.games();
      const room = gameLimits(full).wagerRoom!;
      const over = await refusal(write(playCall(demo, DEMO_COLLECTION, 9_500, room + 1n)));
      await write(playCall(demo, DEMO_COLLECTION, 9_500, room));
      return { wagerSteps, full: capState(full), room, over, end: capState(demoReads.games()) };
    });

    const games = () => readGames(client, d, collection);
    const errorOf = async (call: Call) => (await revertOf(user, call)).name;
    expect(capState(await games())).toEqual(sim.start);
    expect(sim.overWager).toMatch(/largest wager is 0\.5 ETH/);
    expect(await errorOf(playCall(d, collection, 9_500, sim.start.maxWager + 1n))).toBe("WagerTooHigh");
    expect(maxGameWager(await games(), 100)).toBe(sim.longShot);
    expect(sim.overExposure).toMatch(/limit per bet is 0\.5 ETH/);
    expect(await errorOf(playCall(d, collection, 100, sim.longShot + parseEther("0.001")))).toBe("ExposureTooHigh");

    const inner = await client.snapshot();
    for (const wager of sim.exposureSteps) {
      expect(maxGameWager(await games(), 2_500)).toBe(wager);
      await send(user, playCall(d, collection, 2_500, wager));
    }
    expect(sim.exposureSteps.length).toBeGreaterThanOrEqual(20);
    expect(capState(await games())).toEqual(sim.full);
    expect(maxGameWager(await games(), 2_500)).toBe(sim.fits);
    expect(sim.overTotal).toMatch(/^Too many open bets/);
    expect(await errorOf(playCall(d, collection, 2_500, sim.fits + parseEther("0.0001")))).toBe("TotalExposureTooHigh");
    await client.revert({ id: inner });

    for (const wager of sim2.wagerSteps) await send(user, playCall(d, collection, 9_500, wager));
    expect(sim2.wagerSteps.length).toBeGreaterThanOrEqual(20);
    expect(capState(await games())).toEqual(sim2.full);
    expect(gameLimits(await games()).wagerRoom).toBe(sim2.room);
    expect(sim2.over).toMatch(/^Too much is in play already/);
    expect(await errorOf(playCall(d, collection, 9_500, sim2.room + 1n))).toBe("TotalWagersTooHigh");
    await send(user, playCall(d, collection, 9_500, sim2.room));
    expect(capState(await games())).toEqual(sim2.end);
    expect(sim2.end.openWagers).toBe((50n * ETH * 2_000n) / 10_000n);
  });

  it("a refund after six hours, and the ten-minute pause that follows", async () => {
    const wager = parseEther("0.1");
    const sim = await simulate(async (write) => {
      demoWithholdRandomness(true);
      const balance = demoReads.balance();
      await write(playCall(demo, DEMO_COLLECTION, 5_000, wager));
      const bet = demoReads.userBets()[0];
      const placedAt = bet.refundableAt! - demoReads.games().refundTimeout;
      const early = await refusal(write(refundBetCall(demo, bet.requestId)));
      // six simulated hours are 36 real seconds
      await vi.advanceTimersByTimeAsync(((bet.refundableAt! - demoReads.chainTime()) / 600 + 1) * 1_000);
      await write(refundBetCall(demo, bet.requestId));
      const refunded = demoReads.games();
      const paused = await refusal(write(playCall(demo, DEMO_COLLECTION, 5_000, wager)));
      await vi.advanceTimersByTimeAsync(((refunded.betsResumeAt - demoReads.chainTime()) / 600 + 1) * 1_000);
      await write(playCall(demo, DEMO_COLLECTION, 5_000, wager));
      return {
        refundTimeout: demoReads.games().refundTimeout,
        refundableAfter: bet.refundableAt! - placedAt,
        early,
        back: demoReads.userBets()[1].status,
        returned: refunded.bankroll,
        reserved: refunded.reserved,
        openWagers: refunded.openWagers,
        // the wager came back whole
        net: balance - wager - demoReads.balance(),
        paused,
        resumed: demoReads.games().openWagers,
      };
    });

    const games = () => readGames(client, d, collection, user);
    const { refundTimeout } = await games();
    expect(refundTimeout).toBe(sim.refundTimeout);
    expect(refundTimeout).toBe(6 * 3_600);
    const placedAt = await timeOf(await send(user, playCall(d, collection, 5_000, wager)));
    const bet = (await readUserBets(client, d, user, refundTimeout))[0];
    expect(bet.refundableAt! - placedAt).toBe(sim.refundableAfter);
    expect(sim.early).toMatch(/^Too early/);
    expect(await revertOf(seller, refundBetCall(d, bet.requestId))).toMatchObject({ name: "TooEarly" });
    await warpTo(bet.refundableAt!);
    const balance = await client.getBalance({ address: user });
    const refundedAt = await timeOf(await send(seller, refundBetCall(d, bet.requestId)));
    expect((await client.getBalance({ address: user })) - balance).toBe(wager);
    const refunded = await games();
    expect({ back: (await readUserBets(client, d, user, refundTimeout))[0].status, returned: refunded.bankroll, reserved: refunded.reserved, openWagers: refunded.openWagers }).toEqual({
      back: sim.back,
      returned: sim.returned,
      reserved: sim.reserved,
      openWagers: sim.openWagers,
    });
    expect(sim.back).toBe("refunded");
    // betting is paused for ten minutes on both sides
    expect(refunded.betsResumeAt).toBe(refundedAt + 600);
    expect(sim.paused).toMatch(/^Betting is paused/);
    expect(await revertOf(user, playCall(d, collection, 5_000, wager))).toMatchObject({ name: "BetsPaused", args: [BigInt(refundedAt + 600)] });
    await warpTo(refundedAt + 600);
    await send(user, playCall(d, collection, 5_000, wager));
    expect((await games()).openWagers).toBe(sim.resumed);
    expect(sim.resumed).toBe(wager);
  });
});
