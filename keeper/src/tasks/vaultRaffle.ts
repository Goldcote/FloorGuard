// VaultRaffle: draw once the announce period and any redraw cooldown have passed and points are
// activated; reset a draw whose randomness never came; deliver prizes once they have vested.
import type { Address } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export const VR = { None: 0, Open: 1, Drawing: 2, Won: 3, Claimed: 4 } as const;

export interface VaultRaffleEntry {
  id: bigint;
  collection: Address;
  tokenId: bigint;
  drawAfter: bigint;
  requestedAt: bigint;
  status: number;
  winner: Address;
  /** `VaultRaffle.claimableAt`: when a won prize has vested. Read only for won raffles, 0 otherwise. */
  claimableAt: bigint;
  /**
   * `VaultRaffle.minPointsRequired`, for open raffles of a VaultRaffle that scales the minimum with the
   * prize's value. Null when the contract has no such function: `minPointsToDraw` applies.
   */
  minPointsRequired?: bigint | null;
}

export interface VaultRaffleState {
  now: bigint;
  nextDrawAt: bigint;
  drawTimeout: bigint;
  minPointsToDraw: bigint;
  freezeCount: bigint;
  totalPoints: bigint;
  /** Known accounts whose pending points the keeper would still activate. Null when unknown. */
  pendingAccounts: number | null;
  requireFlushed: boolean;
  raffles: VaultRaffleEntry[];
}

export function decideVaultRaffle(state: VaultRaffleState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  const act = (functionName: string, id: bigint, reason: string) =>
    decision.actions.push({ task: "vaultRaffle", contract: "vaultRaffle", functionName, args: [id], reason });

  // resets first: they unfreeze points, which is what flushing and every other draw wait for
  for (const r of state.raffles) {
    if (r.status !== VR.Drawing) continue;
    const readyAt = r.requestedAt + state.drawTimeout;
    if (now >= readyAt) {
      act("resetDraw", r.id, `randomness requested ${duration(now - r.requestedAt)} ago never arrived`);
    } else {
      decision.wakeAt.push(readyAt);
    }
  }
  for (const r of state.raffles) {
    if (r.status !== VR.Won) continue;
    if (now >= r.claimableAt) {
      act("claim", r.id, `deliver the vested prize to the winner ${r.winner}`);
    } else {
      decision.wakeAt.push(r.claimableAt);
      decision.findings.push({
        task: "vaultRaffle",
        level: "info",
        code: "prize_vesting",
        message: `raffle ${r.id}: won by ${r.winner}, claimable in ${duration(r.claimableAt - now)}`,
        data: { raffleId: r.id, winner: r.winner, claimableAt: r.claimableAt },
      });
    }
  }

  let drawInFlight = state.freezeCount !== 0n;
  for (const r of state.raffles) {
    if (r.status !== VR.Open) continue;
    const readyAt = r.drawAfter > state.nextDrawAt ? r.drawAfter : state.nextDrawAt;
    if (now < readyAt) {
      decision.wakeAt.push(readyAt);
      continue;
    }
    const wait = (level: "info" | "warn", code: string, message: string) =>
      decision.findings.push({ task: "vaultRaffle", level, code, message: `raffle ${r.id}: ${message}`, data: { raffleId: r.id } });

    if (drawInFlight) {
      wait("info", "draw_in_flight", "drawable, but only one draw can be in flight at a time");
    } else if (state.requireFlushed && state.pendingAccounts === null) {
      wait("warn", "flush_state_unknown", "drawable, but the keeper does not know whether points are activated (points task off?)");
    } else if (state.requireFlushed && state.pendingAccounts !== 0) {
      wait("warn", "waiting_for_flush", `drawable, but ${state.pendingAccounts} account(s) still have pending points; a draw would lock them out`);
    } else if (state.totalPoints === 0n) {
      wait("warn", "no_points", "drawable, but no points are activated");
    } else if (state.totalPoints < (r.minPointsRequired ?? state.minPointsToDraw)) {
      const required = r.minPointsRequired ?? state.minPointsToDraw;
      wait("warn", "below_min_points", `drawable, but activated points ${state.totalPoints} are below the ${required} this raffle requires`);
    } else {
      act("draw", r.id, `announce period over since ${duration(now - r.drawAfter)}, ${state.totalPoints} points activated`);
      drawInFlight = true;
    }
  }
  return decision;
}

interface RaffleStruct {
  collection: Address;
  tokenId: bigint;
  drawAfter: number;
  requestedAt: number;
  status: number;
  winner: Address;
}

export async function fetchVaultRaffles(ctx: Ctx, head: Head): Promise<VaultRaffleEntry[]> {
  const r = readerAt(ctx, head);
  const count = await r.read<bigint>("vaultRaffle", "raffleCount");
  const from = ctx.cache.watermark("vaultRaffles");
  const scaled = ctx.abis.vaultRaffle.some((i) => i.type === "function" && i.name === "minPointsRequired");
  const raffles = await r.map(range(from, count), async (id): Promise<VaultRaffleEntry> => {
    const s = await r.struct<RaffleStruct>("vaultRaffle", "raffles", [id]);
    const status = Number(s.status);
    return {
      id,
      collection: s.collection,
      tokenId: s.tokenId,
      drawAfter: BigInt(s.drawAfter),
      requestedAt: BigInt(s.requestedAt),
      status,
      winner: s.winner,
      claimableAt: status === VR.Won ? await r.read<bigint>("vaultRaffle", "claimableAt", [id]) : 0n,
      minPointsRequired: status === VR.Open && scaled ? await r.read<bigint>("vaultRaffle", "minPointsRequired", [id]) : null,
    };
  });
  ctx.cache.setWatermark("vaultRaffles", firstOpen(raffles, (x) => x.status === VR.Claimed, from, count));
  return raffles;
}

export async function fetchVaultRaffle(ctx: Ctx, head: Head, pendingAccounts: number | null): Promise<VaultRaffleState> {
  const r = readerAt(ctx, head);
  const [raffles, nextDrawAt, drawTimeout, minPointsToDraw, freezeCount, totalPoints] = await Promise.all([
    fetchVaultRaffles(ctx, head),
    r.read<bigint>("vaultRaffle", "nextDrawAt"),
    r.read<bigint>("vaultRaffle", "DRAW_TIMEOUT"),
    r.read<bigint>("vaultRaffle", "minPointsToDraw"),
    r.read<bigint>("points", "freezeCount"),
    r.read<bigint>("points", "totalPoints"),
  ]);
  return {
    now: head.timestamp,
    nextDrawAt,
    drawTimeout,
    minPointsToDraw,
    freezeCount,
    totalPoints,
    pendingAccounts,
    requireFlushed: ctx.config.requireFlushedBeforeDraw,
    raffles,
  };
}

export async function runVaultRaffle(ctx: Ctx, head: Head, pendingAccounts: number | null): Promise<TaskReport> {
  const state = await fetchVaultRaffle(ctx, head, pendingAccounts);
  const report = await carryOut(ctx, "vaultRaffle", decideVaultRaffle(state));
  report.metrics = {
    open: state.raffles.filter((x) => x.status === VR.Open).length,
    drawing: state.raffles.filter((x) => x.status === VR.Drawing).length,
    totalPoints: state.totalPoints,
    minPointsToDraw: state.minPointsToDraw,
  };
  return report;
}
