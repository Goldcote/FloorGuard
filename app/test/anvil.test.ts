// Integration test against a local anvil chain that has just been deployed and seeded
// (script/Deploy.s.sol + script/SeedLocal.s.sol, see app/README.md).
//
// It exercises the code the UI runs, without a browser:
//   - every read in src/lib/reads.ts and src/lib/house.ts (the functions behind the React hooks),
//   - every transaction builder in src/lib/calls.ts, sent the way src/tx.tsx sends them
//     (simulate with the merged error ABI, then eth_sendTransaction from an unlocked node account,
//     which is the same JSON-RPC path an injected wallet uses),
//   - custom error decoding in src/lib/errors.ts.
//
// Every number is the contracts' own: what src/*.sol computes for the seeded state. Owner settings
// the UI has no button for are sent with `raw` (the generated ABIs).
//
// The chain is snapshotted first and reverted afterwards, so the test can be re-run and leaves the
// seeded state as it found it. Without a reachable, deployed anvil the suite is skipped. The tests
// build on each other, in order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type Address } from "viem";
import {
  buybackEngineAbi,
  erc721Abi,
  gamesAbi,
  lotteryAbi,
  predictionMarketAbi,
  pushFloorOracleAbi,
  salesFloorOracleAbi,
  ticketRaffleAbi,
  treasuryAbi,
  vaultAbi,
  vaultRaffleAbi,
} from "../src/generated/abis";
import {
  abortLotteryCall,
  abortTicketRaffleCall,
  acceptOfferCall,
  approveCall,
  buyCall,
  buyLotteryTicketsCall,
  buyTicketsCall,
  cancelDepositHouseCall,
  cancelOfferCall,
  cancelRedeemHouseCall,
  cancelTicketRaffleCall,
  claimMarketCall,
  claimProjectShareCall,
  claimRaffleCall,
  closeTicketRaffleCall,
  createMarketCall,
  createTicketRaffleCall,
  depositHouseCall,
  drawLotteryCall,
  drawRaffleCall,
  executeDepositHouseCall,
  executeRedeemHouseCall,
  flushPointsCall,
  makeCollectionOfferCall,
  makeOfferCall,
  mockFulfillCall,
  placeBetCall,
  playCall,
  reclaimTicketRaffleCall,
  redeemHouseCall,
  refundBetCall,
  refundLotteryCall,
  refundTicketsCall,
  requestLicenseCall,
  resetLotteryDrawCall,
  resetTicketDrawCall,
  resolveMarketCall,
  sellCall,
  settleTicketRaffleCall,
  spinCall,
  startAuctionCall,
  unlockCall,
  withdrawGamesCall,
  withdrawLotteryCall,
  withdrawTicketRaffleCall,
} from "../src/lib/calls";
import { decodeError } from "../src/lib/errors";
import { recomputeBet } from "../src/lib/fairness";
import { gasLimitFor } from "../src/lib/gas";
import { houseGain, housePoints, lastHolderBlocked, previewDeposit, previewRedeem, quietDeposit, readHouse, readHouseEvents, sharePrice, shareValue, VIRTUAL_SHARES, depositSpreadBps, depositWithinSpread, redeemRequestShares, redeemSpreadBps, redeemWithinSpread } from "../src/lib/house";
import {
  abortableAt,
  auctionReachesReserveAt,
  auctionRestartableAt,
  gameExposure,
  gameLimits,
  HoldingStatus,
  impliedMultiple,
  lotteryWouldRefund,
  LotteryStatus,
  MARKET_DURATION_PER_BETTING,
  maxGameWager,
  maxSlotsWager,
  Outcome,
  RaffleStatus,
  readActivity,
  readAuctionPrice,
  readBetProof,
  readChainTime,
  readDrawProof,
  readExpectedProceeds,
  readFairnessStatus,
  readFloor,
  readFloorBid,
  readGameQuote,
  readGames,
  readHoldings,
  readLicensing,
  readLottery,
  readMarkets,
  readOpenOffers,
  readOverview,
  readPoints,
  readRaffles,
  readTicketRaffles,
  readTokenState,
  readUserBets,
  SLOTS_MAX_MULTIPLIER,
  SLOTS_PAY_TABLE,
  slotsExposure,
  slotsLine,
  slotsMultiplier,
  TicketRaffleStatus,
  ticketRaffleWouldRefund,
  withSlippage,
} from "../src/lib/reads";
import { bidState } from "../src/viz/charts";
import { auctionPriceAt, baseAfterFill, bidAt, payableBid, saleSplit, unlockPrice } from "../src/viz/curves";
import { readSalesFloors } from "../src/viz/data";
import { client, DAY, deployment, gained, raw, ready, revertOf, send, timeOf, warpTo } from "./anvilHarness";

if (!ready) {
  console.warn("SKIPPED: needs anvil on 127.0.0.1:8545 with Deploy.s.sol and SeedLocal.s.sol run, and `npm run sync`.");
}

const ETH = parseEther("1");
const BPS = 10_000n;
/** `Games.REFUND_TIMEOUT`: an unanswered bet can be refunded after six hours. */
const REFUND = 6 * 3_600;
/** Points are 2,500 per ETH of fee that reached a buyback budget (script/Deploy.s.sol). */
const pts = (feeWei: bigint) => (feeWei * 2_500n * ETH) / ETH;

