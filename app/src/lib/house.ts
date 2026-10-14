// The house: shares in the games bankroll. Deposits and redemptions are requests (`Games.deposit`,
// `Games.redeem`): each is carried out once every bet that was open when it was made has closed, at
// the house's funds per share at that moment. The share arithmetic mirrors the contract exactly and
// is shared by the page, the demo simulator and the tests; the reads return the state, the
// connected account's requests and the realised history from events.
import type { Address, Client, Hash } from "viem";
import { readContract } from "viem/actions";
import { demoReads, isDemo } from "../demo/sim";
import { gamesAbi, treasuryAbi } from "../generated/abis";
import type { Deployment } from "../generated/addresses";
import { getEvents } from "./logs";

import { houseGain, type HouseEvent, type HouseRequest, type HouseState } from "./houseMath";

export * from "./houseMath";

/**
 * How many bets numbered below `seq` are still open, from the Games contract's logs: bets are
 * numbered in the order they were placed. Undefined unless the logs cover every bet ever placed.
 */
async function openBetsBefore(client: Client, d: Deployment, seq: bigint, placedCount: bigint, fromBlock: bigint): Promise<number | undefined> {
  try {
    const games = { address: d.games, abi: gamesAbi } as const;
    const range = { fromBlock, toBlock: "latest", strict: true } as const;
    const [placed, settled, refunded] = await Promise.all([
      getEvents(client, { ...games, eventName: "BetPlaced", ...range }),
      getEvents(client, { ...games, eventName: "BetSettled", ...range }),
      getEvents(client, { ...games, eventName: "BetRefunded", ...range }),
    ]);
    if (BigInt(placed.length) !== placedCount) return undefined;
    const closed = new Set([...settled, ...refunded].map((log) => log.args.requestId));
    return placed.slice(0, Number(seq)).filter((log) => !closed.has(log.args.requestId)).length;
  } catch {
    return undefined;
  }
}

export async function readHouse(client: Client, d: Deployment, user?: Address, fromBlock = 0n): Promise<HouseState> {
  if (isDemo(client)) return demoReads.house();
  const games = { address: d.games, abi: gamesAbi } as const;
  const [bankroll, reserved, openWagers, totalShares, bankrollShareBps, edgeBps, maxExposureBps, maxTotalExposureBps, totalPendingDeposits, placedCount, mine] = await Promise.all([
    readContract(client, { ...games, functionName: "bankroll" }),
    readContract(client, { ...games, functionName: "reserved" }),
    readContract(client, { ...games, functionName: "openWagers" }),
    readContract(client, { ...games, functionName: "totalShares" }),
    readContract(client, { ...games, functionName: "bankrollShareBps" }),
    readContract(client, { ...games, functionName: "edgeBps" }),
    readContract(client, { ...games, functionName: "maxExposureBps" }),
    readContract(client, { ...games, functionName: "MAX_TOTAL_EXPOSURE_BPS" }),
    readContract(client, { ...games, functionName: "totalPendingDeposits" }),
    readContract(client, { ...games, functionName: "placedCount" }),
    user
      ? Promise.all([
          readContract(client, { ...games, functionName: "sharesOf", args: [user] }),
          readContract(client, { ...games, functionName: "pendingDepositOf", args: [user] }),
          readContract(client, { ...games, functionName: "depositSeqOf", args: [user] }),
          readContract(client, { ...games, functionName: "pendingRedeemOf", args: [user] }),
          readContract(client, { ...games, functionName: "redeemSeqOf", args: [user] }),
        ])
      : undefined,
  ]);
  const request = async (amount: bigint, seq: bigint): Promise<HouseRequest | undefined> => {
    if (amount === 0n) return undefined;
    const ready = await readContract(client, { ...games, functionName: "isClosedThrough", args: [seq] });
    return { amount, ready, waitingFor: ready ? 0 : await openBetsBefore(client, d, seq, placedCount, fromBlock) };
  };
  const [pendingDeposit, pendingRedeem, openBets] = await Promise.all([
    mine ? request(mine[1], mine[2]) : undefined,
    mine ? request(mine[3], mine[4]) : undefined,
    // counted only while something is set aside: with nothing reserved no bet is open
    reserved === 0n && openWagers === 0n ? 0 : openBetsBefore(client, d, placedCount, placedCount, fromBlock),
  ]);
  return { bankroll, reserved, openWagers, totalShares, bankrollShareBps, edgeBps, maxExposureBps, maxTotalExposureBps, totalPendingDeposits, openBets, userShares: mine?.[0], pendingDeposit, pendingRedeem };
}

