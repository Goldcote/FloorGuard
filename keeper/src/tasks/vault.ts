// Vault: the moving lock and what follows it.
//
// Every day, record each watched collection's oracle floor (`sampleFloor`) and ask for the day's unlock
// draw (`requestUnlockRound`); unlock the holdings the draw picked once the 30-day median floor and the
// release cap allow it (`unlock`); send holdings set aside for players to the raffle once their lock has
// ended (`releaseToPlayers`). Opt-in: start the Dutch auction of a holding governance has left unlocked
// past its window, and restart auctions that sit at their reserve.
import { type Address, getAddress, zeroAddress } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";
import { fetchCollections } from "./monitor.ts";

export const VS = { None: 0, Locked: 1, Unlocked: 2, Auction: 3, Released: 4 } as const;

const BPS = 10_000n;
const UINT128_MAX = (1n << 128n) - 1n;

export interface HoldingState {
  id: bigint;
  collection: Address;
  tokenId: bigint;
  purchasePrice: bigint;
  acquiredAt: bigint;
  lockedUntil: bigint;
  unlockedAt: bigint;
  status: number;
  /** `Vault.isPlayersHolding`: goes to the raffle after its lock, never through the draw. */
  forPlayers: boolean;
  /**
   * `Vault.requiredFloorBps` at the holding's age now. Read for locked holdings that take part in the
   * draw (lock over, not for players); null otherwise.
   */
  requiredBpsNow: bigint | null;
  /** `Vault.isPicked`: the current draw picked this holding. */
  picked: boolean;
  /** `Vault.requiredFloorBps` at the holding's age when the current draw was requested; set when picked. */
  requiredBpsAtSeed: bigint | null;
  /** `Vault.canUnlock`, read only for picked holdings. */
  canUnlock: boolean;
  /** Set for holdings on auction. */
  auction: { startPrice: bigint; endPrice: bigint; startTime: bigint; ownerPriced: boolean } | null;
}

export interface CollectionFloor {
  collection: Address;
  /** `Vault.lastSampleSlot`: the interval index of the last sample, plus one. */
  lastSampleSlot: bigint;
  /** Whether the Vault's oracle has a price `sampleFloor` would accept right now. */
  oracleFresh: boolean;
  /** `Vault.medianFloor`, null while it is not usable (fewer than 15 samples in 30 days). */
  median: bigint | null;
  /**
   * `Vault.drawMedianFloor`, the median as it stood when the current draw was requested, which is what
   * `canUnlock` compares against, where the contract has it. Undefined otherwise: `median` is used.
   */
  drawMedian?: bigint | null;
  /** `Vault.releaseAllowance`: unlocks left in the collection's current release period. */
  releaseAllowance: bigint;
}

export interface UnlockRound {
  /** `Vault.randomness() != 0`. Without it holdings unlock only by governance. */
  hasRandomness: boolean;
  pending: boolean;
  requestedAt: bigint;
  interval: bigint;
  timeout: bigint;
}

export interface VaultState {
  now: bigint;
  governanceWindow: bigint;
  halfLife: bigint;
  sampleInterval: bigint;
  startAuctionEnabled: boolean;
  restartAuctionEnabled: boolean;
  /** How long an auction is left at its reserve before it is restarted. */
  restartDwell: bigint;
  /** `Vault.AUCTION_RESTART_DWELL`: the contract refuses a restart before this. */
  minRestartDwell: bigint;
  collections: CollectionFloor[];
  round: UnlockRound;
  holdings: HoldingState[];
}

/**
 * Seconds from an auction's start until `Vault.auctionPrice` first equals its end price. The price
 * halves every half-life and falls linearly in between, exactly as in the contract.
 */
export function secondsToReserve(startPrice: bigint, endPrice: bigint, halfLife: bigint): bigint {
  for (let halvings = 0n; halvings < 128n; halvings++) {
    const price = startPrice >> halvings;
    if (price <= endPrice) return halvings * halfLife;
    const half = price / 2n;
    // smallest t with price - half * t / halfLife <= endPrice
    const needed = price - endPrice;
    const t = (needed * halfLife + half - 1n) / half;
    if (t < halfLife) return halvings * halfLife + t;
  }
  return 128n * halfLife;
}

/** The earliest time `requestUnlockRound` succeeds, mirroring the contract; `now` or earlier if it does. */
export function roundReadyAt(round: UnlockRound): bigint {
  if (round.requestedAt === 0n) return 0n;
  const afterInterval = round.requestedAt + round.interval;
  const afterTimeout = round.pending ? round.requestedAt + round.timeout : 0n;
  return afterInterval > afterTimeout ? afterInterval : afterTimeout;
}

