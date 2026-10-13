// Integration test against a local anvil chain that has just been deployed and seeded
// (script/Deploy.s.sol + script/SeedLocal.s.sol, see app/README.md).
//
// It exercises the code the UI runs, without a browser:
//   - every read in src/lib/reads.ts (the functions behind the React hooks),
//   - every transaction builder in src/lib/calls.ts, sent the way src/tx.tsx sends them
//     (simulate with the merged error ABI, then eth_sendTransaction from an unlocked node account,
//     which is the same JSON-RPC path an injected wallet uses),
//   - custom error decoding in src/lib/errors.ts.
//
// The chain is snapshotted first and reverted afterwards, so the test can be re-run and leaves the
// seeded state as it found it. Without a reachable, deployed anvil the suite is skipped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  http,
  parseAbi,
  parseEther,
  publicActions,
  walletActions,
  type Abi,
  type Address,
} from "viem";
import { anvil } from "viem/chains";
import { erc721Abi, errorsAbi, vaultAbi } from "../src/generated/abis";
import { deployments } from "../src/generated/addresses";
import {
  acceptOfferCall,
  approveCall,
  buyCall,
  cancelOfferCall,
  claimMarketCall,
  claimRaffleCall,
  drawRaffleCall,
  flushPointsCall,
  makeCollectionOfferCall,
  makeOfferCall,
  placeBetCall,
  resolveMarketCall,
  sellCall,
  startAuctionCall,
  unlockCall,
  type Call,
} from "../src/lib/calls";
import { decodeError, type DecodedError } from "../src/lib/errors";
import {
  HoldingStatus,
  impliedMultiple,
  Outcome,
  RaffleStatus,
  readChainTime,
  readExpectedProceeds,
  readFloor,
  readFloorBid,
  readHoldings,
  readIsDeployed,
  readMarkets,
  readOpenOffers,
  readOverview,
  readRaffles,
  readTokenState,
  withSlippage,
} from "../src/lib/reads";

const client = createTestClient({
  mode: "anvil",
  chain: anvil,
  transport: http(process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545"),
  // anvil mines instantly; do not wait viem's default 4s between receipt polls.
  pollingInterval: 50,
})
  .extend(publicActions)
  .extend(walletActions);

const deployment = deployments[anvil.id];
const reachable = await client.getChainId().then(
  (id) => id === anvil.id,
  () => false,
);
const ready = reachable && !!deployment?.demoCollection && (await readIsDeployed(client, deployment));
if (!ready) {
  console.warn(
    "SKIPPED: needs anvil on 127.0.0.1:8545 with Deploy.s.sol and SeedLocal.s.sol run, and `npm run sync`.",
  );
}

const ETH = parseEther("1");
const DAY = 86_400;

/** Owner-only and mock functions used to set scenes up. The UI has no buttons for these. */
const setupAbi = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function governanceUnlock(uint256 vaultId)",
  "function sendToRaffle(uint256 vaultId) returns (uint256)",
  "function pushFloor(address collection, uint256 price)",
  "function fulfill(uint256 requestId, uint256 randomWord)",
]);

