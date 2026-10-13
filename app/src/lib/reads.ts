// Every on-chain read the UI makes, as plain async functions over a viem client. The React hooks in
// hooks.ts are thin react-query wrappers around these, and test/reads.anvil.test.ts calls the same
// functions against a local anvil chain.
import { parseAbi, type Address, type Client } from "viem";
import { getBlock, getCode, getContractEvents, readContract } from "viem/actions";
import {
  buybackEngineAbi,
  erc721Abi,
  gamesAbi,
  marketplaceAbi,
  pointsAbi,
  predictionMarketAbi,
  pushFloorOracleAbi,
  salesFloorOracleAbi,
  treasuryAbi,
  vaultAbi,
  vaultRaffleAbi,
} from "../generated/abis";
import type { Deployment } from "../generated/addresses";
import { decodeError } from "./errors";

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
  const block = await getBlock(client, { blockTag: "latest" });
  return Number(block.timestamp);
}

/** Whether the deployment's addresses actually hold contracts on the connected chain. */
export async function readIsDeployed(client: Client, d: Deployment): Promise<boolean> {
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
  currentBid: bigint;
  isFillable: boolean;
  active: boolean;
  basePrice: bigint;
  maxPrice: bigint;
  lastReset: number;
  growthBpsPerDay: number;
  stepDownBps: number;
};

export async function readFloorBid(client: Client, d: Deployment, collection: Address): Promise<FloorBid> {
  const engine = { address: d.buybackEngine, abi: buybackEngineAbi } as const;
  const [budget, currentBid, isFillable, bid] = await Promise.all([
    readContract(client, { address: d.treasury, abi: treasuryAbi, functionName: "budgetOf", args: [collection] }),
    readContract(client, { ...engine, functionName: "currentBid", args: [collection] }),
    readContract(client, { ...engine, functionName: "isFillable", args: [collection] }),
    readContract(client, { ...engine, functionName: "bids", args: [collection] }),
  ]);
  const [basePrice, maxPrice, lastReset, growthBpsPerDay, stepDownBps, active] = bid;
  return { budget, currentBid, isFillable, active, basePrice, maxPrice, lastReset, growthBpsPerDay, stepDownBps };
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
 * deleted, so its `remaining` reads 0). If the RPC refuses the log query (public RPCs cap the block
 * range) the most recent ids are scanned instead.
 */
