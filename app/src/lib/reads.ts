// Every on-chain read the UI makes, as plain async functions over a viem client. The React hooks in
// hooks.ts are thin react-query wrappers around these, and test/reads.anvil.test.ts calls the same
// functions against a local anvil chain.
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, formatEther, parseAbi, type Address, type Client, type Hash } from "viem";
import { getBlock, getCode, readContract } from "viem/actions";
import {
  buybackEngineAbi,
  erc721Abi,
  gamesAbi,
  ipLicenseManagerAbi,
  lotteryAbi,
  marketplaceAbi,
  pointsAbi,
  predictionMarketAbi,
  pushFloorOracleAbi,
  mockRandomnessAbi,
  salesFloorOracleAbi,
  ticketRaffleAbi,
  treasuryAbi,
  vaultAbi,
  vaultRaffleAbi,
} from "../generated/abis";
import type { Deployment } from "../generated/addresses";
import { demoReads, isDemo } from "../demo/sim";
import { decodeError } from "./errors";
import { gameExposure, slotsExposure, SLOTS_MAX_MULTIPLIER } from "./gameMath";
import { feesSentToTreasury } from "./house";
import { getEvents } from "./logs";

export * from "./gameMath";

const BPS = 10_000n;
/** Lists show at most this many of the most recent entries. */
export const MAX_ITEMS = 200;

const erc2981Abi = parseAbi([
  "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount)",
]);

/** Ids `count - MAX_ITEMS + 1 .. count`, newest first. Ids start at 1 in every contract. */
function recentIds(count: bigint): bigint[] {
  const ids: bigint[] = [];
  for (let id = count; id >= 1n && ids.length < MAX_ITEMS; id--) ids.push(id);
  return ids;
}

// ---------------------------------------------------------------- chain

/** Timestamp of the latest block. Contract deadlines are compared to this, not to the wall clock. */
export async function readChainTime(client: Client): Promise<number> {
  if (isDemo(client)) return demoReads.chainTime();
  const block = await getBlock(client, { blockTag: "latest" });
  return Number(block.timestamp);
}

/** Whether the deployment's addresses actually hold contracts on the connected chain. */
export async function readIsDeployed(client: Client, d: Deployment): Promise<boolean> {
  if (isDemo(client)) return true;
  const codes = await Promise.all(
    [d.marketplace, d.treasury, d.buybackEngine, d.vault].map((address) => getCode(client, { address })),
  );
  return codes.every((code) => code !== undefined && code !== "0x");
}

// ---------------------------------------------------------------- oracles

export type Floor =
  | { ok: true; price: bigint; updatedAt: number }
  /** `floorPrice` reverted; `reason` is the decoded custom error. */
  | { ok: false; reason: string; errorName?: string };

/** Both oracles implement IFloorOracle and revert when they have no usable price. */
export async function readFloor(client: Client, oracle: Address, collection: Address): Promise<Floor> {
  try {
    const [price, updatedAt] = await readContract(client, {
      address: oracle,
      // The two oracle ABIs share floorPrice; merging them lets either one's errors decode.
      abi: [...salesFloorOracleAbi, ...pushFloorOracleAbi.filter((item) => item.type === "error")],
      functionName: "floorPrice",
      args: [collection],
    });
    return { ok: true, price, updatedAt: Number(updatedAt) };
  } catch (error) {
    const decoded = decodeError(error);
    // Only a decoded revert means "no price". Network failures must surface as errors.
    if (!decoded.name) throw error;
    return { ok: false, reason: decoded.message, errorName: decoded.name };
  }
}

// ---------------------------------------------------------------- floor bid

export type FloorBid = {
  budget: bigint;
  /** What a seller is paid right now: the curve, limited by the budget (0 when inactive). */
  currentBid: bigint;
  /** Where the bid curve stands, whatever the budget can pay. */
  curvePrice: bigint;
  /** No buyback below this: a bid under it cannot be sold into (`BuybackEngine.minBidOf`, a share of the base, a tenth by default). */
  minBid: bigint;
  isFillable: boolean;
  active: boolean;
  basePrice: bigint;
  maxPrice: bigint;
  lastReset: number;
  growthBpsPerDay: number;
  stepDownBps: number;
  /** Seconds the engine pauses between fills for this collection (0: no pause). */
  fillCooldown: number;
  /** Earliest time of the next fill given that pause (0 before the first fill). */
  nextFillAt: number;
};

export async function readFloorBid(client: Client, d: Deployment, collection: Address): Promise<FloorBid> {
  if (isDemo(client)) return demoReads.floorBid();
  const engine = { address: d.buybackEngine, abi: buybackEngineAbi } as const;
  const [budget, currentBid, curvePrice, minBid, isFillable, bid, cooldown, lastFillAt] = await Promise.all([
    readContract(client, { address: d.treasury, abi: treasuryAbi, functionName: "budgetOf", args: [collection] }),
    readContract(client, { ...engine, functionName: "currentBid", args: [collection] }),
    readContract(client, { ...engine, functionName: "curvePrice", args: [collection] }),
    readContract(client, { ...engine, functionName: "minBidOf", args: [collection] }),
    readContract(client, { ...engine, functionName: "isFillable", args: [collection] }),
    readContract(client, { ...engine, functionName: "bids", args: [collection] }),
    readContract(client, { ...engine, functionName: "fillCooldownOf", args: [collection] }),
    readContract(client, { ...engine, functionName: "lastFillAt", args: [collection] }),
  ]);
  const nextFillAt = lastFillAt === 0n ? 0 : Number(lastFillAt + cooldown);
  const [basePrice, maxPrice, lastReset, growthBpsPerDay, stepDownBps, active] = bid;
  return { budget, currentBid, curvePrice, minBid, isFillable, active, basePrice, maxPrice, lastReset, growthBpsPerDay, stepDownBps, fillCooldown: Number(cooldown), nextFillAt };
}

// ---------------------------------------------------------------- overview

export type Overview = {
  floorBid: FloorBid;
  /** SalesFloorOracle: read by the Vault. */
  salesFloor: Floor;
  /** PushFloorOracle: read by the PredictionMarket. */
  pushFloor: Floor;
  /** Every deposit the vault ever registered, all collections. */
  holdingCount: bigint;
  /** Holdings of this collection still inside the vault (not sold or raffled). */
  collectionHoldingsInVault: number;
  /** True when the vault has more holdings than were scanned for the per-collection count. */
  holdingsTruncated: boolean;
  /**
   * Whether the Marketplace treats the collection as supported. Only then are its fees earmarked for
   * its own buybacks, do its trades earn points and do its collection-offer fills feed the oracle.
   */
  marketplaceSupported: boolean;
  /** Share of the collection's fees paid to the NFT project itself. `bps` 0 means none. */
  projectShare: { recipient: Address; bps: number };
  /** Project shares the connected user can claim from the Treasury (as a recipient, any collection). */
  userProjectShareOwed?: bigint;
  totalPoints: bigint;
  /** True while a raffle draw is in flight: pending points cannot be activated until it ends. */
  pointsFrozen: boolean;
  /** Active points: the user's weight in raffles. */
  userPoints?: bigint;
  /**
   * Points earned but not yet activated. Fees credit points here; they only count in `userPoints`
   * and `totalPoints` once `Points.flush(user)` has moved them over.
   */
  userPendingPoints?: bigint;
};

export async function readOverview(
  client: Client,
  d: Deployment,
  collection: Address,
  user?: Address,
): Promise<Overview> {
  if (isDemo(client)) return demoReads.overview();
  const pts = { address: d.points, abi: pointsAbi } as const;
  const treasury = { address: d.treasury, abi: treasuryAbi } as const;
  const [
    floorBid,
    salesFloor,
    pushFloor,
    vault,
    marketplaceSupported,
    totalPoints,
    freezeCount,
    userPoints,
    userPendingPoints,
    [shareRecipient, shareBps],
    userProjectShareOwed,
  ] = await Promise.all([
      readFloorBid(client, d, collection),
      readFloor(client, d.salesFloorOracle, collection),
      readFloor(client, d.pushFloorOracle, collection),
      readHoldings(client, d),
      readContract(client, { address: d.marketplace, abi: marketplaceAbi, functionName: "isSupported", args: [collection] }),
      readContract(client, { ...pts, functionName: "totalPoints" }),
      readContract(client, { ...pts, functionName: "freezeCount" }),
      user ? readContract(client, { ...pts, functionName: "pointsOf", args: [user] }) : undefined,
      user ? readContract(client, { ...pts, functionName: "pendingOf", args: [user] }) : undefined,
      readContract(client, { ...treasury, functionName: "projectShareOf", args: [collection] }),
      user ? readContract(client, { ...treasury, functionName: "owedTo", args: [user] }) : undefined,
    ]);
  return {
    floorBid,
    salesFloor,
    pushFloor,
    holdingCount: vault.holdingCount,
    collectionHoldingsInVault: vault.holdings.filter(
      (h) => h.collection.toLowerCase() === collection.toLowerCase() && h.status !== HoldingStatus.Released,
    ).length,
    holdingsTruncated: vault.holdingCount > BigInt(vault.holdings.length),
    marketplaceSupported,
    projectShare: { recipient: shareRecipient, bps: shareBps },
    userProjectShareOwed,
    totalPoints,
    pointsFrozen: freezeCount !== 0n,
    userPoints,
    userPendingPoints,
  };
}

