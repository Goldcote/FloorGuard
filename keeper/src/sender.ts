// The only code path that signs anything. Every send is: allowlist -> simulate -> estimate -> budget ->
// sign -> wait, with a fee bump on the same nonce if the transaction does not get mined.
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  decodeErrorResult,
} from "viem";
import { type EncodedCall, NotAllowedError, assertSendable, encodeAction } from "./allowlist.ts";
import type { Cache } from "./cache.ts";
import { errorText, isRevert } from "./chain.ts";
import type { Config } from "./config.ts";
import { type Logger, eth, gwei } from "./logger.ts";
import type { Action, ActionResult, TargetContract } from "./types.ts";

export type SenderConfig = Pick<
  Config,
  | "dryRun"
  | "account"
  | "simulateFrom"
  | "maxFeePerGasWei"
  | "maxPriorityFeePerGasWei"
  | "maxSpendPerRunWei"
  | "maxSpendPerDayWei"
  | "maxGasPerTx"
  | "gasLimitMarginBps"
  | "maxActionsPerRun"
  | "txTimeoutSeconds"
  | "maxReplacements"
  | "lotteryAbort"
  | "ticketRaffleAbort"
  | "vaultStartAuction"
  | "vaultRestartAuction"
>;

export interface SenderDeps {
  config: SenderConfig;
  client: PublicClient;
  wallet: WalletClient | null;
  abis: Record<TargetContract, Abi>;
  addresses: Record<TargetContract, Address>;
  errorsAbi: Abi;
  cache: Cache;
  log: Logger;
  /** Wall clock in seconds, for the daily budget. */
  now?: () => number;
  receiptPollMs?: number;
}

