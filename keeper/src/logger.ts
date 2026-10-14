// Structured JSON lines for machines, a short summary for people.
import { formatEther, formatGwei } from "viem";
import type { Level, RunReport } from "./types.ts";

export interface Logger {
  event(level: Level, event: string, fields?: Record<string, unknown>): void;
  summary(text: string): void;
}

export function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function makeLogger(
  format: "json" | "text" | "both",
  out: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  err: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Logger {
  return {
    event(level, event, fields = {}) {
      if (format === "text") return;
      out(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, jsonSafe));
    },
    summary(text) {
      if (format === "json") return;
      // with both, JSON lines own stdout and the summary goes to stderr, so `>> keeper.jsonl` stays clean
      (format === "both" ? err : out)(text);
    },
  };
}

export const silentLogger: Logger = { event() {}, summary() {} };

export const eth = (wei: bigint) => `${formatEther(wei)} ETH`;
export const gwei = (wei: bigint) => `${formatGwei(wei)} gwei`;

export function duration(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s < 120) return `${s}s`;
  if (s < 7_200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3_600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

export function renderSummary(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `FloorGuard keeper | chain ${report.chainId} | block ${report.block} | ` +
      (report.dryRun ? "DRY RUN, nothing sent" : `keeper ${report.keeper}`),
  );
  for (const task of report.tasks) {
    const sent = task.results.filter((r) => r.status === "confirmed").length;
    const would = task.results.filter((r) => r.status === "dry-run").length;
    const bad = task.results.filter((r) => ["reverted", "failed", "pending"].includes(r.status)).length;
    const skipped = task.results.filter((r) => r.status === "skipped").length;
    const parts = [
      sent ? `${sent} sent` : "",
      would ? `${would} would send` : "",
      skipped ? `${skipped} skipped` : "",
      bad ? `${bad} FAILED` : "",
      task.error ? `ERROR ${task.error}` : "",
    ].filter(Boolean);
    lines.push(`  ${task.task}: ${parts.length ? parts.join(", ") : "nothing to do"}`);
    for (const r of task.results) {
      const call = `${r.action.contract}.${r.action.functionName}(${formatArgs(r.action.args)})`;
      const tail = [
        r.txHash ? `tx ${r.txHash}` : "",
        r.gasUsed !== undefined ? `gas ${r.gasUsed}` : r.gasEstimate !== undefined ? `gas est. ${r.gasEstimate}` : "",
        r.detail ?? "",
      ].filter(Boolean);
      lines.push(`    [${r.status}] ${call}: ${r.action.reason}${tail.length ? ` (${tail.join(", ")})` : ""}`);
    }
    for (const line of task.summary ?? []) lines.push(`    ${line}`);
    for (const f of task.findings) {
      lines.push(`    ${f.level === "info" ? "note" : f.level.toUpperCase()} ${f.code}: ${f.message}`);
    }
  }
  lines.push(`  spent ${eth(report.spentWei)} | exit ${report.exitCode}`);
  return lines.join("\n");
}

function formatArgs(args: readonly unknown[]): string {
  return args
    .map((a) => (Array.isArray(a) ? `[${a.length} accounts]` : typeof a === "bigint" ? a.toString() : String(a)))
    .join(", ");
}