// ---------------------------------------------------------------- marketplace

export type Offer = {
  id: bigint;
  offerer: Address;
  collection: Address;
  /** Meaningless when `collectionWide`. */
  tokenId: bigint;
  /** Per item, in wei. */
  price: bigint;
  remaining: number;
  expiry: number;
  collectionWide: boolean;
  /** Items already sold into this offer, from OfferAccepted logs (0 when logs were unavailable). */
  filled: number;
};

export type OpenOffers = {
  offers: Offer[];
  /** "logs": ids came from event logs. "scan": log query failed, ids 1..offerCount were read instead. */
  source: "logs" | "scan";
  feeBps: bigint;
};

/**
 * Open offers, newest first. Candidate ids come from OfferMade / OfferCancelled / OfferAccepted logs;
 * `offers(id)` is then the source of truth for what is still open (a filled or cancelled offer is
 * deleted, so its `remaining` reads 0). Cancelled and fully filled offers are dropped before the
 * newest `MAX_ITEMS` candidates are read, so they cannot crowd open ones out. The connected
 * account's own offers are found through the indexed offerer topic and are always included, so
 * nobody can push someone's Cancel button out of view by making many offers. If the RPC refuses
 * the log query the most recent ids are scanned instead.
 */
export async function readOpenOffers(client: Client, d: Deployment, fromBlock = 0n, user?: Address): Promise<OpenOffers> {
  if (isDemo(client)) return demoReads.openOffers();
  const market = { address: d.marketplace, abi: marketplaceAbi } as const;
  const feeBpsPromise = readContract(client, { ...market, functionName: "feeBps" });

  let ids: bigint[];
  let source: OpenOffers["source"] = "logs";
  const filled = new Map<bigint, number>();
  try {
    const range = { fromBlock, toBlock: "latest", strict: true } as const;
    const [made, cancelled, accepted, mine] = await Promise.all([
      getEvents(client, { ...market, eventName: "OfferMade", ...range }),
      getEvents(client, { ...market, eventName: "OfferCancelled", ...range }),
      getEvents(client, { ...market, eventName: "OfferAccepted", ...range }),
      user ? getEvents(client, { ...market, eventName: "OfferMade", args: { offerer: user }, ...range }) : [],
    ]);
    for (const log of accepted) filled.set(log.args.offerId, (filled.get(log.args.offerId) ?? 0) + 1);
    const gone = new Set(cancelled.map((log) => log.args.offerId));
    const open = (log: (typeof made)[number]) => !gone.has(log.args.offerId) && BigInt(filled.get(log.args.offerId) ?? 0) < log.args.quantity;
    const newestFirst = (a: bigint, b: bigint) => (a < b ? 1 : -1);
    const candidates = made.filter(open).map((log) => log.args.offerId).sort(newestFirst).slice(0, MAX_ITEMS);
    const own = mine.filter(open).map((log) => log.args.offerId);
    ids = [...new Set([...candidates, ...own])].sort(newestFirst);
  } catch {
    source = "scan";
    ids = recentIds(await readContract(client, { ...market, functionName: "offerCount" }));
  }

  const rows = await Promise.all(
    ids.map((id) => readContract(client, { ...market, functionName: "offers", args: [id] })),
  );
  const offers: Offer[] = [];
  rows.forEach(([offerer, collection, tokenId, price, remaining, expiry, collectionWide], i) => {
    if (remaining === 0) return;
    const id = ids[i];
    offers.push({ id, offerer, collection, tokenId, price, remaining, expiry, collectionWide, filled: filled.get(id) ?? 0 });
  });
  return { offers, source, feeBps: await feeBpsPromise };
}

export type TokenState = { owner: Address; approved: boolean };

/** Owner of a token and whether `operator` may transfer it. Throws if the token does not exist. */
export async function readTokenState(
  client: Client,
  collection: Address,
  tokenId: bigint,
  operator: Address,
): Promise<TokenState> {
  if (isDemo(client)) return demoReads.tokenState(tokenId);
  const nft = { address: collection, abi: erc721Abi } as const;
  const owner = await readContract(client, { ...nft, functionName: "ownerOf", args: [tokenId] });
  const [approvedFor, approvedForAll] = await Promise.all([
    readContract(client, { ...nft, functionName: "getApproved", args: [tokenId] }),
    readContract(client, { ...nft, functionName: "isApprovedForAll", args: [owner, operator] }),
  ]);
  return { owner, approved: approvedForAll || approvedFor.toLowerCase() === operator.toLowerCase() };
}

export type Proceeds = { fee: bigint; royalty: bigint; proceeds: bigint };

/** What `Marketplace.acceptOffer` would pay the seller right now. Mirrors the contract's arithmetic. */
export async function readExpectedProceeds(
  client: Client,
  d: Deployment,
  collection: Address,
  tokenId: bigint,
  price: bigint,
): Promise<Proceeds> {
  if (isDemo(client)) return demoReads.expectedProceeds(price);
  const market = { address: d.marketplace, abi: marketplaceAbi } as const;
  const [feeBps, royaltyCapBps] = await Promise.all([
    readContract(client, { ...market, functionName: "feeBps" }),
    readContract(client, { ...market, functionName: "royaltyCapBps" }),
  ]);
  const fee = (price * feeBps) / BPS;
  const cap = (price * royaltyCapBps) / BPS;
  let royalty = 0n;
  if (cap !== 0n) {
    try {
      const [receiver, amount] = await readContract(client, {
        address: collection,
        abi: erc2981Abi,
        functionName: "royaltyInfo",
        args: [tokenId, price],
      });
      if (BigInt(receiver) !== 0n) royalty = amount > cap ? cap : amount;
    } catch {
      // Not ERC-2981: the marketplace treats that as no royalty.
    }
  }
  return { fee, royalty, proceeds: price - fee - royalty };
}

/** `amount` reduced by `slippageBps`, for minPrice / minProceeds guards. */
export function withSlippage(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (BPS - slippageBps)) / BPS;
}

// ---------------------------------------------------------------- predictions

export const Outcome = { Pending: 0, Higher: 1, Lower: 2, Void: 3 } as const;
/** `PredictionMarket.createMarket`: a market must last at least this many times its betting period. */
export const MARKET_DURATION_PER_BETTING = 10;
export const OUTCOME_NAMES = ["Pending", "Higher", "Lower", "Void"] as const;

export type Market = {
  id: bigint;
  collection: Address;
  startPrice: bigint;
  closeTime: number;
  resolveTime: number;
  higherPool: bigint;
  lowerPool: bigint;
  outcome: number;
  /** The fee on winnings of this market, fixed when it was created. */
  feeBps: bigint;
  /** The market is void unless the price moved by at least this share of the start price; fixed at creation. */
  deadBandBps: bigint;
  /** The connected user's stake, when a user was given. */
  stake?: { higher: bigint; lower: bigint };
};

export type Markets = {
  markets: Market[];
  marketCount: bigint;
  feeBps: bigint;
  minBet: bigint;
  /** Shortest betting period and longest duration `createMarket` accepts, in seconds. */
  minBettingPeriod: number;
  maxDuration: number;
  /** The dead band new markets get, and how old a start price `createMarket` accepts, in seconds. */
  deadBandBps: bigint;
  maxStartPriceAge: number;
};

