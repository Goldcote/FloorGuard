// The house: shares in the games bankroll (`Games.deposit` / `Games.redeem`). The share arithmetic
// mirrors the contract exactly and is shared by the page, the demo simulator and the tests; the
// reads return the state and the realised history from events.
import type { Address, Client } from "viem";
import { getContractEvents, readContract } from "viem/actions";
import { demoReads, isDemo } from "../demo/sim";
import { gamesAbi } from "../generated/abis";
import type { Deployment } from "../generated/addresses";

const BPS = 10_000n;
/** `Games.VIRTUAL_SHARES`: makes the first deposit's price well defined and rounding attacks pointless. */
export const VIRTUAL_SHARES = 1_000_000n;
/** Shares are shown in units of a million raw shares: one unit is what 1 wei bought at the start. */
export const SHARE_UNIT = VIRTUAL_SHARES;

export type HouseFunds = {
  /** House funds not set aside for open bets. */
  bankroll: bigint;
  /** House funds set aside to pay the open bets, should they win. */
  reserved: bigint;
  /** Players' wagers on the open bets. */
  openWagers: bigint;
  totalShares: bigint;
};

/** `Games.previewDeposit`: shares for a deposit, priced as if the house wins every open bet. */
export function previewDeposit(h: HouseFunds, assets: bigint): bigint {
  return (assets * (h.totalShares + VIRTUAL_SHARES)) / (h.bankroll + h.reserved + h.openWagers + 1n);
}

/** `Games.previewRedeem`: what shares pay, priced as if the house loses every open bet. */
export function previewRedeem(h: HouseFunds, shares: bigint): bigint {
  return (shares * (h.bankroll + 1n)) / (h.totalShares + VIRTUAL_SHARES);
}

/**
 * What redeeming `shares` right now leaves behind: their part of the funds set aside for open bets
 * and of the wagers in play, which stays with the remaining holders. Zero when no bet is open.
 */
export function leftBehind(h: HouseFunds, shares: bigint): bigint {
  return (shares * (h.reserved + h.openWagers)) / (h.totalShares + VIRTUAL_SHARES);
}

/** A minimum a little under a preview, for `minShares` / `minAssets`. */
export function withTolerance(amount: bigint, toleranceBps: bigint): bigint {
  return (amount * (BPS - toleranceBps)) / BPS;
}

/** Redeem value of one share unit in wei-per-wei terms, as a float: 1 at the very first deposit. */
export function sharePrice(equity: bigint, totalShares: bigint): number {
  return Number(((equity + 1n) * 1_000_000_000n * SHARE_UNIT) / (totalShares + VIRTUAL_SHARES)) / 1e9;
}

export type HouseState = HouseFunds & {
  /** The share of each edge the bankroll keeps; the rest goes to the Treasury. */
  bankrollShareBps: bigint;
  edgeBps: bigint;
  /** One bet may put at most this share of the free bankroll at risk; all open bets this share of the house's funds. */
  maxExposureBps: bigint;
  maxTotalExposureBps: bigint;
  userShares?: bigint;
};

export async function readHouse(client: Client, d: Deployment, user?: Address): Promise<HouseState> {
  if (isDemo(client)) return demoReads.house();
  const games = { address: d.games, abi: gamesAbi } as const;
  const [bankroll, reserved, openWagers, totalShares, bankrollShareBps, edgeBps, maxExposureBps, maxTotalExposureBps, userShares] = await Promise.all([
    readContract(client, { ...games, functionName: "bankroll" }),
    readContract(client, { ...games, functionName: "reserved" }),
    readContract(client, { ...games, functionName: "openWagers" }),
    readContract(client, { ...games, functionName: "totalShares" }),
    readContract(client, { ...games, functionName: "bankrollShareBps" }),
    readContract(client, { ...games, functionName: "edgeBps" }),
    readContract(client, { ...games, functionName: "maxExposureBps" }),
    readContract(client, { ...games, functionName: "MAX_TOTAL_EXPOSURE_BPS" }),
    user ? readContract(client, { ...games, functionName: "sharesOf", args: [user] }) : undefined,
  ]);
  return { bankroll, reserved, openWagers, totalShares, bankrollShareBps, edgeBps, maxExposureBps, maxTotalExposureBps, userShares };
}

