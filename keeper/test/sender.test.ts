// The sender with a scripted node behind it: what gets signed, when, and what never does.
import { type Abi, type Hex, type PublicClient, type WalletClient, encodeErrorResult, parseAbi, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.ts";
import { silentLogger } from "../src/logger.ts";
import { Sender, type SenderConfig, bumpFees, chooseFees, fitsBudget } from "../src/sender.ts";
import type { Action } from "../src/types.ts";
import { A, ABIS, ADDRESSES } from "./helpers.ts";

// anvil's well-known development key #1
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const errorsAbi = parseAbi(["error TooEarly(uint256 readyAt)", "error NotResolvable()"]) as Abi;

const config = (over: Partial<SenderConfig> = {}): SenderConfig => ({
  dryRun: false,
  account,
  simulateFrom: account.address,
  maxFeePerGasWei: parseGwei("30"),
  maxPriorityFeePerGasWei: parseGwei("2"),
  maxSpendPerRunWei: 10n ** 17n,
  maxSpendPerDayWei: 10n ** 18n,
  maxGasPerTx: 3_000_000n,
  gasLimitMarginBps: 3_000n,
  maxActionsPerRun: 50,
  txTimeoutSeconds: 1,
  maxReplacements: 3,
  lotteryAbort: false,
  ticketRaffleAbort: false,
  vaultStartAuction: false,
  vaultRestartAuction: false,
  ...over,
});

class NotFound extends Error {
  override name = "TransactionReceiptNotFoundError";
}

/** A node that mines only the `mineAfter`-th transaction it is sent (none, if Infinity). */
function node(options: { baseFee?: bigint | null; mineAfter?: number; status?: "success" | "reverted"; revert?: Hex | null; balance?: bigint; mined?: number; pending?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    call: vi.fn(async () => {
      if (options.revert) throw Object.assign(new Error("execution reverted"), { code: 3, data: options.revert });
      return { data: "0x" };
    }),
    estimateGas: vi.fn(async () => 100_000n),
    getBlock: vi.fn(async () => ({ baseFeePerGas: options.baseFee === undefined ? parseGwei("10") : options.baseFee })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => parseGwei("1")),
    getGasPrice: vi.fn(async () => parseGwei("12")),
    getBalance: vi.fn(async () => options.balance ?? 10n ** 18n),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? (options.pending ?? options.mined ?? 7) : (options.mined ?? 7))),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const last = `0x${String(sent.length).padStart(64, "0")}`;
      if (sent.length >= (options.mineAfter ?? 1) && hash === last) {
        return { transactionHash: hash, status: options.status ?? "success", gasUsed: 80_000n, effectiveGasPrice: parseGwei("11") };
      }
      throw new NotFound();
    }),
  };
  const wallet = {
    chain: undefined,
    sendTransaction: vi.fn(async (tx: Record<string, unknown>) => {
      sent.push(tx);
      return `0x${String(sent.length).padStart(64, "0")}` as Hex;
    }),
  };
  return { client, wallet, sent };
}

function sender(n: ReturnType<typeof node>, cfg: SenderConfig = config(), wallet = true) {
  const cache = new Cache(null, 31337, "0x00");
  const s = new Sender({
    config: cfg,
    client: n.client as unknown as PublicClient,
    wallet: wallet ? (n.wallet as unknown as WalletClient) : null,
    abis: ABIS,
    addresses: ADDRESSES,
    errorsAbi,
    cache,
    log: silentLogger,
    now: () => 1_800_000_000,
    receiptPollMs: 5,
  });
  return { s, cache };
}

const resolve: Action = { task: "prediction", contract: "predictionMarket", functionName: "resolve", args: [1n], reason: "test" };