export function decideVault(state: VaultState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  const floors = new Map(state.collections.map((c) => [getAddress(c.collection), c]));
  const floorOf = (collection: Address) => floors.get(getAddress(collection));
  const act = (functionName: string, args: readonly unknown[], reason: string) =>
    decision.actions.push({ task: "vault", contract: "vault", functionName, args, reason });
  const summary = (code: string, message: string, data: Record<string, unknown>) =>
    decision.findings.push({ task: "vault", level: "info", code, message, data });

  // ---- floor samples: one per collection per interval, only with a fresh oracle price
  const slot = now / state.sampleInterval;
  const stale: Address[] = [];
  for (const c of state.collections) {
    if (c.lastSampleSlot > slot) {
      decision.wakeAt.push((slot + 1n) * state.sampleInterval);
    } else if (c.oracleFresh) {
      act("sampleFloor", [c.collection], `no floor sample for ${c.collection} today`);
    } else {
      stale.push(c.collection);
    }
  }
  if (stale.length > 0) {
    summary("floor_not_sampled", `${stale.length} collection(s) have no fresh oracle price to sample today`, { collections: stale });
  }

  const restartDwell = state.restartDwell > state.minRestartDwell ? state.restartDwell : state.minRestartDwell;

  // ---- holdings
  const allowance = new Map(state.collections.map((c) => [getAddress(c.collection), c.releaseAllowance]));
  let waitingForDraw = 0;
  let couldUnlock = 0;
  const unlocks: bigint[] = [];
  for (const h of state.holdings) {
    const note = (level: "info" | "warn", code: string, message: string) =>
      decision.findings.push({
        task: "vault",
        level,
        code,
        message: `holding ${h.id}: ${message}`,
        data: { vaultId: h.id, collection: h.collection, tokenId: h.tokenId },
      });

    if (h.status === VS.Locked && h.forPlayers) {
      if (now < h.lockedUntil) decision.wakeAt.push(h.lockedUntil);
      else act("releaseToPlayers", [h.id], `players' holding, locked until ${h.lockedUntil}: send it to the raffle`);
    } else if (h.status === VS.Locked) {
      // takes part in draws requested from its lockedUntil on
      if (now < h.lockedUntil) {
        decision.wakeAt.push(h.lockedUntil);
        continue;
      }
      const floor = floorOf(h.collection);
      const median = floor?.median ?? null;
      if (
        h.requiredBpsNow !== null &&
        median !== null &&
        (floor?.releaseAllowance ?? 0n) > 0n &&
        median >= (h.purchasePrice * h.requiredBpsNow) / BPS
      ) {
        couldUnlock++;
      }
      if (!h.picked) {
        waitingForDraw++;
        continue;
      }
      const left = allowance.get(getAddress(h.collection)) ?? 0n;
      const drawMedian = floor?.drawMedian === undefined ? median : floor.drawMedian;
      const required = h.requiredBpsAtSeed === null ? null : (h.purchasePrice * h.requiredBpsAtSeed) / BPS;
      if (h.canUnlock && left > 0n) {
        unlocks.push(h.id);
        allowance.set(getAddress(h.collection), left - 1n);
      } else if (drawMedian === null) {
        note("info", "picked_without_median", "picked by the draw, but the collection had too few floor samples for a median");
      } else if (required !== null && drawMedian < required) {
        note("info", "picked_below_floor", `picked by the draw, but the median floor ${drawMedian} is below the required ${required}`);
      } else {
        note("info", "release_cap_reached", "picked by the draw, but the collection's weekly release cap is used up");
      }
    } else if (h.status === VS.Unlocked) {
      const opensAt = h.unlockedAt + state.governanceWindow;
      if (now < opensAt) {
        // an unlocked holding is a lump of budget on its way: worth knowing about
        note("info", "holding_unlocked", `unlocked; governance has ${duration(opensAt - now)} left to raffle, relock or auction it`);
        decision.wakeAt.push(opensAt);
      } else if (state.startAuctionEnabled) {
        act("startAuction", [h.id], `unlocked for ${duration(now - h.unlockedAt)}, past the governance window`);
      } else {
        note("warn", "governance_window_passed", `unlocked for ${duration(now - h.unlockedAt)}; anyone can start its auction (startAuction is off)`);
      }
    } else if (h.status === VS.Auction && h.auction) {
      const reachedAt = h.auction.startTime + secondsToReserve(h.auction.startPrice, h.auction.endPrice, state.halfLife);
      if (now < reachedAt) {
        decision.wakeAt.push(reachedAt);
        continue;
      }
      const atReserve = now - reachedAt;
      if (h.auction.ownerPriced) {
        note("info", "auction_at_reserve", `owner-priced auction has been at its end price for ${duration(atReserve)}; only the owner can restart it`);
      } else if (!state.restartAuctionEnabled) {
        note("warn", "auction_at_reserve", `auction has been at its reserve ${h.auction.endPrice} for ${duration(atReserve)} without a buyer; anyone can restart it (restart is off)`);
      } else if (atReserve >= restartDwell) {
        act("startAuction", [h.id], `auction sat at its reserve for ${duration(atReserve)} without a buyer: restart at fresh oracle prices`);
      } else {
        note("info", "auction_at_reserve", `auction at its reserve for ${duration(atReserve)}; restart after ${duration(restartDwell)}`);
        decision.wakeAt.push(reachedAt + restartDwell);
      }
    }
  }
  // unlocks use the current draw: send them before a new draw is requested
  const auctions = decision.actions.filter((a) => a.functionName === "startAuction");
  decision.actions = decision.actions.filter((a) => a.functionName !== "startAuction");
  for (const id of unlocks) act("unlock", [id], "picked by the draw, the median floor meets the required multiple and the release cap has room");

  // ---- the daily draw: only when some holding could unlock if picked, since every request costs a fee
  if (couldUnlock > 0) {
    const readyAt = roundReadyAt(state.round);
    if (!state.round.hasRandomness) {
      decision.findings.push({
        task: "vault",
        level: "warn",
        code: "no_randomness",
        message: `${couldUnlock} holding(s) could unlock if picked, but the Vault has no randomness provider: no draw can be requested`,
        data: { holdings: couldUnlock },
      });
    } else if (now >= readyAt) {
      act("requestUnlockRound", [], `${couldUnlock} holding(s) take part and meet the floor today`);
    } else {
      decision.wakeAt.push(readyAt);
    }
  }
  decision.actions.push(...auctions);

  if (waitingForDraw > 0) {
    summary("waiting_for_draw", `${waitingForDraw} holding(s) are past the minimum lock and wait to be picked by the daily draw`, {
      holdings: waitingForDraw,
      meetFloor: couldUnlock,
    });
  }
  return decision;
}

