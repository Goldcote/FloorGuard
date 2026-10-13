// Games.refund: return the wager of a bet whose randomness is a day late.
import type { Address } from "viem";
import { type Ctx, type Head, carryOut, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { eventsOf, getLogsChunked, scanFrom } from "../logs.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export interface BetState {
  requestId: bigint;
  player: Address;
  wager: bigint;
  placedAt: bigint;
}

export interface GamesState {
  now: bigint;
  refundTimeout: bigint;
  bets: BetState[];
}

export function decideGames(state: GamesState): Decision {
  const decision = emptyDecision();
  for (const bet of state.bets) {
    const readyAt = bet.placedAt + state.refundTimeout;
    if (state.now >= readyAt) {
      decision.actions.push({
        task: "games",
        contract: "games",
        functionName: "refund",
        args: [bet.requestId],
        reason: `randomness for a bet of ${bet.wager} wei placed ${duration(state.now - bet.placedAt)} ago never arrived`,
      });
    } else {
      decision.wakeAt.push(readyAt);
    }
  }
  return decision;
}

/**
 * The open bets. Games keeps no list of them, so they are found from events: placed, less settled and
 * refunded. Each candidate is then read back, which is what decides; the events only say where to look.
 */
export function openBetIds(known: Iterable<bigint>, logs: { eventName: string; args: Record<string, unknown> }[]): Set<bigint> {
  const open = new Set(known);
  for (const log of logs) {
    const id = log.args.requestId as bigint;
    if (log.eventName === "BetPlaced") open.add(id);
  }
  // removals after all additions: the order of logs across ranges does not matter then
  for (const log of logs) {
    const id = log.args.requestId as bigint;
    if (log.eventName === "BetSettled" || log.eventName === "BetRefunded") open.delete(id);
  }
  return open;
}

interface BetStruct {
  player: Address;
  wager: bigint;
  placedAt: number;
}

export async function fetchOpenBets(ctx: Ctx, head: Head): Promise<BetState[]> {
  const { cache, config } = ctx;
  let candidates = new Set(cache.data.openBets.map((id) => BigInt(id)));
  const from = scanFrom(cache.scannedTo("games"), config.startBlock);
  if (from <= head.number) {
    const logs = await getLogsChunked(ctx.client, {
      address: ctx.deployment.games,
      events: eventsOf(ctx.abis.games, ["BetPlaced", "BetSettled", "BetRefunded"]),
      fromBlock: from,
      toBlock: head.number,
      maxRange: config.logRange,
    });
    candidates = openBetIds(candidates, logs);
  }
  const r = readerAt(ctx, head);
  const zero = "0x0000000000000000000000000000000000000000";
  const bets = (
    await r.map([...candidates], async (requestId): Promise<BetState | null> => {
      const bet = await r.struct<BetStruct>("games", "bets", [requestId]);
      if (bet.player === zero) return null;
      return { requestId, player: bet.player, wager: bet.wager, placedAt: BigInt(bet.placedAt) };
    })
  ).filter((bet): bet is BetState => bet !== null);
  cache.data.openBets = bets.map((bet) => bet.requestId.toString());
  cache.data.scanned.games = head.number.toString();
  return bets.sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0));
}

export async function runGames(ctx: Ctx, head: Head): Promise<TaskReport> {
  const r = readerAt(ctx, head);
  const [bets, refundTimeout] = await Promise.all([fetchOpenBets(ctx, head), r.read<bigint>("games", "REFUND_TIMEOUT")]);
  const report = await carryOut(ctx, "games", decideGames({ now: head.timestamp, refundTimeout, bets }));
  report.metrics = { openBets: bets.length };
  return report;
}