export async function readMarkets(client: Client, d: Deployment, user?: Address): Promise<Markets> {
  if (isDemo(client)) return demoReads.markets();
  const pm = { address: d.predictionMarket, abi: predictionMarketAbi } as const;
  const [marketCount, feeBps, minBet, minBettingPeriod, maxDuration, deadBandBps, maxStartPriceAge] = await Promise.all([
    readContract(client, { ...pm, functionName: "marketCount" }),
    readContract(client, { ...pm, functionName: "feeBps" }),
    readContract(client, { ...pm, functionName: "minBet" }),
    readContract(client, { ...pm, functionName: "MIN_BETTING_PERIOD" }),
    readContract(client, { ...pm, functionName: "MAX_DURATION" }),
    readContract(client, { ...pm, functionName: "deadBandBps" }),
    readContract(client, { ...pm, functionName: "maxStartPriceAge" }),
  ]);
  const markets = await Promise.all(
    recentIds(marketCount).map(async (id): Promise<Market> => {
      const [market, marketFeeBps, marketDeadBand, stake] = await Promise.all([
        readContract(client, { ...pm, functionName: "markets", args: [id] }),
        readContract(client, { ...pm, functionName: "feeBpsOf", args: [id] }),
        readContract(client, { ...pm, functionName: "deadBandBpsOf", args: [id] }),
        user ? readContract(client, { ...pm, functionName: "stakes", args: [id, user] }) : undefined,
      ]);
      const [collection, startPrice, closeTime, resolveTime, higherPool, lowerPool, outcome] = market;
      return {
        id,
        collection,
        startPrice,
        closeTime,
        resolveTime,
        higherPool,
        lowerPool,
        outcome,
        feeBps: marketFeeBps,
        deadBandBps: marketDeadBand,
        stake: stake ? { higher: stake[0], lower: stake[1] } : undefined,
      };
    }),
  );
  return { markets, marketCount, feeBps, minBet, minBettingPeriod: Number(minBettingPeriod), maxDuration: Number(maxDuration), deadBandBps, maxStartPriceAge: Number(maxStartPriceAge) };
}

/**
 * Payout per 1 ETH staked on a side if that side wins at the current pools: the stake back plus a
 * pro-rata share of the losing pool, less the fee on the winnings. Pools move until betting closes,
 * so this is indicative only. Undefined when the side has no stake yet.
 */
export function impliedMultiple(sidePool: bigint, otherPool: bigint, feeBps: bigint): number | undefined {
  if (sidePool === 0n) return undefined;
  const scale = 1_000_000n;
  const profit = (otherPool * scale) / sidePool;
  return Number(scale + (profit * (BPS - feeBps)) / BPS) / Number(scale);
}

// ---------------------------------------------------------------- vault

export const HoldingStatus = { None: 0, Locked: 1, Unlocked: 2, Auction: 3, Released: 4 } as const;
export const HOLDING_STATUS_NAMES = ["None", "Locked", "Unlocked", "Auction", "Released"] as const;

export type Holding = {
  id: bigint;
  collection: Address;
  tokenId: bigint;
  purchasePrice: bigint;
  acquiredAt: number;
  lockedUntil: number;
  unlockedAt: number;
  status: number;
  canUnlock: boolean;
  /** Present while `status` is Auction. */
  auction?: {
    startPrice: bigint;
    /** The reserve: the price stops falling here. */
    endPrice: bigint;
    startTime: number;
    currentPrice: bigint;
    /** The price has reached the reserve. An unsold auction can be restarted once it has rested there (see `auctionRestartableAt`). */
    atReserve: boolean;
    /** The owner set the prices by hand; only the owner may restart such an auction. */
    ownerPriced: boolean;
  };
};

/**
 * When a vault auction's price reaches its reserve: it halves every `halfLife`, falling linearly
 * within each period. Mirrors `Vault.auctionPrice`.
 */
export function auctionReachesReserveAt(auction: { startPrice: bigint; endPrice: bigint; startTime: number }, halfLife: number): number {
  let price = auction.startPrice;
  let periods = 0;
  // whole periods after which the price is still above the reserve
  while (periods < 128 && price / 2n > auction.endPrice) {
    price /= 2n;
    periods++;
  }
  if (price <= auction.endPrice) return auction.startTime + periods * halfLife;
  // within this period the price falls linearly from `price` by `price / 2`
  const drop = price - auction.endPrice;
  const half = price / 2n;
  const seconds = half === 0n ? 0n : (drop * BigInt(halfLife) + half - 1n) / half; // rounded up
  return auction.startTime + periods * halfLife + Number(seconds);
}

/**
 * When an unsold auction can be restarted (`Vault._checkAuctionable`): once it has rested at its
 * reserve for `dwell` seconds, counted from the end of the half-life in which its price got there.
 */
export function auctionRestartableAt(auction: { startPrice: bigint; endPrice: bigint; startTime: number }, halfLife: number, dwell: number): number {
  let price = auction.startPrice;
  let halvings = 0;
  while (price > auction.endPrice && halvings < 128) {
    price >>= 1n;
    halvings++;
  }
  return auction.startTime + halvings * halfLife + dwell;
}

export type VaultState = {
  holdings: Holding[];
  holdingCount: bigint;
  owner: Address;
  /** Seconds after unlocking during which only the owner may start an auction. */
  governanceWindow: number;
  /** An auction starts at this multiple of its reserve... */
  auctionStartMultiple: number;
  /** ...and its price halves every this many seconds until it reaches the reserve. */
  auctionHalfLife: number;
  /** An unsold auction rests at its reserve for this many seconds before it can be restarted. */
  auctionRestartDwell: number;
};

const holdingsInFlight = new WeakMap<Client, Map<string, Promise<VaultState>>>();

/**
 * The vault's holdings. Several things on one page need them (the vault, the overview, the
 * licences): reads that are asked for while one is already on its way share its answer.
 */
export function readHoldings(client: Client, d: Deployment): Promise<VaultState> {
  if (isDemo(client)) return Promise.resolve(demoReads.holdings());
  const perClient = holdingsInFlight.get(client) ?? new Map<string, Promise<VaultState>>();
  holdingsInFlight.set(client, perClient);
  const running = perClient.get(d.vault);
  if (running) return running;
  const read = fetchHoldings(client, d).finally(() => perClient.delete(d.vault));
  perClient.set(d.vault, read);
  return read;
}

async function fetchHoldings(client: Client, d: Deployment): Promise<VaultState> {
  const vault = { address: d.vault, abi: vaultAbi } as const;
  const [holdingCount, owner, governanceWindow, auctionStartMultiple, auctionHalfLife, auctionRestartDwell] = await Promise.all([
    readContract(client, { ...vault, functionName: "holdingCount" }),
    readContract(client, { ...vault, functionName: "owner" }),
    readContract(client, { ...vault, functionName: "GOVERNANCE_WINDOW" }),
    readContract(client, { ...vault, functionName: "AUCTION_START_MULTIPLE" }),
    readContract(client, { ...vault, functionName: "AUCTION_HALF_LIFE" }),
    readContract(client, { ...vault, functionName: "AUCTION_RESTART_DWELL" }),
  ]);
  const holdings = await Promise.all(
    recentIds(holdingCount).map(async (id): Promise<Holding> => {
      const [holding, canUnlock] = await Promise.all([
        readContract(client, { ...vault, functionName: "holdings", args: [id] }),
        readContract(client, { ...vault, functionName: "canUnlock", args: [id] }),
      ]);
      const [collection, tokenId, purchasePrice, acquiredAt, lockedUntil, unlockedAt, status] = holding;
      let auction: Holding["auction"];
      if (status === HoldingStatus.Auction) {
        // auctionPrice reverts unless the status is Auction, so it is only read here.
        const [[startPrice, endPrice, startTime], currentPrice, ownerPriced] = await Promise.all([
          readContract(client, { ...vault, functionName: "auctions", args: [id] }),
          readContract(client, { ...vault, functionName: "auctionPrice", args: [id] }),
          readContract(client, { ...vault, functionName: "isOwnerPriced", args: [id] }),
        ]);
        auction = { startPrice, endPrice, startTime, currentPrice, atReserve: currentPrice <= endPrice, ownerPriced };
      }
      return { id, collection, tokenId, purchasePrice, acquiredAt, lockedUntil, unlockedAt, status, canUnlock, auction };
    }),
  );
  return {
    holdings,
    holdingCount,
    owner,
    governanceWindow: Number(governanceWindow),
    auctionStartMultiple: Number(auctionStartMultiple),
    auctionHalfLife: Number(auctionHalfLife),
    auctionRestartDwell: Number(auctionRestartDwell),
  };
}

// ---------------------------------------------------------------- raffles

export const RaffleStatus = { None: 0, Open: 1, Drawing: 2, Won: 3, Claimed: 4 } as const;
export const RAFFLE_STATUS_NAMES = ["None", "Open", "Drawing", "Won", "Claimed"] as const;

export type Raffle = {
  id: bigint;
  collection: Address;
  tokenId: bigint;
  drawAfter: number;
  requestedAt: number;
  status: number;
  winner: Address;
  /** While Drawing: the randomness request in flight. */
  requestId?: bigint;
};

export type Raffles = {
  raffles: Raffle[];
  raffleCount: bigint;
  totalPoints: bigint;
  /** After any draw ends, with a winner or a reset, no raffle can be drawn before this time (0 before the first). */
  nextDrawAt: number;
  /** A draw is in flight; no other raffle can be drawn until it completes or is reset. */
  drawInFlight: boolean;
  /** No draw while fewer points than this are activated (0: no minimum). */
  minPointsToDraw: bigint;
};