interface HoldingStruct {
  collection: Address;
  tokenId: bigint;
  purchasePrice: bigint;
  acquiredAt: number;
  lockedUntil: number;
  unlockedAt: number;
  status: number;
}
interface AuctionStruct {
  startPrice: bigint;
  endPrice: bigint;
  startTime: number;
}

export async function fetchHoldings(ctx: Ctx, head: Head, seedRequestedAt: bigint): Promise<HoldingState[]> {
  const r = readerAt(ctx, head);
  const count = await r.read<bigint>("vault", "holdingCount");
  const from = ctx.cache.watermark("holdings");
  const holdings = await r.map(range(from, count), async (id): Promise<HoldingState> => {
    const s = await r.struct<HoldingStruct>("vault", "holdings", [id]);
    const holding: HoldingState = {
      id,
      collection: s.collection,
      tokenId: s.tokenId,
      purchasePrice: s.purchasePrice,
      acquiredAt: BigInt(s.acquiredAt),
      lockedUntil: BigInt(s.lockedUntil),
      unlockedAt: BigInt(s.unlockedAt),
      status: Number(s.status),
      forPlayers: false,
      requiredBpsNow: null,
      picked: false,
      requiredBpsAtSeed: null,
      canUnlock: false,
      auction: null,
    };
    if (holding.status === VS.Locked) {
      holding.forPlayers = await r.read<boolean>("vault", "isPlayersHolding", [id]);
      if (!holding.forPlayers && head.timestamp >= holding.lockedUntil) {
        const [requiredNow, picked] = await Promise.all([
          r.read<bigint>("vault", "requiredFloorBps", [head.timestamp - holding.acquiredAt]),
          r.read<boolean>("vault", "isPicked", [id]),
        ]);
        holding.requiredBpsNow = requiredNow;
        holding.picked = picked;
        if (picked) {
          const [atSeed, canUnlock] = await Promise.all([
            r.read<bigint>("vault", "requiredFloorBps", [seedRequestedAt - holding.acquiredAt]),
            r.read<boolean>("vault", "canUnlock", [id]),
          ]);
          holding.requiredBpsAtSeed = atSeed;
          holding.canUnlock = canUnlock;
        }
      }
    } else if (holding.status === VS.Auction) {
      const [a, ownerPriced] = await Promise.all([
        r.struct<AuctionStruct>("vault", "auctions", [id]),
        r.read<boolean>("vault", "isOwnerPriced", [id]),
      ]);
      holding.auction = { startPrice: a.startPrice, endPrice: a.endPrice, startTime: BigInt(a.startTime), ownerPriced };
    }
    return holding;
  });
  ctx.cache.setWatermark("holdings", firstOpen(holdings, (h) => h.status === VS.Released, from, count));
  return holdings;
}