export async function readOpenOffers(client: Client, d: Deployment, fromBlock = 0n): Promise<OpenOffers> {
  const market = { address: d.marketplace, abi: marketplaceAbi } as const;
  const feeBpsPromise = readContract(client, { ...market, functionName: "feeBps" });

  let ids: bigint[];
  let source: OpenOffers["source"] = "logs";
  const filled = new Map<bigint, number>();
  try {
    const logs = await getContractEvents(client, { ...market, fromBlock, toBlock: "latest" });
    const made = new Set<bigint>();
    for (const log of logs) {
      if (log.eventName === "OfferMade") made.add(log.args.offerId!);
      else if (log.eventName === "OfferCancelled") made.delete(log.args.offerId!);
      else if (log.eventName === "OfferAccepted") {
        filled.set(log.args.offerId!, (filled.get(log.args.offerId!) ?? 0) + 1);
      }
    }
    ids = [...made].sort((a, b) => (a < b ? 1 : -1));
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
};

export async function readMarkets(client: Client, d: Deployment, user?: Address): Promise<Markets> {
  const pm = { address: d.predictionMarket, abi: predictionMarketAbi } as const;
  const [marketCount, feeBps, minBet, minBettingPeriod, maxDuration] = await Promise.all([
    readContract(client, { ...pm, functionName: "marketCount" }),
    readContract(client, { ...pm, functionName: "feeBps" }),
    readContract(client, { ...pm, functionName: "minBet" }),
    readContract(client, { ...pm, functionName: "MIN_BETTING_PERIOD" }),
    readContract(client, { ...pm, functionName: "MAX_DURATION" }),
  ]);
  const markets = await Promise.all(
    recentIds(marketCount).map(async (id): Promise<Market> => {
      const [market, stake] = await Promise.all([
        readContract(client, { ...pm, functionName: "markets", args: [id] }),
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
        stake: stake ? { higher: stake[0], lower: stake[1] } : undefined,
      };
    }),
  );
  return { markets, marketCount, feeBps, minBet, minBettingPeriod: Number(minBettingPeriod), maxDuration: Number(maxDuration) };
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
  auction?: { startPrice: bigint; endPrice: bigint; startTime: number; currentPrice: bigint };
};

export type VaultState = {
  holdings: Holding[];
  holdingCount: bigint;
  owner: Address;
  /** Seconds after unlocking during which only the owner may start an auction. */
  governanceWindow: number;
  auctionDuration: number;
};

export async function readHoldings(client: Client, d: Deployment): Promise<VaultState> {
  const vault = { address: d.vault, abi: vaultAbi } as const;
  const [holdingCount, owner, governanceWindow, auctionDuration] = await Promise.all([
    readContract(client, { ...vault, functionName: "holdingCount" }),
    readContract(client, { ...vault, functionName: "owner" }),
    readContract(client, { ...vault, functionName: "GOVERNANCE_WINDOW" }),
    readContract(client, { ...vault, functionName: "AUCTION_DURATION" }),
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
        const [[startPrice, endPrice, startTime], currentPrice] = await Promise.all([
          readContract(client, { ...vault, functionName: "auctions", args: [id] }),
          readContract(client, { ...vault, functionName: "auctionPrice", args: [id] }),
        ]);
        auction = { startPrice, endPrice, startTime, currentPrice };
      }
      return { id, collection, tokenId, purchasePrice, acquiredAt, lockedUntil, unlockedAt, status, canUnlock, auction };
    }),
  );
  return {
    holdings,
    holdingCount,
    owner,
    governanceWindow: Number(governanceWindow),
    auctionDuration: Number(auctionDuration),
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
  /** After any draw is reset, no raffle can be drawn before this time (0 when no cooldown applies). */
  nextDrawAt: number;
};

export async function readRaffles(client: Client, d: Deployment): Promise<Raffles> {
  const raffle = { address: d.vaultRaffle, abi: vaultRaffleAbi } as const;
  const [raffleCount, nextDrawAt, totalPoints] = await Promise.all([
    readContract(client, { ...raffle, functionName: "raffleCount" }),
    readContract(client, { ...raffle, functionName: "nextDrawAt" }),
    readContract(client, { address: d.points, abi: pointsAbi, functionName: "totalPoints" }),
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
  return { raffles, raffleCount, totalPoints, nextDrawAt: Number(nextDrawAt) };
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
  /** Whether bets can back the given collection. */
  supported: boolean;
  /** Seconds after which an unsettled bet can be refunded. */
  refundTimeout: number;
  /** Winnings or refunds that could not be delivered to the user and wait for `withdraw`. */
  userOwed?: bigint;
};

export async function readGames(client: Client, d: Deployment, collection: Address, user?: Address): Promise<GamesState> {
  const games = { address: d.games, abi: gamesAbi } as const;
  const [bankroll, reserved, maxTotalExposureBps, edgeBps, minBet, maxExposureBps, supported, refundTimeout, userOwed] = await Promise.all([
    readContract(client, { ...games, functionName: "bankroll" }),
    readContract(client, { ...games, functionName: "reserved" }),
    readContract(client, { ...games, functionName: "MAX_TOTAL_EXPOSURE_BPS" }),
    readContract(client, { ...games, functionName: "edgeBps" }),
    readContract(client, { ...games, functionName: "minBet" }),
    readContract(client, { ...games, functionName: "maxExposureBps" }),
    readContract(client, { ...games, functionName: "isSupported", args: [collection] }),
    readContract(client, { ...games, functionName: "REFUND_TIMEOUT" }),
    user ? readContract(client, { ...games, functionName: "owedTo", args: [user] }) : undefined,
  ]);
  return {
    bankroll,
    reserved,
    maxTotalExposureBps,
    edgeBps,
    minBet,
    maxExposureBps,
    supported,
    refundTimeout: Number(refundTimeout),
    userOwed,
  };
}

export type GameQuote = { payout: bigint; fee: bigint };

/** `Games.quote`: what a winning bet pays (wager included) and the fee taken from the wager. */
export async function readGameQuote(client: Client, d: Deployment, wager: bigint, chanceBps: number): Promise<GameQuote> {
  const [payout, fee] = await readContract(client, {
    address: d.games,
    abi: gamesAbi,
    functionName: "quote",
    args: [wager, BigInt(chanceBps)],
  });
  return { payout, fee };
}

/** House money a bet puts at risk. Mirrors the arithmetic of `Games.play`. */
export function gameExposure(wager: bigint, chanceBps: number, edgeBps: bigint): bigint {
  const fee = (wager * edgeBps) / BPS;
  const payout = ((wager - fee) * BPS) / BigInt(chanceBps);
  return payout - (wager - fee);
}

export type GameLimits = {
  /** Per-bet cap: `bankroll * maxExposureBps`. */
  perBet: bigint;
  /** Room left under the cap on all open bets together: `(bankroll + reserved) * maxTotalExposureBps - reserved`. */
  totalRoom: bigint;
  /** The exposure a new bet may add: the smaller of the two. */
  exposure: bigint;
};

/** The two exposure caps `Games.play` enforces, mirrored from the contract. */
export function gameLimits(
  state: Pick<GamesState, "bankroll" | "reserved" | "maxExposureBps" | "maxTotalExposureBps">,
): GameLimits {
  const perBet = (state.bankroll * state.maxExposureBps) / BPS;
  const totalLimit = ((state.bankroll + state.reserved) * state.maxTotalExposureBps) / BPS;
  const totalRoom = totalLimit > state.reserved ? totalLimit - state.reserved : 0n;
  return { perBet, totalRoom, exposure: perBet < totalRoom ? perBet : totalRoom };
}

/**
 * Largest wager `Games.play` accepts at `chanceBps`: the one whose exposure just fits within both the
 * per-bet cap and the room left under the total-exposure cap. Undefined when the edge takes the whole
 * wager.
 */
export function maxGameWager(
  state: Pick<GamesState, "bankroll" | "reserved" | "maxExposureBps" | "maxTotalExposureBps" | "edgeBps">,
  chanceBps: number,
): bigint | undefined {
  const chance = BigInt(chanceBps);
  if (state.edgeBps >= BPS || chance >= BPS) return undefined;
  const limit = gameLimits(state).exposure;
  // exposure = wager * (1 - edge) * (1 / chance - 1), solved for the wager
  let wager = (limit * chance * BPS) / ((BPS - chance) * (BPS - state.edgeBps));
  // Integer rounding in the contract can put the estimate a few wei over the limit.
  while (wager > 0n && gameExposure(wager, chanceBps, state.edgeBps) > limit) wager -= wager > 1_000n ? 1_000n : 1n;
  return wager;
}

export type GameBet = {
  requestId: bigint;
  collection: Address;
  wager: bigint;
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
 * The user's bets, newest first, from BetPlaced / BetSettled / BetRefunded logs filtered by player.
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
  const games = { address: d.games, abi: gamesAbi } as const;
  const range = { fromBlock, toBlock: "latest", args: { player: user }, strict: true } as const;
  const [placed, settled, refunded] = await Promise.all([
    getContractEvents(client, { ...games, eventName: "BetPlaced", ...range }),
    getContractEvents(client, { ...games, eventName: "BetSettled", ...range }),
    getContractEvents(client, { ...games, eventName: "BetRefunded", ...range }),
  ]);
  const settledById = new Map(settled.map((log) => [log.args.requestId, log.args]));
  const refundedIds = new Set(refunded.map((log) => log.args.requestId));

  const bets = placed
    .map((log): GameBet => {
      const { requestId, collection, wager, chanceBps } = log.args;
      const base = { requestId, collection, wager, chanceBps: Number(chanceBps) };
      const result = settledById.get(requestId);
      if (result) {
        return { ...base, status: result.won ? "won" : "lost", roll: Number(result.roll), payout: result.payout, fee: result.fee };
      }
      return { ...base, status: refundedIds.has(requestId) ? "refunded" : "pending" };
    })
    .reverse()
    .slice(0, MAX_ITEMS);

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