describe.skipIf(!ready)("FloorGuard app against a seeded anvil", () => {
  const d = deployment!;
  const collection = d.demoCollection!;
  let owner: Address; // anvil account #0: deployer, protocol owner, holder of the demo tokens
  let seller: Address; // account #1
  let buyer: Address; // account #2
  let snapshot: `0x${string}`;

  /** Mirrors the `send` step of src/tx.tsx. */
  async function send(account: Address, call: Call) {
    const request = { ...call, abi: [...call.abi, ...errorsAbi] as Abi, account };
    await client.simulateContract(request);
    const hash = await client.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return receipt;
  }

  /** Simulates a call that must revert and returns what the UI would show. */
  async function revertOf(account: Address, call: Call): Promise<DecodedError> {
    try {
      await client.simulateContract({ ...call, abi: [...call.abi, ...errorsAbi] as Abi, account });
    } catch (error) {
      return decodeError(error);
    }
    throw new Error(`${call.functionName} was expected to revert`);
  }

  const setup = (account: Address, address: Address, functionName: string, args: readonly unknown[]) =>
    send(account, { address, abi: setupAbi as Abi, functionName, args });

  const ownerOf = (tokenId: bigint) =>
    client.readContract({ address: collection, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] });

  beforeAll(async () => {
    [owner, seller, buyer] = await client.getAddresses();
    snapshot = await client.snapshot();
  });

  afterAll(async () => {
    await client.revert({ id: snapshot });
  });

  it("reads the seeded state", async () => {
    expect(owner.toLowerCase()).toBe(d.owner.toLowerCase());

    const overview = await readOverview(client, d, collection, owner);
    expect(overview.floorBid.budget).toBe(5n * ETH);
    expect(overview.floorBid.active).toBe(true);
    expect(overview.floorBid.isFillable).toBe(true);
    expect(overview.floorBid.basePrice).toBe(parseEther("0.9"));
    expect(overview.floorBid.maxPrice).toBe(parseEther("1.5"));
    expect(overview.floorBid.growthBpsPerDay).toBe(1_000);
    expect(overview.floorBid.stepDownBps).toBe(500);
    expect(overview.floorBid.currentBid).toBeGreaterThanOrEqual(parseEther("0.9"));
    expect(overview.floorBid.currentBid).toBeLessThan(parseEther("0.91"));
    // No floor-type sales yet: the sales oracle reverts and the UI shows the decoded reason.
    expect(overview.salesFloor).toEqual({
      ok: false,
      errorName: "InsufficientData",
      reason: "Not enough recent sales: 0 usable, 3 required.",
    });
    expect(overview.pushFloor).toMatchObject({ ok: true, price: ETH });
    expect(overview.holdingCount).toBe(0n);
    expect(overview.collectionHoldingsInVault).toBe(0);
    expect(overview.marketplaceSupported).toBe(true);
    expect(overview.totalPoints).toBe(0n);
    expect(overview.pointsFrozen).toBe(false);
    expect(overview.userPoints).toBe(0n);
    expect(overview.userPendingPoints).toBe(0n);
    // Without a connected user there is no points read.
    expect((await readOverview(client, d, collection)).userPoints).toBeUndefined();

    // A collection the protocol has never seen renders rather than throws.
    const unknown = await readOverview(client, d, "0x000000000000000000000000000000000000dEaD");
    expect(unknown.floorBid).toMatchObject({ active: false, currentBid: 0n, isFillable: false, budget: 0n });
    expect(unknown.marketplaceSupported).toBe(false);
    expect(unknown.pushFloor).toMatchObject({ ok: false, errorName: "NoPrice" });

    const { offers, source, feeBps } = await readOpenOffers(client, d);
    expect(source).toBe("logs");
    expect(feeBps).toBe(200n);
    expect(offers.map((o) => o.id)).toEqual([2n, 1n]);
    expect(offers[1]).toMatchObject({ collectionWide: true, price: ETH, remaining: 3, filled: 0, offerer: owner });
    expect(offers[0]).toMatchObject({ collectionWide: false, tokenId: 7n, price: 2n * ETH, remaining: 1 });
    expect(offers[0].collection.toLowerCase()).toBe(collection.toLowerCase());

    const { markets, marketCount, minBet, feeBps: marketFee } = await readMarkets(client, d, owner);
    expect(marketCount).toBe(1n);
    expect(minBet).toBe(parseEther("0.001"));
    expect(marketFee).toBe(300n);
    expect(markets[0]).toMatchObject({
      id: 1n,
      startPrice: ETH,
      higherPool: parseEther("0.5"),
      lowerPool: parseEther("0.3"),
      outcome: Outcome.Pending,
      stake: { higher: parseEther("0.5"), lower: parseEther("0.3") },
    });
    expect(markets[0].resolveTime - markets[0].closeTime).toBe(18 * 3_600);
    // 1 + 0.3/0.5 * 97% and 1 + 0.5/0.3 * 97%
    expect(impliedMultiple(markets[0].higherPool, markets[0].lowerPool, marketFee)).toBeCloseTo(1.582, 5);
    expect(impliedMultiple(markets[0].lowerPool, markets[0].higherPool, marketFee)).toBeCloseTo(2.616666, 5);
    expect(impliedMultiple(0n, ETH, marketFee)).toBeUndefined();
    expect((await readMarkets(client, d)).markets[0].stake).toBeUndefined();

    const vault = await readHoldings(client, d);
    expect(vault).toMatchObject({ holdings: [], holdingCount: 0n, governanceWindow: 30 * DAY, auctionDuration: 3 * DAY });
    expect(vault.owner).toBe(owner);

    expect(await readRaffles(client, d)).toEqual({ raffles: [], raffleCount: 0n, totalPoints: 0n });

    // The seed approved the marketplace for all of the owner's tokens.
    expect(await readTokenState(client, collection, 1n, d.marketplace)).toEqual({ owner, approved: true });
    const missing = await readTokenState(client, collection, 999n, d.marketplace).catch(decodeError);
    expect(missing).toMatchObject({ name: "ERC721NonexistentToken", message: "Token #999 does not exist." });
  });

  it("marketplace: approve, accept with minProceeds, make and cancel offers", async () => {
    for (const tokenId of [1n, 2n, 3n, 4n]) await setup(owner, collection, "transferFrom", [owner, seller, tokenId]);

    // Same steps as the Accept button.
    const acceptLikeTheUi = async (offerId: bigint, tokenId: bigint) => {
      const offer = (await readOpenOffers(client, d)).offers.find((o) => o.id === offerId)!;
      const token = await readTokenState(client, offer.collection, tokenId, d.marketplace);
      expect(token.owner).toBe(seller);
      if (!token.approved) await send(seller, approveCall(offer.collection, d.marketplace, tokenId));
      const expected = await readExpectedProceeds(client, d, offer.collection, tokenId, offer.price);
      // 2% fee, and the mock collection has no royalty receiver.
      expect(expected).toEqual({ fee: parseEther("0.02"), royalty: 0n, proceeds: parseEther("0.98") });
      const before = await client.getBalance({ address: seller });
      const receipt = await send(seller, acceptOfferCall(d, offerId, tokenId, withSlippage(expected.proceeds, 0n)));
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      expect((await client.getBalance({ address: seller })) - before + gas).toBe(expected.proceeds);
    };

    expect((await readTokenState(client, collection, 1n, d.marketplace)).approved).toBe(false);
    await acceptLikeTheUi(1n, 1n);
    expect(await ownerOf(1n)).toBe(owner); // the offerer
    await acceptLikeTheUi(1n, 2n);

    let { offers } = await readOpenOffers(client, d);
    expect(offers.find((o) => o.id === 1n)).toMatchObject({ remaining: 1, filled: 2 });

    // Both sides earn 2,500 points per ETH of the 0.02 ETH fee, twice. Points are pending until
    // activated; anyone may activate them for anyone (the Activate button sends this for yourself).
    let overview = await readOverview(client, d, collection, seller);
    expect(overview).toMatchObject({ userPoints: 0n, userPendingPoints: parseEther("100"), totalPoints: 0n });
    await send(buyer, flushPointsCall(d, seller));
    overview = await readOverview(client, d, collection, seller);
    expect(overview).toMatchObject({ userPoints: parseEther("100"), userPendingPoints: 0n, totalPoints: parseEther("100") });
    expect((await readOverview(client, d, collection, owner)).userPendingPoints).toBe(parseEther("100"));
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

    await send(seller, cancelOfferCall(d, 3n));
    await send(seller, cancelOfferCall(d, 4n));
    expect((await readOpenOffers(client, d)).offers.map((o) => o.id)).toEqual([2n, 1n]);
  });

  it("floor bid: approve and sell with a slippage-guarded minPrice", async () => {
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
    const balance = await client.getBalance({ address: seller });
    const receipt = await send(seller, sellCall(d, collection, 3n, withSlippage(currentBid, 100n)));
    const paid = (await client.getBalance({ address: seller })) - balance + receipt.gasUsed * receipt.effectiveGasPrice;
    expect(paid).toBeGreaterThanOrEqual(currentBid);
    expect(paid).toBeLessThan(currentBid + parseEther("0.001"));

    const after = await readFloorBid(client, d, collection);
    expect(after.budget).toBe(before.budget - paid);
    expect(after.basePrice).toBe((paid * 9_500n) / 10_000n); // stepped down 5%
    expect(await ownerOf(3n)).toBe(d.vault);

    const overview = await readOverview(client, d, collection, seller);
    expect(overview.holdingCount).toBe(1n);
    expect(overview.collectionHoldingsInVault).toBe(1);
    // Third floor-type sale: the lower median of [bid, 1, 1] ETH.
    expect(overview.salesFloor).toMatchObject({ ok: true, price: ETH });

    const { holdings } = await readHoldings(client, d);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      id: 1n,
      tokenId: 3n,
      purchasePrice: paid,
      status: HoldingStatus.Locked,
      canUnlock: false,
      auction: undefined,
    });
    expect(holdings[0].lockedUntil - holdings[0].acquiredAt).toBe(180 * DAY);
    expect(await revertOf(seller, unlockCall(d, 1n))).toMatchObject({ name: "UnlockConditionsNotMet" });
  });

  it("predictions: bet, resolve, claim", async () => {
    expect(await revertOf(seller, placeBetCall(d, 1n, false, 1n))).toMatchObject({ name: "BetTooSmall" });
    expect(await revertOf(seller, placeBetCall(d, 9n, false, ETH))).toMatchObject({ name: "UnknownMarket" });
    expect(await revertOf(seller, resolveMarketCall(d, 1n))).toMatchObject({ name: "NotResolvable" });
    expect(await revertOf(seller, claimMarketCall(d, 1n))).toMatchObject({ name: "NotResolved" });

    await send(seller, placeBetCall(d, 1n, false, parseEther("0.2")));
    let market = (await readMarkets(client, d, seller)).markets[0];
    expect(market).toMatchObject({ lowerPool: parseEther("0.5"), stake: { higher: 0n, lower: parseEther("0.2") } });

    // Past the close time betting is rejected; past the resolve time anyone can settle.
    await client.setNextBlockTimestamp({ timestamp: BigInt(market.closeTime) });
    await client.mine({ blocks: 1 });
    expect(await revertOf(seller, placeBetCall(d, 1n, true, ETH))).toMatchObject({ name: "BettingClosed" });
    await client.setNextBlockTimestamp({ timestamp: BigInt(market.resolveTime) });
    await client.mine({ blocks: 1 });
    expect(await readChainTime(client)).toBe(market.resolveTime);
    // The pushed price is now 18h+ old but within the 1 day limit; refresh it higher.
    await setup(owner, d.pushFloorOracle, "pushFloor", [collection, parseEther("1.2")]);

    await send(buyer, resolveMarketCall(d, 1n));
    market = (await readMarkets(client, d, owner)).markets[0];
    expect(market.outcome).toBe(Outcome.Higher);

    // The owner staked 0.5 on higher: 0.5 back + 0.5 of the losing pool - 3% of the winnings.
    const balance = await client.getBalance({ address: owner });
    const receipt = await send(owner, claimMarketCall(d, 1n));
    const payout = (await client.getBalance({ address: owner })) - balance + receipt.gasUsed * receipt.effectiveGasPrice;
    expect(payout).toBe(parseEther("0.985"));
    expect((await readMarkets(client, d, owner)).markets[0].stake).toEqual({ higher: 0n, lower: 0n });
    expect(await revertOf(owner, claimMarketCall(d, 1n))).toMatchObject({ name: "NothingToClaim" });
    // A losing stake claims points only.
    await send(seller, claimMarketCall(d, 1n));
  });

  it("vault: unlock, auction, buy", async () => {
    await setup(owner, d.vault, "governanceUnlock", [1n]);
    let vault = await readHoldings(client, d);
    expect(vault.holdings[0]).toMatchObject({ status: HoldingStatus.Unlocked, canUnlock: false });
    const now = await readChainTime(client);
    expect(vault.holdings[0].unlockedAt).toBe(now);

    // Within the governance window only the owner may start the auction.
    const blocked = await revertOf(seller, startAuctionCall(d, 1n));
    expect(blocked.name).toBe("GovernanceWindowOpen");
    expect(blocked.args).toEqual([BigInt(now + 30 * DAY)]);
    expect(await revertOf(buyer, buyCall(d, 1n, ETH))).toMatchObject({ name: "WrongStatus" });

    await send(owner, startAuctionCall(d, 1n));
    vault = await readHoldings(client, d);
    const holding = vault.holdings[0];
    expect(holding.status).toBe(HoldingStatus.Auction);
    // The reserve is the higher of the 1 ETH sales floor and 130% of the purchase price (~1.17 ETH).
    const reserve = (holding.purchasePrice * 13_000n) / 10_000n;
    expect(reserve).toBeGreaterThan(ETH);
    const startPrice = (reserve * 15_000n) / 10_000n;
    expect(holding.auction).toMatchObject({ startPrice, endPrice: reserve, currentPrice: startPrice });
    expect(await revertOf(owner, startAuctionCall(d, 1n))).toMatchObject({ name: "AuctionRunning" });
    expect(await revertOf(buyer, buyCall(d, 1n, ETH))).toMatchObject({
      name: "PriceNotMet",
      message: expect.stringMatching(/^The auction price is 1\.75\d* ETH but only 1 ETH was sent\.$/),
    });

    // Same steps as the Buy button: read the price, send exactly that.
    const price = await client.readContract({ address: d.vault, abi: vaultAbi, functionName: "auctionPrice", args: [1n] });
    const budget = (await readFloorBid(client, d, collection)).budget;
    const balance = await client.getBalance({ address: buyer });
    const receipt = await send(buyer, buyCall(d, 1n, price));
    const spent = balance - (await client.getBalance({ address: buyer })) - receipt.gasUsed * receipt.effectiveGasPrice;
    // The price fell between the read and the block; the excess came back.
    expect(spent).toBeLessThanOrEqual(price);
    expect(spent).toBeGreaterThan((price * 999n) / 1_000n);
    expect(await ownerOf(3n)).toBe(buyer);
    expect((await readFloorBid(client, d, collection)).budget).toBe(budget + spent);

    const overview = await readOverview(client, d, collection);
    expect(overview.holdingCount).toBe(1n);
    expect(overview.collectionHoldingsInVault).toBe(0); // released holdings are not counted
    expect((await readHoldings(client, d)).holdings[0]).toMatchObject({ status: HoldingStatus.Released, auction: undefined });
  });

  it("raffles: draw and claim", async () => {
    await send(seller, approveCall(collection, d.buybackEngine, 4n));
    const { currentBid } = await readFloorBid(client, d, collection);
    await send(seller, sellCall(d, collection, 4n, withSlippage(currentBid, 100n)));
    await setup(owner, d.vault, "governanceUnlock", [2n]);
    await setup(owner, d.vault, "sendToRaffle", [2n]);

    let state = await readRaffles(client, d);
    expect(state.raffleCount).toBe(1n);
    expect(state.totalPoints).toBeGreaterThan(0n);
    const opened = await readChainTime(client);
    expect(state.raffles[0]).toMatchObject({ id: 1n, tokenId: 4n, status: RaffleStatus.Open, drawAfter: opened + 7 * DAY });
    expect(state.raffles[0].collection.toLowerCase()).toBe(collection.toLowerCase());

    const early = await revertOf(buyer, drawRaffleCall(d, 1n));
    expect(early.name).toBe("TooEarly");
    expect(early.message).toMatch(/^Too early: possible from /);
    expect(await revertOf(buyer, claimRaffleCall(d, 1n))).toMatchObject({ name: "WrongStatus" });

    await client.setNextBlockTimestamp({ timestamp: BigInt(state.raffles[0].drawAfter) });
    await client.mine({ blocks: 1 });
    await send(buyer, drawRaffleCall(d, 1n));
    state = await readRaffles(client, d);
    expect(state.raffles[0].status).toBe(RaffleStatus.Drawing);
    expect((await readOverview(client, d, collection, seller)).pointsFrozen).toBe(true);
    expect(await revertOf(owner, flushPointsCall(d, owner))).toMatchObject({ name: "Frozen" });

    // On a local chain whoever calls the mock provider picks the random word.
    await setup(buyer, d.randomness, "fulfill", [1n, 0n]);
    state = await readRaffles(client, d);
    expect(state.raffles[0].status).toBe(RaffleStatus.Won);
    const winner = state.raffles[0].winner;
    expect(winner).toBe(seller); // the only holder of active points

    await send(buyer, claimRaffleCall(d, 1n));
    expect((await readRaffles(client, d)).raffles[0].status).toBe(RaffleStatus.Claimed);
    expect(await ownerOf(4n)).toBe(winner);

    // The push oracle's price is over a day old now; both oracle states still render.
    expect(await readFloor(client, d.pushFloorOracle, collection)).toMatchObject({ ok: true, price: parseEther("1.2") });
    expect(await readFloor(client, d.salesFloorOracle, collection)).toMatchObject({ ok: false, errorName: "InsufficientData" });
  });
});