/** Floor-sample state of each collection: those the keeper watches and those the Vault holds. */
export async function fetchFloors(ctx: Ctx, head: Head, holdings: HoldingState[]): Promise<CollectionFloor[]> {
  const r = readerAt(ctx, head);
  const watched = new Set((await fetchCollections(ctx, head)).map((c) => getAddress(c)));
  for (const h of holdings) if (h.status !== VS.Released) watched.add(getAddress(h.collection));
  const hasDrawMedian = ctx.abis.vault.some((i) => i.type === "function" && i.name === "drawMedianFloor");
  const [oracle, maxOracleAge] = await Promise.all([
    r.read<Address>("vault", "oracle"),
    r.read<bigint>("vault", "maxOracleAge"),
  ]);
  return r.map([...watched].sort(), async (collection): Promise<CollectionFloor> => {
    const [lastSampleSlot, median, drawMedian, releaseAllowance, price] = await Promise.all([
      r.read<bigint>("vault", "lastSampleSlot", [collection]),
      r.read<readonly [boolean, bigint]>("vault", "medianFloor", [collection]),
      hasDrawMedian ? r.read<readonly [boolean, bigint]>("vault", "drawMedianFloor", [collection]) : undefined,
      r.read<bigint>("vault", "releaseAllowance", [collection]),
      // the sales oracle reverts while it has too few observations
      r.tryRead<readonly [bigint, bigint]>("floorOracle", "floorPrice", [collection], oracle),
    ]);
    // `sampleFloor` is mined in a later block: leave a minute of margin on the oracle's age
    const oracleFresh =
      price !== undefined && price[0] !== 0n && price[0] <= UINT128_MAX && price[1] + maxOracleAge >= head.timestamp + 60n;
    return {
      collection,
      lastSampleSlot,
      oracleFresh,
      median: median[0] ? median[1] : null,
      ...(drawMedian === undefined ? {} : { drawMedian: drawMedian[0] ? drawMedian[1] : null }),
      releaseAllowance,
    };
  });
}

export async function fetchVault(ctx: Ctx, head: Head): Promise<VaultState> {
  const r = readerAt(ctx, head);
  const [governanceWindow, halfLife, minRestartDwell, sampleInterval, randomness, pending, requestedAt, interval, timeout, seedRequestedAt] =
    await Promise.all([
      r.read<bigint>("vault", "GOVERNANCE_WINDOW"),
      r.read<bigint>("vault", "AUCTION_HALF_LIFE"),
      r.read<bigint>("vault", "AUCTION_RESTART_DWELL"),
      r.read<bigint>("vault", "SAMPLE_INTERVAL"),
      r.read<Address>("vault", "randomness"),
      r.read<boolean>("vault", "roundPending"),
      r.read<number | bigint>("vault", "roundRequestedAt"),
      r.read<bigint>("vault", "ROUND_INTERVAL"),
      r.read<bigint>("vault", "ROUND_TIMEOUT"),
      r.read<number | bigint>("vault", "seedRequestedAt"),
    ]);
  const holdings = await fetchHoldings(ctx, head, BigInt(seedRequestedAt));
  const collections = await fetchFloors(ctx, head, holdings);
  return {
    now: head.timestamp,
    governanceWindow,
    halfLife,
    sampleInterval,
    startAuctionEnabled: ctx.config.vaultStartAuction,
    restartAuctionEnabled: ctx.config.vaultRestartAuction,
    restartDwell: ctx.config.vaultRestartDwellSeconds,
    minRestartDwell,
    collections,
    round: { hasRandomness: randomness !== zeroAddress, pending, requestedAt: BigInt(requestedAt), interval, timeout },
    holdings,
  };
}

export async function runVault(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchVault(ctx, head);
  const report = await carryOut(ctx, "vault", decideVault(state));
  const count = (status: number) => state.holdings.filter((h) => h.status === status).length;
  report.metrics = {
    locked: count(VS.Locked),
    forPlayers: state.holdings.filter((h) => h.status === VS.Locked && h.forPlayers).length,
    unlocked: count(VS.Unlocked),
    onAuction: count(VS.Auction),
    collections: state.collections.length,
  };
  return report;
}
