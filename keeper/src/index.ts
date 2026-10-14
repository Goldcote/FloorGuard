#!/usr/bin/env node
// FloorGuard keeper: permissionless maintenance calls, nothing else.
//
//   node src/index.ts once      one pass, then exit (for cron)
//   node src/index.ts watch     loop until SIGINT/SIGTERM
//   node src/index.ts monitor   one pass of the monitoring task only; sends nothing
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "./chain.ts";
import { ConfigError, KEEPER_DIR, describeConfig, loadConfig } from "./config.ts";
import { makeLogger } from "./logger.ts";
import { EXIT, createContext, runOnce, watch } from "./runner.ts";
import { TASK_NAMES } from "./types.ts";

const USAGE = `usage: node src/index.ts <once|watch|monitor> [--dry-run]

  once      run every enabled task once and exit
  watch     keep running; wakes for deadlines and for new oracle prices
  monitor   print the monitoring figures only; never sends a transaction
  --dry-run simulate everything, send nothing (also the behaviour without a key)

Configuration is read from the environment, from keeper/.env if it exists, and from the JSON file
named by KEEPER_CONFIG. See .env.example.

exit codes: 0 nothing to report, 1 could not start, 2 something needs attention, 3 a task or
transaction failed.`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith("-"));
  if (!mode || args.includes("--help") || args.includes("-h") || !["once", "watch", "monitor"].includes(mode)) {
    process.stderr.write(USAGE + "\n");
    return mode && ["once", "watch", "monitor"].includes(mode) ? EXIT.ok : EXIT.fatal;
  }

  // .env next to package.json, then one in the working directory; real environment variables win
  for (const file of new Set([join(KEEPER_DIR, ".env"), join(process.cwd(), ".env")])) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  if (args.includes("--dry-run")) process.env.KEEPER_DRY_RUN = "true";

  let log = makeLogger("both");
  try {
    const config = loadConfig(process.env, { scrub: true });
    if (mode === "monitor") {
      for (const task of TASK_NAMES) config.tasks[task] = task === "monitor";
    }
    log = makeLogger(config.logFormat);
    log.event("info", "config", describeConfig(config));
    if (config.dryRun) {
      const notice = `DRY RUN: ${config.dryRunReason}. Calls are simulated and reported, nothing is sent.`;
      log.event("warn", "dry_run", { reason: config.dryRunReason });
      log.summary(notice);
    }

    const ctx = await createContext(config, log);
    if (mode === "watch") {
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
      await watch(ctx, controller.signal);
      return EXIT.ok;
    }
    return (await runOnce(ctx)).exitCode;
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : errorText(error);
    log.event("error", "fatal", { message });
    log.summary(`fatal: ${message}`);
    return EXIT.fatal;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fatal: ${errorText(error)}\n`);
    process.exitCode = EXIT.fatal;
  },
);