export async function readRaffles(client: Client, d: Deployment): Promise<Raffles> {
  if (isDemo(client)) return demoReads.raffles();
  const raffle = { address: d.vaultRaffle, abi: vaultRaffleAbi } as const;
  const [raffleCount, nextDrawAt, freezeCount, totalPoints, minPointsToDraw] = await Promise.all([
    readContract(client, { ...raffle, functionName: "raffleCount" }),
    readContract(client, { ...raffle, functionName: "nextDrawAt" }),
    readContract(client, { address: d.points, abi: pointsAbi, functionName: "freezeCount" }),
    readContract(client, { address: d.points, abi: pointsAbi, functionName: "totalPoints" }),
    readContract(client, { ...raffle, functionName: "minPointsToDraw" }),
  ]);
  const raffles = await Promise.all(
    recentIds(raffleCount).map(async (id): Promise<Raffle> => {
      const [collection, tokenId, drawAfter, requestedAt, status, winner] = await readContract(client, {
        ...raffle,
        functionName: "raffles",
        args: [id],
      });
      const requestId =
        status === RaffleStatus.Drawing
          ? await readContract(client, { ...raffle, functionName: "currentRequest", args: [id] })
          : undefined;
      return { id, collection, tokenId, drawAfter, requestedAt, status, winner, requestId };
    }),
  );
  return { raffles, raffleCount, totalPoints, nextDrawAt: Number(nextDrawAt), drawInFlight: freezeCount !== 0n, minPointsToDraw };
}

// ---------------------------------------------------------------- games

export type GamesState = {
  /** House funds not set aside for open bets. */
  bankroll: bigint;
  /** House funds set aside to pay the open bets, should they win. */
  reserved: bigint;
  /** The most that may be `reserved` at once, as a share of `bankroll + reserved`. */
  maxTotalExposureBps: bigint;
  edgeBps: bigint;
  minBet: bigint;
  /** The most the house may stand to lose on one bet, as a share of `bankroll`. */
  maxExposureBps: bigint;
  /** The largest wager, as a share of `bankroll` (`Games.maxWagerBps`). */
  maxWagerBps: bigint;
  /** `Games.maxWager()`: the largest wager accepted right now. Below `minBet`, the bankroll is too small for any bet. */
  maxWager: bigint;
  /** The share of each edge the bankroll keeps; the rest goes to the Treasury (`Games.bankrollShareBps`). */
  bankrollShareBps: bigint;
  /** Players' wagers on the open bets. */
  openWagers: bigint;
  /** The most that may be in play at once, as a share of `bankroll + reserved` (`Games.MAX_OPEN_WAGERS_BPS`). */
  maxOpenWagersBps: bigint;
  /** No bet is accepted before this time: betting pauses for a few minutes after any refund (0: never paused). */
  betsResumeAt: number;
  /** Whether bets can back the given collection. */
  supported: boolean;
  /** Seconds after which an unsettled bet can be refunded. */
  refundTimeout: number;
  /** Winnings or refunds that could not be delivered to the user and wait for `withdraw`. */
  userOwed?: bigint;
};

export async function readGames(client: Client, d: Deployment, collection: Address, user?: Address): Promise<GamesState> {
  if (isDemo(client)) return demoReads.games();
  const games = { address: d.games, abi: gamesAbi } as const;
  const [bankroll, reserved, maxTotalExposureBps, edgeBps, minBet, maxExposureBps, maxWagerBps, bankrollShareBps, supported, refundTimeout, userOwed, openWagers, maxOpenWagersBps, betsResumeAt] = await Promise.all([
    readContract(client, { ...games, functionName: "bankroll" }),
    readContract(client, { ...games, functionName: "reserved" }),
    readContract(client, { ...games, functionName: "MAX_TOTAL_EXPOSURE_BPS" }),
    readContract(client, { ...games, functionName: "edgeBps" }),
    readContract(client, { ...games, functionName: "minBet" }),
    readContract(client, { ...games, functionName: "maxExposureBps" }),
    readContract(client, { ...games, functionName: "maxWagerBps" }),
    readContract(client, { ...games, functionName: "bankrollShareBps" }),
    readContract(client, { ...games, functionName: "isSupported", args: [collection] }),
    readContract(client, { ...games, functionName: "REFUND_TIMEOUT" }),
    user ? readContract(client, { ...games, functionName: "owedTo", args: [user] }) : undefined,
    readContract(client, { ...games, functionName: "openWagers" }),
    readContract(client, { ...games, functionName: "MAX_OPEN_WAGERS_BPS" }),
    readContract(client, { ...games, functionName: "betsResumeAt" }),
  ]);
  return {
    bankroll,
    reserved,
    openWagers,
    maxOpenWagersBps,
    betsResumeAt: Number(betsResumeAt),
    maxTotalExposureBps,
    edgeBps,
    minBet,
    maxExposureBps,
    maxWagerBps,
    maxWager: (bankroll * maxWagerBps) / BPS,
    bankrollShareBps,
    supported,
    refundTimeout: Number(refundTimeout),
    userOwed,
  };
}

export type GameQuote = { payout: bigint; fee: bigint };

/** `Games.quote`: what a winning bet pays (wager included) and the fee taken from the wager. */
export async function readGameQuote(client: Client, d: Deployment, wager: bigint, chanceBps: number): Promise<GameQuote> {
  if (isDemo(client)) return demoReads.gameQuote(wager, chanceBps);
  const [payout, fee] = await readContract(client, {
    address: d.games,
    abi: gamesAbi,
    functionName: "quote",
    args: [wager, BigInt(chanceBps)],
  });
  return { payout, fee };
}

export type GameLimits = {
  /** Per-bet cap: `bankroll * maxExposureBps`. */
  perBet: bigint;
  /** Room left under the cap on all open bets together: `(bankroll + reserved) * maxTotalExposureBps - reserved`. */
  totalRoom: bigint;
  /** The exposure a new bet may add: the smaller of the two. */
  exposure: bigint;
  /** Room left under the cap on all wagers in play: `(bankroll + reserved) * maxOpenWagersBps - openWagers`. Undefined when the state does not carry that cap. */
  wagerRoom?: bigint;
};

type LimitState = Pick<GamesState, "bankroll" | "reserved" | "maxExposureBps" | "maxTotalExposureBps"> & { maxWagerBps?: bigint; openWagers?: bigint; maxOpenWagersBps?: bigint };

/** The caps `Games._place` enforces, mirrored from the contract. */
export function gameLimits(state: LimitState): GameLimits {
  const perBet = (state.bankroll * state.maxExposureBps) / BPS;
  const totalLimit = ((state.bankroll + state.reserved) * state.maxTotalExposureBps) / BPS;
  const totalRoom = totalLimit > state.reserved ? totalLimit - state.reserved : 0n;
  let wagerRoom: bigint | undefined;
  if (state.openWagers !== undefined && state.maxOpenWagersBps !== undefined) {
    const wagerLimit = ((state.bankroll + state.reserved) * state.maxOpenWagersBps) / BPS;
    wagerRoom = wagerLimit > state.openWagers ? wagerLimit - state.openWagers : 0n;
  }
  return { perBet, totalRoom, exposure: perBet < totalRoom ? perBet : totalRoom, wagerRoom };
}

/**
 * `Games` also refuses a wager above `bankroll * maxWagerBps`, whatever its exposure, and one that
 * would bring all wagers in play above their cap.
 */
function capWager(wager: bigint, state: LimitState): bigint {
  let capped = wager;
  if (state.maxWagerBps !== undefined) {
    const cap = (state.bankroll * state.maxWagerBps) / BPS;
    if (cap < capped) capped = cap;
  }
  const { wagerRoom } = gameLimits(state);
  if (wagerRoom !== undefined && wagerRoom < capped) capped = wagerRoom;
  return capped;
}

/**
 * Largest wager `Games.play` accepts at `chanceBps`: the smallest of four limits. The one whose
 * exposure just fits within the per-bet cap and the room left under the total-exposure cap, the
 * wager cap, and the room left under the cap on all wagers in play. Undefined when the edge takes
 * the whole wager.
 */
export function maxGameWager(state: LimitState & Pick<GamesState, "edgeBps">, chanceBps: number): bigint | undefined {
  const chance = BigInt(chanceBps);
  if (state.edgeBps >= BPS || chance >= BPS) return undefined;
  const limit = gameLimits(state).exposure;
  // exposure = wager * (1 - edge) * (1 / chance - 1), solved for the wager
  let wager = (limit * chance * BPS) / ((BPS - chance) * (BPS - state.edgeBps));
  // Integer rounding in the contract can put the estimate a few wei over the limit.
  while (wager > 0n && gameExposure(wager, chanceBps, state.edgeBps) > limit) wager -= wager > 1_000n ? 1_000n : 1n;
  return capWager(wager, state);
}