export type Fees =
  | { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { type: "legacy"; gasPrice: bigint };

export const feeCap = (fees: Fees) => (fees.type === "eip1559" ? fees.maxFeePerGas : fees.gasPrice);

/**
 * Fees for a transaction, or null when the network is above the ceiling.
 * `baseFee` is null on chains without EIP-1559.
 */
export function chooseFees(baseFee: bigint | null, suggestedTip: bigint, gasPrice: bigint, ceiling: bigint, maxTip: bigint): Fees | null {
  if (baseFee === null) return gasPrice > ceiling ? null : { type: "legacy", gasPrice };
  const tip = suggestedTip > maxTip ? maxTip : suggestedTip;
  if (baseFee + tip > ceiling) return null;
  // room for the base fee to double before the transaction stops being includable, never above the ceiling
  const want = baseFee * 2n + tip;
  return { type: "eip1559", maxFeePerGas: want > ceiling ? ceiling : want, maxPriorityFeePerGas: tip };
}

/**
 * Fees for replacing a pending transaction: at least 12.5% more on every field, which is what nodes
 * require, and never above the ceiling. Null when the ceiling leaves no room for a valid bump.
 */
export function bumpFees(fees: Fees, ceiling: bigint): Fees | null {
  const up = (v: bigint) => v + v / 8n + 1n;
  if (fees.type === "legacy") {
    const gasPrice = up(fees.gasPrice);
    return gasPrice > ceiling ? null : { type: "legacy", gasPrice };
  }
  const maxFeePerGas = up(fees.maxFeePerGas);
  const maxPriorityFeePerGas = up(fees.maxPriorityFeePerGas);
  if (maxFeePerGas > ceiling) return null;
  return { type: "eip1559", maxFeePerGas, maxPriorityFeePerGas };
}

/** Whether a transaction that may cost up to `bound` fits both budgets. */
export function fitsBudget(
  bound: bigint,
  spentRun: bigint,
  spentDay: bigint,
  maxRun: bigint,
  maxDay: bigint,
): { ok: true } | { ok: false; why: string } {
  if (spentRun + bound > maxRun) {
    return { ok: false, why: `would exceed the per-run budget (${eth(spentRun)} spent, up to ${eth(bound)} more, limit ${eth(maxRun)})` };
  }
  if (spentDay + bound > maxDay) {
    return { ok: false, why: `would exceed the daily budget (${eth(spentDay)} spent today, up to ${eth(bound)} more, limit ${eth(maxDay)})` };
  }
  return { ok: true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Sender {
  private readonly deps: SenderDeps;
  private nonce: number | null = null;
  /** Set when nothing more can be sent in this run, with the reason. */
  blocked: string | null = null;
  spentThisRun = 0n;
  sentThisRun = 0;

  constructor(deps: SenderDeps) {
    this.deps = deps;
  }

  /** Start a new run: the nonce is read again and the per-run budget starts from zero. */
  reset(): void {
    this.nonce = null;
    this.blocked = null;
    this.spentThisRun = 0n;
    this.sentThisRun = 0;
  }

  private get now(): number {
    return (this.deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  }

  get from(): Address {
    return this.deps.config.account?.address ?? this.deps.config.simulateFrom;
  }

  /** Simulate an action without any intention of sending it. Returns the revert reason, or null. */
  async wouldRevert(action: Pick<Action, "contract" | "functionName" | "args">): Promise<string | null> {
    const call = encodeAction(action, this.deps.abis, this.deps.addresses, {
      lotteryAbort: true,
      ticketRaffleAbort: true,
      vaultStartAuction: true,
    });
    return this.simulate(call);
  }

  private async simulate(call: EncodedCall): Promise<string | null> {
    try {
      await this.deps.client.call({ account: this.from, to: call.to, data: call.data, value: 0n });
      return null;
    } catch (error) {
      const reason = this.revertReason(error);
      if (reason !== null) return reason;
      throw error;
    }
  }

  /** The name of the custom error a call reverted with; null if the error is not a revert. */
  private revertReason(error: unknown): string | null {
    let data: unknown;
    let reverted = isRevert(error);
    for (let e = error as { data?: unknown; cause?: unknown; code?: number } | undefined, d = 0; e && d < 10; d++) {
      const candidate = typeof e.data === "object" && e.data !== null ? (e.data as { data?: unknown }).data : e.data;
      if (typeof candidate === "string" && candidate.startsWith("0x")) data = candidate;
      if (e.code === 3) reverted = true;
      e = e.cause as typeof e;
    }
    if (typeof data === "string" && data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: this.deps.errorsAbi, data: data as Hex });
        const args = (decoded.args ?? []).map((a) => String(a)).join(", ");
        return `${decoded.errorName}(${args})`;
      } catch {
        return `unknown error ${data.slice(0, 10)}`;
      }
    }
    if (typeof data === "string" || reverted) return errorText(error) || "reverted without a reason";
    return null;
  }

  async execute(action: Action): Promise<ActionResult> {
    const result = await this.run(action);
    const level = ["reverted", "failed", "pending"].includes(result.status) ? "error" : "info";
    this.deps.log.event(level, "action", {
      task: action.task,
      contract: action.contract,
      function: action.functionName,
      args: action.args,
      reason: action.reason,
      status: result.status,
      detail: result.detail,
      to: result.to,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      gasEstimate: result.gasEstimate,
      costWei: result.costWei,
      replacements: result.replacements,
    });
    return result;
  }

  private async run(action: Action): Promise<ActionResult> {
    const { config, client } = this.deps;
    const skipped = (detail: string, extra: Partial<ActionResult> = {}): ActionResult => ({ action, status: "skipped", detail, ...extra });
    const failed = (detail: string, extra: Partial<ActionResult> = {}): ActionResult => ({ action, status: "failed", detail, ...extra });

    // 1. allowlist, in the one place that defines it
    let call: EncodedCall;
    try {
      call = encodeAction(action, this.deps.abis, this.deps.addresses, {
        lotteryAbort: config.lotteryAbort,
        ticketRaffleAbort: config.ticketRaffleAbort,
        // starting and restarting an auction are the same function
        vaultStartAuction: config.vaultStartAuction || config.vaultRestartAuction,
      });
    } catch (error) {
      if (error instanceof NotAllowedError) return failed(error.message);
      return failed(`could not encode the call: ${errorText(error)}`);
    }
    const base = { to: call.to, data: call.data };
    if (this.blocked !== null) return skipped(this.blocked, base);
    if (this.sentThisRun >= config.maxActionsPerRun) return skipped("the per-run transaction limit is reached", base);

    // 2. simulate: never pay for a revert
    let gasEstimate: bigint;
    try {
      const reason = await this.simulate(call);
      if (reason !== null) return skipped(`simulation reverted: ${reason}`, base);
      gasEstimate = await client.estimateGas({ account: this.from, to: call.to, data: call.data, value: 0n });
    } catch (error) {
      const reason = this.revertReason(error);
      if (reason !== null) return skipped(`simulation reverted: ${reason}`, base);
      return failed(`simulation failed: ${errorText(error)}`, base);
    }
    const gas = gasEstimate + (gasEstimate * config.gasLimitMarginBps) / 10_000n;
    if (gas > config.maxGasPerTx) {
      return skipped(`needs ${gas} gas, above the limit of ${config.maxGasPerTx} per transaction`, { ...base, gasEstimate });
    }

    if (config.dryRun || !config.account || !this.deps.wallet) {
      return { action, status: "dry-run", detail: "simulation passed", ...base, gasEstimate };
    }

    // 3. fees and budgets
    let fees: Fees | null;
    try {
      fees = await this.currentFees();
    } catch (error) {
      return failed(`could not read gas prices: ${errorText(error)}`, base);
    }
    if (fees === null) {
      return skipped(`gas price is above the ceiling of ${gwei(config.maxFeePerGasWei)}`, { ...base, gasEstimate });
    }
    const bound = gas * feeCap(fees);
    const fit = fitsBudget(bound, this.spentThisRun, this.deps.cache.spentOn(this.now), config.maxSpendPerRunWei, config.maxSpendPerDayWei);
    if (!fit.ok) return skipped(fit.why, { ...base, gasEstimate });
    const balance = await client.getBalance({ address: config.account.address });
    if (balance < bound) {
      this.blocked = `the keeper's balance (${eth(balance)}) does not cover the next transaction`;
      return skipped(this.blocked, { ...base, gasEstimate });
    }

    // 4. sign and send
    try {
      return await this.sendAndWait(action, call, gas, fees, gasEstimate);
    } catch (error) {
      return failed(`send failed: ${errorText(error)}`, { ...base, gasEstimate });
    }
  }

  private async currentFees(): Promise<Fees | null> {
    const { client, config } = this.deps;
    const block = await client.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? null;
    if (baseFee === null) {
      return chooseFees(null, 0n, await client.getGasPrice(), config.maxFeePerGasWei, config.maxPriorityFeePerGasWei);
    }
    let tip: bigint;
    try {
      tip = await client.estimateMaxPriorityFeePerGas();
    } catch {
      tip = config.maxPriorityFeePerGasWei;
    }
    return chooseFees(baseFee, tip, 0n, config.maxFeePerGasWei, config.maxPriorityFeePerGasWei);
  }

  /**
   * The next nonce. Starts from the mined count, not the pending count: a transaction left in the
   * mempool by an earlier run is replaced by whatever this run decides, instead of being queued behind.
   */
  private async nextNonce(): Promise<number> {
    if (this.nonce !== null) return this.nonce;
    const address = this.deps.config.account!.address;
    const [mined, pending] = await Promise.all([
      this.deps.client.getTransactionCount({ address, blockTag: "latest" }),
      this.deps.client.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    if (pending > mined) {
      this.deps.log.event("warn", "pending_transactions", {
        message: `${pending - mined} transaction(s) of an earlier run are still pending; replacing from nonce ${mined}`,
        mined,
        pending,
      });
    }
    this.nonce = mined;
    return mined;
  }

  private async submit(call: EncodedCall, gas: bigint, nonce: number, fees: Fees): Promise<Hex> {
    // the last look at the bytes before they are signed
    assertSendable({ to: call.to, data: call.data, value: 0n }, this.deps.addresses);
    const wallet = this.deps.wallet!;
    const common = { account: this.deps.config.account!, chain: wallet.chain, to: call.to, data: call.data, value: 0n, gas, nonce } as const;
    return fees.type === "eip1559"
      ? wallet.sendTransaction({ ...common, type: "eip1559", maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
      : wallet.sendTransaction({ ...common, type: "legacy", gasPrice: fees.gasPrice });
  }

  private async receiptOfAny(hashes: Hex[]): Promise<TransactionReceipt | null> {
    for (const hash of hashes) {
      try {
        return await this.deps.client.getTransactionReceipt({ hash });
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name !== "TransactionReceiptNotFoundError" && name !== "TransactionNotFoundError") throw error;
      }
    }
    return null;
  }

  private async waitForAny(hashes: Hex[], timeoutMs: number): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    const poll = this.deps.receiptPollMs ?? 1_000;
    // look often at first (a fast chain answers within a block time), then settle at the poll interval
    for (let wait = Math.min(poll, 100); ; wait = Math.min(poll, wait * 2)) {
      const receipt = await this.receiptOfAny(hashes);
      if (receipt) return receipt;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
    }
  }

  private async sendAndWait(action: Action, call: EncodedCall, gas: bigint, firstFees: Fees, gasEstimate: bigint): Promise<ActionResult> {
    const { config, log } = this.deps;
    const base = { action, to: call.to, data: call.data, gasEstimate };
    const hashes: Hex[] = [];
    let fees = firstFees;
    let nonce = await this.nextNonce();
    let replacements = 0;
    let refreshed = false;

    for (;;) {
      try {
        hashes.push(await this.submit(call, gas, nonce, fees));
        this.sentThisRun++;
      } catch (error) {
        const text = errorText(error) + " " + String((error as { details?: string }).details ?? "");
        if (/nonce too low|already known|already imported/i.test(text) && hashes.length > 0) {
          // an earlier attempt at this nonce was mined while the replacement was being prepared
        } else if (/nonce too low/i.test(text) && !refreshed) {
          refreshed = true;
          this.nonce = null;
          nonce = await this.nextNonce();
          continue;
        } else if (/underpriced/i.test(text) && replacements < config.maxReplacements) {
          // an older transaction sits at this nonce and has to be outbid
          const bumped = bumpFees(fees, config.maxFeePerGasWei);
          if (bumped === null) {
            this.blocked = `nonce ${nonce} is held by a pending transaction that cannot be outbid under the gas price ceiling`;
            return { ...base, status: hashes.length ? "pending" : "skipped", detail: this.blocked, txHash: hashes.at(-1) };
          }
          fees = bumped;
          replacements++;
          continue;
        } else {
          throw error;
        }
      }

      const receipt = await this.waitForAny(hashes, config.txTimeoutSeconds * 1000);
      if (receipt) {
        this.nonce = nonce + 1;
        const cost = receipt.gasUsed * receipt.effectiveGasPrice;
        this.account(cost);
        const ok = receipt.status === "success";
        return {
          ...base,
          status: ok ? "confirmed" : "reverted",
          detail: ok ? undefined : "mined but reverted: the state changed between the simulation and inclusion",
          txHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed,
          costWei: cost,
          replacements,
        };
      }

      const bumped = replacements < config.maxReplacements ? bumpFees(fees, config.maxFeePerGasWei) : null;
      if (bumped === null) {
        // still in the mempool: count the worst case against the budgets and stop sending in this run
        this.account(gas * feeCap(fees));
        this.blocked = `transaction at nonce ${nonce} is still pending after ${replacements} replacement(s)`;
        return { ...base, status: "pending", detail: this.blocked, txHash: hashes.at(-1), replacements };
      }
      fees = bumped;
      replacements++;
      log.event("warn", "replacing_transaction", { nonce, attempt: replacements, maxFeePerGas: feeCap(fees), previous: hashes.at(-1) });
    }
  }

  private account(cost: bigint): void {
    this.spentThisRun += cost;
    this.deps.cache.addSpend(this.now, cost);
    try {
      this.deps.cache.save();
    } catch (error) {
      this.deps.log.event("warn", "cache_write_failed", { message: errorText(error) });
    }
  }
}