describe("sender", () => {
  it("simulates, then sends exactly the simulated bytes with no value", async () => {
    const n = node();
    const { s, cache } = sender(n);
    const result = await s.execute(resolve);

    expect(result.status).toBe("confirmed");
    expect(n.client.call).toHaveBeenCalledTimes(1);
    expect(n.sent).toHaveLength(1);
    const tx = n.sent[0]!;
    expect(tx.to).toBe(ADDRESSES.predictionMarket);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(result.data);
    expect((n.client.call.mock.calls[0] as unknown[])[0]).toMatchObject({ to: tx.to, data: tx.data, value: 0n, account: account.address });
    // 100,000 estimated, plus a 30% margin
    expect(tx.gas).toBe(130_000n);
    expect(tx.nonce).toBe(7);
    expect(tx.maxFeePerGas).toBe(parseGwei("21")); // twice the base fee plus the tip
    expect(tx.maxPriorityFeePerGas).toBe(parseGwei("1"));
    // what it cost is booked against both budgets
    expect(result.costWei).toBe(80_000n * parseGwei("11"));
    expect(s.spentThisRun).toBe(result.costWei);
    expect(cache.spentOn(1_800_000_000)).toBe(result.costWei);
  });

  it("does not send when the simulation reverts, and names the error", async () => {
    const n = node({ revert: encodeErrorResult({ abi: errorsAbi, errorName: "TooEarly", args: [123n] }) });
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("simulation reverted: TooEarly(123)");
    expect(n.sent).toHaveLength(0);
    expect(n.client.estimateGas).not.toHaveBeenCalled();
  });

  it("treats a failing RPC as a failure, not as a revert, and still sends nothing", async () => {
    const n = node();
    n.client.call.mockRejectedValueOnce(new Error("fetch failed"));
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("failed");
    expect(n.sent).toHaveLength(0);
  });

  it("refuses a call that is not on the allowlist before touching the node", async () => {
    const n = node();
    const result = await sender(n).s.execute({ ...resolve, contract: "vault", functionName: "governanceUnlock" });
    expect(result.status).toBe("failed");
    expect(result.detail).toMatch(/not on the allowlist/);
    expect(n.client.call).not.toHaveBeenCalled();
    expect(n.sent).toHaveLength(0);
  });

  it("sends the Vault's daily maintenance calls without an opt-in, and never its randomness callback", async () => {
    for (const [functionName, args] of [
      ["sampleFloor", [A(9)]],
      ["requestUnlockRound", []],
      ["releaseToPlayers", [4n]],
    ] as const) {
      const n = node();
      const result = await sender(n).s.execute({ task: "vault", contract: "vault", functionName, args, reason: "test" });
      expect(result.status, functionName).toBe("confirmed");
      expect(n.sent).toHaveLength(1);
      expect(n.sent[0]!.to).toBe(ADDRESSES.vault);
      expect(n.sent[0]!.value).toBe(0n);
    }
    const n = node();
    const fulfill = await sender(n).s.execute({ task: "vault", contract: "vault", functionName: "fulfillRandomness", args: [1n, 2n], reason: "test" });
    expect(fulfill.status).toBe("failed");
    expect(n.sent).toHaveLength(0);
  });

  it("refuses an opt-in call unless its switch is on", async () => {
    const abort: Action = { task: "lottery", contract: "lottery", functionName: "abort", args: [1n], reason: "test" };
    const off = node();
    expect((await sender(off).s.execute(abort)).status).toBe("failed");
    expect(off.sent).toHaveLength(0);
    const on = node();
    expect((await sender(on, config({ lotteryAbort: true })).s.execute(abort)).status).toBe("confirmed");

    const start: Action = { task: "vault", contract: "vault", functionName: "startAuction", args: [1n], reason: "test" };
    expect((await sender(node()).s.execute(start)).status).toBe("failed");
    expect((await sender(node(), config({ vaultRestartAuction: true })).s.execute(start)).status).toBe("confirmed");
  });

  it("only simulates in dry-run, and without a key", async () => {
    for (const [cfg, withWallet] of [
      [config({ dryRun: true }), true],
      [config({ account: null, dryRun: true }), false],
    ] as const) {
      const n = node();
      const result = await sender(n, cfg, withWallet).s.execute(resolve);
      expect(result.status).toBe("dry-run");
      expect(result.gasEstimate).toBe(100_000n);
      expect(n.client.call).toHaveBeenCalledTimes(1);
      expect(n.sent).toHaveLength(0);
    }
  });

  it("does not send above the gas price ceiling", async () => {
    const n = node({ baseFee: parseGwei("40") });
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/above the ceiling/);
    expect(n.sent).toHaveLength(0);
  });

  it("does not send what could exceed the per-run or the daily budget", async () => {
    // worst case for one transaction here: 130,000 gas at 21 gwei = 0.00273 ETH
    const perRun = node();
    const run = await sender(perRun, config({ maxSpendPerRunWei: 2_000_000_000_000_000n })).s.execute(resolve);
    expect(run.status).toBe("skipped");
    expect(run.detail).toMatch(/per-run budget/);
    expect(perRun.sent).toHaveLength(0);

    const perDay = node();
    const { s, cache } = sender(perDay, config({ maxSpendPerDayWei: 5_000_000_000_000_000n }));
    cache.addSpend(1_800_000_000, 3_000_000_000_000_000n); // spent earlier today by another run
    const day = await s.execute(resolve);
    expect(day.status).toBe("skipped");
    expect(day.detail).toMatch(/daily budget/);
    expect(perDay.sent).toHaveLength(0);
  });

  it("stops at the per-run transaction limit and the per-transaction gas limit", async () => {
    const n = node();
    const { s } = sender(n, config({ maxActionsPerRun: 1 }));
    expect((await s.execute(resolve)).status).toBe("confirmed");
    expect((await s.execute(resolve)).detail).toMatch(/transaction limit/);
    expect(n.sent).toHaveLength(1);

    const big = node();
    const result = await sender(big, config({ maxGasPerTx: 120_000n })).s.execute(resolve);
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/^needs 130000 gas/);
    expect(big.sent).toHaveLength(0);
  });

  it("stops the run when the balance cannot cover a transaction", async () => {
    const n = node({ balance: 1_000n });
    const { s } = sender(n);
    expect((await s.execute(resolve)).detail).toMatch(/balance/);
    expect(s.blocked).toMatch(/balance/);
    expect((await s.execute(resolve)).status).toBe("skipped");
    expect(n.sent).toHaveLength(0);
  });

  it("uses consecutive nonces within a run", async () => {
    const n = node();
    const { s } = sender(n);
    await s.execute(resolve);
    await s.execute(resolve);
    expect(n.sent.map((tx) => tx.nonce)).toEqual([7, 8]);
    expect(n.client.getTransactionCount).toHaveBeenCalledTimes(2); // latest and pending, once
  });

  it("starts from the mined nonce, so a transaction stuck from an earlier run is replaced", async () => {
    const n = node({ mined: 7, pending: 9 });
    await sender(n).s.execute(resolve);
    expect(n.sent[0]!.nonce).toBe(7);
  });

  it("replaces a transaction that is not mined in time: same nonce, same bytes, at least 12.5% more", async () => {
    // the first transaction is never mined; its replacement is
    const n = node({ mineAfter: 2 });
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("confirmed");
    expect(result.replacements).toBe(1);
    expect(n.sent).toHaveLength(2);
    const [first, second] = n.sent as { nonce: number; data: Hex; to: Hex; value: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }[];
    expect(second!.nonce).toBe(first!.nonce);
    expect(second!.data).toBe(first!.data);
    expect(second!.to).toBe(first!.to);
    expect(second!.value).toBe(0n);
    expect(second!.maxFeePerGas * 8n).toBeGreaterThanOrEqual(first!.maxFeePerGas * 9n);
    expect(second!.maxPriorityFeePerGas * 8n).toBeGreaterThanOrEqual(first!.maxPriorityFeePerGas * 9n);
    expect(second!.maxFeePerGas).toBeLessThanOrEqual(parseGwei("30"));
    expect(result.txHash).toBe(`0x${"2".padStart(64, "0")}`);
  }, 10_000);

  it("gives up replacing at the ceiling, reports the transaction as pending and sends nothing more", async () => {
    const n = node({ mineAfter: Infinity, baseFee: parseGwei("13") }); // first fee 27 gwei: one bump would pass 30
    const { s } = sender(n);
    const result = await s.execute(resolve);
    expect(result.status).toBe("pending");
    expect(n.sent).toHaveLength(1);
    expect(s.blocked).toMatch(/still pending/);
    // the worst case is booked, so the budgets cannot be overrun by transactions still in the mempool
    expect(s.spentThisRun).toBe(130_000n * parseGwei("27"));
    expect((await s.execute(resolve)).status).toBe("skipped");
    expect(n.sent).toHaveLength(1);
  }, 10_000);

  it("outbids a transaction left at the same nonce when the node says the first try is underpriced", async () => {
    const n = node();
    n.wallet.sendTransaction.mockRejectedValueOnce(Object.assign(new Error("replacement transaction underpriced"), { details: "replacement transaction underpriced" }));
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("confirmed");
    expect(result.replacements).toBe(1);
    expect(n.sent[0]!.maxFeePerGas).toBeGreaterThan(parseGwei("21"));
  });

  it("re-reads the nonce once when the node says it is too low", async () => {
    const n = node();
    n.wallet.sendTransaction.mockRejectedValueOnce(new Error("nonce too low"));
    const result = await sender(n).s.execute(resolve);
    expect(result.status).toBe("confirmed");
    expect(n.client.getTransactionCount).toHaveBeenCalledTimes(4);
  });

  it("reports a transaction that was mined but reverted, and counts its cost", async () => {
    const n = node({ status: "reverted" });
    const { s } = sender(n);
    const result = await s.execute(resolve);
    expect(result.status).toBe("reverted");
    expect(s.spentThisRun).toBe(80_000n * parseGwei("11"));
  });

  it("uses a legacy gas price on a chain without a base fee", async () => {
    const n = node({ baseFee: null });
    await sender(n).s.execute(resolve);
    expect(n.sent[0]).toMatchObject({ type: "legacy", gasPrice: parseGwei("12"), value: 0n });
  });

  it("starts over with reset()", async () => {
    const n = node();
    const { s } = sender(n, config({ maxActionsPerRun: 1 }));
    await s.execute(resolve);
    s.reset();
    expect(s.spentThisRun).toBe(0n);
    expect((await s.execute(resolve)).status).toBe("confirmed");
  });
});