/** Largest wager `Games.spin` accepts: the one whose reserve fits both exposure caps, within the two wager caps. */
export function maxSlotsWager(state: LimitState & Pick<GamesState, "edgeBps">): bigint | undefined {
  if (state.edgeBps >= BPS) return undefined;
  const limit = gameLimits(state).exposure;
  let wager = (limit * BPS) / ((SLOTS_MAX_MULTIPLIER - 1n) * (BPS - state.edgeBps));
  while (wager > 0n && slotsExposure(wager, state.edgeBps) > limit) wager -= wager > 1_000n ? 1_000n : 1n;
  return capWager(wager, state);
}

export type GameBet = {
  requestId: bigint;
  collection: Address;
  wager: bigint;
  /** "slots" for a spin (recorded on-chain with a chance of 0), "dice" for dice and coinflip. */
  kind: "dice" | "slots";
  /** Dice: the chance of winning in basis points. Slots: 0. */
  chanceBps: number;
  status: "pending" | "won" | "lost" | "refunded";
  /** Settled bets: the roll (0..9999; below `chanceBps` wins), the payout and the fee. */
  roll?: number;
  payout?: bigint;
  fee?: bigint;
  /** Pending bets: when the bet can be refunded if its randomness has not arrived. */
  refundableAt?: number;
};

/**
 * The user's bets, newest first, from BetPlaced / BetSettled / BetRefunded logs filtered by the
 * indexed player topic, so nobody else's bets can crowd them out.
 * Bets are keyed by randomness request id and cannot be enumerated on-chain, so there is no fallback
 * if the RPC refuses the log query.
 */
export async function readUserBets(
  client: Client,
  d: Deployment,
  user: Address,
  refundTimeout: number,
  fromBlock = 0n,
): Promise<GameBet[]> {
  if (isDemo(client)) return demoReads.userBets();
  const games = { address: d.games, abi: gamesAbi } as const;
  const range = { fromBlock, toBlock: "latest", args: { player: user }, strict: true } as const;
  const [placed, settled, refunded] = await Promise.all([
    getEvents(client, { ...games, eventName: "BetPlaced", ...range }),
    getEvents(client, { ...games, eventName: "BetSettled", ...range }),
    getEvents(client, { ...games, eventName: "BetRefunded", ...range }),
  ]);
  const settledById = new Map(settled.map((log) => [log.args.requestId, log.args]));
  const refundedIds = new Set(refunded.map((log) => log.args.requestId));

  const all = placed
    .map((log): GameBet => {
      const { requestId, collection, wager, chanceBps } = log.args;
      const base = { requestId, collection, wager, kind: chanceBps === 0n ? ("slots" as const) : ("dice" as const), chanceBps: Number(chanceBps) };
      const result = settledById.get(requestId);
      if (result) {
        return { ...base, status: result.won ? "won" : "lost", roll: Number(result.roll), payout: result.payout, fee: result.fee };
      }
      return { ...base, status: refundedIds.has(requestId) ? "refunded" : "pending" };
    })
    .reverse();
  // The newest `MAX_ITEMS`, and every bet that is still open however old: its Refund control must
  // not scroll out of reach.
  const bets = all.filter((bet, i) => i < MAX_ITEMS || bet.status === "pending");

  // `placedAt` of the open bets gives the moment a refund becomes possible.
  await Promise.all(
    bets
      .filter((bet) => bet.status === "pending")
      .map(async (bet) => {
        const stored = await readContract(client, { ...games, functionName: "bets", args: [bet.requestId] });
        bet.refundableAt = stored[6] + refundTimeout;
      }),
  );
  return bets;
}

// ---------------------------------------------------------------- ticket raffles

export const TicketRaffleStatus = { None: 0, Open: 1, Drawing: 2, Won: 3, Settled: 4, Refunding: 5, Cancelled: 6 } as const;
export const TICKET_RAFFLE_STATUS_NAMES = ["None", "Open", "Drawing", "Won", "Settled", "Refunding", "Cancelled"] as const;

export type TicketRaffle = {
  id: bigint;
  creator: Address;
  collection: Address;
  tokenId: bigint;
  ticketPrice: bigint;
  minTickets: number;
  maxTickets: number;
  ticketsSold: number;
  endTime: number;
  /** When the draw was requested (0 before). */
  requestedAt: number;
  status: number;
  winner: Address;
  /** The platform fee of this raffle, fixed when it was created. */
  feeBps: bigint;
  /** The smallest pot this raffle is drawn at, fixed when it was created; below it, it is refunded. */
  minPot: bigint;
  /** Whether the creator has taken the NFT back (cancelled or refunded raffles). */
  nftReturned: boolean;
  /** While Drawing: the randomness request in flight. */
  requestId?: bigint;
  /** What the user paid in and has not been refunded. */
  userPaid?: bigint;
  /** The user's tickets: `userPaid / ticketPrice`. */
  userTickets?: number;
};

export type TicketRaffles = {
  raffles: TicketRaffle[];
  raffleCount: bigint;
  /** The minimum pot new raffles get: a raffle whose ticket revenue ends below its own is refunded. */
  minPot: bigint;
  /** The fee new raffles get. */
  feeBps: bigint;
  minDuration: number;
  maxDuration: number;
  /** Seconds after which a draw without randomness can be reset. */
  drawTimeout: number;
  /** Seconds after its end (or after its winner was drawn) at which a stuck raffle can be aborted. */
  abortDelay: number;
  /** Whether the given collection may be raffled. */
  collectionSupported?: boolean;
  /** Raffle revenue waiting for the user (as a creator) to withdraw. */
  userOwed?: bigint;
};

export async function readTicketRaffles(
  client: Client,
  d: Deployment,
  user?: Address,
  collection?: Address,
): Promise<TicketRaffles> {
  if (isDemo(client)) return demoReads.ticketRaffles();
  const tr = { address: d.ticketRaffle, abi: ticketRaffleAbi } as const;
  const [raffleCount, minPot, feeBps, minDuration, maxDuration, drawTimeout, abortDelay, collectionSupported, userOwed] =
    await Promise.all([
      readContract(client, { ...tr, functionName: "raffleCount" }),
      readContract(client, { ...tr, functionName: "minPot" }),
      readContract(client, { ...tr, functionName: "feeBps" }),
      readContract(client, { ...tr, functionName: "MIN_DURATION" }),
      readContract(client, { ...tr, functionName: "MAX_DURATION" }),
      readContract(client, { ...tr, functionName: "DRAW_TIMEOUT" }),
      readContract(client, { ...tr, functionName: "ABORT_DELAY" }),
      collection ? readContract(client, { ...tr, functionName: "isSupported", args: [collection] }) : undefined,
      user ? readContract(client, { ...tr, functionName: "owedTo", args: [user] }) : undefined,
    ]);
  const raffles = await Promise.all(
    recentIds(raffleCount).map(async (id): Promise<TicketRaffle> => {
      const [raffle, raffleFeeBps, raffleMinPot, nftReturned, userPaid] = await Promise.all([
        readContract(client, { ...tr, functionName: "raffles", args: [id] }),
        readContract(client, { ...tr, functionName: "feeBpsOf", args: [id] }),
        readContract(client, { ...tr, functionName: "minPotOf", args: [id] }),
        readContract(client, { ...tr, functionName: "nftReturned", args: [id] }),
        user ? readContract(client, { ...tr, functionName: "paidBy", args: [id, user] }) : undefined,
      ]);
      const [creator, collection_, tokenId, ticketPrice, minTickets, maxTickets, ticketsSold, endTime, requestedAt, status, winner] =
        raffle;
      const requestId =
        status === TicketRaffleStatus.Drawing
          ? await readContract(client, { ...tr, functionName: "currentRequest", args: [id] })
          : undefined;
      return {
        id,
        creator,
        collection: collection_,
        tokenId,
        ticketPrice,
        minTickets,
        maxTickets,
        ticketsSold,
        endTime,
        requestedAt,
        status,
        winner,
        feeBps: raffleFeeBps,
        minPot: raffleMinPot,
        nftReturned,
        requestId,
        userPaid,
        userTickets: userPaid !== undefined && ticketPrice > 0n ? Number(userPaid / ticketPrice) : undefined,
      };
    }),
  );
  return {
    raffles,
    raffleCount,
    minPot,
    feeBps,
    minDuration: Number(minDuration),
    maxDuration: Number(maxDuration),
    drawTimeout: Number(drawTimeout),
    abortDelay: Number(abortDelay),
    collectionSupported,
    userOwed,
  };
}

/**
 * What `TicketRaffle.close` would do with the raffle as it stands: request a draw, or open refunds
 * because too few tickets sold or the pot is below the minimum. Mirrors the contract.
 */
