// One pass over all tasks, and the loop around it.
import { type Abi, type WalletClient, createWalletClient, http } from "viem";
import { verifyAbis } from "./allowlist.ts";
import { Cache, fingerprintOf } from "./cache.ts";
import { collectErrors, errorText, loadAbis, loadDeployment, makeChain, makePublicClient, targetAddresses } from "./chain.ts";
import { type Config, ConfigError } from "./config.ts";
import { type Ctx, type Head, headOf } from "./context.ts";
import { type Logger, renderSummary } from "./logger.ts";
import { Sender } from "./sender.ts";
import { runGames } from "./tasks/games.ts";
import { runLottery } from "./tasks/lottery.ts";
import { runMonitor } from "./tasks/monitor.ts";
import { fetchPendingAccounts, runPoints } from "./tasks/points.ts";
import { runPrediction } from "./tasks/prediction.ts";
import { runTicketRaffle } from "./tasks/ticketRaffle.ts";
import { runVault } from "./tasks/vault.ts";
import { runVaultRaffle } from "./tasks/vaultRaffle.ts";
import { TARGET_CONTRACTS, type RunReport, type TargetContract, type TaskName, type TaskReport } from "./types.ts";

export const EXIT = {
  ok: 0,
  /** Could not start or could not reach the chain. */
  fatal: 1,
  /** Ran, and something needs a human: a stuck market, a monitoring warning, a call that was not sent. */
  attention: 2,
  /** A task or a transaction failed, or monitoring found an error-level condition. */
  failure: 3,
} as const;

export async function createContext(config: Config, log: Logger): Promise<Ctx> {
  const abis = loadAbis(config.outDir);
  const deployment = loadDeployment(config.deploymentFile);
  const targetAbis = Object.fromEntries(TARGET_CONTRACTS.map((c) => [c, abis[c]])) as Record<TargetContract, Abi>;
  verifyAbis(targetAbis);

  const client = makePublicClient(config);
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new ConfigError(`cannot reach the RPC endpoint: ${errorText(error)}`);
  }
  if (chainId !== config.chainId) {
    throw new ConfigError(`the RPC endpoint is chain ${chainId}, but KEEPER_CHAIN_ID is ${config.chainId}`);
  }
  for (const contract of TARGET_CONTRACTS) {
    const code = await client.getCode({ address: deployment[contract] });
    if (!code || code === "0x") {
      throw new ConfigError(`${contract} at ${deployment[contract]} has no code on chain ${chainId}: wrong deployment file?`);
    }
  }

  const wallet: WalletClient | null =
    config.account && !config.dryRun
      ? createWalletClient({ account: config.account, chain: makeChain(config), transport: http(config.rpcUrl, { retryCount: 0, timeout: 20_000 }) })
      : null;

  const cache = new Cache(config.cacheFile, config.chainId, fingerprintOf(deployment));
  if (cache.discarded) log.event("warn", "cache_discarded", { file: config.cacheFile, reason: cache.discarded });

  const errorsAbi = collectErrors(abis);
  const sender = new Sender({ config, client, wallet, abis: targetAbis, addresses: targetAddresses(deployment), errorsAbi, cache, log });
  return { config, client, abis, errorsAbi, deployment, cache, sender, log };
}

export function exitCodeOf(tasks: TaskReport[]): number {
  let code: number = EXIT.ok;
  for (const task of tasks) {
    if (task.error || task.findings.some((f) => f.level === "error")) return EXIT.failure;
    if (task.findings.some((f) => f.level === "warn")) code = EXIT.attention;
  }
  return code;
}

type TaskRunner = (ctx: Ctx, head: Head) => Promise<TaskReport>;

const RUNNERS: [TaskName, TaskRunner][] = [
  ["prediction", runPrediction],
  // points before the vault raffle: a draw closes activation
  ["points", runPoints],
  [
    "vaultRaffle",
    async (ctx, head) => {
      let pending: number | null = null;
      try {
        pending = (await fetchPendingAccounts(ctx, head)).length;
      } catch (error) {
        ctx.log.event("warn", "pending_points_unknown", { message: errorText(error) });
      }
      return runVaultRaffle(ctx, head, pending);
    },
  ],
  ["lottery", runLottery],
  ["ticketRaffle", runTicketRaffle],
  ["games", runGames],
  ["vault", runVault],
  ["monitor", runMonitor],
];