describe("fees and budgets", () => {
  const g = parseGwei;

  it("chooses fees under the ceiling or none at all", () => {
    expect(chooseFees(g("10"), g("1"), 0n, g("30"), g("2"))).toEqual({ type: "eip1559", maxFeePerGas: g("21"), maxPriorityFeePerGas: g("1") });
    // the tip is capped
    expect(chooseFees(g("10"), g("9"), 0n, g("30"), g("2"))).toEqual({ type: "eip1559", maxFeePerGas: g("22"), maxPriorityFeePerGas: g("2") });
    // the cap on the fee is the ceiling, never more
    expect(chooseFees(g("20"), g("1"), 0n, g("30"), g("2"))).toEqual({ type: "eip1559", maxFeePerGas: g("30"), maxPriorityFeePerGas: g("1") });
    expect(chooseFees(g("29.5"), g("1"), 0n, g("30"), g("2"))).toBeNull();
    expect(chooseFees(null, 0n, g("12"), g("30"), g("2"))).toEqual({ type: "legacy", gasPrice: g("12") });
    expect(chooseFees(null, 0n, g("31"), g("30"), g("2"))).toBeNull();
  });

  it("bumps by at least an eighth and never past the ceiling", () => {
    const bumped = bumpFees({ type: "eip1559", maxFeePerGas: g("16"), maxPriorityFeePerGas: g("1") }, g("30"));
    expect(bumped).toEqual({ type: "eip1559", maxFeePerGas: g("18") + 1n, maxPriorityFeePerGas: g("1.125") + 1n });
    expect(bumpFees({ type: "eip1559", maxFeePerGas: g("27"), maxPriorityFeePerGas: g("1") }, g("30"))).toBeNull();
    expect(bumpFees({ type: "legacy", gasPrice: g("8") }, g("30"))).toEqual({ type: "legacy", gasPrice: g("9") + 1n });
    expect(bumpFees({ type: "legacy", gasPrice: g("28") }, g("30"))).toBeNull();
  });

  it("checks both budgets against the worst case", () => {
    expect(fitsBudget(10n, 0n, 0n, 10n, 10n)).toEqual({ ok: true });
    expect(fitsBudget(10n, 1n, 0n, 10n, 100n)).toMatchObject({ ok: false, why: expect.stringContaining("per-run") });
    expect(fitsBudget(10n, 0n, 95n, 100n, 100n)).toMatchObject({ ok: false, why: expect.stringContaining("daily") });
  });
});