describe.skipIf(!ready)("FloorGuard app against a seeded anvil", () => {
  const d = deployment!;
  const collection = d.demoCollection!;
  let owner: Address; // anvil account #0: deployer, protocol owner, holder of the demo tokens
  let seller: Address; // account #1
  let buyer: Address; // account #2
  let other: Address; // account #3
  let snapshot: `0x${string}`;

  const ownerOf = (tokenId: bigint) => client.readContract({ address: collection, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] });
  const balanceOf = (address: Address) => client.getBalance({ address });
  const budgetOf = async () => (await readFloorBid(client, d, collection)).budget;
  const vaultRead = (functionName: "unlockFloorOf" | "minReserveOf" | "isOwnerPriced", arg: bigint | Address) =>
    client.readContract({ address: d.vault, abi: vaultAbi, functionName, args: [arg] } as never) as Promise<bigint | boolean>;
  const gamesRead = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: d.games, abi: gamesAbi, functionName, args } as never) as Promise<T>;
  /** Runs `body` on a snapshot of its own and puts the chain (and its clock) back afterwards. */
  async function isolated(body: () => Promise<void>) {
    const local = await client.snapshot();
    try {
      await body();
    } finally {
      await client.revert({ id: local });
    }
  }
  /** `count` floor-type sales at `price`, reported by the owner as a reporter of the sales oracle. */
  async function recordSales(price: bigint, count: number) {
    await send(owner, raw(d.salesFloorOracle, salesFloorOracleAbi, "setReporter", [owner, true]));
    for (let i = 0; i < count; i++) await send(owner, raw(d.salesFloorOracle, salesFloorOracleAbi, "recordSale", [collection, price]));
  }

  beforeAll(async () => {
    [owner, seller, buyer, other] = await client.getAddresses();
    snapshot = await client.snapshot();
  });

  afterAll(async () => {
    await client.revert({ id: snapshot });
  });

  it("reads the seeded state", async () => {
    expect(owner.toLowerCase()).toBe(d.owner.toLowerCase());
    const now = await readChainTime(client);

    const overview = await readOverview(client, d, collection, owner);
    const bid = overview.floorBid;
    expect(bid).toMatchObject({
      budget: 5n * ETH,
      active: true,
      isFillable: true,
      basePrice: parseEther("0.9"),
      maxPrice: parseEther("1.5"),
      growthBpsPerDay: 1_000,
      stepDownBps: 500,
      fillCooldown: 0,
      nextFillAt: 0,
      // the minimum bid is a tenth of the base
      minBid: parseEther("0.09"),
    });
    // The curve: base + base * 10% * elapsed / 1 day. The 5 ETH budget covers it, so it is the bid.
    const curve = parseEther("0.9") + (parseEther("0.9") * 1_000n * BigInt(now - bid.lastReset)) / (BPS * BigInt(DAY));
    expect(bid.curvePrice).toBe(curve);
    expect(bid.currentBid).toBe(curve);
    expect(bidAt(bid, now)).toBe(curve); // the mirror the page draws with
    expect(payableBid(bid.curvePrice, bid.budget)).toBe(bid.currentBid);
    expect(bidState(bid, now)).toBe("rising");
    expect(await readFloorBid(client, d, collection)).toEqual(bid);
    // No floor-type sales yet: the sales oracle reverts and the UI shows the decoded reason.
    expect(overview.salesFloor).toEqual({
      ok: false,
      errorName: "InsufficientData",
      reason: "Not enough recent sales: 0 usable, 3 required.",
    });
    expect(await readSalesFloors(client, d, [collection, collection])).toEqual({ [collection.toLowerCase()]: overview.salesFloor });
    expect(overview.pushFloor).toMatchObject({ ok: true, price: ETH });
    expect(overview.holdingCount).toBe(0n);
    expect(overview.collectionHoldingsInVault).toBe(0);
    expect(overview.marketplaceSupported).toBe(true);
    // The seed sets no project share.
    expect(BigInt(overview.projectShare.recipient)).toBe(0n);
    expect(overview.projectShare.bps).toBe(0);
    expect(overview.userProjectShareOwed).toBe(0n);

    // Games: the 50 ETH bankroll, a 2% edge of which the bankroll keeps half, and a wager cap of 1%.
    const games = await readGames(client, d, collection, owner);
    expect(games).toEqual({
      bankroll: 50n * ETH,
      reserved: 0n,
      maxTotalExposureBps: 2_000n,
      edgeBps: 200n,
      minBet: parseEther("0.001"),
      maxExposureBps: 100n,
      maxWagerBps: 100n,
      maxWager: parseEther("0.5"),
      bankrollShareBps: 5_000n,
      openWagers: 0n,
      maxOpenWagersBps: 2_000n,
      betsResumeAt: 0,
      supported: true,
      refundTimeout: REFUND,
      userOwed: 0n,
    });
    expect(await gamesRead("maxWager")).toBe(games.maxWager);
    expect((await readGames(client, d, "0x000000000000000000000000000000000000dEaD")).supported).toBe(false);
    expect(await readUserBets(client, d, owner, REFUND)).toEqual([]);

    // The house: `fundBankroll` minted the seeder a million shares per wei.
    const house = await readHouse(client, d, owner);
    expect(house).toEqual({
      bankroll: 50n * ETH,
      reserved: 0n,
      openWagers: 0n,
      totalShares: 50n * ETH * VIRTUAL_SHARES,
      bankrollShareBps: 5_000n,
      edgeBps: 200n,
      maxExposureBps: 100n,
      maxTotalExposureBps: 2_000n,
      totalPendingDeposits: 0n,
      openBets: 0,
      userShares: 50n * ETH * VIRTUAL_SHARES,
      pendingDeposit: undefined,
      pendingRedeem: undefined,
    });
    expect((await readHouse(client, d)).userShares).toBeUndefined();
    expect((await readHouse(client, d, seller)).userShares).toBe(0n);
    expect(await gamesRead("previewDeposit", [ETH])).toBe(previewDeposit(house, ETH));
    expect(await gamesRead("previewRedeem", [house.totalShares])).toBe(previewRedeem(house, house.totalShares));
    expect(await gamesRead("shareValue", [house.totalShares])).toBe(shareValue(house, house.totalShares));
    expect(shareValue(house, house.totalShares)).toBe(previewRedeem(house, house.totalShares)); // no bet open: the same
    expect(50n * ETH - previewRedeem(house, house.totalShares)).toBeLessThanOrEqual(1n);
    const houseEvents = (await readHouseEvents(client, d))!;
    expect(houseEvents).toHaveLength(1);
    expect(houseEvents[0]).toMatchObject({ kind: "deposit", amount: 50n * ETH, shares: 50n * ETH * VIRTUAL_SHARES });
    expect(housePoints(houseEvents)).toMatchObject([{ kind: "deposit", equity: 50n * ETH, shares: house.totalShares, change: 50n * ETH }]);
    expect(housePoints(houseEvents)[0].price).toBeCloseTo(1, 9);

    // The seeded weekly lottery: 0.01 ETH a ticket, 5 tickets sold to the owner.
    const lottery = await readLottery(client, d, collection, owner);
    expect(lottery).toMatchObject({
      config: { ticketPrice: parseEther("0.01"), duration: 7 * DAY, active: true },
      past: [],
      minPot: parseEther("0.05"),
      feeBps: 500n,
      drawTimeout: DAY,
      abortDelay: 7 * DAY,
      userOwed: 0n,
    });
    expect(lottery.current).toMatchObject({
      id: 1n,
      ticketPrice: parseEther("0.01"),
      ticketsSold: 5,
      feeBps: 500,
      minPot: parseEther("0.05"),
      status: LotteryStatus.Open,
      pot: parseEther("0.05"),
      prize: parseEther("0.0475"),
      userPaid: parseEther("0.05"),
      userTickets: 5,
    });
    expect((await readLottery(client, d, collection)).current!.userTickets).toBeUndefined();
    const noLottery = await readLottery(client, d, d.owner);
    expect(noLottery).toMatchObject({ config: { active: false }, current: undefined, past: [] });

    expect(await readPoints(client, d, owner)).toEqual({ active: 0n, pending: 0n });

    // The conditions the fairness claim depends on: on anvil every provider is the mock and the
    // owner is a plain account, and the app must say so.
    const fairness = await readFairnessStatus(client, d);
    expect(fairness.anyMock).toBe(true);
    expect(fairness.sources.map((s) => [s.module, s.isMock])).toEqual([
      ["Games", true],
      ["Lottery", true],
      ["Ticket raffles", true],
      ["Vault raffles", true],
    ]);
    expect(fairness.sources[0].provider).toBe(d.gamesRandomness);
    expect(fairness.sources[1].provider).toBe(d.lotteryRandomness);
    expect(fairness.sources[2].provider).toBe(d.ticketRaffleRandomness);
    expect(fairness.sources[3].provider).toBe(d.randomness);
    expect(fairness).toMatchObject({
      gamesOwner: owner,
      ownerIsContract: false,
      games: { edgeBps: 200n, minBet: parseEther("0.001"), maxExposureBps: 100n, maxTotalExposureBps: 2_000n, refundTimeout: REFUND, maxWagerBps: 100n, bankrollShareBps: 5_000n },
      lottery: { feeBps: 500n, minPot: parseEther("0.05") },
      ticketRaffle: { feeBps: 500n, minPot: parseEther("0.05") },
    });
    // The helpers that mirror the contracts' abort timing.
    const timing = { abortDelay: 7 * DAY, drawTimeout: DAY };
    expect(abortableAt({ endTime: 100, requestedAt: 0 }, "open", timing)).toBe(100 + 7 * DAY);
    expect(abortableAt({ endTime: 100, requestedAt: 200 }, "drawing", timing)).toBe(100 + 7 * DAY);
    expect(abortableAt({ endTime: 100, requestedAt: 100 + 7 * DAY }, "drawing", timing)).toBe(100 + 8 * DAY);
    expect(abortableAt({ endTime: 100, requestedAt: 500 }, "won", timing)).toBe(500 + 7 * DAY);
    expect(abortableAt({ endTime: 100, requestedAt: 500 }, "done", timing)).toBeUndefined();

    // The seed's events for this collection, newest first, with block times and routes.
    const activity = await readActivity(client, d, collection);
    expect(activity.length).toBeGreaterThanOrEqual(5);
    expect(activity.map((a) => a.module)).toEqual(expect.arrayContaining(["Marketplace", "Ticket raffle", "Lottery", "Predictions"]));
    expect(activity.every((a) => a.time !== undefined && a.route.startsWith("/"))).toBe(true);
    expect(activity.find((a) => a.module === "Lottery")!.text).toBe("Lottery round #1 opened at 0.01 ETH a ticket");
    expect(activity.find((a) => a.module === "Predictions")!.text).toBe("Prediction market #1 opened at a 1 ETH floor");
    expect(activity.find((a) => a.text.startsWith("Collection offer"))).toMatchObject({ text: "Collection offer: 3 × 1 ETH", actor: owner });
    expect(await readActivity(client, d, d.owner)).toEqual([]);
    expect(overview.totalPoints).toBe(0n);
    expect(overview.pointsFrozen).toBe(false);
    expect(overview.userPoints).toBe(0n);
    expect(overview.userPendingPoints).toBe(0n);
    // Without a connected user there is no points read.
    expect((await readOverview(client, d, collection)).userPoints).toBeUndefined();

    // A collection the protocol has never seen renders rather than throws.
    const unknown = await readOverview(client, d, "0x000000000000000000000000000000000000dEaD");
    expect(unknown.floorBid).toMatchObject({ active: false, currentBid: 0n, curvePrice: 0n, minBid: 0n, isFillable: false, budget: 0n });
    expect(bidState(unknown.floorBid, now)).toBe("inactive");
    expect(unknown.marketplaceSupported).toBe(false);
    expect(unknown.pushFloor).toMatchObject({ ok: false, errorName: "NoPrice" });

    const { offers, source, feeBps } = await readOpenOffers(client, d);
    expect(source).toBe("logs");
    expect(feeBps).toBe(200n);
    expect(offers.map((o) => o.id)).toEqual([2n, 1n]);
    expect(offers[1]).toMatchObject({ collectionWide: true, price: ETH, remaining: 3, filled: 0, offerer: owner });
    expect(offers[0]).toMatchObject({ collectionWide: false, tokenId: 7n, price: 2n * ETH, remaining: 1 });
    expect(offers[0].collection.toLowerCase()).toBe(collection.toLowerCase());

    // The seeded market: 2 hours of betting, settled a day after it opened, at the contract's
    // default 3% fee and 2% dead band.
    const { markets, marketCount, minBet, feeBps: marketFee, deadBandBps, maxStartPriceAge, minBettingPeriod, maxDuration } = await readMarkets(client, d, owner);
    expect({ marketCount, minBet, marketFee, deadBandBps, maxStartPriceAge, minBettingPeriod, maxDuration }).toEqual({
      marketCount: 1n,
      minBet: parseEther("0.001"),
      marketFee: 300n,
      deadBandBps: 200n,
      maxStartPriceAge: 3_600,
      minBettingPeriod: 600,
      maxDuration: 30 * DAY,
    });
    expect(markets[0]).toMatchObject({
      id: 1n,
      startPrice: ETH,
      higherPool: parseEther("0.5"),
      lowerPool: parseEther("0.3"),
      outcome: Outcome.Pending,
      feeBps: 300n, // fixed per market when it was created
      deadBandBps: 200n,
      stake: { higher: parseEther("0.5"), lower: parseEther("0.3") },
    });
    expect(markets[0].resolveTime - markets[0].closeTime).toBe(22 * 3_600);
    expect(MARKET_DURATION_PER_BETTING).toBe(10);
    // 1 + 0.3/0.5 * 97% and 1 + 0.5/0.3 * 97%
    expect(impliedMultiple(markets[0].higherPool, markets[0].lowerPool, marketFee)).toBeCloseTo(1.582, 5);
    expect(impliedMultiple(markets[0].lowerPool, markets[0].higherPool, marketFee)).toBeCloseTo(2.616666, 5);
    expect(impliedMultiple(0n, ETH, marketFee)).toBeUndefined();
    expect((await readMarkets(client, d)).markets[0].stake).toBeUndefined();

    const vault = await readHoldings(client, d);
    expect(vault).toMatchObject({ holdings: [], holdingCount: 0n, governanceWindow: 30 * DAY, auctionStartMultiple: 16, auctionHalfLife: DAY, auctionRestartDwell: DAY });
    expect(vault.owner).toBe(owner);
    expect(await vaultRead("minReserveOf", collection)).toBe(0n);

    expect(await readRaffles(client, d)).toEqual({ raffles: [], raffleCount: 0n, totalPoints: 0n, nextDrawAt: 0, drawInFlight: false, minPointsToDraw: 0n });

    // The seed approved the marketplace for all of the owner's tokens.
    expect(await readTokenState(client, collection, 1n, d.marketplace)).toEqual({ owner, approved: true });
    const missing = await readTokenState(client, collection, 999n, d.marketplace).catch(decodeError);
    expect(missing).toMatchObject({ name: "ERC721NonexistentToken", message: "Token #999 does not exist." });
  });

  it("marketplace: approve, accept with minProceeds, points credited once per fee, make and cancel offers", async () => {
    for (const tokenId of [1n, 2n, 3n, 4n]) await send(owner, raw(collection, erc721Abi, "transferFrom", [owner, seller, tokenId]));

    // Same steps as the Accept button.
    const acceptLikeTheUi = async (offerId: bigint, tokenId: bigint) => {
      const offer = (await readOpenOffers(client, d)).offers.find((o) => o.id === offerId)!;
      const token = await readTokenState(client, offer.collection, tokenId, d.marketplace);
      expect(token.owner).toBe(seller);
      if (!token.approved) await send(seller, approveCall(offer.collection, d.marketplace, tokenId));
      const expected = await readExpectedProceeds(client, d, offer.collection, tokenId, offer.price);
      // 2% fee, and the mock collection has no royalty receiver.
      expect(expected).toEqual({ fee: parseEther("0.02"), royalty: 0n, proceeds: parseEther("0.98") });
      const before = await balanceOf(seller);
      const receipt = await send(seller, acceptOfferCall(d, offerId, tokenId, withSlippage(expected.proceeds, 0n)));
      expect(await gained(seller, before, receipt)).toBe(expected.proceeds);
    };

    expect((await readTokenState(client, collection, 1n, d.marketplace)).approved).toBe(false);
    await acceptLikeTheUi(1n, 1n);
    expect(await ownerOf(1n)).toBe(owner); // the offerer
    await acceptLikeTheUi(1n, 2n);

    let { offers } = await readOpenOffers(client, d);
    expect(offers.find((o) => o.id === 1n)).toMatchObject({ remaining: 1, filled: 2 });

    // Each 0.02 ETH fee reaches the budget whole (no project share) and is credited once: half to
    // the seller, half to the offerer, at 2,500 points per ETH. Twice. Points are pending until
    // activated; anyone may activate them for anyone (the Activate button sends this for yourself).
    expect(saleSplit(ETH, 200n, 0n, 0)).toEqual({ seller: parseEther("0.98"), royalty: 0n, fee: parseEther("0.02"), toProject: 0n, toBudget: parseEther("0.02") });
    expect(pts(parseEther("0.01"))).toBe(parseEther("25"));
    let overview = await readOverview(client, d, collection, seller);
    expect(overview).toMatchObject({ userPoints: 0n, userPendingPoints: parseEther("50"), totalPoints: 0n });
    expect(await readPoints(client, d, seller)).toEqual({ active: 0n, pending: parseEther("50") });
    await send(buyer, flushPointsCall(d, seller));
    overview = await readOverview(client, d, collection, seller);
    expect(overview).toMatchObject({ userPoints: parseEther("50"), userPendingPoints: 0n, totalPoints: parseEther("50") });
    expect(await readPoints(client, d, owner)).toEqual({ active: 0n, pending: parseEther("50") });
    expect(overview.floorBid.budget).toBe(parseEther("5.04"));
    expect(overview.salesFloor).toMatchObject({ ok: false, reason: "Not enough recent sales: 2 usable, 3 required." });

    // Reverts are decoded before a wallet would be asked to sign.
    expect(await revertOf(seller, acceptOfferCall(d, 2n, 3n, 0n))).toMatchObject({ name: "WrongToken" });
    expect(await revertOf(seller, acceptOfferCall(d, 1n, 3n, 10n * ETH))).toMatchObject({
      name: "ProceedsTooLow",
      message: "Proceeds would be 0.98 ETH, below your minimum of 10 ETH (the fee or royalty changed).",
    });
    expect(await revertOf(seller, cancelOfferCall(d, 1n))).toMatchObject({ name: "NotOfferer" });
    expect(await revertOf(seller, cancelOfferCall(d, 99n))).toMatchObject({ name: "OfferInactive" });

    const expiry = BigInt((await readChainTime(client)) + DAY);
    await send(seller, makeOfferCall(d, collection, 8n, expiry, parseEther("0.5")));
    await send(seller, makeCollectionOfferCall(d, collection, 2n, expiry, parseEther("0.25")));
    ({ offers } = await readOpenOffers(client, d));
    expect(offers.map((o) => o.id)).toEqual([4n, 3n, 2n, 1n]);
    expect(offers[0]).toMatchObject({ collectionWide: true, price: parseEther("0.25"), remaining: 2, offerer: seller });
    expect(offers[1]).toMatchObject({ collectionWide: false, tokenId: 8n, price: parseEther("0.5"), expiry: Number(expiry) });
    expect(await revertOf(seller, makeOfferCall(d, collection, 8n, 1n, ETH))).toMatchObject({ name: "InvalidExpiry" });

    // Cancelling pays the escrow back.
    let before = await balanceOf(seller);
    expect(await gained(seller, before, await send(seller, cancelOfferCall(d, 3n)))).toBe(parseEther("0.5"));
    before = await balanceOf(seller);
    expect(await gained(seller, before, await send(seller, cancelOfferCall(d, 4n)))).toBe(parseEther("0.5"));
    expect((await readOpenOffers(client, d)).offers.map((o) => o.id)).toEqual([2n, 1n]);
  });

  it("floor bid: sell at the curve; a thin budget limits the bid, moves the base and restarts the curve", async () => {
    const before = await readFloorBid(client, d, collection);
    expect(await revertOf(seller, sellCall(d, collection, 3n, 100n * ETH))).toMatchObject({ name: "BidBelowMinimum" });
    // The engine is not approved yet. The NFT's own error bubbles up through the engine and is
    // only decodable because the merged error ABI is appended to the call.
    const nested = await revertOf(seller, sellCall(d, collection, 3n, 0n));
    expect(nested).toMatchObject({
      name: "ERC721InsufficientApproval",
      message: "The contract is not approved to transfer this token.",
    });

    // Same steps as the Sell button.
    const token = await readTokenState(client, collection, 3n, d.buybackEngine);
    expect(token).toEqual({ owner: seller, approved: false });
    await send(seller, approveCall(collection, d.buybackEngine, 3n));
    expect((await readTokenState(client, collection, 3n, d.buybackEngine)).approved).toBe(true);
    const { currentBid } = await readFloorBid(client, d, collection);
    const balance = await balanceOf(seller);
    const receipt = await send(seller, sellCall(d, collection, 3n, withSlippage(currentBid, 100n)));
    const paid = await gained(seller, balance, receipt);
    const soldAt = await timeOf(receipt);
    // Paid the curve at the block of the sale, to the wei: the 5.04 ETH budget covers it.
    expect(paid).toBe(parseEther("0.9") + (parseEther("0.9") * 1_000n * BigInt(soldAt - before.lastReset)) / (BPS * BigInt(DAY)));
    expect(paid).toBe(bidAt(before, soldAt));

    const after = await readFloorBid(client, d, collection);
    expect(after.budget).toBe(before.budget - paid);
    // The sale is above the old base, so it is the anchor: the next climb starts one 5% step below it.
    expect(after.basePrice).toBe((paid * 9_500n) / 10_000n);
    expect(after.basePrice).toBe(baseAfterFill(paid, before.basePrice, before.stepDownBps));
    expect(after.lastReset).toBe(soldAt);
    expect(after.curvePrice).toBe(after.basePrice);
    expect(after.currentBid).toBe(after.basePrice);
    // the minimum bid follows the base: a tenth of it (`minBidBpsOf`, 1000 by default)
    expect(after.minBid).toBe(after.basePrice / 10n);
    expect(await client.readContract({ address: d.buybackEngine, abi: buybackEngineAbi, functionName: "minBidBpsOf", args: [collection] })).toBe(1_000n);
    expect(await ownerOf(3n)).toBe(d.vault);

    const overview = await readOverview(client, d, collection, seller);
    expect(overview.holdingCount).toBe(1n);
    expect(overview.collectionHoldingsInVault).toBe(1);
    // Third floor-type sale: the lower median of [bid, 1, 1] ETH.
    expect(overview.salesFloor).toMatchObject({ ok: true, price: ETH, updatedAt: soldAt });
    expect((await readActivity(client, d, collection))[0]).toMatchObject({
      module: "Floor bid",
      route: "/vault/holdings",
      actor: seller,
      text: expect.stringMatching(/^Bought token #3 for 0\.9\d* ETH, now vault holding #1$/),
    });

    const { holdings } = await readHoldings(client, d);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      id: 1n,
      tokenId: 3n,
      purchasePrice: paid,
      acquiredAt: soldAt,
      status: HoldingStatus.Locked,
      canUnlock: false,
      auction: undefined,
    });
    expect(holdings[0].lockedUntil - holdings[0].acquiredAt).toBe(180 * DAY);
    expect(await revertOf(seller, unlockCall(d, 1n))).toMatchObject({ name: "UnlockConditionsNotMet" });

    // --- the bid when the budget cannot pay the curve (on a snapshot of its own)
    await isolated(async () => {
      const engine = (functionName: string, args: readonly unknown[]) => raw(d.buybackEngine, buybackEngineAbi, functionName, args);
      const donate = (amount: bigint) => send(buyer, raw(d.treasury, treasuryAbi, "deposit", [collection], amount));
      // The owner sets the curve far above what the budget holds.
      let configured = await timeOf(await send(owner, engine("configureBid", [collection, 10n * ETH, 20n * ETH, 1_000, 500, true])));
      let bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({
        basePrice: 10n * ETH,
        maxPrice: 20n * ETH,
        lastReset: configured,
        curvePrice: 10n * ETH,
        currentBid: after.budget, // min(curve, budget)
        budget: after.budget,
        isFillable: true,
        minBid: ETH, // a tenth of the new base
      });
      expect(bidState(bid, configured)).toBe("budget");
      expect(payableBid(bidAt(bid, configured), bid.budget)).toBe(bid.currentBid);

      // A sale is paid the whole budget. It is below the base less three steps (8.5 ETH), so that is
      // the anchor: the new base is 10 * 85% * 95%.
      await send(seller, approveCall(collection, d.buybackEngine, 4n));
      const sellerBefore = await balanceOf(seller);
      const thin = await send(seller, sellCall(d, collection, 4n, withSlippage(bid.currentBid, 100n)));
      expect(await gained(seller, sellerBefore, thin)).toBe(after.budget);
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ budget: 0n, currentBid: 0n, isFillable: false, basePrice: parseEther("8.075"), curvePrice: parseEther("8.075"), minBid: parseEther("0.8075"), lastReset: await timeOf(thin) });
      expect(bid.basePrice).toBe(baseAfterFill(after.budget, 10n * ETH, 500));
      expect(bidState(bid, bid.lastReset)).toBe("empty");
      expect((await readHoldings(client, d)).holdings[0]).toMatchObject({ id: 2n, tokenId: 4n, purchasePrice: after.budget });
      // With nothing in the budget there is no bid (the owner's tokens are approved by the seed).
      expect(await revertOf(owner, sellCall(d, collection, 5n, 0n))).toMatchObject({
        name: "NothingToBid",
        message: "There is nothing to bid with: the collection's buyback budget holds less than the minimum bid.",
      });

      // Money arrives: the budget could not cover the curve, so the curve restarts. 0.05 ETH is
      // below the 0.8075 ETH minimum bid: still nothing to sell into.
      let restarted = await timeOf(await donate(parseEther("0.05")));
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ budget: parseEther("0.05"), currentBid: parseEther("0.05"), curvePrice: parseEther("8.075"), basePrice: parseEther("8.075"), lastReset: restarted, isFillable: false });
      expect(bidState(bid, restarted)).toBe("empty");
      expect(await revertOf(owner, sellCall(d, collection, 5n, 0n))).toMatchObject({ name: "NothingToBid" });

      // The guardian (or the owner) can lower a bid, never raise it.
      await send(owner, engine("setGuardian", [buyer]));
      expect(await revertOf(seller, engine("lowerBid", [collection, parseEther("0.2"), 20n * ETH, true]))).toMatchObject({ name: "NotGuardian" });
      expect(await revertOf(buyer, engine("lowerBid", [collection, 9n * ETH, 20n * ETH, true]))).toMatchObject({ name: "InvalidConfig" });
      configured = await timeOf(await send(buyer, engine("lowerBid", [collection, parseEther("0.2"), 20n * ETH, true])));
      bid = await readFloorBid(client, d, collection);
      // The minimum bid came down with the base, to 0.02 ETH: the 0.05 ETH in the budget is a bid again.
      expect(bid).toMatchObject({ basePrice: parseEther("0.2"), maxPrice: 20n * ETH, lastReset: configured, curvePrice: parseEther("0.2"), currentBid: parseEther("0.05"), minBid: parseEther("0.02"), isFillable: true, active: true });
      expect(bidState(bid, configured)).toBe("budget");
      // The owner can set the share: at 30% of the base the minimum is 0.06 ETH and 0.05 is no bid.
      await send(owner, engine("setMinBid", [collection, 3_000n]));
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ minBid: parseEther("0.06"), currentBid: parseEther("0.05"), isFillable: false });
      expect(bidState(bid, configured)).toBe("empty");
      await send(owner, engine("setMinBid", [collection, 1_000n]));

      // 0.25 ETH in the budget covers the 0.2 ETH curve again (the arrival restarts it once more).
      restarted = await timeOf(await donate(parseEther("0.2")));
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ budget: parseEther("0.25"), basePrice: parseEther("0.2"), lastReset: restarted, curvePrice: parseEther("0.2"), currentBid: parseEther("0.2"), isFillable: true });
      expect(bidState(bid, restarted)).toBe("rising");
      // Five days at +10% a day take the curve to 0.3 ETH; the budget pays 0.25.
      await warpTo(restarted + 5 * DAY);
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ curvePrice: parseEther("0.3"), currentBid: parseEther("0.25"), isFillable: true });
      expect(bidAt(bid, restarted + 5 * DAY)).toBe(parseEther("0.3"));
      expect(bidState(bid, restarted + 5 * DAY)).toBe("budget");
      // More money: the bid until now was the budget, which is above the base, so the curve
      // restarts from there. Money arriving never lowers the bid.
      restarted = await timeOf(await donate(ETH));
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ budget: parseEther("1.25"), basePrice: parseEther("0.25"), lastReset: restarted, curvePrice: parseEther("0.25"), currentBid: parseEther("0.25"), isFillable: true });
      // A budget that covers the curve grows without a restart.
      await donate(ETH);
      expect((await readFloorBid(client, d, collection)).lastReset).toBe(restarted);
      // A paused bid reads as inactive.
      await send(buyer, engine("lowerBid", [collection, parseEther("0.25"), 20n * ETH, false]));
      bid = await readFloorBid(client, d, collection);
      expect(bid).toMatchObject({ active: false, currentBid: 0n, isFillable: false });
      expect(await revertOf(owner, sellCall(d, collection, 5n, 0n))).toMatchObject({ name: "InactiveCollection" });
    });
    expect(await readFloorBid(client, d, collection)).toMatchObject({ basePrice: after.basePrice, lastReset: soldAt, budget: after.budget });

    // --- why the app sends more gas than the node's estimate (lib/gas.ts)
    // A deposit is estimated while the budget still covers the curve. By the time it is mined the
    // curve has passed the budget, so the Treasury's notice restarts it, which costs more gas.
    for (const withMargin of [false, true]) {
      await isolated(async () => {
        // a base from which the curve needs five minutes to pass the budget
        const base = after.budget - (after.budget * 1_000n * 300n) / (BPS * BigInt(DAY));
        const configured = await timeOf(await send(owner, raw(d.buybackEngine, buybackEngineAbi, "configureBid", [collection, base, 20n * ETH, 1_000, 500, true])));
        expect((await readFloorBid(client, d, collection)).curvePrice).toBeLessThan(after.budget);
        const donation = { ...raw(d.treasury, treasuryAbi, "deposit", [collection], parseEther("0.01")), account: buyer };
        const estimate = await client.estimateContractGas(donation);
        await client.setNextBlockTimestamp({ timestamp: BigInt(configured + 600) });
        const hash = await client.writeContract({ ...donation, gas: withMargin ? gasLimitFor(estimate) : estimate });
        const receipt = await client.waitForTransactionReceipt({ hash });
        const bid = await readFloorBid(client, d, collection);
        if (withMargin) {
          expect(receipt.status).toBe("success");
          expect(receipt.gasUsed).toBeGreaterThan(estimate);
          expect(bid).toMatchObject({ lastReset: configured + 600, budget: after.budget + parseEther("0.01") });
        } else {
          // with the bare estimate the deposit fails, or goes through without the restart
          expect(receipt.status === "reverted" || bid.lastReset === configured).toBe(true);
        }
      });
    }

    // The owner can make the engine pause between fills; the tab shows it and blocks the Sell button.
    expect(after).toMatchObject({ fillCooldown: 0, nextFillAt: holdings[0].acquiredAt });
    // At +10% a day a 5% step is regrown in 5/95 of ten days: a longer pause is refused.
    expect(await revertOf(owner, raw(d.buybackEngine, buybackEngineAbi, "setFillCooldown", [collection, 45_474n]))).toMatchObject({ name: "CooldownTooLong", args: [45_473n] });
    await send(owner, raw(d.buybackEngine, buybackEngineAbi, "setFillCooldown", [collection, 3_600n]));
    const cooling = await readFloorBid(client, d, collection);
    expect(cooling).toMatchObject({ fillCooldown: 3_600, nextFillAt: holdings[0].acquiredAt + 3_600, isFillable: false });
    expect(bidState(cooling, soldAt + 1)).toBe("cooldown");
    const paused = await revertOf(seller, sellCall(d, collection, 4n, 0n));
    expect(paused.name).toBe("FillCooldown");
    expect(paused.args).toEqual([BigInt(cooling.nextFillAt)]);
    expect(paused.message).toMatch(/^The floor bid is pausing between fills; the next sale is possible from /);
  });

  it("licences: tiers, request with exact payment, one licence per tier in force", async () => {
    // Holding 1 (token 3) is locked in the vault after the floor-bid sale.
    let licensing = await readLicensing(client, d, seller);
    expect(licensing.maxScopeLength).toBe(280);
    expect(licensing.holdings).toHaveLength(1);
    expect(licensing.holdings[0]).toMatchObject({
      holding: { id: 1n, tokenId: 3n, status: HoldingStatus.Locked },
      tiers: [
        { tier: 0, price: 0n, duration: 30 * DAY },
        { tier: 1, price: parseEther("0.1"), duration: 90 * DAY },
        { tier: 2, price: parseEther("0.5"), duration: 365 * DAY },
      ],
      licenses: [],
      banned: false,
    });
    const anonymous = await readLicensing(client, d);
    expect(anonymous.holdings[0].licenses).toEqual([]);
    expect(anonymous.holdings[0].banned).toBeUndefined();

    const tier1 = licensing.holdings[0].tiers[1];
    expect(await revertOf(seller, requestLicenseCall(d, 1n, 1, "prints", parseEther("0.05")))).toMatchObject({
      name: "WrongPayment",
      message: "The payment must be exactly 0.1 ETH.",
    });
    expect(await revertOf(seller, requestLicenseCall(d, 1n, 5, "prints", 0n))).toMatchObject({ name: "TierInactive" });
    expect(await revertOf(seller, requestLicenseCall(d, 99n, 1, "prints", tier1.price))).toMatchObject({ name: "NotInVault" });
    expect(await revertOf(seller, requestLicenseCall(d, 1n, 1, "x".repeat(281), tier1.price))).toMatchObject({ name: "ScopeTooLong" });

    // Same call as the request form: the tier's price as the value, the scope as typed.
    const budget = await budgetOf();
    const issued = await timeOf(await send(seller, requestLicenseCall(d, 1n, tier1.tier, "x".repeat(280), tier1.price)));
    licensing = await readLicensing(client, d, seller);
    expect(licensing.holdings[0].licenses).toEqual([{ tier: 1, end: issued + 90 * DAY }]);
    // The fee went to the collection's buyback budget (no project share is set).
    expect(await budgetOf()).toBe(budget + parseEther("0.1"));

    // Licences are per tier: a free tier 0 licence bought afterwards stands next to the tier 1 one.
    const second = await timeOf(await send(seller, requestLicenseCall(d, 1n, 0, "", 0n)));
    expect((await readLicensing(client, d, seller)).holdings[0].licenses).toEqual([
      { tier: 0, end: second + 30 * DAY },
      { tier: 1, end: issued + 90 * DAY },
    ]);
    // Buying the same tier again replaces that tier's licence (it runs longer) and leaves the other.
    const third = await timeOf(await send(seller, requestLicenseCall(d, 1n, 0, "again", 0n)));
    expect((await readLicensing(client, d, seller)).holdings[0].licenses).toEqual([
      { tier: 0, end: third + 30 * DAY },
      { tier: 1, end: issued + 90 * DAY },
    ]);
    // Licences are per licensee.
    expect((await readLicensing(client, d, buyer)).holdings[0].licenses).toEqual([]);
    await send(buyer, requestLicenseCall(d, 1n, 0, "personal use", 0n));
    expect((await readLicensing(client, d, buyer)).holdings[0].licenses).toMatchObject([{ tier: 0 }]);
  });

  it("ticket raffles: buy, sell-out draw and settle; refund and reclaim; cancel; minimum pot per raffle; abort timing", async () => {
    // --- the seeded raffle: token 10, 0.05 ETH a ticket, 5 to 40 tickets, the owner holds 2
    let state = await readTicketRaffles(client, d, owner, collection);
    expect(state).toMatchObject({
      raffleCount: 1n,
      minPot: parseEther("0.05"),
      feeBps: 500n,
      minDuration: 3_600,
      maxDuration: 30 * DAY,
      drawTimeout: DAY,
      abortDelay: 7 * DAY,
      collectionSupported: true,
      userOwed: 0n,
    });
    expect(state.raffles).toHaveLength(1);
    expect(state.raffles[0]).toMatchObject({
      id: 1n,
      creator: owner,
      tokenId: 10n,
      ticketPrice: parseEther("0.05"),
      minTickets: 5,
      maxTickets: 40,
      ticketsSold: 2,
      status: TicketRaffleStatus.Open,
      feeBps: 500n,
      minPot: parseEther("0.05"),
      nftReturned: false,
      requestId: undefined,
      userPaid: parseEther("0.1"),
      userTickets: 2,
    });
    expect(await ownerOf(10n)).toBe(d.ticketRaffle);
    expect(ticketRaffleWouldRefund(state.raffles[0], state.raffles[0].endTime - 1, state.abortDelay)).toBe(true); // 2 sold, 5 needed
    const anonymous = await readTicketRaffles(client, d);
    expect(anonymous.raffles[0].userTickets).toBeUndefined();
    expect(anonymous.collectionSupported).toBeUndefined();
    expect((await readTicketRaffles(client, d, buyer, d.owner)).collectionSupported).toBe(false);

    const price = state.raffles[0].ticketPrice;
    expect(await revertOf(buyer, closeTicketRaffleCall(d, 1n))).toMatchObject({ name: "StillOpen" });
    expect(await revertOf(buyer, cancelTicketRaffleCall(d, 1n))).toMatchObject({ name: "NotCreator" });
    expect(await revertOf(owner, cancelTicketRaffleCall(d, 1n))).toMatchObject({ name: "TicketsAlreadySold" });
    expect(await revertOf(buyer, buyTicketsCall(d, 1n, 39, price))).toMatchObject({
      name: "SoldOut",
      message: "Only 38 ticket(s) are left (and at least one must be bought).",
    });
    expect(await revertOf(buyer, settleTicketRaffleCall(d, 1n))).toMatchObject({ name: "WrongStatus" });
    expect(await revertOf(buyer, refundTicketsCall(d, 1n))).toMatchObject({ name: "WrongStatus" });
    const tooEarly = await revertOf(buyer, abortTicketRaffleCall(d, 1n));
    expect(tooEarly.name).toBe("TooEarly");
    expect(tooEarly.args).toEqual([BigInt(state.raffles[0].endTime + 7 * DAY)]);
    expect(abortableAt(state.raffles[0], "open", state)).toBe(state.raffles[0].endTime + 7 * DAY);

    await send(buyer, buyTicketsCall(d, 1n, 3, price));
    state = await readTicketRaffles(client, d, buyer, collection);
    expect(state.raffles[0]).toMatchObject({ ticketsSold: 5, userPaid: parseEther("0.15"), userTickets: 3 });
    expect(ticketRaffleWouldRefund(state.raffles[0], state.raffles[0].endTime - 1, state.abortDelay)).toBe(false);
    // closed a week or more after its end, a raffle is refunded whatever it sold
    expect(ticketRaffleWouldRefund(state.raffles[0], state.raffles[0].endTime + 7 * DAY, state.abortDelay)).toBe(true);

    // --- a raffle that ends below its minimum: refunds, and the creator reclaims the NFT
    for (const tokenId of [8n, 9n]) await send(owner, raw(collection, erc721Abi, "transferFrom", [owner, seller, tokenId]));
    // Same steps as the Create raffle form.
    const token = await readTokenState(client, collection, 8n, d.ticketRaffle);
    expect(token).toEqual({ owner: seller, approved: false });
    expect(await revertOf(seller, createTicketRaffleCall(d, collection, 8n, parseEther("0.01"), 3, 5, 60n))).toMatchObject({ name: "InvalidParams" });
    expect(await revertOf(buyer, createTicketRaffleCall(d, collection, 8n, parseEther("0.01"), 3, 5, 3_600n))).toMatchObject({ name: "NotTokenOwner" });
    await send(seller, approveCall(collection, d.ticketRaffle, 8n));
    const created = await timeOf(await send(seller, createTicketRaffleCall(d, collection, 8n, parseEther("0.01"), 3, 5, 3_600n)));
    state = await readTicketRaffles(client, d, seller, collection);
    expect(state.raffleCount).toBe(2n);
    expect(state.raffles[0]).toMatchObject({
      id: 2n,
      creator: seller,
      tokenId: 8n,
      ticketPrice: parseEther("0.01"),
      minTickets: 3,
      maxTickets: 5,
      ticketsSold: 0,
      endTime: created + 3_600,
      status: TicketRaffleStatus.Open,
      userTickets: 0,
    });
    expect(await ownerOf(8n)).toBe(d.ticketRaffle);
    await send(buyer, buyTicketsCall(d, 2n, 1, parseEther("0.01")));

    // --- cancel: only while no ticket is sold
    await send(seller, approveCall(collection, d.ticketRaffle, 9n));
    await send(seller, createTicketRaffleCall(d, collection, 9n, ETH, 1, 2, 3_600n));
    await send(seller, cancelTicketRaffleCall(d, 3n));
    state = await readTicketRaffles(client, d, seller, collection);
    expect(state.raffles[0]).toMatchObject({ id: 3n, status: TicketRaffleStatus.Cancelled, nftReturned: true });
    expect(await ownerOf(9n)).toBe(seller);

    // Raffle 2 runs out with 1 of 3 tickets sold.
    await warpTo(created + 3_600);
    expect(await revertOf(buyer, buyTicketsCall(d, 2n, 1, parseEther("0.01")))).toMatchObject({ name: "SalesClosed" });
    await send(buyer, closeTicketRaffleCall(d, 2n)); // anyone may close
    state = await readTicketRaffles(client, d, buyer, collection);
    const refunding = state.raffles.find((r) => r.id === 2n)!;
    expect(refunding).toMatchObject({ status: TicketRaffleStatus.Refunding, nftReturned: false, userPaid: parseEther("0.01"), userTickets: 1 });
    let balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, refundTicketsCall(d, 2n)))).toBe(parseEther("0.01"));
    expect(await revertOf(buyer, refundTicketsCall(d, 2n))).toMatchObject({ name: "NothingOwed" });
    expect(await revertOf(buyer, reclaimTicketRaffleCall(d, 2n))).toMatchObject({ name: "NotCreator" });
    await send(seller, reclaimTicketRaffleCall(d, 2n));
    expect(await ownerOf(8n)).toBe(seller);
    expect(await revertOf(seller, reclaimTicketRaffleCall(d, 2n))).toMatchObject({ name: "AlreadyReclaimed" });
    state = await readTicketRaffles(client, d, buyer, collection);
    expect(state.raffles.find((r) => r.id === 2n)).toMatchObject({ nftReturned: true, userPaid: 0n, userTickets: 0 });

    // --- raffle 1 sells out, which allows closing before its end time: draw, settle, withdraw
    await send(buyer, buyTicketsCall(d, 1n, 35, price));
    const closed = await timeOf(await send(seller, closeTicketRaffleCall(d, 1n)));
    state = await readTicketRaffles(client, d, buyer, collection);
    let drawn = state.raffles.find((r) => r.id === 1n)!;
    // a raffle that sold out early has ended now: its abort clock runs from the close
    expect(drawn).toMatchObject({ status: TicketRaffleStatus.Drawing, ticketsSold: 40, userTickets: 38, endTime: closed, requestedAt: closed });
    expect(drawn.requestId).toBe(1n); // the ticket raffle has its own mock provider on anvil
    expect(await revertOf(buyer, resetTicketDrawCall(d, 1n))).toMatchObject({ name: "TooEarly", args: [BigInt(closed + DAY)] });
    // Same call as the "Local only: draw with mock randomness" button. Tickets 0-1 are the owner's,
    // 2-39 the buyer's; ticket 7 wins.
    await send(seller, mockFulfillCall(d.ticketRaffleRandomness, drawn.requestId!, 40n * 1_000n + 7n));
    drawn = (await readTicketRaffles(client, d, buyer, collection)).raffles.find((r) => r.id === 1n)!;
    expect(drawn).toMatchObject({ status: TicketRaffleStatus.Won, winner: buyer, requestId: undefined });

    expect(await readDrawProof(client, d, "ticketRaffle", 1n)).toMatchObject({ ticketsSold: 40, ticket: 7n, winner: buyer, ticketHolder: buyer });
    expect(await readDrawProof(client, d, "ticketRaffle", 2n)).toBeUndefined();
    const budget = await budgetOf();
    await send(seller, settleTicketRaffleCall(d, 1n)); // anyone may settle
    expect(await ownerOf(10n)).toBe(buyer);
    // The 2 ETH pot: 5% to the buyback budget, the rest to the creator.
    expect(await budgetOf()).toBe(budget + parseEther("0.1"));
    state = await readTicketRaffles(client, d, owner, collection);
    expect(state.raffles.find((r) => r.id === 1n)).toMatchObject({ status: TicketRaffleStatus.Settled, winner: buyer });
    expect(state.userOwed).toBe(parseEther("1.9"));
    balance = await balanceOf(owner);
    expect(await gained(owner, balance, await send(owner, withdrawTicketRaffleCall(d)))).toBe(parseEther("1.9"));
    expect((await readTicketRaffles(client, d, owner)).userOwed).toBe(0n);
    expect(await revertOf(owner, withdrawTicketRaffleCall(d))).toMatchObject({ name: "NothingOwed" });

    // --- the minimum pot is fixed per raffle when it is created
    const setParams = (feeBps: bigint, minPot: bigint) => send(owner, raw(d.ticketRaffle, ticketRaffleAbi, "setParams", [feeBps, minPot]));
    await setParams(300n, ETH);
    await send(seller, approveCall(collection, d.ticketRaffle, 9n));
    await send(seller, createTicketRaffleCall(d, collection, 9n, parseEther("0.05"), 1, 3, 3_600n));
    await setParams(500n, parseEther("0.05"));
    state = await readTicketRaffles(client, d, buyer, collection);
    expect(state).toMatchObject({ minPot: parseEther("0.05"), feeBps: 500n, raffleCount: 4n });
    expect(state.raffles[0]).toMatchObject({ id: 4n, minPot: ETH, feeBps: 300n });
    expect(state.raffles.find((r) => r.id === 1n)).toMatchObject({ minPot: parseEther("0.05"), feeBps: 500n });
    await send(buyer, buyTicketsCall(d, 4n, 3, parseEther("0.05")));
    const soldOut = (await readTicketRaffles(client, d, buyer, collection)).raffles[0];
    // sold out and above its minimum of tickets, but the 0.15 ETH pot is below its own 1 ETH minimum
    expect(ticketRaffleWouldRefund(soldOut, soldOut.endTime - 1, state.abortDelay)).toBe(true);
    expect(ticketRaffleWouldRefund({ ...soldOut, minPot: state.minPot }, soldOut.endTime - 1, state.abortDelay)).toBe(false);
    const closedEarly = await timeOf(await send(buyer, closeTicketRaffleCall(d, 4n)));
    expect((await readTicketRaffles(client, d, buyer, collection)).raffles[0]).toMatchObject({ status: TicketRaffleStatus.Refunding, endTime: closedEarly, requestId: undefined });
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, refundTicketsCall(d, 4n)))).toBe(parseEther("0.15"));
    await send(seller, reclaimTicketRaffleCall(d, 4n));

    // --- abort timing (on a snapshot of its own: it moves the clock by weeks)
    await isolated(async () => {
      const timing = { abortDelay: 7 * DAY, drawTimeout: DAY };
      const find = async (id: bigint) => (await readTicketRaffles(client, d, buyer, collection)).raffles.find((r) => r.id === id)!;
      await send(seller, approveCall(collection, d.ticketRaffle, 8n));
      await send(seller, createTicketRaffleCall(d, collection, 8n, parseEther("0.05"), 1, 3, 3_600n)); // 5: drawn late
      await send(seller, approveCall(collection, d.ticketRaffle, 9n));
      await send(seller, createTicketRaffleCall(d, collection, 9n, parseEther("0.05"), 1, 3, 3_600n)); // 6: never answered
      await send(buyer, approveCall(collection, d.ticketRaffle, 10n));
      await send(buyer, createTicketRaffleCall(d, collection, 10n, parseEther("0.05"), 1, 2, 3_600n)); // 7: won, never settled
      await send(buyer, buyTicketsCall(d, 5n, 1, parseEther("0.05")));
      await send(buyer, buyTicketsCall(d, 6n, 2, parseEther("0.05")));
      await send(seller, buyTicketsCall(d, 7n, 2, parseEther("0.05")));

      // 7 sold out: drawn at once. A winner that is never settled can be aborted a week after the draw request.
      await send(seller, closeTicketRaffleCall(d, 7n));
      await send(seller, mockFulfillCall(d.ticketRaffleRandomness, (await find(7n)).requestId!, 1n));
      const won = await find(7n);
      expect(won).toMatchObject({ status: TicketRaffleStatus.Won, winner: seller });
      expect(abortableAt(won, "won", timing)).toBe(won.requestedAt + 7 * DAY);
      expect(await revertOf(buyer, abortTicketRaffleCall(d, 7n))).toMatchObject({ name: "TooEarly", args: [BigInt(won.requestedAt + 7 * DAY)] });

      // 6 is closed at its end and its randomness never arrives: abortable a week after the end.
      const end = (await find(6n)).endTime;
      await warpTo(end);
      await send(buyer, closeTicketRaffleCall(d, 6n));
      const stuck = await find(6n);
      expect(stuck).toMatchObject({ status: TicketRaffleStatus.Drawing, requestId: 3n });
      expect(abortableAt(stuck, "drawing", timing)).toBe(end + 7 * DAY);
      expect(await revertOf(buyer, abortTicketRaffleCall(d, 6n))).toMatchObject({ name: "TooEarly", args: [BigInt(end + 7 * DAY)] });

      // 5 is closed six and a half days late: still drawn, and not abortable while its answer would be accepted.
      const lateEnd = (await find(5n)).endTime;
      await warpTo(lateEnd + 6 * DAY + DAY / 2);
      expect(ticketRaffleWouldRefund(await find(5n), await readChainTime(client), 7 * DAY)).toBe(false);
      await send(buyer, closeTicketRaffleCall(d, 5n));
      const late = await find(5n);
      expect(late.status).toBe(TicketRaffleStatus.Drawing);
      expect(late.requestedAt).toBeGreaterThan(lateEnd + 6 * DAY);
      expect(abortableAt(late, "drawing", timing)).toBe(late.requestedAt + DAY);

      await warpTo(end + 7 * DAY);
      expect(await revertOf(buyer, abortTicketRaffleCall(d, 5n))).toMatchObject({ name: "TooEarly", args: [BigInt(late.requestedAt + DAY)] });
      await send(other, abortTicketRaffleCall(d, 6n)); // anyone may abort
      expect(await find(6n)).toMatchObject({ status: TicketRaffleStatus.Refunding, requestId: undefined, userPaid: parseEther("0.1") });
      let before = await balanceOf(buyer);
      expect(await gained(buyer, before, await send(buyer, refundTicketsCall(d, 6n)))).toBe(parseEther("0.1"));
      await send(seller, reclaimTicketRaffleCall(d, 6n));
      // the unsettled winner is past its week too: the abort clears the winner and opens refunds
      await send(other, abortTicketRaffleCall(d, 7n));
      expect(BigInt((await find(7n)).winner)).toBe(0n);
      expect(await find(7n)).toMatchObject({ status: TicketRaffleStatus.Refunding });
      before = await balanceOf(seller);
      expect(await gained(seller, before, await send(seller, refundTicketsCall(d, 7n)))).toBe(parseEther("0.1"));
      await send(buyer, reclaimTicketRaffleCall(d, 7n));
      expect(await ownerOf(10n)).toBe(buyer);

      // Randomness that arrives after the timeout is not used: the raffle is open again, and closing
      // it now, more than a week past its end, refunds instead of drawing.
      await warpTo(late.requestedAt + DAY);
      await send(other, mockFulfillCall(d.ticketRaffleRandomness, late.requestId!, 0n));
      const reopened = await find(5n);
      expect(reopened).toMatchObject({ status: TicketRaffleStatus.Open, requestId: undefined });
      expect(BigInt(reopened.winner)).toBe(0n);
      expect(ticketRaffleWouldRefund(reopened, await readChainTime(client), 7 * DAY)).toBe(true);
      await send(other, closeTicketRaffleCall(d, 5n));
      expect((await find(5n)).status).toBe(TicketRaffleStatus.Refunding);
    });
    expect((await readTicketRaffles(client, d)).raffleCount).toBe(4n);
  });

  it("predictions: fresh start price, short betting window, per-market fee and dead band, points once per fee", async () => {
    const pm = (functionName: string, args: readonly unknown[]) => raw(d.predictionMarket, predictionMarketAbi, functionName, args);
    const push = (price: bigint) => send(owner, raw(d.pushFloorOracle, pushFloorOracleAbi, "pushFloor", [collection, price]));
    const market = async (id: bigint, user?: Address) => (await readMarkets(client, d, user)).markets.find((m) => m.id === id)!;
    expect(await revertOf(seller, placeBetCall(d, 1n, false, 1n))).toMatchObject({ name: "BetTooSmall" });
    expect(await revertOf(seller, placeBetCall(d, 9n, false, ETH))).toMatchObject({ name: "UnknownMarket" });
    expect(await revertOf(seller, resolveMarketCall(d, 1n))).toMatchObject({ name: "NotResolvable" });
    expect(await revertOf(seller, claimMarketCall(d, 1n))).toMatchObject({ name: "NotResolved" });

    // Anyone can open a market (the Create market form). Betting may last at most a tenth of it.
    expect(await revertOf(seller, createMarketCall(d, collection, 60n, 3_600n))).toMatchObject({ name: "InvalidDuration" });
    expect(await revertOf(seller, createMarketCall(d, collection, 3_600n, 7_200n))).toMatchObject({ name: "InvalidDuration" });
    expect(await revertOf(seller, createMarketCall(d, collection, 3_600n, 35_999n))).toMatchObject({ name: "InvalidDuration" });
    expect(await revertOf(seller, createMarketCall(d, d.owner, 3_600n, 36_000n))).toMatchObject({ name: "UnsupportedCollection" });
    // The start price must be at most an hour old; the seeded one is older by now.
    const pushed = await readFloor(client, d.pushFloorOracle, collection);
    expect(pushed.ok && pushed.updatedAt + 3_600 < (await readChainTime(client))).toBe(true);
    expect(await revertOf(seller, createMarketCall(d, collection, 3_600n, 36_000n))).toMatchObject({
      name: "OracleUnavailable",
      message: "The floor oracle has no fresh price. Opening a market needs a recent price; settling one needs a price published after its resolve time.",
    });
    await push(ETH);
    const opened = await timeOf(await send(seller, createMarketCall(d, collection, 3_600n, 36_000n)));
    expect((await readMarkets(client, d)).marketCount).toBe(2n);
    expect(await market(2n, seller)).toMatchObject({
      id: 2n,
      startPrice: ETH,
      closeTime: opened + 3_600,
      resolveTime: opened + 36_000,
      higherPool: 0n,
      lowerPool: 0n,
      outcome: Outcome.Pending,
      feeBps: 300n,
      deadBandBps: 200n,
      stake: { higher: 0n, lower: 0n },
    });

    // The owner changes the fee and the dead band: they apply to markets created afterwards only.
    await send(owner, pm("setParams", [500n, parseEther("0.001"), BigInt(DAY)]));
    await send(owner, pm("setMarketRules", [500n, 3_600n]));
    await send(seller, createMarketCall(d, collection, 600n, 6_000n));
    let all = await readMarkets(client, d, seller);
    expect(all).toMatchObject({ marketCount: 3n, feeBps: 500n, deadBandBps: 500n });
    expect(all.markets.map((m) => [m.id, m.feeBps, m.deadBandBps])).toEqual([
      [3n, 500n, 500n],
      [2n, 300n, 200n],
      [1n, 300n, 200n],
    ]);

    await send(seller, placeBetCall(d, 1n, false, parseEther("0.2")));
    expect(await market(1n, seller)).toMatchObject({ lowerPool: parseEther("0.5"), stake: { higher: 0n, lower: parseEther("0.2") } });
    for (const id of [2n, 3n]) {
      await send(seller, placeBetCall(d, id, true, parseEther("0.1")));
      await send(buyer, placeBetCall(d, id, false, parseEther("0.1")));
    }

    // --- market 3 (5% dead band): the price moved 3%, which is too little. Void: stakes back, no points.
    const third = await market(3n);
    await warpTo(third.closeTime);
    expect(await revertOf(seller, placeBetCall(d, 3n, true, ETH))).toMatchObject({ name: "BettingClosed" });
    expect(await revertOf(seller, resolveMarketCall(d, 3n))).toMatchObject({ name: "NotResolvable" });
    await warpTo(third.resolveTime);
    // the settlement price must have been published after the resolve time
    expect(await revertOf(seller, resolveMarketCall(d, 3n))).toMatchObject({ name: "OracleUnavailable" });
    await push(parseEther("1.03"));
    await send(buyer, resolveMarketCall(d, 3n));
    expect((await market(3n)).outcome).toBe(Outcome.Void);
    const pointsBefore = { seller: await readPoints(client, d, seller), buyer: await readPoints(client, d, buyer), owner: await readPoints(client, d, owner) };
    expect(pointsBefore).toEqual({ seller: { active: parseEther("50"), pending: 0n }, buyer: { active: 0n, pending: 0n }, owner: { active: 0n, pending: parseEther("50") } });
    let balance = await balanceOf(seller);
    expect(await gained(seller, balance, await send(seller, claimMarketCall(d, 3n)))).toBe(parseEther("0.1"));
    expect(await readPoints(client, d, seller)).toEqual(pointsBefore.seller);

    // --- market 2 (2% dead band, 3% fee): a move of exactly 2% decides it
    const second = await market(2n);
    await warpTo(second.resolveTime);
    expect(await revertOf(seller, resolveMarketCall(d, 2n))).toMatchObject({ name: "OracleUnavailable" });
    await push(parseEther("1.02"));
    await send(buyer, resolveMarketCall(d, 2n));
    expect((await market(2n)).outcome).toBe(Outcome.Higher);
    // The seller staked 0.1 on higher and wins the 0.1 ETH losing pool less the market's own 3%.
    let budget = await budgetOf();
    balance = await balanceOf(seller);
    expect(await gained(seller, balance, await send(seller, claimMarketCall(d, 2n)))).toBe(parseEther("0.197"));
    expect(await budgetOf()).toBe(budget + parseEther("0.003"));
    // The 0.003 ETH fee is credited once: half to the winner who paid it, half to the loser who funded it.
    expect((await readPoints(client, d, seller)).pending).toBe(pts(parseEther("0.0015")));
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, claimMarketCall(d, 2n)))).toBe(0n); // a losing stake claims points only
    expect((await readPoints(client, d, buyer)).pending).toBe(pts(parseEther("0.0015")));
    expect(pts(parseEther("0.0015"))).toBe(parseEther("3.75"));

    // --- market 1: past the close time betting is rejected; past the resolve time anyone can settle
    const first = await market(1n);
    expect(await revertOf(seller, placeBetCall(d, 1n, true, ETH))).toMatchObject({ name: "BettingClosed" });
    await warpTo(first.resolveTime);
    expect(await readChainTime(client)).toBe(first.resolveTime);
    await push(parseEther("1.2"));
    await send(buyer, resolveMarketCall(d, 1n));
    expect((await market(1n, owner)).outcome).toBe(Outcome.Higher);

    // The owner staked 0.5 on higher and 0.3 on lower: 0.5 back + 0.5 of the losing pool - 3% of the winnings.
    budget = await budgetOf();
    balance = await balanceOf(owner);
    expect(await gained(owner, balance, await send(owner, claimMarketCall(d, 1n)))).toBe(parseEther("0.985"));
    expect(await budgetOf()).toBe(budget + parseEther("0.015"));
    expect((await market(1n, owner)).stake).toEqual({ higher: 0n, lower: 0n });
    expect(await revertOf(owner, claimMarketCall(d, 1n))).toMatchObject({ name: "NothingToClaim" });
    // Points: half of (the 0.015 fee paid + 3% of the owner's losing 0.3) for the owner, half of 3%
    // of the losing 0.2 for the seller. Together 0.015 ETH of fee: credited once.
    expect((await readPoints(client, d, owner)).pending).toBe(parseEther("50") + pts(parseEther("0.012")));
    await send(seller, claimMarketCall(d, 1n));
    expect((await readPoints(client, d, seller)).pending).toBe(pts(parseEther("0.0015")) + pts(parseEther("0.003")));
    expect(pts(parseEther("0.012")) + pts(parseEther("0.003"))).toBe(pts(parseEther("0.015")));

    // back to the defaults for what follows
    await send(owner, pm("setParams", [300n, parseEther("0.001"), BigInt(DAY)]));
    await send(owner, pm("setMarketRules", [200n, 3_600n]));
    all = await readMarkets(client, d);
    expect(all).toMatchObject({ feeBps: 300n, deadBandBps: 200n });
    expect(all.markets[0]).toMatchObject({ id: 3n, feeBps: 500n, deadBandBps: 500n });
  });

  it("vault: unlock, auction at 16 times the reserve, restart rule, owner prices, minimum reserve, buy", async () => {
    const vault = (functionName: string, args: readonly unknown[]) => raw(d.vault, vaultAbi, functionName, args);
    await send(owner, vault("governanceUnlock", [1n]));
    // An unlocked holding keeps its licences in force but accepts no new ones.
    const unlocked = (await readLicensing(client, d, seller)).holdings[0];
    expect(unlocked).toMatchObject({ holding: { id: 1n, status: HoldingStatus.Unlocked }, licenses: [{ tier: 0 }, { tier: 1 }] });
    expect(await revertOf(seller, requestLicenseCall(d, 1n, 0, "", 0n))).toMatchObject({ name: "NotInVault" });
    let state = await readHoldings(client, d);
    expect(state.holdings[0]).toMatchObject({ status: HoldingStatus.Unlocked, canUnlock: false });
    const now = await readChainTime(client);
    expect(state.holdings[0].unlockedAt).toBe(now);
    expect(await vaultRead("unlockFloorOf", 1n)).toBe(0n); // a governance unlock records no floor

    // Within the governance window only the owner may start the auction.
    const blocked = await revertOf(seller, startAuctionCall(d, 1n));
    expect(blocked.name).toBe("GovernanceWindowOpen");
    expect(blocked.args).toEqual([BigInt(now + 30 * DAY)]);
    expect(await revertOf(buyer, buyCall(d, 1n, ETH))).toMatchObject({ name: "WrongStatus" });

    const started = await timeOf(await send(owner, startAuctionCall(d, 1n)));
    state = await readHoldings(client, d);
    const holding = state.holdings[0];
    expect(holding.status).toBe(HoldingStatus.Auction);
    // The reserve is the highest of the 1 ETH sales floor, 130% of the purchase price (~1.17 ETH)
    // and the collection's minimum reserve (none).
    const reserve = (holding.purchasePrice * 13_000n) / 10_000n;
    expect(reserve).toBe(unlockPrice(holding.purchasePrice));
    expect(reserve).toBeGreaterThan(ETH);
    const startPrice = reserve * 16n; // and it halves every day until it reaches the reserve
    expect(holding.auction).toEqual({ startPrice, endPrice: reserve, startTime: started, currentPrice: startPrice, atReserve: false, ownerPriced: false });
    expect(await vaultRead("isOwnerPriced", 1n)).toBe(false);
    expect(await readAuctionPrice(client, d, 1n)).toBe(startPrice);
    expect(await revertOf(owner, startAuctionCall(d, 1n))).toMatchObject({ name: "AuctionRunning" });
    // 16x the reserve halves four times: it reaches the reserve exactly four days in.
    expect(auctionReachesReserveAt(holding.auction!, state.auctionHalfLife)).toBe(started + 4 * DAY);
    expect(auctionReachesReserveAt({ startPrice: 3n * ETH, endPrice: ETH, startTime: 0 }, DAY)).toBe(DAY + (2 * DAY) / 3); // 3 -> 1.5 in a day, then 0.5 of the next day's 0.75 drop
    expect(auctionReachesReserveAt({ startPrice: ETH, endPrice: ETH, startTime: 50 }, DAY)).toBe(50);
    // A licence lapses once its holding goes to auction, and the holding is no longer listed.
    expect((await readLicensing(client, d, seller)).holdings).toEqual([]);
    expect(await revertOf(buyer, buyCall(d, 1n, ETH))).toMatchObject({
      name: "PriceNotMet",
      message: expect.stringMatching(/^The auction price is 18\.\d* ETH but only 1 ETH was sent\.$/),
    });

    // --- the rules around an auction nobody buys (on a snapshot of its own: it moves the clock by months)
    await isolated(async () => {
      const auction = async (id: bigint) => (await readHoldings(client, d)).holdings.find((h) => h.id === id)!.auction!;
      // One second before the fourth halving completes the price is still above the reserve.
      await warpTo(started + 4 * DAY - 1);
      let a = await auction(1n);
      expect(a.atReserve).toBe(false);
      expect(a.currentPrice).toBe(auctionPriceAt(a, started + 4 * DAY - 1));
      expect(a.currentPrice).toBe(2n * reserve - (reserve * 86_399n) / 86_400n);
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({
        name: "AuctionRunning",
        message: "The auction is still running: it can be restarted only once its price has rested at the reserve for a day.",
      });
      await warpTo(started + 4 * DAY);
      a = await auction(1n);
      expect(a).toMatchObject({ atReserve: true, currentPrice: reserve });
      // It rests at the reserve for a day, so buyers get a real chance at that price.
      const state = await readHoldings(client, d);
      expect(state.auctionRestartDwell).toBe(DAY);
      expect(auctionRestartableAt(a, state.auctionHalfLife, state.auctionRestartDwell)).toBe(started + 5 * DAY);
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({ name: "AuctionRunning" });
      await warpTo(started + 5 * DAY - 1);
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({ name: "AuctionRunning" });
      await warpTo(started + 5 * DAY);
      // Anyone may restart it now, but only on a fresh floor: the last sale is six days old.
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({ name: "StaleOracle" });
      await recordSales(3n * ETH, 4);
      expect(await readFloor(client, d.salesFloorOracle, collection)).toMatchObject({ ok: true, price: 3n * ETH });
      let restarted = await timeOf(await send(seller, startAuctionCall(d, 1n)));
      // The reserve follows the floor up: 3 ETH, opening at 48 ETH.
      expect(await auction(1n)).toEqual({ startPrice: 48n * ETH, endPrice: 3n * ETH, startTime: restarted, currentPrice: 48n * ETH, atReserve: false, ownerPriced: false });

      // The owner can take it off auction: unlocked again, with a new governance window.
      expect(await revertOf(seller, vault("cancelAuction", [1n]))).toMatchObject({ name: "OwnableUnauthorizedAccount" });
      const cancelled = await timeOf(await send(owner, vault("cancelAuction", [1n])));
      expect((await readHoldings(client, d)).holdings[0]).toMatchObject({ status: HoldingStatus.Unlocked, unlockedAt: cancelled, auction: undefined });
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({ name: "GovernanceWindowOpen", args: [BigInt(cancelled + 30 * DAY)] });

      // An auction at prices the owner chose: only the owner can restart it.
      restarted = await timeOf(await send(owner, vault("startAuctionWithPrices", [1n, 5n * ETH, 4n * ETH])));
      expect(await auction(1n)).toEqual({ startPrice: 5n * ETH, endPrice: 4n * ETH, startTime: restarted, currentPrice: 5n * ETH, atReserve: false, ownerPriced: true });
      expect(await vaultRead("isOwnerPriced", 1n)).toBe(true);
      expect(auctionReachesReserveAt(await auction(1n), DAY)).toBe(restarted + (2 * DAY) / 5); // 5 -> 4 is two fifths of the first day's 2.5 drop
      await warpTo(restarted + (2 * DAY) / 5 - 1);
      expect((await auction(1n)).atReserve).toBe(false);
      await warpTo(restarted + (2 * DAY) / 5);
      expect(await auction(1n)).toMatchObject({ atReserve: true, currentPrice: 4n * ETH, ownerPriced: true });
      // The rest at the reserve counts from the end of the half-life in which the price got there:
      // not even the owner can restart before that plus a day.
      expect(auctionRestartableAt(await auction(1n), DAY, DAY)).toBe(restarted + 2 * DAY);
      await warpTo(restarted + 2 * DAY - 1);
      expect(await revertOf(owner, startAuctionCall(d, 1n))).toMatchObject({ name: "AuctionRunning" });
      await warpTo(restarted + 2 * DAY);
      expect(await revertOf(seller, startAuctionCall(d, 1n))).toMatchObject({
        name: "OwnerPricedAuction",
        message: "The owner set this auction's prices by hand, so only the owner can restart it.",
      });
      // The owner restarts it at oracle prices, with a minimum reserve for the collection in force.
      await send(owner, vault("setMinReserve", [collection, 10n * ETH]));
      expect(await vaultRead("minReserveOf", collection)).toBe(10n * ETH);
      restarted = await timeOf(await send(owner, startAuctionCall(d, 1n)));
      expect(await auction(1n)).toEqual({ startPrice: 160n * ETH, endPrice: 10n * ETH, startTime: restarted, currentPrice: 160n * ETH, atReserve: false, ownerPriced: false });
      await send(owner, vault("setMinReserve", [collection, 0n]));

      // A holding that unlocks on its own: the lock has ended and the floor is 130% of the price paid.
      const sale = await send(owner, sellCall(d, collection, 5n, 0n)); // the seed approved the engine for the owner's tokens
      let second = (await readHoldings(client, d)).holdings[0];
      expect(second).toMatchObject({ id: 2n, tokenId: 5n, status: HoldingStatus.Locked, canUnlock: false, acquiredAt: await timeOf(sale) });
      const paid = second.purchasePrice;
      await warpTo(second.lockedUntil);
      // no sale in the last seven days: no floor, so the price lock stays shut
      expect((await readHoldings(client, d)).holdings[0].canUnlock).toBe(false);
      expect(await revertOf(buyer, unlockCall(d, 2n))).toMatchObject({ name: "UnlockConditionsNotMet" });
      await recordSales(2n * ETH, 3);
      expect(2n * ETH).toBeGreaterThanOrEqual(unlockPrice(paid));
      expect((await readHoldings(client, d)).holdings[0].canUnlock).toBe(true);
      const unlockedAt = await timeOf(await send(buyer, unlockCall(d, 2n))); // anyone may unlock
      second = (await readHoldings(client, d)).holdings[0];
      expect(second).toMatchObject({ status: HoldingStatus.Unlocked, unlockedAt, canUnlock: false });
      // the floor seen at the unlock is remembered
      expect(await vaultRead("unlockFloorOf", 2n)).toBe(2n * ETH);
      // The floor then falls to 0.5 ETH. The reserve is 130% of the price paid, but the auction
      // opens at 16 times the floor seen at the unlock, which is higher.
      await recordSales(parseEther("0.5"), 4);
      expect(await readFloor(client, d.salesFloorOracle, collection)).toMatchObject({ ok: true, price: parseEther("0.5") });
      expect(await revertOf(seller, startAuctionCall(d, 2n))).toMatchObject({ name: "GovernanceWindowOpen", args: [BigInt(unlockedAt + 30 * DAY)] });
      restarted = await timeOf(await send(owner, startAuctionCall(d, 2n)));
      a = await auction(2n);
      expect(unlockPrice(paid)).toBeLessThan(2n * ETH);
      expect(a).toEqual({ startPrice: 32n * ETH, endPrice: unlockPrice(paid), startTime: restarted, currentPrice: 32n * ETH, atReserve: false, ownerPriced: false });
      // more than four halvings from 32 ETH: the mirror finds the exact second
      const reachesAt = auctionReachesReserveAt(a, DAY);
      expect(reachesAt).toBeGreaterThan(restarted + 4 * DAY);
      await warpTo(reachesAt - 1);
      expect((await auction(2n)).atReserve).toBe(false);
      await warpTo(reachesAt);
      expect(await auction(2n)).toMatchObject({ atReserve: true, currentPrice: unlockPrice(paid) });
      // five halvings take 32 ETH under the reserve: restartable six days after it opened
      const restartAt = auctionRestartableAt(a, DAY, DAY);
      expect(restartAt).toBe(restarted + 6 * DAY);
      await warpTo(restartAt - 1);
      expect(await revertOf(owner, startAuctionCall(d, 2n))).toMatchObject({ name: "AuctionRunning" });
      await warpTo(restartAt);
      await recordSales(parseEther("0.5"), 3);
      await send(owner, startAuctionCall(d, 2n));
      expect((await auction(2n)).startPrice).toBe(32n * ETH);
    });
    expect(await readChainTime(client)).toBeLessThan(started + DAY);

    // Same steps as the Buy button: read the price, then buy. Time passes in between, so the price
    // has fallen by the time the transaction is mined and the contract refunds the difference. (With
    // a value of exactly the price read, gas was estimated without that refund and the transaction
    // ran out of gas whenever a block boundary fell in between: this used to fail intermittently.)
    const price = await readAuctionPrice(client, d, 1n);
    const budget = await budgetOf();
    const balance = await balanceOf(buyer);
    await client.increaseTime({ seconds: 600 });
    const receipt = await send(buyer, buyCall(d, 1n, price));
    const spent = -(await gained(buyer, balance, receipt));
    // The price fell between the read and the block; the excess came back.
    expect(spent).toBeLessThan(price);
    expect(spent).toBeGreaterThan((price * 99n) / 100n);
    expect(spent).toBe(auctionPriceAt(holding.auction!, await timeOf(receipt)));
    expect(await ownerOf(3n)).toBe(buyer);
    expect(await budgetOf()).toBe(budget + spent);

    const overview = await readOverview(client, d, collection);
    expect(overview.holdingCount).toBe(1n);
    expect(overview.collectionHoldingsInVault).toBe(0); // released holdings are not counted
    expect((await readHoldings(client, d)).holdings[0]).toMatchObject({ status: HoldingStatus.Released, auction: undefined });
  });

  it("vault raffles: minimum of activated points, one draw at a time, reset and cooldown, claim", async () => {
    const vault = (functionName: string, args: readonly unknown[]) => raw(d.vault, vaultAbi, functionName, args);
    const raffle = (functionName: string, args: readonly unknown[]) => raw(d.vaultRaffle, vaultRaffleAbi, functionName, args);
    // Two prizes: the seller's token 4 and the owner's token 5, each sold into the bid and released.
    await send(owner, raw(d.buybackEngine, buybackEngineAbi, "setFillCooldown", [collection, 0n]));
    await send(seller, approveCall(collection, d.buybackEngine, 4n));
    await send(seller, sellCall(d, collection, 4n, withSlippage((await readFloorBid(client, d, collection)).currentBid, 100n)));
    await send(owner, sellCall(d, collection, 5n, withSlippage((await readFloorBid(client, d, collection)).currentBid, 100n)));
    for (const id of [2n, 3n]) {
      await send(owner, vault("governanceUnlock", [id]));
      await send(owner, vault("sendToRaffle", [id]));
    }

    let state = await readRaffles(client, d);
    expect(state).toMatchObject({ raffleCount: 2n, totalPoints: parseEther("50"), drawInFlight: false, nextDrawAt: 0, minPointsToDraw: 0n });
    const opened = await readChainTime(client);
    expect(state.raffles[0]).toMatchObject({ id: 2n, tokenId: 5n, status: RaffleStatus.Open, drawAfter: opened + 7 * DAY });
    expect(state.raffles[1]).toMatchObject({ id: 1n, tokenId: 4n, status: RaffleStatus.Open });
    expect(state.raffles[0].collection.toLowerCase()).toBe(collection.toLowerCase());

    const early = await revertOf(buyer, drawRaffleCall(d, 1n));
    expect(early.name).toBe("TooEarly");
    expect(early.message).toMatch(/^Too early: possible from /);
    expect(await revertOf(buyer, claimRaffleCall(d, 1n))).toMatchObject({ name: "WrongStatus" });

    // The owner requires 100 activated points before any draw; only the seller's 50 are active.
    await send(owner, raffle("setMinPointsToDraw", [parseEther("100")]));
    expect((await readRaffles(client, d)).minPointsToDraw).toBe(parseEther("100"));
    await warpTo(state.raffles[0].drawAfter);
    const below = await revertOf(buyer, drawRaffleCall(d, 1n));
    expect(below).toMatchObject({ name: "BelowMinPoints", args: [parseEther("50"), parseEther("100")], message: "Only 50 points are activated; a draw needs at least 100." });
    // The owner's pending points are activated (by anyone): 50 from the sales + 30 from the market.
    await send(buyer, flushPointsCall(d, owner));
    expect(await readPoints(client, d, owner)).toEqual({ active: parseEther("80"), pending: 0n });
    expect((await readRaffles(client, d)).totalPoints).toBe(parseEther("130"));

    const requested = await timeOf(await send(buyer, drawRaffleCall(d, 1n)));
    state = await readRaffles(client, d);
    expect(state.drawInFlight).toBe(true);
    expect(state.raffles[1]).toMatchObject({ status: RaffleStatus.Drawing, requestedAt: requested });
    // The request id the "Local only: draw with mock randomness" button answers.
    expect(state.raffles[1].requestId).toBe(1n);
    expect((await readOverview(client, d, collection, seller)).pointsFrozen).toBe(true);
    expect(await revertOf(owner, flushPointsCall(d, seller))).toMatchObject({ name: "Frozen" });
    // One draw at a time.
    expect(await revertOf(buyer, drawRaffleCall(d, 2n))).toMatchObject({ name: "DrawInFlight", message: "Another raffle's draw is in flight. Wait for it to complete or be reset." });

    // On a local chain whoever calls the mock provider picks the random word. Point 0 is the seller's.
    const drawn = await timeOf(await send(buyer, mockFulfillCall(d.randomness, state.raffles[1].requestId!, 0n)));
    state = await readRaffles(client, d);
    expect(state.raffles[1]).toMatchObject({ status: RaffleStatus.Won, winner: seller, requestId: undefined });
    // The winner keeps a fifth of their points. No draw for an hour after any draw ends, so that
    // points can be activated in between.
    expect(state).toMatchObject({ drawInFlight: false, totalPoints: parseEther("90"), nextDrawAt: drawn + 3_600 });
    expect(await revertOf(buyer, drawRaffleCall(d, 2n))).toMatchObject({ name: "TooEarly", args: [BigInt(drawn + 3_600)] });
    expect((await readPoints(client, d, seller)).active).toBe(parseEther("10"));

    await send(buyer, claimRaffleCall(d, 1n));
    expect((await readRaffles(client, d)).raffles[1].status).toBe(RaffleStatus.Claimed);
    expect(await ownerOf(4n)).toBe(seller);

    // 90 points are left: below the minimum again.
    await warpTo(drawn + 3_600);
    expect(await revertOf(buyer, drawRaffleCall(d, 2n))).toMatchObject({ name: "BelowMinPoints", args: [parseEther("90"), parseEther("100")] });
    await send(owner, raffle("setMinPointsToDraw", [0n]));
    // A draw whose randomness never arrives can be reset after a day; no draw for an hour after that.
    const second = await timeOf(await send(buyer, drawRaffleCall(d, 2n)));
    expect((await readRaffles(client, d)).raffles[0]).toMatchObject({ status: RaffleStatus.Drawing, requestId: 2n });
    expect(await revertOf(buyer, raffle("resetDraw", [2n]))).toMatchObject({ name: "TooEarly", args: [BigInt(second + DAY)] });
    await warpTo(second + DAY);
    const reset = await timeOf(await send(buyer, raffle("resetDraw", [2n])));
    state = await readRaffles(client, d);
    expect(state).toMatchObject({ drawInFlight: false, nextDrawAt: reset + 3_600 });
    expect(state.raffles[0]).toMatchObject({ status: RaffleStatus.Open, requestId: undefined });
    expect(await revertOf(buyer, drawRaffleCall(d, 2n))).toMatchObject({ name: "TooEarly", args: [BigInt(reset + 3_600)] });
    await warpTo(reset + 3_600);
    await send(buyer, drawRaffleCall(d, 2n));
    const request = (await readRaffles(client, d)).raffles[0].requestId!;
    expect(request).toBe(3n);
    // Points 0..10 are the seller's, 10..90 the owner's.
    await send(buyer, mockFulfillCall(d.randomness, request, parseEther("90") * 5n + parseEther("10")));
    expect((await readRaffles(client, d)).raffles[0]).toMatchObject({ status: RaffleStatus.Won, winner: owner });
    expect(await readPoints(client, d, owner)).toEqual({ active: parseEther("16"), pending: 0n });
    await send(seller, claimRaffleCall(d, 2n)); // anyone may deliver the prize
    expect(await ownerOf(5n)).toBe(owner);

    // The push oracle's price is over a day old now; both oracle states still render.
    expect(await readFloor(client, d.pushFloorOracle, collection)).toMatchObject({ ok: true, price: parseEther("1.2") });
    expect(await readFloor(client, d.salesFloorOracle, collection)).toMatchObject({ ok: false, errorName: "InsufficientData" });
  });

  it("slots: pay table, wager limits, spin and mock settle at each kind of result, the fee split", async () => {
    // Runs on its own snapshot so the bankroll is untouched for the games tests below.
    await isolated(async () => {
      // The TypeScript mirror of the pay table agrees with the contract at every band edge.
      for (const roll of [0, 19, 20, 119, 120, 519, 520, 2_019, 2_020, 5_019, 5_020, 9_999]) {
        expect(slotsMultiplier(roll)).toBe(Number(await gamesRead<bigint>("slotsMultiplier", [BigInt(roll)])));
      }
      expect(SLOTS_PAY_TABLE.reduce((sum, tier) => sum + tier.chanceBps, 0)).toBe(10_000);
      expect(await gamesRead("SLOTS_MAX_MULTIPLIER")).toBe(SLOTS_MAX_MULTIPLIER);
      // The cosmetic line always matches the prize: three of a kind, a pair, or nothing.
      const tripleSymbol: Record<number, string> = { 50: "7", 10: "★", 5: "◆", 2: "●" };
      for (let roll = 0; roll < 10_000; roll++) {
        const line = slotsLine(roll);
        const distinct = new Set(line).size;
        const multiplier = slotsMultiplier(roll);
        if (multiplier >= 2) expect(line).toEqual([tripleSymbol[multiplier], tripleSymbol[multiplier], tripleSymbol[multiplier]]);
        else expect(distinct).toBe(multiplier === 1 ? 2 : 3);
        // never a staged near miss: the top symbol only ever appears as the jackpot, and a
        // stake-back pair is always made of the two plainest symbols
        if (multiplier !== 50) expect(line).not.toContain("7");
        if (multiplier === 1) expect(line.every((s) => s === "♣" || s === "▲")).toBe(true);
      }

      // The house reserves 49 stakes per spin, within 1% of the 50 ETH bankroll. That binds long
      // before the 0.5 ETH wager cap.
      let games = await readGames(client, d, collection, buyer);
      const max = maxSlotsWager(games)!;
      expect(slotsExposure(max, games.edgeBps)).toBeLessThanOrEqual(parseEther("0.5"));
      expect(slotsExposure(max + parseEther("0.000001"), games.edgeBps)).toBeGreaterThan(parseEther("0.5"));
      expect(max).toBeGreaterThan(parseEther("0.0104"));
      expect(max).toBeLessThan(parseEther("0.01042"));
      expect(await revertOf(buyer, spinCall(d, collection, max + parseEther("0.0001")))).toMatchObject({ name: "ExposureTooHigh" });
      expect(await revertOf(buyer, spinCall(d, collection, parseEther("0.6")))).toMatchObject({
        name: "WagerTooHigh",
        args: [parseEther("0.6"), parseEther("0.5")],
        message: "The wager of 0.6 ETH is above the largest allowed right now, 0.5 ETH (a share of the bankroll).",
      });
      expect(await revertOf(buyer, spinCall(d, collection, 1n))).toMatchObject({ name: "BetTooSmall" });
      expect(await revertOf(buyer, spinCall(d, d.owner, max))).toMatchObject({ name: "UnsupportedCollection" });
      await send(buyer, spinCall(d, collection, max)); // exactly the maximum is accepted
      await send(seller, mockFulfillCall(d.gamesRandomness, (await readUserBets(client, d, buyer, REFUND))[0].requestId, 9_999n));
    });

    await isolated(async () => {
      const wager = parseEther("0.01");
      const stake = parseEther("0.0098"); // after the 2% edge
      const pointsBefore = (await readPoints(client, d, buyer)).pending;
      const budget = await budgetOf();
      const spinAndSettle = async (roll: bigint) => {
        await send(buyer, spinCall(d, collection, wager));
        const pending = (await readUserBets(client, d, buyer, REFUND))[0];
        expect(pending).toMatchObject({ kind: "slots", chanceBps: 0, wager, status: "pending" });
        expect((await readGames(client, d, collection)).reserved).toBe(stake * 49n);
        expect(await readHouse(client, d)).toMatchObject({ reserved: stake * 49n, openWagers: wager });
        const balance = await balanceOf(buyer);
        await send(seller, mockFulfillCall(d.gamesRandomness, pending.requestId, 10_000n * 77n + roll));
        const settled = (await readUserBets(client, d, buyer, REFUND))[0];
        return { settled, received: (await balanceOf(buyer)) - balance };
      };

      // No proof exists while a bet is unsettled or unknown.
      expect(await readBetProof(client, d, 999n)).toBeUndefined();
      const jackpot = await spinAndSettle(5n);
      // The Verify view: both events, the edge stored with the bet, the same payout recomputed, and
      // how the 0.0002 ETH fee was split: half stayed in the bankroll, half went to the Treasury.
      const proof = (await readBetProof(client, d, jackpot.settled.requestId))!;
      expect(proof).toMatchObject({
        wager,
        chanceBps: 0,
        edgeBps: 200n,
        edgeSource: "stored",
        roll: 5,
        paidPayout: stake * 50n,
        paidFee: parseEther("0.0002"),
        feeToTreasury: parseEther("0.0001"),
        feeKeptByBankroll: parseEther("0.0001"),
      });
      expect(proof.placedTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(proof.settledTx).not.toBe(proof.placedTx);
      expect(recomputeBet(proof)).toMatchObject({ payout: proof.paidPayout, fee: proof.paidFee, multiplier: 50, tierIndex: 0 });
      expect(jackpot.settled).toMatchObject({ kind: "slots", status: "won", roll: 5, payout: stake * 50n, fee: parseEther("0.0002") });
      expect(jackpot.received).toBe(stake * 50n);
      const stakeBack = await spinAndSettle(3_000n);
      expect(stakeBack.settled).toMatchObject({ status: "won", roll: 3_000, payout: stake });
      expect(stakeBack.received).toBe(stake);
      const nothing = await spinAndSettle(9_999n);
      expect(nothing.settled).toMatchObject({ status: "lost", roll: 9_999, payout: 0n });
      expect(nothing.received).toBe(0n);

      // The house paid 49 stakes once and kept one stake once, and kept half of each 0.0002 ETH edge.
      const games = await readGames(client, d, collection);
      expect(games.reserved).toBe(0n);
      expect(games.bankroll).toBe(50n * ETH - stake * 49n + stake + 3n * parseEther("0.0001"));
      // The other halves went to the buyback budget, and earned the player points.
      expect(await budgetOf()).toBe(budget + 3n * parseEther("0.0001"));
      expect((await readPoints(client, d, buyer)).pending).toBe(pointsBefore + 3n * pts(parseEther("0.0001")));
      expect((await readUserBets(client, d, buyer, REFUND)).map((b) => b.kind)).toEqual(["slots", "slots", "slots"]);
      // The house's realised history from events: the seed deposit, then each spin at its settlement.
      const history = housePoints((await readHouseEvents(client, d))!);
      expect(history.map((p) => [p.kind, p.change])).toEqual([
        ["deposit", 50n * ETH],
        ["bet", houseGain(wager, stake * 50n, parseEther("0.0002"), 5_000n)],
        ["bet", parseEther("0.0001")],
        ["bet", parseEther("0.0099")],
      ]);
      expect(history[1].change).toBe(-parseEther("0.4801"));
      expect(history[3].equity).toBe(games.bankroll);
      expect(history[3].price).toBe(sharePrice(games.bankroll, 50n * ETH * VIRTUAL_SHARES));
      expect((await readActivity(client, d, collection))[0]).toMatchObject({ module: "Games", route: "/play/slots", text: "Slots spin of 0.01 ETH", actor: buyer });
    });
  });

  it("games: quote, wager cap, play, mock settle (win and loss), fee split, refund, project share", async () => {
    await send(owner, raw(d.treasury, treasuryAbi, "setProjectShare", [collection, buyer, 2_000]));
    let overview = await readOverview(client, d, collection, buyer);
    expect(overview.projectShare).toEqual({ recipient: buyer, bps: 2_000 });
    expect(overview.userProjectShareOwed).toBe(0n);

    // 2% edge leaves a 0.98 stake; a fair coinflip pays 1.96. A 1% long shot pays 98x the stake.
    expect(await readGameQuote(client, d, ETH, 5_000)).toEqual({ payout: parseEther("1.96"), fee: parseEther("0.02") });
    expect(await readGameQuote(client, d, parseEther("0.1"), 100)).toEqual({ payout: parseEther("9.8"), fee: parseEther("0.002") });

    // The house risks at most 1% of the 50 ETH bankroll per bet, and takes no wager above 1% of it.
    let games = await readGames(client, d, collection, seller);
    const limit = parseEther("0.5");
    expect(games.maxWager).toBe(limit);
    for (const chance of [100, 3_300]) {
      // long odds: the exposure cap binds
      const max = maxGameWager(games, chance)!;
      expect(max).toBeLessThan(games.maxWager);
      expect(gameExposure(max, chance, games.edgeBps)).toBeLessThanOrEqual(limit);
      expect(gameExposure(max + parseEther("0.000001"), chance, games.edgeBps)).toBeGreaterThan(limit);
      const over = await revertOf(seller, playCall(d, collection, chance, max + parseEther("0.001")));
      expect(over.name).toBe("ExposureTooHigh");
      expect(over.message).toMatch(/the limit per bet is 0\.5 ETH/);
    }
    for (const chance of [5_000, 9_500]) {
      // short odds: the exposure would allow more, the wager cap binds
      expect(maxGameWager({ ...games, maxWagerBps: undefined }, chance)!).toBeGreaterThan(games.maxWager);
      expect(maxGameWager(games, chance)).toBe(games.maxWager);
      expect(await revertOf(seller, playCall(d, collection, chance, games.maxWager + 1n))).toMatchObject({ name: "WagerTooHigh", args: [games.maxWager + 1n, games.maxWager] });
    }
    expect(await revertOf(seller, playCall(d, collection, 9_600, parseEther("0.1")))).toMatchObject({ name: "InvalidChance" });
    expect(await revertOf(seller, playCall(d, collection, 5_000, 1n))).toMatchObject({ name: "BetTooSmall" });
    expect(await revertOf(seller, playCall(d, d.owner, 5_000, parseEther("0.1")))).toMatchObject({ name: "UnsupportedCollection" });

    // --- win
    const wager = parseEther("0.1");
    const sellerPoints = (await readPoints(client, d, seller)).pending;
    expect(sellerPoints).toBe(parseEther("11.25"));
    const placedAt = await timeOf(await send(seller, playCall(d, collection, 5_000, wager)));
    let bets = await readUserBets(client, d, seller, games.refundTimeout);
    expect(bets).toHaveLength(1);
    const first = bets[0].requestId;
    expect(bets[0]).toMatchObject({ wager, chanceBps: 5_000, status: "pending", refundableAt: placedAt + REFUND });
    expect(bets[0].collection.toLowerCase()).toBe(collection.toLowerCase());
    games = await readGames(client, d, collection);
    expect(games).toMatchObject({ bankroll: 50n * ETH - parseEther("0.098"), reserved: parseEther("0.098"), openWagers: wager });
    // the wager cap follows the free bankroll
    expect(games.maxWager).toBe((50n * ETH - parseEther("0.098")) / 100n);
    expect(await gamesRead("maxWager")).toBe(games.maxWager);
    expect(await readUserBets(client, d, buyer, games.refundTimeout)).toEqual([]); // filtered by player
    expect((await readActivity(client, d, collection))[0]).toMatchObject({ module: "Games", route: "/play/dice", text: "Dice bet of 0.1 ETH at 50%", actor: seller });

    const early = await revertOf(buyer, refundBetCall(d, first));
    expect(early.name).toBe("TooEarly");
    expect(early.args).toEqual([BigInt(placedAt + REFUND)]);

    const budget = await budgetOf();
    let balance = await balanceOf(seller);
    // Same call as the "Local only" button; anyone may send it. Roll 4999 < 5000 wins.
    await send(buyer, mockFulfillCall(d.gamesRandomness, first, 10_000n * 123n + 4_999n));
    expect((await balanceOf(seller)) - balance).toBe(parseEther("0.196"));
    bets = await readUserBets(client, d, seller, games.refundTimeout);
    expect(bets[0]).toEqual({
      requestId: first,
      collection: bets[0].collection,
      wager,
      kind: "dice",
      chanceBps: 5_000,
      status: "won",
      roll: 4_999,
      payout: parseEther("0.196"),
      fee: parseEther("0.002"),
    });
    // Of the 0.002 ETH edge the bankroll keeps half. Of the other half 20% accrues to the project
    // and the rest reaches the buyback budget; the player's points follow that last part.
    expect(await budgetOf()).toBe(budget + parseEther("0.0008"));
    overview = await readOverview(client, d, collection, buyer);
    expect(overview.userProjectShareOwed).toBe(parseEther("0.0002"));
    expect((await readPoints(client, d, seller)).pending).toBe(sellerPoints + pts(parseEther("0.0008")));
    const diceProof = (await readBetProof(client, d, first))!;
    expect(diceProof).toMatchObject({
      wager,
      chanceBps: 5_000,
      edgeBps: 200n,
      edgeSource: "stored",
      roll: 4_999,
      paidPayout: parseEther("0.196"),
      paidFee: parseEther("0.002"),
      // budget + project share, and what stayed in the bankroll
      feeToTreasury: parseEther("0.001"),
      feeKeptByBankroll: parseEther("0.001"),
    });
    expect(recomputeBet(diceProof)).toMatchObject({ kind: "dice", won: true, payout: diceProof.paidPayout, fee: diceProof.paidFee });
    // A settled bet cannot be settled again; the error comes from Games through the mock provider.
    expect(await revertOf(buyer, mockFulfillCall(d.gamesRandomness, first, 0n))).toMatchObject({ name: "UnknownBet" });
    expect(await revertOf(buyer, refundBetCall(d, first))).toMatchObject({ name: "UnknownBet" });

    // --- loss
    await send(seller, playCall(d, collection, 5_000, wager));
    bets = await readUserBets(client, d, seller, games.refundTimeout);
    expect(bets.map((b) => b.status)).toEqual(["pending", "won"]);
    const second = bets[0].requestId;
    balance = await balanceOf(seller);
    await send(buyer, mockFulfillCall(d.gamesRandomness, second, 5_000n)); // roll 5000: not below 5000
    expect(await balanceOf(seller)).toBe(balance);
    bets = await readUserBets(client, d, seller, games.refundTimeout);
    expect(bets[0]).toMatchObject({ status: "lost", roll: 5_000, payout: 0n, fee: parseEther("0.002") });
    // First bet: the house paid 0.098. Second: it kept the 0.098 stake. Both times it kept 0.001 of the edge.
    games = await readGames(client, d, collection, seller);
    expect(games).toMatchObject({ bankroll: parseEther("50.002"), reserved: 0n, userOwed: 0n });
    expect(await revertOf(seller, withdrawGamesCall(d))).toMatchObject({ name: "NothingOwed" });
    expect((await readPoints(client, d, seller)).pending).toBe(parseEther("15.25"));

    // --- project share claim (the Overview Claim button)
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, claimProjectShareCall(d)))).toBe(parseEther("0.0004"));
    expect((await readOverview(client, d, collection, buyer)).userProjectShareOwed).toBe(0n);
    expect(await revertOf(buyer, claimProjectShareCall(d))).toMatchObject({
      name: "NothingOwed",
      message: "There is nothing owed to this account.",
    });

    // --- refund: the largest wager the UI allows is accepted; its randomness never arrives
    const largest = maxGameWager(games, 5_000)!;
    expect(largest).toBe(parseEther("0.50002"));
    await send(seller, playCall(d, collection, 5_000, largest));
    bets = await readUserBets(client, d, seller, games.refundTimeout);
    const third = bets[0];
    expect(third.status).toBe("pending");
    await warpTo(third.refundableAt!);
    expect(await readChainTime(client)).toBe(third.refundableAt); // the UI now shows "Refundable"
    balance = await balanceOf(seller);
    const refundedAt = await timeOf(await send(buyer, refundBetCall(d, third.requestId)));
    expect((await balanceOf(seller)) - balance).toBe(third.wager);
    // After any refund betting pauses for ten minutes: the provider is not answering.
    games = await readGames(client, d, collection, seller);
    expect(games).toMatchObject({ betsResumeAt: refundedAt + 600, openWagers: 0n, reserved: 0n });
    const pausedBet = await revertOf(seller, playCall(d, collection, 5_000, wager));
    expect(pausedBet).toMatchObject({ name: "BetsPaused", args: [BigInt(refundedAt + 600)] });
    expect(pausedBet.message).toMatch(/^Betting is paused for a few minutes after a refund; it resumes /);
    expect(await revertOf(seller, spinCall(d, collection, parseEther("0.01")))).toMatchObject({ name: "BetsPaused" });
    await warpTo(refundedAt + 599);
    expect(await revertOf(seller, playCall(d, collection, 5_000, wager))).toMatchObject({ name: "BetsPaused" });
    await warpTo(refundedAt + 600);
    bets = await readUserBets(client, d, seller, games.refundTimeout);
    expect(bets.map((b) => b.status)).toEqual(["refunded", "lost", "won"]);
    expect(bets[0].refundableAt).toBeUndefined();
    expect(await readBetProof(client, d, third.requestId)).toBeUndefined();
    expect((await readGames(client, d, collection)).bankroll).toBe(parseEther("50.002"));

    // --- randomness that arrives after the refund window refunds the bet instead of settling it
    await send(seller, playCall(d, collection, 5_000, wager));
    const late = (await readUserBets(client, d, seller, games.refundTimeout))[0];
    await warpTo(late.refundableAt!);
    balance = await balanceOf(seller);
    await send(buyer, mockFulfillCall(d.gamesRandomness, late.requestId, 0n)); // roll 0 would have won
    expect((await balanceOf(seller)) - balance).toBe(wager);
    expect((await readUserBets(client, d, seller, games.refundTimeout))[0]).toMatchObject({ requestId: late.requestId, status: "refunded" });
    expect(await readHouse(client, d)).toMatchObject({ bankroll: parseEther("50.002"), reserved: 0n, openWagers: 0n });
    // (that refund paused betting again; let the pause run out for what follows)
    await warpTo((await readGames(client, d, collection)).betsResumeAt);
    // Refunds move nothing: the house's history is the deposit and the two settled bets.
    const history = housePoints((await readHouseEvents(client, d))!);
    expect(history.map((p) => [p.kind, p.change])).toEqual([
      ["deposit", 50n * ETH],
      ["bet", -parseEther("0.097")],
      ["bet", parseEther("0.099")],
    ]);
    expect(history[2].equity).toBe(parseEther("50.002"));
  });

  it("the house: requests wait for the bets open when they were made, and are priced against the bets open when they are carried out", async () => {
    const S0 = 50n * ETH * VIRTUAL_SHARES;
    let house = await readHouse(client, d, seller);
    expect(house).toMatchObject({ bankroll: parseEther("50.002"), reserved: 0n, openWagers: 0n, totalShares: S0, userShares: 0n, totalPendingDeposits: 0n, openBets: 0, pendingDeposit: undefined, pendingRedeem: undefined });
    const check = async (h: typeof house) => {
      // the three prices, against the contract's own views
      expect(await gamesRead("previewDeposit", [ETH])).toBe(previewDeposit(h, ETH));
      expect(await gamesRead("previewRedeem", [S0 / 7n])).toBe(previewRedeem(h, S0 / 7n));
      expect(await gamesRead("shareValue", [S0 / 7n])).toBe(shareValue(h, S0 / 7n));
      // the contract holds exactly what it accounts for
      expect(await client.getBalance({ address: d.games })).toBe(h.bankroll + h.reserved + h.openWagers + h.totalPendingDeposits);
    };
    await check(house);

    // --- no bet is open: a deposit is carried out at once (the Deposit form: preview, a tolerance, Games.deposit)
    const preview = previewDeposit(house, ETH);
    expect(preview).toBe((ETH * (S0 + VIRTUAL_SHARES)) / (parseEther("50.002") + 1n));
    expect(preview).toBe(quietDeposit(house, ETH));
    // the argument is the most to give up against fair value, in basis points: at most 100%
    expect(await revertOf(seller, depositHouseCall(d, ETH, 10_001n))).toMatchObject({ name: "InvalidParams" });
    expect(await revertOf(seller, depositHouseCall(d, 0n, 0n))).toMatchObject({ name: "InvalidParams" });
    expect(depositSpreadBps(house, ETH)).toBe(0n);
    expect(await revertOf(seller, executeDepositHouseCall(d, 0n))).toMatchObject({ name: "NothingPending", message: "You have no pending request of that kind." });
    expect(await revertOf(seller, cancelDepositHouseCall(d))).toMatchObject({ name: "NothingPending" });
    expect(await revertOf(seller, executeRedeemHouseCall(d, 0n, seller))).toMatchObject({ name: "NothingPending" });
    expect(await revertOf(seller, cancelRedeemHouseCall(d))).toMatchObject({ name: "NothingPending" });
    await send(seller, depositHouseCall(d, ETH, 0n)); // no tolerance at all: fair value or wait
    house = await readHouse(client, d, seller);
    expect(house).toMatchObject({ bankroll: parseEther("51.002"), totalShares: S0 + preview, userShares: preview, pendingDeposit: undefined, totalPendingDeposits: 0n });
    // a share bought at the going price is worth what was paid, less rounding
    expect(ETH - previewRedeem(house, preview)).toBeLessThanOrEqual(1n);

    // --- a bet is open: a deposit waits apart from the bankroll, and can be cancelled
    await send(seller, playCall(d, collection, 5_000, parseEther("0.1")));
    const open = (await readUserBets(client, d, seller, REFUND))[0];
    const funds = parseEther("51.002"); // free plus set aside: unchanged by placing a bet
    let before = await balanceOf(buyer);
    // however much is tolerated, a request made while a bet is open waits for that bet
    expect(await gained(buyer, before, await send(buyer, depositHouseCall(d, 2n * ETH, 10_000n)))).toBe(-2n * ETH);
    house = await readHouse(client, d, buyer);
    expect(house).toMatchObject({
      bankroll: funds - parseEther("0.098"),
      reserved: parseEther("0.098"),
      openWagers: parseEther("0.1"),
      totalShares: S0 + preview, // no shares issued yet
      totalPendingDeposits: 2n * ETH,
      openBets: 1,
      userShares: 0n,
      pendingDeposit: { amount: 2n * ETH, ready: false, waitingFor: 1 },
    });
    await check(house);
    expect(await revertOf(buyer, executeDepositHouseCall(d, 10_000n))).toMatchObject({ name: "BetsStillOpen" });
    // with the bet open a deposit is priced as if the house wins it, a redemption as if it loses it
    expect(previewDeposit(house, 2n * ETH)).toBe((2n * ETH * (house.totalShares + VIRTUAL_SHARES)) / (funds + parseEther("0.1") + 1n));
    expect(quietDeposit(house, 2n * ETH)).toBe((2n * ETH * (house.totalShares + VIRTUAL_SHARES)) / (funds + 1n));
    expect(previewRedeem(house, preview)).toBe((preview * (funds - parseEther("0.098") + 1n)) / (house.totalShares + VIRTUAL_SHARES));
    expect(shareValue(house, preview)).toBe((preview * (funds + 1n)) / (house.totalShares + VIRTUAL_SHARES));
    before = await balanceOf(buyer);
    expect(await gained(buyer, before, await send(buyer, cancelDepositHouseCall(d)))).toBe(2n * ETH);
    expect(await readHouse(client, d, buyer)).toMatchObject({ pendingDeposit: undefined, totalPendingDeposits: 0n });
    await send(buyer, depositHouseCall(d, 2n * ETH, 0n));
    // a second deposit adds to the pending one
    await send(buyer, depositHouseCall(d, ETH, 0n));
    expect((await readHouse(client, d, buyer)).pendingDeposit).toEqual({ amount: 3n * ETH, ready: false, waitingFor: 1 });

    // --- a redemption asked for now waits too; the shares stay held and at risk
    const half = preview / 2n;
    before = await balanceOf(seller);
    expect(await gained(seller, before, await send(seller, redeemHouseCall(d, preview, 10_000n, other)))).toBe(0n);
    expect(await readHouse(client, d, seller)).toMatchObject({ userShares: preview, pendingRedeem: { amount: preview, ready: false, waitingFor: 1 } });
    expect(await revertOf(seller, executeRedeemHouseCall(d, 10_000n, other))).toMatchObject({ name: "BetsStillOpen" });
    expect(await revertOf(seller, redeemHouseCall(d, preview + 1n, 0n, seller))).toMatchObject({ name: "InsufficientShares", message: "You do not hold that many shares in the house." });
    expect(await revertOf(seller, redeemHouseCall(d, 0n, 0n, seller))).toMatchObject({ name: "InsufficientShares" });
    // a new request replaces the earlier one; a request can be withdrawn
    await send(seller, redeemHouseCall(d, half, 0n, other));
    expect((await readHouse(client, d, seller)).pendingRedeem).toMatchObject({ amount: half, ready: false });
    await send(seller, cancelRedeemHouseCall(d));
    expect((await readHouse(client, d, seller)).pendingRedeem).toBeUndefined();
    await send(seller, redeemHouseCall(d, half, 0n, other));

    // --- the bet loses: stake and reserve return to the bankroll, with half of the edge. Both requests are ready.
    await send(other, mockFulfillCall(d.gamesRandomness, open.requestId, 9_999n));
    house = await readHouse(client, d, buyer);
    expect(house).toMatchObject({ bankroll: funds + parseEther("0.099"), reserved: 0n, openWagers: 0n, openBets: 0, totalPendingDeposits: 3n * ETH, pendingDeposit: { amount: 3n * ETH, ready: true, waitingFor: 0 } });
    const quietShares = previewDeposit(house, 3n * ETH);
    const quietPays = previewRedeem(house, half);
    expect(quietPays).toBe(shareValue(house, half));
    // A later bet does not hold them up, but it is priced against whoever carries a request out now.
    await send(seller, playCall(d, collection, 5_000, parseEther("0.1")));
    const later = (await readUserBets(client, d, seller, REFUND))[0];
    house = await readHouse(client, d, buyer);
    expect(house).toMatchObject({ reserved: parseEther("0.098"), openBets: 1, pendingDeposit: { amount: 3n * ETH, ready: true, waitingFor: 0 } });
    await check(house);
    const buyerShares = previewDeposit(house, 3n * ETH);
    expect(buyerShares).toBe((3n * ETH * (S0 + preview + VIRTUAL_SHARES)) / (funds + parseEther("0.099") + parseEther("0.1") + 1n));
    expect(quietDeposit(house, 3n * ETH)).toBe(quietShares);
    expect(buyerShares).toBeLessThan(quietShares);
    // The spread against fair value: 1 - (funds) / (funds + the 0.1 ETH in play), about 0.2%.
    const depositSpread = depositSpreadBps(house, 3n * ETH);
    expect(depositSpread).toBe(20n);
    expect([depositWithinSpread(house, 3n * ETH, depositSpread - 1n), depositWithinSpread(house, 3n * ETH, depositSpread)]).toEqual([false, true]);
    // Beyond the tolerance the contract refuses to carry it out, and the deposit stays pending.
    expect(await revertOf(buyer, executeDepositHouseCall(d, depositSpread - 1n))).toMatchObject({
      name: "SlippageExceeded",
      message: "Carrying this out right now would give up more against fair value than the limit you set, because bets are open. Nothing was done; wait for a quieter moment.",
    });
    expect(await revertOf(buyer, executeDepositHouseCall(d, 0n))).toMatchObject({ name: "SlippageExceeded" });
    await send(buyer, executeDepositHouseCall(d, depositSpread));
    house = await readHouse(client, d, seller);
    expect(house).toMatchObject({ totalShares: S0 + preview + buyerShares, totalPendingDeposits: 0n, pendingRedeem: { amount: half, ready: true, waitingFor: 0 } });
    expect(await gamesRead("sharesOf", [buyer])).toBe(buyerShares);

    // The seller's redemption, carried out with that bet open: the shares' part of the free bankroll,
    // less than their fair value. Paid to another account.
    const assets = previewRedeem(house, half);
    expect(assets).toBe((half * (house.bankroll + 1n)) / (house.totalShares + VIRTUAL_SHARES));
    expect(shareValue(house, half) - assets).toBe((half * (house.bankroll + house.reserved + 1n)) / (house.totalShares + VIRTUAL_SHARES) - assets);
    expect(shareValue(house, half)).toBeGreaterThan(assets);
    await check(house);
    expect(lastHolderBlocked(house, half)).toBe(false);
    // 1 - (free bankroll) / (free + the 0.098 ETH set aside), about 0.19%
    const redeemSpread = redeemSpreadBps(house, half);
    expect(redeemSpread).toBe(19n);
    expect([redeemWithinSpread(house, half, redeemSpread - 1n), redeemWithinSpread(house, half, redeemSpread)]).toEqual([false, true]);
    expect(await revertOf(seller, executeRedeemHouseCall(d, redeemSpread - 1n, other))).toMatchObject({ name: "SlippageExceeded" });
    expect(await revertOf(seller, executeRedeemHouseCall(d, 10_001n, other))).toMatchObject({ name: "InvalidParams" });
    const otherBefore = await balanceOf(other);
    await send(seller, executeRedeemHouseCall(d, redeemSpread, other));
    expect((await balanceOf(other)) - otherBefore).toBe(assets);
    house = await readHouse(client, d, seller);
    expect(house).toMatchObject({ userShares: preview - half, pendingRedeem: undefined, totalShares: S0 + preview - half + buyerShares });
    await send(other, mockFulfillCall(d.gamesRandomness, later.requestId, 9_999n));

    // --- whoever holds every share cannot redeem while bets are open
    await isolated(async () => {
      // everyone else leaves (no bet is open: at once); the owner holds every share
      for (const [who, shares] of [[seller, preview - half], [buyer, buyerShares]] as const) await send(who, redeemHouseCall(d, shares, 0n, who));
      await send(seller, playCall(d, collection, 5_000, parseEther("0.1")));
      const bet = (await readUserBets(client, d, seller, REFUND))[0];
      const ownerBefore = await balanceOf(owner);
      expect(await gained(owner, ownerBefore, await send(owner, redeemHouseCall(d, S0, 0n, owner)))).toBe(0n); // recorded, not carried out
      let mine = await readHouse(client, d, owner);
      expect(mine).toMatchObject({ totalShares: S0, userShares: S0, pendingRedeem: { amount: S0, ready: false, waitingFor: 1 } });
      await send(other, mockFulfillCall(d.gamesRandomness, bet.requestId, 9_999n));
      await send(seller, playCall(d, collection, 5_000, parseEther("0.1")));
      mine = await readHouse(client, d, owner);
      // ready, since the bet it waited for has closed, but another is open and the owner is the last holder
      expect(mine.pendingRedeem).toEqual({ amount: S0, ready: true, waitingFor: 0 });
      expect(lastHolderBlocked(mine, S0)).toBe(true);
      expect(await revertOf(owner, executeRedeemHouseCall(d, 0n, owner))).toMatchObject({
        name: "BetsStillOpen",
        message: "Not yet: a bet that was open when you made the request has not finished (or you hold every share and bets are open).",
      });
    });

    // The buyer redeems everything with no bet open: carried out at once, at the fair value.
    house = await readHouse(client, d, buyer);
    const all = previewRedeem(house, buyerShares);
    expect(all).toBe(shareValue(house, buyerShares));
    before = await balanceOf(buyer);
    // Asking for all but a few raw shares takes the whole holding: the dust could never be redeemed.
    expect(redeemRequestShares(buyerShares, buyerShares - 5n)).toBe(buyerShares);
    expect(redeemRequestShares(buyerShares, buyerShares - VIRTUAL_SHARES)).toBe(buyerShares - VIRTUAL_SHARES);
    expect(await gained(buyer, before, await send(buyer, redeemHouseCall(d, buyerShares - 5n, 0n, buyer)))).toBe(all);
    house = await readHouse(client, d, buyer);
    expect(house).toMatchObject({ userShares: 0n, pendingRedeem: undefined, reserved: 0n });

    // --- the realised share price, from events: requests appear when they are carried out
    const events = (await readHouseEvents(client, d))!;
    expect(events.map((e) => e.kind)).toEqual(["deposit", "bet", "bet", "deposit", "bet", "deposit", "redeem", "bet", "redeem"]);
    expect(events[3]).toMatchObject({ kind: "deposit", amount: ETH, shares: preview });
    expect(events[4]).toMatchObject({ kind: "bet", gain: parseEther("0.099") });
    expect(events[5]).toMatchObject({ kind: "deposit", amount: 3n * ETH, shares: buyerShares });
    expect(events[6]).toMatchObject({ kind: "redeem", amount: assets, shares: half });
    expect(events[8]).toMatchObject({ kind: "redeem", amount: all, shares: buyerShares });
    const history = housePoints(events);
    const last = history[history.length - 1];
    // replayed from an empty house, the events add up to the contract's own figures to the wei
    expect(last.equity).toBe(house.bankroll);
    expect(last.shares).toBe(house.totalShares);
    expect(last.price).toBe(sharePrice(house.bankroll, house.totalShares));
    expect(last.price).toBeGreaterThan(1);
    await check(house);
  });

  it("games: the cap on all open bets together, and the owner's risk settings", async () => {
    // --- a different bankroll share and wager cap (on a snapshot of its own)
    await isolated(async () => {
      const before = await readHouse(client, d);
      await send(owner, raw(d.games, gamesAbi, "setRiskParams", [200n, 2_500n]));
      const games = await readGames(client, d, collection, seller);
      expect(games).toMatchObject({ maxWagerBps: 200n, bankrollShareBps: 2_500n, maxWager: (before.bankroll * 200n) / BPS });
      expect(await gamesRead("maxWager")).toBe(games.maxWager);
      expect((await readHouse(client, d)).bankrollShareBps).toBe(2_500n);
      expect((await readFairnessStatus(client, d)).games).toMatchObject({ maxWagerBps: 200n, bankrollShareBps: 2_500n });
      await send(seller, playCall(d, collection, 5_000, parseEther("0.1")));
      const bet = (await readUserBets(client, d, seller, REFUND))[0];
      await send(buyer, mockFulfillCall(d.gamesRandomness, bet.requestId, 9_999n));
      // a quarter of the 0.002 ETH edge stays in the bankroll
      expect(await readBetProof(client, d, bet.requestId)).toMatchObject({ paidFee: parseEther("0.002"), feeKeptByBankroll: parseEther("0.0005"), feeToTreasury: parseEther("0.0015") });
      const after = await readHouse(client, d);
      expect(after.bankroll).toBe(before.bankroll + parseEther("0.098") + parseEther("0.0005"));
      // The history replays each settled bet with the split it was settled at, not the one in
      // force now: it still adds up to the bankroll.
      const history = housePoints((await readHouseEvents(client, d))!);
      expect(history[history.length - 1]).toMatchObject({ kind: "bet", change: parseEther("0.0985"), equity: after.bankroll });
    });

    // --- the cap on all open bets together: 20% of the house's funds
    await isolated(async () => {
      let games = await readGames(client, d, collection, seller);
      expect(games.reserved).toBe(0n);
      const funds = games.bankroll;
      // Fill up with maximum bets at a 25% chance. Each reserves 1% of the remaining free bankroll
      // (the per-bet cap), until the room left under the total cap is smaller than that.
      let placed = 0;
      for (; placed < 40; placed++) {
        games = await readGames(client, d, collection, seller);
        const limits = gameLimits(games);
        expect(limits.exposure).toBe(limits.perBet < limits.totalRoom ? limits.perBet : limits.totalRoom);
        if (limits.totalRoom < limits.perBet) break;
        await send(seller, playCall(d, collection, 2_500, maxGameWager(games, 2_500)!));
      }
      expect(placed).toBeGreaterThanOrEqual(20);
      expect(placed).toBeLessThan(40);
      expect(games.bankroll + games.reserved).toBe(funds);
      // Now the total cap binds: the maximum wager is what fits in the remaining room, less than the
      // per-bet cap alone would allow.
      const limits = gameLimits(games);
      const totalLimit = (funds * 2_000n) / BPS;
      expect(limits.totalRoom).toBe(totalLimit - games.reserved);
      const capped = maxGameWager(games, 2_500)!;
      expect(gameExposure(capped, 2_500, games.edgeBps)).toBeLessThanOrEqual(limits.totalRoom);
      expect(gameExposure(capped + parseEther("0.000001"), 2_500, games.edgeBps)).toBeGreaterThan(limits.totalRoom);
      expect(gameExposure(capped + parseEther("0.0001"), 2_500, games.edgeBps)).toBeLessThan(limits.perBet);
      const overTotal = await revertOf(seller, playCall(d, collection, 2_500, capped + parseEther("0.0001")));
      expect(overTotal.name).toBe("TotalExposureTooHigh");
      expect(overTotal.args).toEqual([games.reserved + gameExposure(capped + parseEther("0.0001"), 2_500, games.edgeBps), totalLimit]);
      expect(overTotal.message).toMatch(/^Too many open bets: .* the limit is 10\.\d+ ETH\./);
      await send(seller, playCall(d, collection, 2_500, capped)); // exactly the maximum is accepted
      games = await readGames(client, d, collection, seller);
      expect(totalLimit - games.reserved).toBeLessThan(parseEther("0.0001"));
      // Nothing above the minimum bet fits any more.
      expect(maxGameWager(games, 2_500)!).toBeLessThan(games.minBet);
      expect(maxSlotsWager(games)!).toBeLessThan(games.minBet);
    });

    // --- the cap on all wagers in play together: also 20% of the house's funds
    await isolated(async () => {
      let games = await readGames(client, d, collection, seller);
      const funds = games.bankroll;
      const wagerLimit = (funds * 2_000n) / BPS;
      // Near-certain bets put little of the house's money at risk, so the exposure caps are far
      // away: each wager is the wager cap, 1% of the free bankroll, until the room for wagers runs out.
      let placed = 0;
      for (; placed < 40; placed++) {
        games = await readGames(client, d, collection, seller);
        if (gameLimits(games).wagerRoom! < games.maxWager) break;
        expect(maxGameWager(games, 9_500)).toBe(games.maxWager);
        await send(seller, playCall(d, collection, 9_500, games.maxWager));
      }
      expect(placed).toBeGreaterThanOrEqual(20);
      expect(games.bankroll + games.reserved).toBe(funds);
      const room = gameLimits(games).wagerRoom!;
      expect(room).toBe(wagerLimit - games.openWagers);
      expect(room).toBeGreaterThan(games.minBet);
      // the fourth limit binds now: the largest wager is the room left, for dice and for slots
      expect(maxGameWager(games, 9_500)).toBe(room);
      expect(maxSlotsWager(games)!).toBeLessThanOrEqual(room);
      const over = await revertOf(seller, playCall(d, collection, 9_500, room + 1n));
      expect(over).toMatchObject({ name: "TotalWagersTooHigh", args: [wagerLimit + 1n, wagerLimit] });
      expect(over.message).toMatch(/^Too much is in play already: this wager would bring the open wagers to 10\.\d+ ETH; the limit is 10\.\d+ ETH\./);
      await send(seller, playCall(d, collection, 9_500, room)); // exactly the room is accepted
      games = await readGames(client, d, collection, seller);
      expect(games.openWagers).toBe(wagerLimit);
      expect(gameLimits(games).wagerRoom).toBe(0n);
      expect(maxGameWager(games, 9_500)).toBe(0n);
      expect(maxSlotsWager(games)).toBe(0n);
      expect(await revertOf(seller, spinCall(d, collection, games.minBet))).toMatchObject({ name: "TotalWagersTooHigh" });
    });
  });

  it("lottery: buy, next round, draw and withdraw; minimum pot per round; late draws; abort timing", async () => {
    const setParams = (feeBps: bigint, minPot: bigint) => send(owner, raw(d.lottery, lotteryAbi, "setParams", [feeBps, minPot]));
    // Earlier tests moved time past the seeded round's end, so it is over but not drawn.
    let state = await readLottery(client, d, collection, owner);
    const now = await readChainTime(client);
    expect(state.current).toMatchObject({ id: 1n, status: LotteryStatus.Open, ticketsSold: 5, userTickets: 5 });
    expect(state.current!.endTime).toBeLessThan(now);
    expect(lotteryWouldRefund(state.current!, now, state.abortDelay)).toBe(false);
    const price = state.config.ticketPrice;

    expect(await revertOf(buyer, buyLotteryTicketsCall(d, d.owner, 1, price))).toMatchObject({ name: "InactiveCollection" });
    expect(await revertOf(buyer, buyLotteryTicketsCall(d, collection, 2, price / 2n))).toMatchObject({
      name: "WrongPayment",
      message: "The payment must be exactly 0.02 ETH.",
    });
    expect(await revertOf(buyer, buyLotteryTicketsCall(d, collection, 0, price))).toMatchObject({ name: "InvalidCount" });

    // --- buying after a round has ended opens the next one
    const opened = await timeOf(await send(buyer, buyLotteryTicketsCall(d, collection, 3, price)));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({
      id: 2n,
      status: LotteryStatus.Open,
      ticketPrice: price,
      ticketsSold: 3,
      endTime: opened + 7 * DAY,
      feeBps: 500,
      minPot: parseEther("0.05"),
      pot: parseEther("0.03"),
      prize: parseEther("0.0285"),
      userPaid: parseEther("0.03"),
      userTickets: 3,
    });
    expect(state.past.map((r) => r.id)).toEqual([1n]);
    expect(state.past[0]).toMatchObject({ status: LotteryStatus.Open, userTickets: 0 });

    // --- round 1: draw (anyone), mock randomness, the winner withdraws
    expect(await revertOf(seller, drawLotteryCall(d, 2n))).toMatchObject({ name: "StillOpen" });
    expect(await revertOf(seller, refundLotteryCall(d, 1n))).toMatchObject({ name: "WrongStatus" });
    await send(seller, drawLotteryCall(d, 1n));
    state = await readLottery(client, d, collection, owner);
    expect(state.past[0]).toMatchObject({ id: 1n, status: LotteryStatus.Drawing, requestId: 1n }); // its own mock provider
    expect(await revertOf(seller, resetLotteryDrawCall(d, 1n))).toMatchObject({ name: "TooEarly" });
    let budget = await budgetOf();
    await send(seller, mockFulfillCall(d.lotteryRandomness, state.past[0].requestId!, 123_457n));
    state = await readLottery(client, d, collection, owner);
    expect(state.past[0]).toMatchObject({ status: LotteryStatus.Won, winner: owner, requestId: undefined, prize: parseEther("0.0475") });
    expect(state.userOwed).toBe(parseEther("0.0475"));
    // The Verify view of the draw: 123457 mod 5 tickets = ticket 2, held by the owner.
    expect(await readDrawProof(client, d, "lottery", 1n)).toMatchObject({ ticketsSold: 5, ticket: 2n, winner: owner, ticketHolder: owner });
    expect(await readDrawProof(client, d, "lottery", 2n)).toBeUndefined();
    // 5% of the 0.05 ETH pot is the fee; the games test gave the project 20% of fees.
    expect(await budgetOf()).toBe(budget + parseEther("0.002"));
    let balance = await balanceOf(owner);
    expect(await gained(owner, balance, await send(owner, withdrawLotteryCall(d)))).toBe(parseEther("0.0475"));
    expect((await readLottery(client, d, collection, owner)).userOwed).toBe(0n);
    expect(await revertOf(owner, withdrawLotteryCall(d))).toMatchObject({ name: "NothingOwed" });

    // --- round 2 ends with a pot below the minimum: refunds
    await send(seller, buyLotteryTicketsCall(d, collection, 1, price));
    state = await readLottery(client, d, collection, seller);
    expect(state.current).toMatchObject({ id: 2n, ticketsSold: 4, userTickets: 1 });
    expect(state.current!.pot).toBeLessThan(state.current!.minPot);
    expect(lotteryWouldRefund(state.current!, state.current!.endTime, state.abortDelay)).toBe(true);
    await warpTo(state.current!.endTime);
    await send(owner, drawLotteryCall(d, 2n));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ id: 2n, status: LotteryStatus.Refunding, userPaid: parseEther("0.03") });
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, refundLotteryCall(d, 2n)))).toBe(parseEther("0.03"));
    expect(await revertOf(buyer, refundLotteryCall(d, 2n))).toMatchObject({ name: "NothingOwed" });
    expect(await revertOf(buyer, abortLotteryCall(d, 2n))).toMatchObject({ name: "WrongStatus" });
    expect((await readLottery(client, d, collection, buyer)).current).toMatchObject({ userPaid: 0n, userTickets: 0 });

    // --- round 3 opens while the owner's settings are a 3% fee and a 0.02 ETH minimum pot: it keeps
    // them. Its randomness arrives late the first time and is not used.
    await setParams(300n, parseEther("0.02"));
    await send(buyer, buyLotteryTicketsCall(d, collection, 3, price));
    expect(await readLottery(client, d, collection, buyer)).toMatchObject({ minPot: parseEther("0.02"), feeBps: 300n });
    await setParams(500n, parseEther("0.05"));
    state = await readLottery(client, d, collection, buyer);
    expect(state).toMatchObject({ minPot: parseEther("0.05"), feeBps: 500n });
    expect(state.current).toMatchObject({ id: 3n, ticketsSold: 3, feeBps: 300, minPot: parseEther("0.02"), pot: parseEther("0.03"), prize: parseEther("0.0291") });
    expect(state.past.map((r) => [r.id, r.minPot, r.feeBps])).toEqual([
      [2n, parseEther("0.05"), 500],
      [1n, parseEther("0.05"), 500],
    ]);
    let end = state.current!.endTime;
    // the 0.03 ETH pot is below the default minimum but not below the round's own
    expect(lotteryWouldRefund(state.current!, end, state.abortDelay)).toBe(false);
    expect(lotteryWouldRefund({ ...state.current!, minPot: state.minPot }, end, state.abortDelay)).toBe(true);
    await warpTo(end);
    let requested = await timeOf(await send(seller, drawLotteryCall(d, 3n)));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ status: LotteryStatus.Drawing, requestedAt: requested, requestId: 2n });
    await warpTo(requested + DAY);
    await send(seller, mockFulfillCall(d.lotteryRandomness, 2n, 1n)); // too late: the round is open again
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ status: LotteryStatus.Open, requestId: undefined });
    expect(state.userOwed).toBe(0n);
    await send(seller, drawLotteryCall(d, 3n));
    budget = await budgetOf();
    await send(seller, mockFulfillCall(d.lotteryRandomness, 3n, 1n));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ status: LotteryStatus.Won, winner: buyer });
    expect(state.userOwed).toBe(parseEther("0.0291"));
    // the round's own 3% fee, of which 20% is the project's
    expect(await budgetOf()).toBe(budget + parseEther("0.00072"));
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, withdrawLotteryCall(d)))).toBe(parseEther("0.0291"));

    // --- round 4 is drawn six and a half days late and never answered: the draw can be reset after
    // a day, and by then the round is a week past its end, so drawing it again refunds.
    await send(seller, buyLotteryTicketsCall(d, collection, 6, price));
    state = await readLottery(client, d, collection, seller);
    expect(state.current).toMatchObject({ id: 4n, ticketsSold: 6, feeBps: 500, minPot: parseEther("0.05") });
    end = state.current!.endTime;
    await warpTo(end + 6 * DAY + DAY / 2);
    expect(lotteryWouldRefund(state.current!, end + 6 * DAY + DAY / 2, state.abortDelay)).toBe(false);
    requested = await timeOf(await send(seller, drawLotteryCall(d, 4n)));
    state = await readLottery(client, d, collection, seller);
    expect(state.current!.status).toBe(LotteryStatus.Drawing);
    // not abortable while the answer to the pending request would still be accepted
    expect(abortableAt(state.current!, "drawing", state)).toBe(requested + DAY);
    await warpTo(end + 7 * DAY);
    expect(await revertOf(seller, abortLotteryCall(d, 4n))).toMatchObject({ name: "TooEarly", args: [BigInt(requested + DAY)] });
    expect(await revertOf(seller, resetLotteryDrawCall(d, 4n))).toMatchObject({ name: "TooEarly", args: [BigInt(requested + DAY)] });
    await warpTo(requested + DAY);
    await send(buyer, resetLotteryDrawCall(d, 4n)); // anyone may reset
    state = await readLottery(client, d, collection, seller);
    expect(state.current).toMatchObject({ status: LotteryStatus.Open, requestId: undefined });
    expect(lotteryWouldRefund(state.current!, requested + DAY, state.abortDelay)).toBe(true);
    await send(buyer, drawLotteryCall(d, 4n));
    state = await readLottery(client, d, collection, seller);
    expect(state.current).toMatchObject({ status: LotteryStatus.Refunding, requestId: undefined, userPaid: parseEther("0.06") });
    balance = await balanceOf(seller);
    expect(await gained(seller, balance, await send(seller, refundLotteryCall(d, 4n)))).toBe(parseEther("0.06"));

    // --- round 5 is drawn but its randomness never arrives: abort after a week, then refunds
    await send(buyer, buyLotteryTicketsCall(d, collection, 6, price));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ id: 5n, ticketsSold: 6 });
    expect(state.past.map((r) => r.id)).toEqual([4n, 3n, 2n, 1n]);
    end = state.current!.endTime;
    expect(abortableAt(state.current!, "open", state)).toBe(end + 7 * DAY);
    expect(await revertOf(seller, abortLotteryCall(d, 5n))).toMatchObject({ name: "TooEarly", args: [BigInt(end + 7 * DAY)] });
    await warpTo(end);
    await send(seller, drawLotteryCall(d, 5n));
    state = await readLottery(client, d, collection, buyer);
    expect(abortableAt(state.current!, "drawing", state)).toBe(end + 7 * DAY);
    const early = await revertOf(seller, abortLotteryCall(d, 5n));
    expect(early.name).toBe("TooEarly");
    expect(early.args).toEqual([BigInt(end + 7 * DAY)]);
    await warpTo(end + 7 * DAY);
    await send(seller, abortLotteryCall(d, 5n));
    state = await readLottery(client, d, collection, buyer);
    expect(state.current).toMatchObject({ id: 5n, status: LotteryStatus.Refunding, requestId: undefined, userPaid: parseEther("0.06") });
    balance = await balanceOf(buyer);
    expect(await gained(buyer, balance, await send(buyer, refundLotteryCall(d, 5n)))).toBe(parseEther("0.06"));
  });
});
