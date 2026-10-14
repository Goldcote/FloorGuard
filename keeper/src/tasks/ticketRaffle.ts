// TicketRaffle: close raffles that have ended or sold out, settle raffles with a winner, reset draws
// whose randomness never came, and (opt-in) abort raffles that cannot finish.
import type { Address } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export const TR = { None: 0, Open: 1, Drawing: 2, Won: 3, Settled: 4, Refunding: 5, Cancelled: 6 } as const;

export interface TicketRaffleEntry {
  id: bigint;
  collection: Address;
  ticketPrice: bigint;
  minTickets: bigint;
  maxTickets: bigint;
  ticketsSold: bigint;
  endTime: bigint;
  requestedAt: bigint;
  status: number;
  minPot: bigint;
  /** For a raffle with a winner: why `settle` would revert right now, or null if it would not. */
  settleReverts: string | null;
}

export interface TicketRaffleState {
  now: bigint;
  drawTimeout: bigint;
  abortDelay: bigint;
  abortEnabled: boolean;
  abortGuard: bigint;
  raffles: TicketRaffleEntry[];
}

export function decideTicketRaffle(state: TicketRaffleState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  for (const r of state.raffles) {
    const act = (functionName: string, reason: string) =>
      decision.actions.push({ task: "ticketRaffle", contract: "ticketRaffle", functionName, args: [r.id], reason });
    const stuck = (message: string) =>
      decision.findings.push({
        task: "ticketRaffle",
        level: "warn",
        code: "raffle_stuck",
        message: `raffle ${r.id}: ${message}`,
        data: { raffleId: r.id, status: r.status, endTime: r.endTime, requestedAt: r.requestedAt },
      });
    const abortAt = r.endTime + state.abortDelay;

    if (r.status === TR.Open) {
      const soldOut = r.ticketsSold >= r.maxTickets;
      if (now < r.endTime) {
        if (soldOut) act("close", `sold out (${r.ticketsSold} tickets) before its end`);
        else decision.wakeAt.push(r.endTime);
        continue;
      }
      const pot = r.ticketPrice * r.ticketsSold;
      if (r.ticketsSold === 0n || r.ticketsSold < r.minTickets || pot < r.minPot) {
        act("close", `ended with ${r.ticketsSold} of at least ${r.minTickets} tickets and ${pot} wei: opens refunds`);
      } else if (now >= abortAt) {
        // From here on `close` does not request randomness: it opens refunds, exactly like `abort`.
        if (state.abortEnabled) act("abort", `undrawn ${duration(now - r.endTime)} after its end: open refunds`);
        else stuck(`undrawn ${duration(now - r.endTime)} after its end; anyone can now turn it into refunds (abort is off)`);
      } else if (now + state.abortGuard >= abortAt) {
        stuck(`ended and undrawn, but too close to its abort time (${duration(abortAt - now)}) to request a draw safely`);
        decision.wakeAt.push(abortAt);
      } else {
        act("close", `ended ${duration(now - r.endTime)} ago with ${r.ticketsSold} tickets`);
      }
    } else if (r.status === TR.Drawing) {
      const answerDeadline = r.requestedAt + state.drawTimeout;
      if (now < answerDeadline) {
        decision.wakeAt.push(answerDeadline);
      } else if (now >= abortAt) {
        if (state.abortEnabled) act("abort", `randomness never arrived and the raffle ended ${duration(now - r.endTime)} ago: open refunds`);
        else stuck(`randomness requested ${duration(now - r.requestedAt)} ago never arrived and the abort time has passed (abort is off)`);
      } else {
        act("resetDraw", `randomness requested ${duration(now - r.requestedAt)} ago never arrived`);
      }
    } else if (r.status === TR.Won) {
      if (r.settleReverts === null) {
        act("settle", "deliver the prize and split the ticket revenue");
        continue;
      }
      // a winner was drawn but the prize cannot be delivered; refunds open a week after the draw request
      const wonAbortAt = r.requestedAt + state.abortDelay;
      if (now >= wonAbortAt && state.abortEnabled) {
        act("abort", `settle reverts (${r.settleReverts}) ${duration(now - r.requestedAt)} after the draw: open refunds`);
      } else if (now >= wonAbortAt) {
        stuck(`has a winner but settle reverts (${r.settleReverts}); anyone can now abort it (abort is off)`);
      } else {
        stuck(`has a winner but settle reverts (${r.settleReverts}); it can be aborted in ${duration(wonAbortAt - now)}`);
        decision.wakeAt.push(wonAbortAt);
      }
    }
  }
  return decision;
}

interface RaffleStruct {
  collection: Address;
  ticketPrice: bigint;
  minTickets: number;
  maxTickets: number;
  ticketsSold: number;
  endTime: number;
  requestedAt: number;
  status: number;
}

const FINAL: number[] = [TR.Settled, TR.Refunding, TR.Cancelled];

export async function fetchTicketRaffles(ctx: Ctx, head: Head, withSettleCheck = true): Promise<TicketRaffleEntry[]> {
  const r = readerAt(ctx, head);
  const count = await r.read<bigint>("ticketRaffle", "raffleCount");
  const from = ctx.cache.watermark("ticketRaffles");
  const raffles = await r.map(range(from, count), async (id): Promise<TicketRaffleEntry> => {
    const [s, minPot] = await Promise.all([
      r.struct<RaffleStruct>("ticketRaffle", "raffles", [id]),
      r.read<bigint>("ticketRaffle", "minPotOf", [id]),
    ]);
    const status = Number(s.status);
    return {
      id,
      collection: s.collection,
      ticketPrice: s.ticketPrice,
      minTickets: BigInt(s.minTickets),
      maxTickets: BigInt(s.maxTickets),
      ticketsSold: BigInt(s.ticketsSold),
      endTime: BigInt(s.endTime),
      requestedAt: BigInt(s.requestedAt),
      status,
      minPot,
      settleReverts:
        status === TR.Won && withSettleCheck
          ? await ctx.sender.wouldRevert({ contract: "ticketRaffle", functionName: "settle", args: [id] })
          : null,
    };
  });
  ctx.cache.setWatermark("ticketRaffles", firstOpen(raffles, (x) => FINAL.includes(x.status), from, count));
  return raffles;
}

export async function fetchTicketRaffle(ctx: Ctx, head: Head): Promise<TicketRaffleState> {
  const r = readerAt(ctx, head);
  const [raffles, drawTimeout, abortDelay] = await Promise.all([
    fetchTicketRaffles(ctx, head),
    r.read<bigint>("ticketRaffle", "DRAW_TIMEOUT"),
    r.read<bigint>("ticketRaffle", "ABORT_DELAY"),
  ]);
  return {
    now: head.timestamp,
    drawTimeout,
    abortDelay,
    abortEnabled: ctx.config.ticketRaffleAbort,
    abortGuard: ctx.config.abortGuardSeconds,
    raffles,
  };
}

export async function runTicketRaffle(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchTicketRaffle(ctx, head);
  const report = await carryOut(ctx, "ticketRaffle", decideTicketRaffle(state));
  report.metrics = {
    open: state.raffles.filter((x) => x.status === TR.Open).length,
    drawing: state.raffles.filter((x) => x.status === TR.Drawing).length,
    won: state.raffles.filter((x) => x.status === TR.Won).length,
  };
  return report;
}