export function ticketRaffleWouldRefund(
  raffle: Pick<TicketRaffle, "ticketsSold" | "minTickets" | "ticketPrice" | "minPot" | "endTime">,
  now: number,
  abortDelay: number,
): boolean {
  return (
    // closed a week or more after its end, a raffle is refunded rather than drawn
    now >= raffle.endTime + abortDelay ||
    raffle.ticketsSold === 0 ||
    raffle.ticketsSold < raffle.minTickets ||
    raffle.ticketPrice * BigInt(raffle.ticketsSold) < raffle.minPot
  );
}

/**
 * When anyone may abort an unfinished raffle or lottery round into refunds; undefined once it is
 * finished. While a draw is pending, never before its answer would stop being accepted. Mirrors
 * `TicketRaffle.abort` and `Lottery.abort` (a lottery round has no `won` waiting state).
 */
/** What `Lottery.draw` would do with a round right now: open refunds instead of requesting a draw. */
export function lotteryWouldRefund(round: Pick<LotteryRound, "ticketsSold" | "pot" | "minPot" | "endTime">, now: number, abortDelay: number): boolean {
  return now >= round.endTime + abortDelay || round.ticketsSold === 0 || round.pot < round.minPot;
}

export function abortableAt(
  item: { endTime: number; requestedAt: number },
  phase: "open" | "drawing" | "won" | "done",
  timing: { abortDelay: number; drawTimeout: number },
): number | undefined {
  if (phase === "open") return item.endTime + timing.abortDelay;
  if (phase === "drawing") return Math.max(item.endTime + timing.abortDelay, item.requestedAt + timing.drawTimeout);
  if (phase === "won") return item.requestedAt + timing.abortDelay;
  return undefined;
}

// ---------------------------------------------------------------- licences

/** Tier numbers probed per collection. Tiers are a free-form uint8 mapping with no on-chain list. */
export const LICENSE_TIER_PROBE = 8;

export type LicenseTier = { tier: number; price: bigint; duration: number };

export type HoldingLicense = {
  holding: Holding;
  /** Active tiers of the holding's collection (among tier numbers 0..LICENSE_TIER_PROBE-1). */
  tiers: LicenseTier[];
  /** The user's licences in force on this holding, one per tier at most, lowest tier first. */
  licenses: { tier: number; end: number }[];
  /**
   * The owner revoked a licence of the user on this holding: none of their licences on it is in
   * force and they cannot buy another until the ban is lifted.
   */
  banned?: boolean;
};

export type Licensing = {
  /** Holdings still in the vault under lock or unlocked: those a licence can be in force on. */
  holdings: HoldingLicense[];
  /** Longest usage scope the contract accepts, in bytes. */
  maxScopeLength: number;
};

export async function readLicensing(client: Client, d: Deployment, user?: Address): Promise<Licensing> {
  if (isDemo(client)) return demoReads.licensing();
  const lm = { address: d.ipLicenseManager, abi: ipLicenseManagerAbi } as const;
  const [vault, maxScopeLength] = await Promise.all([
    readHoldings(client, d),
    readContract(client, { ...lm, functionName: "MAX_SCOPE_LENGTH" }),
  ]);
  const relevant = vault.holdings.filter(
    (h) => h.status === HoldingStatus.Locked || h.status === HoldingStatus.Unlocked,
  );

  const tiersByCollection = new Map<string, Promise<LicenseTier[]>>();
  const tiersOf = (collection: Address) => {
    const key = collection.toLowerCase();
    let tiers = tiersByCollection.get(key);
    if (!tiers) {
      tiers = Promise.all(
        Array.from({ length: LICENSE_TIER_PROBE }, async (_, tier) => {
          const [price, duration, active] = await readContract(client, { ...lm, functionName: "tiers", args: [collection, tier] });
          return active ? { tier, price, duration } : undefined;
        }),
      ).then((list) => list.filter((t): t is LicenseTier => t !== undefined));
      tiersByCollection.set(key, tiers);
    }
    return tiers;
  };

  const holdings = await Promise.all(
    relevant.map(async (holding): Promise<HoldingLicense> => {
      const [tiers, banned, perTier] = await Promise.all([
        tiersOf(holding.collection),
        user ? readContract(client, { ...lm, functionName: "isBanned", args: [user, holding.id] }) : undefined,
        // A licence can outlive its tier being switched off, so every probed tier number is checked.
        user
          ? Promise.all(
              Array.from({ length: LICENSE_TIER_PROBE }, async (_, tier) => {
                const [valid, end] = await readContract(client, { ...lm, functionName: "validLicenseOf", args: [user, holding.id, tier] });
                return valid ? { tier, end } : undefined;
              }),
            )
          : [],
      ]);
      return {
        holding,
        tiers,
        licenses: (perTier as ({ tier: number; end: number } | undefined)[]).filter((l): l is { tier: number; end: number } => l !== undefined),
        banned,
      };
    }),
  );
  return { holdings, maxScopeLength: Number(maxScopeLength) };
}

// ---------------------------------------------------------------- lottery

export const LotteryStatus = { None: 0, Open: 1, Drawing: 2, Won: 3, Refunding: 4 } as const;
export const LOTTERY_STATUS_NAMES = ["None", "Open", "Drawing", "Won", "Refunding"] as const;

export type LotteryRound = {
  id: bigint;
  collection: Address;
  ticketPrice: bigint;
  ticketsSold: number;
  endTime: number;
  requestedAt: number;
  /** The fee of this round, fixed when it opened. */
  feeBps: number;
  status: number;
  winner: Address;
  /** The smallest pot this round is drawn at, fixed when it opened; below it, it is refunded. */
  minPot: bigint;
  /** `ticketPrice * ticketsSold`. */
  pot: bigint;
  /** What the winner receives: the pot less the fee. */
  prize: bigint;
  /** While Drawing: the randomness request in flight. */
  requestId?: bigint;
  /** What the user paid in and has not been refunded. */
  userPaid?: bigint;
  userTickets?: number;
};

export type LotteryState = {
  /** The collection's settings for its next round. `active` false: no new rounds open. */
  config: { ticketPrice: bigint; duration: number; active: boolean };
  /** The collection's latest round (it may have ended), if it ever had one. */
  current?: LotteryRound;
  /** Earlier rounds of this collection, newest first (among the most recent rounds of all collections). */
  past: LotteryRound[];
  /** The minimum pot new rounds get: a round whose pot ends below its own is refunded, not drawn. */
  minPot: bigint;
  /** The fee new rounds get. */
  feeBps: bigint;
  drawTimeout: number;
  abortDelay: number;
  /** Winnings waiting for the user to withdraw. */
  userOwed?: bigint;
};

export async function readLottery(client: Client, d: Deployment, collection: Address, user?: Address): Promise<LotteryState> {
  if (isDemo(client)) return demoReads.lottery();
  const lottery = { address: d.lottery, abi: lotteryAbi } as const;
  const [config, currentId, roundCount, minPot, feeBps, drawTimeout, abortDelay, userOwed] = await Promise.all([
    readContract(client, { ...lottery, functionName: "configOf", args: [collection] }),
    readContract(client, { ...lottery, functionName: "currentRoundOf", args: [collection] }),
    readContract(client, { ...lottery, functionName: "roundCount" }),
    readContract(client, { ...lottery, functionName: "minPot" }),
    readContract(client, { ...lottery, functionName: "feeBps" }),
    readContract(client, { ...lottery, functionName: "DRAW_TIMEOUT" }),
    readContract(client, { ...lottery, functionName: "ABORT_DELAY" }),
    user ? readContract(client, { ...lottery, functionName: "owedTo", args: [user] }) : undefined,
  ]);
  const rounds = (
    await Promise.all(
      recentIds(roundCount).map(async (id): Promise<LotteryRound> => {
        const [round, roundMinPot, userPaid] = await Promise.all([
          readContract(client, { ...lottery, functionName: "rounds", args: [id] }),
          readContract(client, { ...lottery, functionName: "minPotOf", args: [id] }),
          user ? readContract(client, { ...lottery, functionName: "paidBy", args: [id, user] }) : undefined,
        ]);
        const [roundCollection, ticketPrice, ticketsSold, endTime, requestedAt, roundFeeBps, status, winner] = round;
        const requestId =
          status === LotteryStatus.Drawing
            ? await readContract(client, { ...lottery, functionName: "currentRequest", args: [id] })
            : undefined;
        const pot = ticketPrice * BigInt(ticketsSold);
        return {
          id,
          collection: roundCollection,
          ticketPrice,
          ticketsSold,
          endTime,
          requestedAt,
          feeBps: roundFeeBps,
          status,
          winner,
          minPot: roundMinPot,
          pot,
          prize: pot - (pot * BigInt(roundFeeBps)) / BPS,
          requestId,
          userPaid,
          userTickets: userPaid !== undefined && ticketPrice > 0n ? Number(userPaid / ticketPrice) : undefined,
        };
      }),
    )
  ).filter((round) => round.collection.toLowerCase() === collection.toLowerCase());
  return {
    config: { ticketPrice: config[0], duration: config[1], active: config[2] },
    current: rounds.find((round) => round.id === currentId),
    past: rounds.filter((round) => round.id !== currentId),
    minPot,
    feeBps,
    drawTimeout: Number(drawTimeout),
    abortDelay: Number(abortDelay),
    userOwed,
  };
}