/**
 * What the Games contract sent to the Treasury in each transaction: the `Deposited` amounts that came
 * from it, plus what was set aside for a project alongside. Keyed by transaction hash.
 */
export async function feesSentToTreasury(client: Client, d: Deployment, fromBlock: bigint, toBlock: bigint | "latest"): Promise<Map<Hash, bigint>> {
  const treasury = { address: d.treasury, abi: treasuryAbi } as const;
  const range = { fromBlock, toBlock, strict: true } as const;
  const [deposited, accrued] = await Promise.all([
    getEvents(client, { ...treasury, eventName: "Deposited", args: { from: d.games }, ...range }),
    getEvents(client, { ...treasury, eventName: "ProjectShareAccrued", ...range }),
  ]);
  const sent = new Map<Hash, bigint>();
  for (const log of deposited) sent.set(log.transactionHash, (sent.get(log.transactionHash) ?? 0n) + log.args.amount);
  // a project's share is only accrued together with a fee deposit
  for (const log of accrued) if (sent.has(log.transactionHash)) sent.set(log.transactionHash, sent.get(log.transactionHash)! + log.args.amount);
  return sent;
}

/**
 * The house's events from the Games contract's logs, oldest first. A settled bet's gain uses what
 * the Treasury received in the settlement transaction, so it is right whatever the bankroll's share
 * of the edge was at the time; if those logs cannot be read, the share in force now is used. Returns
 * undefined if the RPC refuses the log queries.
 */
export async function readHouseEvents(client: Client, d: Deployment, fromBlock = 0n): Promise<HouseEvent[] | undefined> {
  if (isDemo(client)) return demoReads.houseEvents();
  const games = { address: d.games, abi: gamesAbi } as const;
  const range = { fromBlock, toBlock: "latest", strict: true } as const;
  try {
    const [funded, redeemed, placed, settled, share, toTreasury] = await Promise.all([
      getEvents(client, { ...games, eventName: "BankrollFunded", ...range }),
      getEvents(client, { ...games, eventName: "BankrollRedeemed", ...range }),
      getEvents(client, { ...games, eventName: "BetPlaced", ...range }),
      getEvents(client, { ...games, eventName: "BetSettled", ...range }),
      readContract(client, { ...games, functionName: "bankrollShareBps" }),
      feesSentToTreasury(client, d, fromBlock, "latest").catch(() => undefined),
    ]);
    const order = (log: { blockNumber: bigint; logIndex: number }) => Number(log.blockNumber) * 10_000 + log.logIndex;
    const wagers = new Map(placed.map((log) => [log.args.requestId, log.args.wager]));
    // one transaction settles one bet, except where a provider answers several at once: then the
    // split cannot be told apart per bet and the current share is used for them
    const settledPerTx = new Map<Hash, number>();
    for (const log of settled) settledPerTx.set(log.transactionHash, (settledPerTx.get(log.transactionHash) ?? 0) + 1);
    return [
      ...funded.map((log): HouseEvent => ({ kind: "deposit", amount: log.args.amount, shares: log.args.shares, order: order(log) })),
      ...redeemed.map((log): HouseEvent => ({ kind: "redeem", amount: log.args.amount, shares: log.args.shares, order: order(log) })),
      ...settled.flatMap((log): HouseEvent[] => {
        const wager = wagers.get(log.args.requestId);
        if (wager === undefined) return [];
        const { payout, fee } = log.args;
        const sent = toTreasury && settledPerTx.get(log.transactionHash) === 1 ? (toTreasury.get(log.transactionHash) ?? 0n) : undefined;
        const gain = sent !== undefined && sent <= fee ? wager - payout - sent : houseGain(wager, payout, fee, share);
        return [{ kind: "bet", gain, order: order(log) }];
      }),
    ].sort((a, b) => a.order - b.order);
  } catch {
    return undefined;
  }
}
