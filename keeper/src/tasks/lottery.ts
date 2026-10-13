// Lottery: draw rounds that have ended, reset draws whose randomness never came, and (opt-in) abort
// rounds that are stuck.
import type { Address } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export const LOT = { None: 0, Open: 1, Drawing: 2, Won: 3, Refunding: 4 } as const;

export interface RoundState {
  id: bigint;
  collection: Address;
  ticketPrice: bigint;
  ticketsSold: bigint;
  endTime: bigint;
  requestedAt: bigint;
  status: number;
  minPot: bigint;
}

export interface LotteryState {
  now: bigint;
  drawTimeout: bigint;
  abortDelay: bigint;
  abortEnabled: boolean;
  /** No draw is requested this close to the abort time; see `decideLottery`. */
  abortGuard: bigint;
  rounds: RoundState[];
}

export function decideLottery(state: LotteryState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  for (const r of state.rounds) {
    const act = (functionName: string, reason: string) =>
      decision.actions.push({ task: "lottery", contract: "lottery", functionName, args: [r.id], reason });
    const stuck = (message: string) =>
      decision.findings.push({
        task: "lottery",
        level: "warn",
        code: "round_stuck",
        message: `round ${r.id}: ${message}`,
        data: { roundId: r.id, status: r.status, endTime: r.endTime, requestedAt: r.requestedAt },
      });
    const abortAt = r.endTime + state.abortDelay;

    if (r.status === LOT.Open) {
      if (now < r.endTime) {
        decision.wakeAt.push(r.endTime);
        continue;
      }
      const pot = r.ticketPrice * r.ticketsSold;
      if (r.ticketsSold === 0n || pot < r.minPot) {
        act("draw", `ended with a pot of ${pot} wei, below the minimum ${r.minPot}: opens refunds`);
      } else if (now >= abortAt) {
        // From here on `draw` does not request randomness: it opens refunds, exactly like `abort`.
        if (state.abortEnabled) act("abort", `undrawn ${duration(now - r.endTime)} after its end: open refunds`);
        else stuck(`undrawn ${duration(now - r.endTime)} after its end; anyone can now turn it into refunds (abort is off)`);
      } else if (now + state.abortGuard >= abortAt) {
        // A draw simulated before the abort time and mined after it would open refunds instead.
        stuck(`ended and undrawn, but too close to its abort time (${duration(abortAt - now)}) to request a draw safely`);
        decision.wakeAt.push(abortAt);
      } else {
        act("draw", `ended ${duration(now - r.endTime)} ago with ${r.ticketsSold} tickets`);
      }
    } else if (r.status === LOT.Drawing) {
      const answerDeadline = r.requestedAt + state.drawTimeout;
      if (now < answerDeadline) {
        decision.wakeAt.push(answerDeadline);
      } else if (now >= abortAt) {
        if (state.abortEnabled) act("abort", `randomness never arrived and the round ended ${duration(now - r.endTime)} ago: open refunds`);
        else stuck(`randomness requested ${duration(now - r.requestedAt)} ago never arrived and the abort time has passed (abort is off)`);
      } else {
        act("resetDraw", `randomness requested ${duration(now - r.requestedAt)} ago never arrived`);
      }
    }
  }
  return decision;
}

interface RoundStruct {
  collection: Address;
  ticketPrice: bigint;
  ticketsSold: number;
  endTime: number;
  requestedAt: number;
  status: number;
}

export async function fetchLotteryRounds(ctx: Ctx, head: Head): Promise<RoundState[]> {
  const r = readerAt(ctx, head);
  const count = await r.read<bigint>("lottery", "roundCount");
  const from = ctx.cache.watermark("lotteryRounds");
  const rounds = await r.map(range(from, count), async (id): Promise<RoundState> => {
    const [s, minPot] = await Promise.all([
      r.struct<RoundStruct>("lottery", "rounds", [id]),
      r.read<bigint>("lottery", "minPotOf", [id]),
    ]);
    return {
      id,
      collection: s.collection,
      ticketPrice: s.ticketPrice,
      ticketsSold: BigInt(s.ticketsSold),
      endTime: BigInt(s.endTime),
      requestedAt: BigInt(s.requestedAt),
      status: Number(s.status),
      minPot,
    };
  });
  ctx.cache.setWatermark("lotteryRounds", firstOpen(rounds, (x) => x.status === LOT.Won || x.status === LOT.Refunding, from, count));
  return rounds;
}

export async function fetchLottery(ctx: Ctx, head: Head): Promise<LotteryState> {
  const r = readerAt(ctx, head);
  const [rounds, drawTimeout, abortDelay] = await Promise.all([
    fetchLotteryRounds(ctx, head),
    r.read<bigint>("lottery", "DRAW_TIMEOUT"),
    r.read<bigint>("lottery", "ABORT_DELAY"),
  ]);
  return {
    now: head.timestamp,
    drawTimeout,
    abortDelay,
    abortEnabled: ctx.config.lotteryAbort,
    abortGuard: ctx.config.abortGuardSeconds,
    rounds,
  };
}

export async function runLottery(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchLottery(ctx, head);
  const report = await carryOut(ctx, "lottery", decideLottery(state));
  report.metrics = {
    open: state.rounds.filter((x) => x.status === LOT.Open).length,
    drawing: state.rounds.filter((x) => x.status === LOT.Drawing).length,
  };
  return report;
}