// ---------------------------------------------------------------- points and activity

export type PointsBalance = { active: bigint; pending: bigint };

export async function readPoints(client: Client, d: Deployment, user: Address): Promise<PointsBalance> {
  if (isDemo(client)) return demoReads.points();
  const pts = { address: d.points, abi: pointsAbi } as const;
  const [active, pending] = await Promise.all([
    readContract(client, { ...pts, functionName: "pointsOf", args: [user] }),
    readContract(client, { ...pts, functionName: "pendingOf", args: [user] }),
  ]);
  return { active, pending };
}

export type ActivityItem = {
  /** Unique within the feed. */
  key: string;
  /** Where in the app this happened, as a route (see routes.ts). */
  route: string;
  module: string;
  text: string;
  /** Who did it, when the event names an account. */
  actor?: Address;
  blockNumber: bigint;
  /** Block timestamp; missing if the block could not be read. */
  time?: number;
};

/**
 * Recent events of one collection across the protocol's modules, newest first. Only events indexed by
 * collection are used, one log query per contract. Returns an empty list if the RPC refuses the
 * queries (public RPCs cap the block range): the feed is a convenience, not a source of truth.
 */
export async function readActivity(
  client: Client,
  d: Deployment,
  collection: Address,
  fromBlock = 0n,
  limit = 12,
): Promise<ActivityItem[]> {
  if (isDemo(client)) return demoReads.activity();
  const range = { fromBlock, toBlock: "latest", args: { collection }, strict: true } as const;
  const wei = (v: bigint) => `${formatEther(v).replace(/(\.\d{0,4})\d*$/, "$1").replace(/\.?0+$/, "") || "0"} ETH`;
  let items: ActivityItem[];
  try {
    const [made, accepted, buybacks, bets, raffles, rounds, markets] = await Promise.all([
      getEvents(client, { address: d.marketplace, abi: marketplaceAbi, eventName: "OfferMade", ...range }),
      getEvents(client, { address: d.marketplace, abi: marketplaceAbi, eventName: "OfferAccepted", ...range }),
      getEvents(client, { address: d.buybackEngine, abi: buybackEngineAbi, eventName: "Buyback", ...range }),
      getEvents(client, { address: d.games, abi: gamesAbi, eventName: "BetPlaced", ...range }),
      getEvents(client, { address: d.ticketRaffle, abi: ticketRaffleAbi, eventName: "RaffleCreated", ...range }),
      getEvents(client, { address: d.lottery, abi: lotteryAbi, eventName: "RoundOpened", ...range }),
      getEvents(client, { address: d.predictionMarket, abi: predictionMarketAbi, eventName: "MarketCreated", ...range }),
    ]);
    const key = (log: { blockNumber: bigint; logIndex: number }) => `${log.blockNumber}-${log.logIndex}`;
    items = [
      ...made.map((l) => ({
        key: key(l),
        route: "/trade/marketplace",
        module: "Marketplace",
        text: l.args.collectionWide
          ? `Collection offer: ${l.args.quantity} × ${wei(l.args.price)}`
          : `Offer of ${wei(l.args.price)} for token #${l.args.tokenId}`,
        actor: l.args.offerer,
        blockNumber: l.blockNumber,
      })),
      ...accepted.map((l) => ({
        key: key(l),
        route: "/trade/marketplace",
        module: "Marketplace",
        text: `Token #${l.args.tokenId} sold for ${wei(l.args.price)} (${wei(l.args.fee)} fee)`,
        actor: l.args.seller,
        blockNumber: l.blockNumber,
      })),
      ...buybacks.map((l) => ({
        key: key(l),
        route: "/vault/holdings",
        module: "Floor bid",
        text: `Bought token #${l.args.tokenId} for ${wei(l.args.price)}, now vault holding #${l.args.vaultId}`,
        actor: l.args.seller,
        blockNumber: l.blockNumber,
      })),
      ...bets.map((l) => ({
        key: key(l),
        route: l.args.chanceBps === 0n ? "/play/slots" : "/play/dice",
        module: "Games",
        text: l.args.chanceBps === 0n ? `Slots spin of ${wei(l.args.wager)}` : `Dice bet of ${wei(l.args.wager)} at ${Number(l.args.chanceBps) / 100}%`,
        actor: l.args.player,
        blockNumber: l.blockNumber,
      })),
      ...raffles.map((l) => ({
        key: key(l),
        route: "/play/ticket-raffles",
        module: "Ticket raffle",
        text: `Raffle #${l.args.raffleId} opened for token #${l.args.tokenId} at ${wei(l.args.ticketPrice)} a ticket`,
        actor: l.args.creator,
        blockNumber: l.blockNumber,
      })),
      ...rounds.map((l) => ({
        key: key(l),
        route: "/play/lottery",
        module: "Lottery",
        text: `Lottery round #${l.args.roundId} opened at ${wei(l.args.ticketPrice)} a ticket`,
        blockNumber: l.blockNumber,
      })),
      ...markets.map((l) => ({
        key: key(l),
        route: "/play/predictions",
        module: "Predictions",
        text: `Prediction market #${l.args.marketId} opened at a ${wei(l.args.startPrice)} floor`,
        blockNumber: l.blockNumber,
      })),
    ];
  } catch {
    return [];
  }
  items.sort((a, b) => (a.blockNumber === b.blockNumber ? (a.key < b.key ? 1 : -1) : a.blockNumber < b.blockNumber ? 1 : -1));
  items = items.slice(0, limit);
  const times = new Map<bigint, number>();
  await Promise.all(
    [...new Set(items.map((item) => item.blockNumber))].map(async (blockNumber) => {
      try {
        times.set(blockNumber, Number((await getBlock(client, { blockNumber })).timestamp));
      } catch {
        // leave the time out
      }
    }),
  );
  return items.map((item) => ({ ...item, time: times.get(item.blockNumber) }));
}

// ---------------------------------------------------------------- fairness: proofs and status

export type BetProof = {
  requestId: bigint;
  wager: bigint;
  /** 0 marks a slots spin. */
  chanceBps: number;
  /** The edge the bet was placed with, in basis points. */
  edgeBps: bigint;
  /** "stored": read from the bet's record as it was just before settlement. "fee": implied by the fee paid. */
  edgeSource: "stored" | "fee";
  roll: number;
  /** What the contract actually paid and took, from the BetSettled event. */
  paidPayout: bigint;
  paidFee: bigint;
  /**
   * How the fee was split when the bet settled: the part sent to the Treasury (buyback budget plus
   * any project share), read from the Treasury's events in the settlement transaction, and the part
   * the bankroll kept. Undefined when those events could not be read; the split in force now is
   * then the only guide.
   */
  feeToTreasury?: bigint;
  feeKeptByBankroll?: bigint;
  placedTx: Hash;
  settledTx: Hash;
};

/** What the Games contract sent to the Treasury in one transaction; undefined if the node will not return the logs. */
async function feeSentToTreasury(client: Client, d: Deployment, blockNumber: bigint, tx: Hash): Promise<bigint | undefined> {
  try {
    return (await feesSentToTreasury(client, d, blockNumber, blockNumber)).get(tx) ?? 0n;
  } catch {
    return undefined;
  }
}