/** Run every enabled task once. */
export async function runOnce(ctx: Ctx): Promise<RunReport> {
  const { config, log } = ctx;
  const startedAt = new Date().toISOString();
  // nonce, per-run budget and the "blocked" flag all start over
  ctx.sender.reset();

  const first = await headOf(ctx.client);
  for (const stream of Object.keys(ctx.cache.data.scanned)) {
    if ((ctx.cache.scannedTo(stream) ?? 0n) > first.number) {
      log.event("warn", "cache_ahead_of_chain", { message: "the cache has scanned past the chain head (reset chain?); rebuilding from the start block" });
      ctx.cache.reset();
      break;
    }
  }
  log.event("info", "run_start", {
    chainId: config.chainId,
    block: first.number,
    chainTime: first.timestamp,
    dryRun: config.dryRun,
    dryRunReason: config.dryRunReason,
    keeper: config.account?.address ?? null,
    tasks: Object.entries(config.tasks).filter(([, on]) => on).map(([name]) => name),
  });

  const tasks: TaskReport[] = [];
  let head = first;
  for (const [name, run] of RUNNERS) {
    if (!config.tasks[name]) continue;
    let report: TaskReport;
    try {
      // each task looks at the chain as the previous task left it
      head = await headOf(ctx.client);
      report = await run(ctx, head);
    } catch (error) {
      report = { task: name, results: [], findings: [], wakeAt: [], error: errorText(error) };
      log.event("error", "task_failed", { task: name, message: report.error });
    }
    for (const f of report.findings) log.event(f.level, "finding", { task: f.task, code: f.code, message: f.message, ...f.data });
    log.event("info", "task_done", { task: name, actions: report.results.length, findings: report.findings.length, ...report.metrics });
    tasks.push(report);
  }

  try {
    ctx.cache.save();
  } catch (error) {
    log.event("warn", "cache_write_failed", { message: errorText(error) });
  }

  const report: RunReport = {
    startedAt,
    chainId: config.chainId,
    block: head.number,
    chainTime: head.timestamp,
    dryRun: config.dryRun,
    keeper: config.account?.address ?? null,
    tasks,
    spentWei: ctx.sender.spentThisRun,
    exitCode: exitCodeOf(tasks),
  };
  log.event("info", "run_done", { block: report.block, spentWei: report.spentWei, exitCode: report.exitCode });
  log.summary(renderSummary(report));
  return report;
}

/** Seconds to sleep before the next pass: the poll interval, or less if a task has something due. */
export function nextDelaySeconds(report: RunReport, pollSeconds: number, fastPollSeconds: number): number {
  let delay = pollSeconds;
  for (const task of report.tasks) {
    for (const at of task.wakeAt) {
      const wait = at <= report.chainTime ? fastPollSeconds : Number(at - report.chainTime);
      if (wait < delay) delay = wait;
    }
  }
  return Math.max(Math.min(delay, pollSeconds), Math.min(fastPollSeconds, pollSeconds), 1);
}

export async function watch(ctx: Ctx, signal: AbortSignal): Promise<void> {
  const { config, log } = ctx;
  let wake: (() => void) | null = null;
  const sleep = (seconds: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, seconds * 1000);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        wake = null;
        resolve();
      }
      wake = done;
      signal.addEventListener("abort", done, { once: true });
    });

  // Any event from the prediction market's oracle may be the price a market is waiting for: run at once.
  let unwatch: (() => void) | null = null;
  if (config.tasks.prediction) {
    try {
      const oracle = (await ctx.client.readContract({
        address: ctx.deployment.predictionMarket,
        abi: ctx.abis.predictionMarket,
        functionName: "oracle",
      })) as `0x${string}`;
      unwatch = ctx.client.watchEvent({
        address: oracle,
        pollingInterval: config.fastPollSeconds * 1000,
        onLogs: () => wake?.(),
        onError: (error) => log.event("warn", "oracle_watch_error", { message: errorText(error) }),
      });
    } catch (error) {
      log.event("warn", "oracle_watch_unavailable", { message: errorText(error) });
    }
  }

  let failures = 0;
  while (!signal.aborted) {
    let delay = config.pollSeconds;
    try {
      const report = await runOnce(ctx);
      delay = nextDelaySeconds(report, config.pollSeconds, config.fastPollSeconds);
      failures = 0;
    } catch (error) {
      failures++;
      delay = Math.min(config.pollSeconds * 2 ** Math.min(failures, 5), 900);
      log.event("error", "run_failed", { message: errorText(error), retryInSeconds: delay });
    }
    if (!signal.aborted) await sleep(delay);
  }
  unwatch?.();
  log.event("info", "stopped", {});
}
