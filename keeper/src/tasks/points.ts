// Points.flushMany: activate pending points so they count in the next vault raffle. Whoever calls
// VaultRaffle.draw closes activation for everyone, and that can happen in the first block after the
// announce period, so the flush has to land before then.
import { type Address, getAddress } from "viem";
import { type Ctx, type Head, findingsOf, readerAt } from "../context.ts";
import { eventsOf, getLogsChunked, scanFrom } from "../logs.ts";
import { type Action, type Decision, type TaskReport, emptyDecision } from "../types.ts";
import { VR, fetchVaultRaffles } from "./vaultRaffle.ts";

export interface PendingAccount {
  address: Address;
  pending: bigint;
}

export interface PointsState {
  now: bigint;
  freezeCount: bigint;
  /** Accounts worth activating, largest pending balance first. */
  pending: PendingAccount[];
  /** `drawAfter` of every raffle that is open and not yet drawn. */
  openRaffleDrawAfter: bigint[];
  nextDrawAt: bigint;
  /** Chain time of the last scheduled flush; null if unknown. */
  lastFlushAt: bigint | null;
  intervalSeconds: bigint;
  leadSeconds: bigint;
  onlyWithOpenRaffle: boolean;
  batchSize: number;
}

/** How many accounts fit one `flushMany` under the gas limit, leaving room for the estimate margin. */
export function flushBatchSize(maxGasPerTx: bigint, marginBps: bigint, gasPerAccount: bigint, maxBatch: number): number {
  const usable = (maxGasPerTx * 10_000n) / (10_000n + marginBps);
  const overhead = 30_000n;
  const fit = usable > overhead && gasPerAccount > 0n ? Number((usable - overhead) / gasPerAccount) : 0;
  return Math.max(1, Math.min(maxBatch, fit));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type FlushReason = "pre-draw" | "schedule" | null;

/** Why a flush is due now, if it is. */
export function flushReason(state: Omit<PointsState, "pending" | "freezeCount" | "batchSize">): FlushReason {
  const { now } = state;
  const preDraw = state.openRaffleDrawAfter.some((drawAfter) => {
    const drawable = drawAfter > state.nextDrawAt ? drawAfter : state.nextDrawAt;
    return now + state.leadSeconds >= drawable;
  });
  if (preDraw) return "pre-draw";
  if (state.onlyWithOpenRaffle && state.openRaffleDrawAfter.length === 0) return null;
  if (state.lastFlushAt === null || now >= state.lastFlushAt + state.intervalSeconds) return "schedule";
  return null;
}

export function decidePoints(state: PointsState): Decision & { reason: FlushReason } {
  const decision = { ...emptyDecision(), reason: null as FlushReason };
  const { now } = state;
  for (const drawAfter of state.openRaffleDrawAfter) {
    const drawable = drawAfter > state.nextDrawAt ? drawAfter : state.nextDrawAt;
    if (drawable - state.leadSeconds > now) decision.wakeAt.push(drawable - state.leadSeconds);
  }
  if (state.lastFlushAt !== null) decision.wakeAt.push(state.lastFlushAt + state.intervalSeconds);
  if (state.pending.length === 0) return decision;

  if (state.freezeCount !== 0n) {
    decision.findings.push({
      task: "points",
      level: "info",
      code: "points_frozen",
      message: `${state.pending.length} account(s) have pending points that cannot be activated while a raffle draw is in flight`,
      data: { accounts: state.pending.length },
    });
    return decision;
  }
  decision.reason = flushReason(state);
  if (decision.reason === null) return decision;

  const why =
    decision.reason === "pre-draw"
      ? "a vault raffle can be drawn soon: pending points must be activated before anyone calls draw"
      : "scheduled activation of pending points";
  for (const batch of chunk(state.pending, state.batchSize)) {
    decision.actions.push({
      task: "points",
      contract: "points",
      functionName: "flushMany",
      args: [batch.map((a) => a.address)],
      reason: `${why} (${batch.length} account(s))`,
    });
  }
  return decision;
}

/**
 * Accounts with pending points: everyone ever named in a `PointsCredited` event, less those whose
 * pending balance is now below the threshold. The log scan resumes from the cache.
 */
export async function fetchPendingAccounts(ctx: Ctx, head: Head): Promise<PendingAccount[]> {
  const { cache, config } = ctx;
  const known = new Set(cache.data.pointsAccounts.map((a) => getAddress(a)));
  const from = scanFrom(cache.scannedTo("points"), config.startBlock);
  if (from <= head.number) {
    const logs = await getLogsChunked(ctx.client, {
      address: ctx.deployment.points,
      events: eventsOf(ctx.abis.points, ["PointsCredited"]),
      fromBlock: from,
      toBlock: head.number,
      maxRange: config.logRange,
    });
    for (const log of logs) known.add(getAddress(log.args.user as Address));
  }
  const r = readerAt(ctx, head);
  const balances = await r.map([...known], async (address) => ({
    address,
    pending: await r.read<bigint>("points", "pendingOf", [address]),
  }));
  // An account with nothing pending at this block can be forgotten: a later credit emits a later event.
  const withPending = balances.filter((a) => a.pending > 0n);
  cache.data.pointsAccounts = withPending.map((a) => a.address);
  cache.data.scanned.points = head.number.toString();
  return withPending
    .filter((a) => a.pending >= config.flushMinPending)
    .sort((a, b) => (a.pending === b.pending ? a.address.localeCompare(b.address) : a.pending > b.pending ? -1 : 1));
}

export async function fetchPoints(ctx: Ctx, head: Head): Promise<PointsState> {
  const r = readerAt(ctx, head);
  const { config } = ctx;
  const [pending, raffles, freezeCount, nextDrawAt] = await Promise.all([
    fetchPendingAccounts(ctx, head),
    fetchVaultRaffles(ctx, head),
    r.read<bigint>("points", "freezeCount"),
    r.read<bigint>("vaultRaffle", "nextDrawAt"),
  ]);
  return {
    now: head.timestamp,
    freezeCount,
    pending,
    openRaffleDrawAfter: raffles.filter((x) => x.status === VR.Open).map((x) => x.drawAfter),
    nextDrawAt,
    lastFlushAt: ctx.cache.data.lastFlushAt === null ? null : BigInt(ctx.cache.data.lastFlushAt),
    intervalSeconds: config.flushIntervalSeconds,
    leadSeconds: config.flushLeadSeconds,
    onlyWithOpenRaffle: config.flushOnlyWithOpenRaffle,
    batchSize: flushBatchSize(config.maxGasPerTx, config.gasLimitMarginBps, config.flushGasPerAccount, config.flushMaxBatch),
  };
}

export async function runPoints(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchPoints(ctx, head);
  const decision = decidePoints(state);
  const report: TaskReport = { task: "points", results: [], findings: [...decision.findings], wakeAt: decision.wakeAt };

  // Batches are sized from a gas figure per account; if the estimate says a batch is still too large,
  // it is split in two and tried again.
  const queue: Action[] = [...decision.actions];
  let allConfirmed = decision.actions.length > 0;
  while (queue.length > 0) {
    const action = queue.shift()!;
    const result = await ctx.sender.execute(action);
    const accounts = action.args[0] as Address[];
    if (result.status === "skipped" && result.detail?.startsWith("needs ") && accounts.length > 1) {
      const half = Math.ceil(accounts.length / 2);
      const split = (part: Address[]): Action => ({ ...action, args: [part], reason: action.reason.replace(/\(\d+ account\(s\)\)/, `(${part.length} account(s))`) });
      queue.unshift(split(accounts.slice(0, half)), split(accounts.slice(half)));
      continue;
    }
    report.results.push(result);
    report.findings.push(...findingsOf("points", result));
    if (result.status !== "confirmed") allConfirmed = false;
  }
  if (allConfirmed) ctx.cache.data.lastFlushAt = head.timestamp.toString();
  report.metrics = {
    pendingAccounts: state.pending.length,
    pendingPoints: state.pending.reduce((sum, a) => sum + a.pending, 0n),
    freezeCount: state.freezeCount,
    flushReason: decision.reason,
  };
  return report;
}