/** Everything needed to recompute a settled bet, from its two events. Undefined if it is not settled. */
export async function readBetProof(client: Client, d: Deployment, requestId: bigint, fromBlock = 0n): Promise<BetProof | undefined> {
  if (isDemo(client)) return demoReads.betProof(requestId);
  const games = { address: d.games, abi: gamesAbi } as const;
  const range = { fromBlock, toBlock: "latest", args: { requestId }, strict: true } as const;
  const [placed, settled] = await Promise.all([
    getEvents(client, { ...games, eventName: "BetPlaced", ...range }),
    getEvents(client, { ...games, eventName: "BetSettled", ...range }),
  ]);
  if (placed.length === 0 || settled.length === 0) return undefined;
  const bet = placed[placed.length - 1];
  const result = settled[settled.length - 1];
  const { wager, chanceBps } = bet.args;
  // The bet's record, with the edge it was placed at, is deleted at settlement. Read it as it stood
  // one block earlier; a node without that history leaves only the fee to infer it from.
  let edgeBps: bigint;
  let edgeSource: BetProof["edgeSource"] = "stored";
  try {
    const stored = await readContract(client, { ...games, functionName: "bets", args: [requestId], blockNumber: result.blockNumber - 1n });
    if (BigInt(stored[0]) === 0n) throw new Error("no record");
    edgeBps = BigInt(stored[5]);
  } catch {
    edgeSource = "fee";
    edgeBps = wager === 0n ? 0n : (result.args.fee * BPS) / wager;
    while ((wager * edgeBps) / BPS < result.args.fee) edgeBps++;
  }
  const feeToTreasury = result.args.fee === 0n ? 0n : await feeSentToTreasury(client, d, result.blockNumber, result.transactionHash);
  const splitKnown = feeToTreasury !== undefined && feeToTreasury <= result.args.fee;
  return {
    requestId,
    wager,
    chanceBps: Number(chanceBps),
    edgeBps,
    edgeSource,
    roll: Number(result.args.roll),
    paidPayout: result.args.payout,
    paidFee: result.args.fee,
    feeToTreasury: splitKnown ? feeToTreasury : undefined,
    feeKeptByBankroll: splitKnown ? result.args.fee - feeToTreasury : undefined,
    placedTx: bet.transactionHash,
    settledTx: result.transactionHash,
  };
}

export type DrawProof = {
  ticketsSold: number;
  /** The winning ticket number the contract emitted (0-based). */
  ticket: bigint;
  /** The winner the contract recorded. */
  winner: Address;
  /** Who `ownerOfTicket` says held that ticket. */
  ticketHolder: Address;
  drawTx: Hash;
};

/** The draw of a lottery round or ticket raffle: the emitted ticket and who held it. */
export async function readDrawProof(
  client: Client,
  d: Deployment,
  kind: "lottery" | "ticketRaffle",
  id: bigint,
  fromBlock = 0n,
): Promise<DrawProof | undefined> {
  if (isDemo(client)) return demoReads.drawProof(kind, id);
  const range = { fromBlock, toBlock: "latest", strict: true } as const;
  if (kind === "lottery") {
    const lottery = { address: d.lottery, abi: lotteryAbi } as const;
    const logs = await getEvents(client, { ...lottery, eventName: "RoundWon", args: { roundId: id }, ...range });
    const log = logs[logs.length - 1];
    if (!log) return undefined;
    const [round, ticketHolder] = await Promise.all([
      readContract(client, { ...lottery, functionName: "rounds", args: [id] }),
      readContract(client, { ...lottery, functionName: "ownerOfTicket", args: [id, log.args.ticket] }),
    ]);
    return { ticketsSold: round[2], ticket: log.args.ticket, winner: log.args.winner, ticketHolder, drawTx: log.transactionHash };
  }
  const raffle = { address: d.ticketRaffle, abi: ticketRaffleAbi } as const;
  const logs = await getEvents(client, { ...raffle, eventName: "WinnerDrawn", args: { raffleId: id }, ...range });
  const log = logs[logs.length - 1];
  if (!log) return undefined;
  const [data, ticketHolder] = await Promise.all([
    readContract(client, { ...raffle, functionName: "raffles", args: [id] }),
    readContract(client, { ...raffle, functionName: "ownerOfTicket", args: [id, log.args.ticket] }),
  ]);
  return { ticketsSold: data[6], ticket: log.args.ticket, winner: log.args.winner, ticketHolder, drawTx: log.transactionHash };
}

export type RandomnessSource = {
  module: "Games" | "Lottery" | "Ticket raffles" | "Vault raffles";
  provider: Address;
  /**
   * "mock": the provider answers like test/mocks/MockRandomness.sol, where whoever calls `fulfill`
   * picks the number. "unknown": anything else. The app cannot tell the Chainlink adapter from
   * another contract, so it never says more than that.
   */
  kind: "mock" | "unknown";
  /** `kind === "mock"`. */
  isMock: boolean;
};

export type FairnessStatus = {
  sources: RandomnessSource[];
  anyMock: boolean;
  /** At least one provider is not the mock, i.e. is something this app cannot identify. */
  anyUnknown: boolean;
  /** The owner of the Games contract, who can replace its randomness provider. */
  gamesOwner: Address;
  /** Whether that owner is a contract (a timelock or multisig could be) rather than a plain account. */
  ownerIsContract: boolean;
  /** `maxWagerBps`: the largest wager as a share of the bankroll. `bankrollShareBps`: the part of each edge the bankroll keeps. */
  games: { edgeBps: bigint; minBet: bigint; maxExposureBps: bigint; maxTotalExposureBps: bigint; refundTimeout: number; maxWagerBps: bigint; bankrollShareBps: bigint };
  lottery: { feeBps: bigint; minPot: bigint };
  ticketRaffle: { feeBps: bigint; minPot: bigint };
};

async function isMockRandomness(client: Client, provider: Address): Promise<boolean> {
  try {
    // Only the mock has this counter; the Chainlink adapter does not answer the call.
    await readContract(client, { address: provider, abi: mockRandomnessAbi, functionName: "lastRequestId" });
    return true;
  } catch (error) {
    // The contract refused the call (a revert, or no such function): it is not the mock. Anything
    // else is a read that failed, which says nothing about the provider and must not pass as an answer.
    const refused = error instanceof BaseError && !!error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
    if (!refused) throw error;
    return false;
  }
}

/** The on-chain facts the fairness claim depends on, for the connected chain. */
export async function readFairnessStatus(client: Client, d: Deployment): Promise<FairnessStatus> {
  if (isDemo(client)) return demoReads.fairness();
  const games = { address: d.games, abi: gamesAbi } as const;
  const lottery = { address: d.lottery, abi: lotteryAbi } as const;
  const ticketRaffle = { address: d.ticketRaffle, abi: ticketRaffleAbi } as const;
  const [gamesRng, lotteryRng, ticketRng, vaultRng, gamesOwner, edgeBps, minBet, maxExposureBps, maxTotalExposureBps, refundTimeout, lotteryFee, lotteryMinPot, raffleFee, raffleMinPot, maxWagerBps, bankrollShareBps] =
    await Promise.all([
      readContract(client, { ...games, functionName: "randomness" }),
      readContract(client, { ...lottery, functionName: "randomness" }),
      readContract(client, { ...ticketRaffle, functionName: "randomness" }),
      readContract(client, { address: d.vaultRaffle, abi: vaultRaffleAbi, functionName: "randomness" }),
      readContract(client, { ...games, functionName: "owner" }),
      readContract(client, { ...games, functionName: "edgeBps" }),
      readContract(client, { ...games, functionName: "minBet" }),
      readContract(client, { ...games, functionName: "maxExposureBps" }),
      readContract(client, { ...games, functionName: "MAX_TOTAL_EXPOSURE_BPS" }),
      readContract(client, { ...games, functionName: "REFUND_TIMEOUT" }),
      readContract(client, { ...lottery, functionName: "feeBps" }),
      readContract(client, { ...lottery, functionName: "minPot" }),
      readContract(client, { ...ticketRaffle, functionName: "feeBps" }),
      readContract(client, { ...ticketRaffle, functionName: "minPot" }),
      readContract(client, { ...games, functionName: "maxWagerBps" }),
      readContract(client, { ...games, functionName: "bankrollShareBps" }),
    ]);
  const providers = [
    ["Games", gamesRng],
    ["Lottery", lotteryRng],
    ["Ticket raffles", ticketRng],
    ["Vault raffles", vaultRng],
  ] as const;
  const [mocks, ownerCode] = await Promise.all([
    Promise.all(providers.map(([, provider]) => isMockRandomness(client, provider))),
    getCode(client, { address: gamesOwner }),
  ]);
  const sources = providers.map(([module, provider], i): RandomnessSource => ({ module, provider, kind: mocks[i] ? "mock" : "unknown", isMock: mocks[i] }));
  return {
    sources,
    anyMock: mocks.some(Boolean),
    anyUnknown: mocks.some((mock) => !mock),
    gamesOwner,
    ownerIsContract: ownerCode !== undefined && ownerCode !== "0x",
    games: { edgeBps, minBet, maxExposureBps, maxTotalExposureBps, refundTimeout: Number(refundTimeout), maxWagerBps, bankrollShareBps },
    lottery: { feeBps: lotteryFee, minPot: lotteryMinPot },
    ticketRaffle: { feeBps: raffleFee, minPot: raffleMinPot },
  };
}

/** `Vault.auctionPrice`: the current price of a holding in auction. */
export async function readAuctionPrice(client: Client, d: Deployment, vaultId: bigint): Promise<bigint> {
  if (isDemo(client)) return demoReads.auctionPrice(vaultId);
  return readContract(client, { address: d.vault, abi: vaultAbi, functionName: "auctionPrice", args: [vaultId] });
}