export type HouseEvent =
  | { kind: "deposit"; amount: bigint; shares: bigint; order: number; time?: number }
  | { kind: "redeem"; amount: bigint; shares: bigint; order: number; time?: number }
  /** A settled bet: what the house gained (negative: lost) on it, its part of the edge included. */
  | { kind: "bet"; gain: bigint; order: number; time?: number };

export type HousePoint = { order: number; time?: number; kind: HouseEvent["kind"]; equity: bigint; shares: bigint; price: number; change: bigint };

/**
 * The share price after each event, replayed from an empty house: deposits and redemptions move
 * funds and shares together, a settled bet moves funds only. Each bet counts at its settlement, so
 * the series is the realised history and says nothing about bets still open.
 */
export function housePoints(events: readonly HouseEvent[]): HousePoint[] {
  let equity = 0n;
  let shares = 0n;
  return [...events]
    .sort((a, b) => a.order - b.order)
    .map((event) => {
      let change: bigint;
      if (event.kind === "deposit") {
        equity += event.amount;
        shares += event.shares;
        change = event.amount;
      } else if (event.kind === "redeem") {
        equity -= event.amount;
        shares -= event.shares;
        change = -event.amount;
      } else {
        equity += event.gain;
        change = event.gain;
      }
      if (equity < 0n) equity = 0n;
      return { order: event.order, time: event.time, kind: event.kind, equity, shares, price: sharePrice(equity, shares), change };
    });
}

/** What the house gained on a settled bet: the wager, less the payout, less the Treasury's part of the edge. */
export function houseGain(wager: bigint, payout: bigint, fee: bigint, bankrollShareBps: bigint): bigint {
  return wager - payout - (fee - (fee * bankrollShareBps) / BPS);
}

/**
 * The house's events from the Games contract's logs, oldest first. A settled bet's gain uses the
 * bankroll share in force now (the contract does not log it per bet). Returns undefined if the RPC
 * refuses the log queries.
 */
export async function readHouseEvents(client: Client, d: Deployment, fromBlock = 0n): Promise<HouseEvent[] | undefined> {
  if (isDemo(client)) return demoReads.houseEvents();
  const games = { address: d.games, abi: gamesAbi } as const;
  const range = { fromBlock, toBlock: "latest", strict: true } as const;
  try {
    const [funded, redeemed, placed, settled, share] = await Promise.all([
      getContractEvents(client, { ...games, eventName: "BankrollFunded", ...range }),
      getContractEvents(client, { ...games, eventName: "BankrollRedeemed", ...range }),
      getContractEvents(client, { ...games, eventName: "BetPlaced", ...range }),
      getContractEvents(client, { ...games, eventName: "BetSettled", ...range }),
      readContract(client, { ...games, functionName: "bankrollShareBps" }),
    ]);
    const order = (log: { blockNumber: bigint; logIndex: number }) => Number(log.blockNumber) * 10_000 + log.logIndex;
    const wagers = new Map(placed.map((log) => [log.args.requestId, log.args.wager]));
    return [
      ...funded.map((log): HouseEvent => ({ kind: "deposit", amount: log.args.amount, shares: log.args.shares, order: order(log) })),
      ...redeemed.map((log): HouseEvent => ({ kind: "redeem", amount: log.args.amount, shares: log.args.shares, order: order(log) })),
      ...settled.flatMap((log): HouseEvent[] => {
        const wager = wagers.get(log.args.requestId);
        return wager === undefined ? [] : [{ kind: "bet", gain: houseGain(wager, log.args.payout, log.args.fee, share), order: order(log) }];
      }),
    ].sort((a, b) => a.order - b.order);
  } catch {
    return undefined;
  }
}
