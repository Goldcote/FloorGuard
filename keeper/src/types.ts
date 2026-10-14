import type { Address, Hex } from "viem";

/** The contracts the keeper may send transactions to. */
export const TARGET_CONTRACTS = [
  "predictionMarket",
  "points",
  "vaultRaffle",
  "lottery",
  "ticketRaffle",
  "games",
  "vault",
] as const;
export type TargetContract = (typeof TARGET_CONTRACTS)[number];

export const TASK_NAMES = [
  "prediction",
  "points",
  "vaultRaffle",
  "lottery",
  "ticketRaffle",
  "games",
  "vault",
  "monitor",
] as const;
export type TaskName = (typeof TASK_NAMES)[number];

/** One permissionless call the keeper wants to make. Produced by the pure decision functions. */
export interface Action {
  task: TaskName;
  contract: TargetContract;
  functionName: string;
  args: readonly unknown[];
  /** Why, for the log. */
  reason: string;
}

export type Level = "info" | "warn" | "error";

/** Something a human should know. `warn` and `error` set the exit code. */
export interface Finding {
  task: TaskName;
  level: Level;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Decision {
  actions: Action[];
  findings: Finding[];
  /** Chain timestamps at which this task has something to do; the watch loop wakes for the earliest. */
  wakeAt: bigint[];
}

export function emptyDecision(): Decision {
  return { actions: [], findings: [], wakeAt: [] };
}

export type ActionStatus =
  | "confirmed" // mined and succeeded
  | "reverted" // mined and reverted: gas was paid
  | "pending" // sent, not mined within the timeout
  | "dry-run" // simulated successfully, not sent
  | "skipped" // not sent: simulation reverted, budget, gas price, disabled
  | "failed"; // could not be sent

export interface ActionResult {
  action: Action;
  status: ActionStatus;
  detail?: string;
  to?: Address;
  data?: Hex;
  txHash?: Hex;
  gasUsed?: bigint;
  gasEstimate?: bigint;
  costWei?: bigint;
  replacements?: number;
}

export interface TaskReport {
  task: TaskName;
  results: ActionResult[];
  findings: Finding[];
  wakeAt: bigint[];
  metrics?: Record<string, unknown>;
  /** Extra lines for the human-readable summary. */
  summary?: string[];
  error?: string;
}

export interface RunReport {
  startedAt: string;
  chainId: number;
  block: bigint;
  chainTime: bigint;
  dryRun: boolean;
  keeper: Address | null;
  tasks: TaskReport[];
  spentWei: bigint;
  exitCode: number;
}
