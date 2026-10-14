// Vault: unlock holdings whose time and price conditions are met. Opt-in: start the Dutch auction of a
// holding governance has left unlocked past its window, and restart auctions that sit at their reserve.
import type { Address } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export const VS = { None: 0, Locked: 1, Unlocked: 2, Auction: 3, Released: 4 } as const;

export interface HoldingState {
  id: bigint;
  collection: Address;
  tokenId: bigint;
  purchasePrice: bigint;
  lockedUntil: bigint;
  unlockedAt: bigint;
  status: number;
  /** `Vault.canUnlock`, read only once the time lock has passed. */
  canUnlock: boolean;
  /** Set for holdings on auction. */
  auction: { startPrice: bigint; endPrice: bigint; startTime: bigint; ownerPriced: boolean } | null;
}

export interface VaultState {
  now: bigint;
  governanceWindow: bigint;
  halfLife: bigint;
  startAuctionEnabled: boolean;
  restartAuctionEnabled: boolean;
  /** How long an auction is left at its reserve before it is restarted. */
  restartDwell: bigint;
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

export function decideVault(state: VaultState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  let waitingForFloor = 0;
  for (const h of state.holdings) {
    const act = (functionName: string, reason: string) =>
      decision.actions.push({ task: "vault", contract: "vault", functionName, args: [h.id], reason });
    const note = (level: "info" | "warn", code: string, message: string) =>
      decision.findings.push({
        task: "vault",
        level,
        code,
        message: `holding ${h.id}: ${message}`,
        data: { vaultId: h.id, collection: h.collection, tokenId: h.tokenId },
      });

    if (h.status === VS.Locked) {
      if (now < h.lockedUntil) decision.wakeAt.push(h.lockedUntil);
      else if (h.canUnlock) act("unlock", `locked until ${h.lockedUntil} and the floor is at least 130% of the purchase price`);
      else waitingForFloor++;
    } else if (h.status === VS.Unlocked) {
      const opensAt = h.unlockedAt + state.governanceWindow;
      if (now < opensAt) {
        // an unlocked holding is a lump of budget on its way: worth knowing about
        note("info", "holding_unlocked", `unlocked; governance has ${duration(opensAt - now)} left to raffle, relock or auction it`);
        decision.wakeAt.push(opensAt);
      } else if (state.startAuctionEnabled) {
        act("startAuction", `unlocked for ${duration(now - h.unlockedAt)}, past the governance window`);
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
      } else if (atReserve >= state.restartDwell) {
        act("startAuction", `auction sat at its reserve for ${duration(atReserve)} without a buyer: restart at fresh oracle prices`);
      } else {
        note("info", "auction_at_reserve", `auction at its reserve for ${duration(atReserve)}; restart after ${duration(state.restartDwell)}`);
        decision.wakeAt.push(reachedAt + state.restartDwell);
      }
    }
  }
  if (waitingForFloor > 0) {
    decision.findings.push({
      task: "vault",
      level: "info",
      code: "waiting_for_floor",
      message: `${waitingForFloor} holding(s) are past their time lock and wait for a fresh floor at 130% of the purchase price`,
      data: { holdings: waitingForFloor },
    });
  }
  return decision;
}

interface HoldingStruct {
  collection: Address;
  tokenId: bigint;
  purchasePrice: bigint;
  lockedUntil: number;
  unlockedAt: number;
  status: number;
}
interface AuctionStruct {
  startPrice: bigint;
  endPrice: bigint;
  startTime: number;
}

export async function fetchHoldings(ctx: Ctx, head: Head): Promise<HoldingState[]> {
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
      lockedUntil: BigInt(s.lockedUntil),
      unlockedAt: BigInt(s.unlockedAt),
      status: Number(s.status),
      canUnlock: false,
      auction: null,
    };
    if (holding.status === VS.Locked && head.timestamp >= holding.lockedUntil) {
      holding.canUnlock = await r.read<boolean>("vault", "canUnlock", [id]);
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

export async function fetchVault(ctx: Ctx, head: Head): Promise<VaultState> {
  const r = readerAt(ctx, head);
  const [holdings, governanceWindow, halfLife] = await Promise.all([
    fetchHoldings(ctx, head),
    r.read<bigint>("vault", "GOVERNANCE_WINDOW"),
    r.read<bigint>("vault", "AUCTION_HALF_LIFE"),
  ]);
  return {
    now: head.timestamp,
    governanceWindow,
    halfLife,
    startAuctionEnabled: ctx.config.vaultStartAuction,
    restartAuctionEnabled: ctx.config.vaultRestartAuction,
    restartDwell: ctx.config.vaultRestartDwellSeconds,
    holdings,
  };
}

export async function runVault(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchVault(ctx, head);
  const report = await carryOut(ctx, "vault", decideVault(state));
  const count = (status: number) => state.holdings.filter((h) => h.status === status).length;
  report.metrics = { locked: count(VS.Locked), unlocked: count(VS.Unlocked), onAuction: count(VS.Auction) };
  return report;
}
