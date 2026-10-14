import type { Abi, PublicClient } from "viem";
import type { Cache } from "./cache.ts";
import { type Abis, type Deployment, Reader } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Sender } from "./sender.ts";
import type { Decision, Finding, TaskName, TaskReport } from "./types.ts";

export interface Ctx {
  config: Config;
  client: PublicClient;
  abis: Abis;
  errorsAbi: Abi;
  deployment: Deployment;
  cache: Cache;
  sender: Sender;
  log: Logger;
}

export interface Head {
  number: bigint;
  /** The chain's clock: the timestamp of the latest block. Every decision uses it, never the wall clock. */
  timestamp: bigint;
}

export async function headOf(client: PublicClient): Promise<Head> {
  const block = await client.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
}

export function readerAt(ctx: Ctx, head: Head): Reader {
  return new Reader(ctx.client, ctx.abis, ctx.deployment, head.number, ctx.config.readConcurrency);
}

/** Send a decision's actions one after another and collect what happened. */
export async function carryOut(ctx: Ctx, task: TaskName, decision: Decision): Promise<TaskReport> {
  const report: TaskReport = { task, results: [], findings: [...decision.findings], wakeAt: decision.wakeAt };
  for (const action of decision.actions) {
    const result = await ctx.sender.execute(action);
    report.results.push(result);
    report.findings.push(...findingsOf(task, result));
  }
  return report;
}

/** What a result means for a human: a call the keeper believed in that did not go through. */
export function findingsOf(task: TaskName, result: TaskReport["results"][number]): Finding[] {
  const call = `${result.action.contract}.${result.action.functionName}(${result.action.args
    .map((a) => (Array.isArray(a) ? `${a.length} accounts` : String(a)))
    .join(", ")})`;
  if (result.status === "skipped" && result.detail?.startsWith("simulation reverted")) {
    return [{ task, level: "warn", code: "simulation_reverted", message: `${call}: ${result.detail}` }];
  }
  if (result.status === "skipped") {
    return [{ task, level: "warn", code: "not_sent", message: `${call}: ${result.detail ?? "skipped"}` }];
  }
  if (result.status === "failed" || result.status === "reverted" || result.status === "pending") {
    return [{ task, level: "error", code: `transaction_${result.status}`, message: `${call}: ${result.detail ?? result.status}` }];
  }
  return [];
}

/** Lowest id in a list whose entry is not final yet; `count + 1` if all are. */
export function firstOpen<T extends { id: bigint }>(items: T[], isFinal: (item: T) => boolean, from: bigint, count: bigint): bigint {
  let mark = count + 1n;
  for (const item of items) {
    if (!isFinal(item) && item.id < mark) mark = item.id;
  }
  return mark < from ? from : mark;
}
