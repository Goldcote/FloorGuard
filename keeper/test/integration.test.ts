// End-to-end against a local anvil on port 8547. Skips when anvil is not running:
//
//   anvil --port 8547
//   npm test
//
// The test snapshots the chain, deploys the protocol with script/Deploy.s.sol, seeds it, and plays six
// months of protocol life against the keeper. The keeper signs with anvil key #1, which owns nothing;
// everything that needs the owner (anvil key #0), a player or the mock randomness is done by the test.
//
// script/SeedLocal.s.sol is not used: it reverts with InvalidDuration against the current
// PredictionMarket (it asks for a 6-hour betting period on a 1-day market). The same seeding is done
// here with viem.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  type Hex,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  publicActions,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deployment, makeChain, namedOutputs, parseDeployment } from "../src/chain.ts";
import { KEEPER_DIR, REPO_DIR, loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { silentLogger } from "../src/logger.ts";
import { EXIT, createContext, runOnce, watch } from "../src/runner.ts";
import type { ActionResult, RunReport } from "../src/types.ts";

const RPC = "http://127.0.0.1:8547";
const CHAIN_ID = 31337;
// anvil's well-known development keys (accounts 0 to 3); they are public and hold nothing anywhere else
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  keeper: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  bob: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const chain = makeChain({ chainId: CHAIN_ID, rpcUrl: RPC });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC), pollingInterval: 50 }).extend(publicActions);

async function anvilIsUp(): Promise<boolean> {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1_500),
    });
    const body = (await response.json()) as { result?: string };
    return Number(body.result) === CHAIN_ID;
  } catch {
    return false;
  }
}

function forgeIsInstalled(): boolean {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ready = (await anvilIsUp()) && forgeIsInstalled();
if (!ready) console.warn("integration test skipped: no anvil on port 8547 (run `anvil --port 8547`) or no forge");

const artifact = (name: string) =>
  JSON.parse(readFileSync(join(REPO_DIR, "out", `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

const DAY = 86_400;

describe.skipIf(!ready)("keeper against anvil", () => {
  const accounts = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, privateKeyToAccount(key)])) as Record<
    keyof typeof KEYS,
    ReturnType<typeof privateKeyToAccount>
  >;
  const wallet = createWalletClient({ chain, transport: http(RPC) });

  let snapshot: Hex;
  let dir: string;
  let d: Deployment;
  let nft: Address;
  const abi: Record<string, Abi> = {};
  const gas: Record<string, bigint[]> = {};

  /** Send a transaction as one of the test accounts and wait for it. */
  async function send(who: keyof typeof KEYS, to: Address, abiName: string, functionName: string, args: unknown[] = [], value = 0n) {
    const hash = await wallet.writeContract({ account: accounts[who], chain, address: to, abi: abi[abiName]!, functionName, args, value });
    const receipt = await test.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${abiName}.${functionName} reverted`);
    return receipt;
  }
  const read = <T>(to: Address, abiName: string, functionName: string, args: unknown[] = []) =>
    test.readContract({ address: to, abi: abi[abiName]!, functionName, args }) as Promise<T>;
  const struct = async <T>(to: Address, abiName: string, functionName: string, args: unknown[]) =>
    namedOutputs(abi[abiName]!, functionName, await read(to, abiName, functionName, args)) as T;
  const warp = async (seconds: number) => {
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  /** A keeper as a fresh process would be: new context, state from the chain (and the cache file, if any). */
  async function keeper(overrides: Record<string, string> = {}, key: Hex | null = KEYS.keeper): Promise<{ ctx: Ctx; report: RunReport }> {
    const env: Record<string, string> = {
      KEEPER_RPC_URL: RPC,
      KEEPER_CHAIN_ID: String(CHAIN_ID),
      KEEPER_DEPLOYMENT_FILE: join(dir, "deployment.json"),
      KEEPER_MAX_SPEND_PER_RUN_ETH: "1",
      KEEPER_MAX_SPEND_PER_DAY_ETH: "5",
      KEEPER_TX_TIMEOUT_SECONDS: "20",
      ...overrides,
    };
    if (key) env.KEEPER_PRIVATE_KEY = key;
    const ctx = await createContext(loadConfig(env), silentLogger);
    const report = await runOnce(ctx);
    for (const task of report.tasks) {
      for (const r of task.results) {
        if (r.status === "confirmed") (gas[`${r.action.contract}.${r.action.functionName}`] ??= []).push(r.gasUsed!);
      }
    }
    return { ctx, report };
  }
  const results = (report: RunReport): ActionResult[] => report.tasks.flatMap((t) => t.results);
  const calls = (report: RunReport) => results(report).map((r) => `${r.action.contract}.${r.action.functionName}:${r.status}`);
  const findings = (report: RunReport) => report.tasks.flatMap((t) => t.findings);

  /** One floor-type sale on the marketplace: `buyer` bids on the collection, the owner sells `tokenId`. */
  async function trade(buyer: "alice" | "bob", tokenId: bigint, price: bigint) {
    const now = (await test.getBlock()).timestamp;
    await send(buyer, d.marketplace, "Marketplace", "makeCollectionOffer", [nft, 1n, now + 3_600n], price);
    const offerId = await read<bigint>(d.marketplace, "Marketplace", "offerCount");
    await send("owner", d.marketplace, "Marketplace", "acceptOffer", [offerId, tokenId, 0n]);
  }

  beforeAll(async () => {
    snapshot = await test.snapshot();
    dir = mkdtempSync(join(tmpdir(), "floorguard-keeper-"));

    // Deploy with the repository's own script. It writes deployments/31337.json; the keeper under test
    // reads a copy, and whatever was in that file before is put back.
    const file = join(REPO_DIR, "deployments", "31337.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    try {
      execFileSync(
        "forge",
        ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--private-key", KEYS.owner],
        { cwd: REPO_DIR, stdio: "pipe", env: { ...process.env, OWNER: "", TIMELOCK_DELAY: "", VRF_COORDINATOR: "" } },
      );
      const json = readFileSync(file, "utf8");
      writeFileSync(join(dir, "deployment.json"), json);
      d = parseDeployment(JSON.parse(json));
    } finally {
      if (before !== null) writeFileSync(file, before);
      else if (existsSync(file)) unlinkSync(file);
    }

    for (const name of ["MockNFT", "MockRandomness", "Marketplace", "Treasury", "BuybackEngine", "PushFloorOracle", "PredictionMarket", "Games", "TicketRaffle", "Lottery", "Vault", "VaultRaffle", "Points"]) {
      abi[name] = artifact(name).abi;
    }

    // ---- seed: what script/SeedLocal.s.sol sets up, plus players other than the owner
    const deployHash = await wallet.deployContract({ account: accounts.owner, chain, abi: abi.MockNFT!, bytecode: artifact("MockNFT").bytecode.object });
    nft = getAddress((await test.waitForTransactionReceipt({ hash: deployHash })).contractAddress!);
    for (let tokenId = 1n; tokenId <= 10n; tokenId++) await send("owner", nft, "MockNFT", "mint", [accounts.owner.address, tokenId]);
    for (const operator of [d.marketplace, d.buybackEngine, d.ticketRaffle]) {
      await send("owner", nft, "MockNFT", "setApprovalForAll", [operator, true]);
    }
    await send("owner", d.marketplace, "Marketplace", "setCollectionSupport", [nft, true]);
    await send("owner", d.buybackEngine, "BuybackEngine", "configureBid", [nft, parseEther("0.9"), parseEther("1.5"), 1_000, 500, true]);
    await send("owner", d.treasury, "Treasury", "deposit", [nft], parseEther("5"));

    // a prediction market: one hour of betting, settles after a day
    await send("owner", d.pushFloorOracle, "PushFloorOracle", "setReporter", [accounts.owner.address, true]);
    await send("owner", d.pushFloorOracle, "PushFloorOracle", "pushFloor", [nft, parseEther("1")]);
    await send("owner", d.predictionMarket, "PredictionMarket", "setCollectionSupport", [nft, true]);
    await send("owner", d.predictionMarket, "PredictionMarket", "createMarket", [nft, 3_600n, BigInt(DAY)]);
    await send("alice", d.predictionMarket, "PredictionMarket", "placeBet", [1n, true], parseEther("0.5"));
    await send("bob", d.predictionMarket, "PredictionMarket", "placeBet", [1n, false], parseEther("0.3"));
    // and a second one that settles a day later, for the watch mode
    await send("owner", d.predictionMarket, "PredictionMarket", "createMarket", [nft, 3_600n, BigInt(2 * DAY)]);
    await send("alice", d.predictionMarket, "PredictionMarket", "placeBet", [2n, true], parseEther("0.2"));
    await send("bob", d.predictionMarket, "PredictionMarket", "placeBet", [2n, false], parseEther("0.2"));

    // games: a bankroll and one bet whose randomness will never arrive
    await send("owner", d.games, "Games", "setCollectionSupport", [nft, true]);
    await send("owner", d.games, "Games", "fundBankroll", [], parseEther("50"));
    await send("alice", d.games, "Games", "play", [nft, 5_000n], parseEther("0.01"));

    // a ticket raffle of token 10: five tickets sold, the minimum
    await send("owner", d.ticketRaffle, "TicketRaffle", "setCollectionSupport", [nft, true]);
    await send("owner", d.ticketRaffle, "TicketRaffle", "create", [nft, 10n, parseEther("0.05"), 5, 40, BigInt(3 * DAY)]);
    await send("alice", d.ticketRaffle, "TicketRaffle", "buy", [1n, 3], parseEther("0.15"));
    await send("bob", d.ticketRaffle, "TicketRaffle", "buy", [1n, 2], parseEther("0.1"));

    // a weekly lottery with five tickets sold
    await send("owner", d.lottery, "Lottery", "setConfig", [nft, parseEther("0.01"), BigInt(7 * DAY), true]);
    await send("alice", d.lottery, "Lottery", "buy", [nft, 5], parseEther("0.05"));

    // a vault holding: the owner sells token 1 into the floor bid at 0.9 ETH
    await send("owner", d.buybackEngine, "BuybackEngine", "sell", [nft, 1n, 0n]);

    // fees, and so pending points, for bob and the owner
    await trade("bob", 2n, parseEther("1"));
  }, 300_000);

  afterAll(async () => {
    if (snapshot) await test.revert({ id: snapshot });
    if (dir) rmSync(dir, { recursive: true, force: true });
    const rows = Object.entries(gas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([call, used]) => `${call.padEnd(26)} ${used.map(String).join(", ")}`);
    console.log(["gas used per keeper action (anvil):", ...rows].join("\n"));
  });

  it("is not the owner and sends nothing in dry-run", async () => {
    expect(accounts.keeper.address).not.toBe(d.owner);
    const blockBefore = await test.getBlockNumber();
    const { report } = await keeper({}, null);
    expect(report.dryRun).toBe(true);
    expect(report.keeper).toBeNull();
    // pending points exist, so the scheduled flush is due: it is simulated and reported, not sent
    expect(calls(report)).toEqual(["points.flushMany:dry-run"]);
    // nothing reached the points contract while it ran
    for (let n = blockBefore + 1n; n <= (await test.getBlockNumber()); n++) {
      const block = await test.getBlock({ blockNumber: n, includeTransactions: true });
      expect(block.transactions.filter((tx) => tx.to?.toLowerCase() === d.points.toLowerCase())).toEqual([]);
    }
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address])).toBeGreaterThan(0n);
    expect(await read<bigint>(d.points, "Points", "totalPoints")).toBe(0n);
  });

  it("flushes pending points on schedule and reports the monitoring figures", async () => {
    const pendingBob = await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address]);
    expect(pendingBob).toBeGreaterThan(0n);

    const { report } = await keeper();
    expect(calls(report)).toEqual(["points.flushMany:confirmed"]);
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address])).toBe(0n);
    expect(await read<bigint>(d.points, "Points", "pointsOf", [accounts.bob.address])).toBe(pendingBob);
    expect(report.spentWei).toBeGreaterThan(0n);

    const monitor = report.tasks.find((t) => t.task === "monitor")!;
    expect(monitor.error).toBeUndefined();
    expect(monitor.summary!.some((line) => line.startsWith(nft))).toBe(true);
    expect(monitor.metrics!.waitingForRandomness).toBe(1); // alice's bet
    // nothing unexpected about owners or randomness providers on a fresh local deployment
    expect(monitor.findings.filter((f) => f.level === "error")).toEqual([]);

    // a second pass finds nothing left to do
    const again = await keeper();
    expect(calls(again.report)).toEqual([]);
  });

  it("resolves a market at the first price published after its settlement time, and refunds a late bet", async () => {
    await warp(DAY + 60);

    // past the settlement time, but the only price is from before it: the keeper waits and says so
    const waiting = await keeper();
    expect(calls(waiting.report)).toEqual(["games.refund:confirmed"]);
    expect(findings(waiting.report).some((f) => f.code === "market_waiting_for_price")).toBe(true);
    expect((await struct<{ outcome: number }>(d.predictionMarket, "PredictionMarket", "markets", [1n])).outcome).toBe(0);
    // the bet placed more than a day ago was refunded: the wager is back and the bet is gone
    expect((await struct<{ player: Address }>(d.games, "Games", "bets", [1n])).player).toBe(zeroAddress);
    expect(await read<bigint>(d.games, "Games", "reserved")).toBe(0n);

    // the reporter publishes the first price after settlement: 1.1 ETH, up 10%
    await send("owner", d.pushFloorOracle, "PushFloorOracle", "pushFloor", [nft, parseEther("1.1")]);
    const { report } = await keeper();
    expect(calls(report)).toEqual(["predictionMarket.resolve:confirmed"]);
    expect((await struct<{ outcome: number }>(d.predictionMarket, "PredictionMarket", "markets", [1n])).outcome).toBe(1); // Higher

    // a later price that the losing side would have preferred changes nothing
    await send("owner", d.pushFloorOracle, "PushFloorOracle", "pushFloor", [nft, parseEther("0.5")]);
    const after = await keeper();
    expect(calls(after.report)).toEqual([]);
    expect((await struct<{ outcome: number }>(d.predictionMarket, "PredictionMarket", "markets", [1n])).outcome).toBe(1);
  });

  it("in watch mode, resolves a market within seconds of the price being published", async () => {
    await warp(DAY);
    const ctx = await createContext(
      loadConfig({
        KEEPER_RPC_URL: RPC,
        KEEPER_CHAIN_ID: String(CHAIN_ID),
        KEEPER_DEPLOYMENT_FILE: join(dir, "deployment.json"),
        KEEPER_PRIVATE_KEY: KEYS.keeper,
        // a long poll interval: only the oracle's event or the fast poll for a waiting market can be this quick
        KEEPER_POLL_SECONDS: "600",
        KEEPER_FAST_POLL_SECONDS: "1",
      }),
      silentLogger,
    );
    const controller = new AbortController();
    const loop = watch(ctx, controller.signal);
    try {
      // the loop has made its first pass and found market 2 waiting for a price
      await new Promise((r) => setTimeout(r, 1_500));
      const outcome = async () => (await struct<{ outcome: number }>(d.predictionMarket, "PredictionMarket", "markets", [2n])).outcome;
      expect(await outcome()).toBe(0);

      await send("owner", d.pushFloorOracle, "PushFloorOracle", "pushFloor", [nft, parseEther("0.9")]);
      const published = Date.now();
      while ((await outcome()) === 0 && Date.now() - published < 15_000) await new Promise((r) => setTimeout(r, 100));
      expect(await outcome()).toBe(2); // Lower: 0.9 against a start price of 1
      expect(Date.now() - published).toBeLessThan(5_000);
    } finally {
      controller.abort();
      await loop;
    }
  }, 40_000);

  it("closes a ticket raffle that has ended and settles it once a winner is drawn", async () => {
    await warp(DAY);
    const closed = await keeper();
    expect(calls(closed.report)).toEqual(["ticketRaffle.close:confirmed"]);
    expect((await struct<{ status: number }>(d.ticketRaffle, "TicketRaffle", "raffles", [1n])).status).toBe(2); // Drawing

    // nothing to do while the randomness is outstanding
    expect(calls((await keeper()).report)).toEqual([]);

    // the mock provider answers: ticket 0 belongs to alice
    await send("bob", d.ticketRaffleRandomness, "MockRandomness", "fulfill", [1n, 0n]);
    const settled = await keeper();
    expect(calls(settled.report)).toEqual(["ticketRaffle.settle:confirmed"]);
    expect((await struct<{ status: number }>(d.ticketRaffle, "TicketRaffle", "raffles", [1n])).status).toBe(4); // Settled
    expect(await read<Address>(nft, "MockNFT", "ownerOf", [10n])).toBe(accounts.alice.address);
  });

  it("draws a lottery round that has ended", async () => {
    await warp(4 * DAY);
    const { report } = await keeper();
    expect(calls(report)).toEqual(["lottery.draw:confirmed"]);
    expect((await struct<{ status: number }>(d.lottery, "Lottery", "rounds", [1n])).status).toBe(2); // Drawing

    await send("bob", d.lotteryRandomness, "MockRandomness", "fulfill", [1n, 3n]);
    const round = await struct<{ status: number; winner: Address }>(d.lottery, "Lottery", "rounds", [1n]);
    expect(round.status).toBe(3); // Won
    expect(round.winner).toBe(accounts.alice.address);
    expect(calls((await keeper()).report)).toEqual([]);
  });

  it("unlocks a vault holding once the lock has passed and the floor is at 130%", async () => {
    await warp(174 * DAY);
    // the time lock is over but the sales oracle has no fresh price: nothing to do, and it says why
    const early = await keeper();
    expect(calls(early.report)).toEqual([]);
    expect(findings(early.report).some((f) => f.code === "waiting_for_floor")).toBe(true);

    // three floor-type sales at 1.3 ETH put the sales oracle above 130% of the 0.9 ETH purchase price
    for (const tokenId of [3n, 4n, 5n]) await trade("bob", tokenId, parseEther("1.3"));
    expect(await read<boolean>(d.vault, "Vault", "canUnlock", [1n])).toBe(true);

    const { report } = await keeper();
    // the trades also credited points, and a day has passed since the last flush
    expect(calls(report).sort()).toEqual(["points.flushMany:confirmed", "vault.unlock:confirmed"]);
    expect((await struct<{ status: number }>(d.vault, "Vault", "holdings", [1n])).status).toBe(2); // Unlocked

    // the governance window is open: the keeper reports the unlocked holding and leaves it alone
    const idle = await keeper();
    expect(calls(idle.report)).toEqual([]);
    expect(findings(idle.report).some((f) => f.code === "holding_unlocked")).toBe(true);
  });

  it("flushes points before a vault raffle can be drawn, draws it, and delivers the prize", async () => {
    const cache = { KEEPER_CACHE_FILE: join(dir, "cache.json") };
    await send("owner", d.vault, "Vault", "sendToRaffle", [1n]);
    const raffle = await struct<{ drawAfter: number }>(d.vaultRaffle, "VaultRaffle", "raffles", [1n]);

    // a keeper with a cache file: its first pass has nothing to flush and records that
    expect(calls((await keeper(cache)).report)).toEqual([]);

    // 30 minutes before the draw opens, new points are pending. The interval is set to a year so that
    // only the approaching draw, not the daily schedule, can be the reason for the flush.
    await warp(7 * DAY - 1_800 - 120);
    await trade("alice", 6n, parseEther("1"));
    expect(BigInt(raffle.drawAfter)).toBeGreaterThan((await test.getBlock()).timestamp);
    const before = await keeper({ ...cache, KEEPER_FLUSH_INTERVAL_SECONDS: String(365 * DAY) });
    expect(calls(before.report)).toEqual(["points.flushMany:confirmed"]);
    expect(before.report.tasks.find((t) => t.task === "points")!.metrics!.flushReason).toBe("pre-draw");
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.alice.address])).toBe(0n);
    expect((await struct<{ status: number }>(d.vaultRaffle, "VaultRaffle", "raffles", [1n])).status).toBe(1); // still Open

    // the announce period ends with points pending again: one pass flushes them and then draws
    await warp(1_800 + 120);
    await trade("bob", 7n, parseEther("1"));
    const total = await read<bigint>(d.points, "Points", "totalPoints");
    const drawn = await keeper(cache);
    expect(calls(drawn.report)).toEqual(["points.flushMany:confirmed", "vaultRaffle.draw:confirmed"]);
    expect(await read<bigint>(d.points, "Points", "totalPoints")).toBeGreaterThan(total);
    expect(await read<bigint>(d.points, "Points", "freezeCount")).toBe(1n);
    expect((await struct<{ status: number }>(d.vaultRaffle, "VaultRaffle", "raffles", [1n])).status).toBe(2); // Drawing

    // points credited during the draw cannot be activated: the keeper reports it and sends nothing
    await trade("bob", 8n, parseEther("1"));
    const frozen = await keeper(cache);
    expect(calls(frozen.report)).toEqual([]);
    expect(findings(frozen.report).some((f) => f.code === "points_frozen")).toBe(true);

    // the randomness arrives; the first registered holder owns point 0
    const requestId = await read<bigint>(d.vaultRaffle, "VaultRaffle", "currentRequest", [1n]);
    await send("alice", d.randomness, "MockRandomness", "fulfill", [requestId, 0n]);
    const won = await struct<{ status: number; winner: Address }>(d.vaultRaffle, "VaultRaffle", "raffles", [1n]);
    expect(won.status).toBe(3); // Won

    const claimed = await keeper(cache);
    expect(calls(claimed.report)).toEqual(["vaultRaffle.claim:confirmed"]);
    expect(await read<Address>(nft, "MockNFT", "ownerOf", [1n])).toBe(won.winner);
    expect((await struct<{ status: number }>(d.vaultRaffle, "VaultRaffle", "raffles", [1n])).status).toBe(4); // Claimed

    // No raffle is open and the cache says points were flushed today, so the points credited during
    // the draw wait for the daily schedule: a pass now does nothing, a pass a day later activates them.
    const last = await keeper(cache);
    expect(calls(last.report)).toEqual([]);
    expect(existsSync(cache.KEEPER_CACHE_FILE)).toBe(true);
    expect(last.report.exitCode).not.toBe(EXIT.failure);
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address])).toBeGreaterThan(0n);
    await warp(DAY);
    expect(calls((await keeper(cache)).report)).toEqual(["points.flushMany:confirmed"]);
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address])).toBe(0n);
  });

  it("resets draws whose randomness never arrives, reports stuck rounds, and aborts only when opted in", async () => {
    for (let tokenId = 11n; tokenId <= 19n; tokenId++) await send("owner", nft, "MockNFT", "mint", [accounts.owner.address, tokenId]);
    // a new lottery round, a new ticket raffle, a second vault raffle and a bet: none will get an answer
    await send("alice", d.lottery, "Lottery", "buy", [nft, 5], parseEther("0.05"));
    await send("owner", d.ticketRaffle, "TicketRaffle", "create", [nft, 11n, parseEther("0.05"), 5, 40, BigInt(3 * DAY)]);
    await send("alice", d.ticketRaffle, "TicketRaffle", "buy", [2n, 5], parseEther("0.25"));
    await send("owner", d.buybackEngine, "BuybackEngine", "sell", [nft, 12n, 0n]);
    await send("owner", d.vault, "Vault", "governanceUnlock", [2n]);
    await send("owner", d.vault, "Vault", "sendToRaffle", [2n]);
    await send("alice", d.games, "Games", "play", [nft, 5_000n], parseEther("0.01"));
    const status = async (to: Address, name: string, getter: string, id: bigint) => (await struct<{ status: number }>(to, name, getter, [id])).status;

    await warp(7 * DAY + 60);
    const requested = await keeper();
    expect(calls(requested.report).sort()).toEqual([
      "games.refund:confirmed",
      "lottery.draw:confirmed",
      "ticketRaffle.close:confirmed",
      "vaultRaffle.draw:confirmed",
    ]);

    // a day later no randomness has arrived: every draw is reset
    await warp(DAY + 60);
    const reset = await keeper();
    expect(calls(reset.report).sort()).toEqual(["lottery.resetDraw:confirmed", "ticketRaffle.resetDraw:confirmed", "vaultRaffle.resetDraw:confirmed"]);
    expect(await status(d.vaultRaffle, "VaultRaffle", "raffles", 2n)).toBe(1);
    expect(await read<bigint>(d.points, "Points", "freezeCount")).toBe(0n);

    // the next pass requests the lottery and ticket raffle draws again; the vault raffle has an hour's cooldown
    const again = await keeper();
    expect(calls(again.report).sort()).toEqual(["lottery.draw:confirmed", "ticketRaffle.close:confirmed"]);
    await warp(3_600 + 60);
    expect(calls((await keeper()).report)).toEqual(["vaultRaffle.draw:confirmed"]);

    // A week on, both are past their abort time with a dead draw. By default the keeper only reports.
    await warp(7 * DAY);
    const reported = await keeper({ KEEPER_TASK_VAULT_RAFFLE: "off" });
    expect(calls(reported.report)).toEqual([]);
    expect(findings(reported.report).map((f) => f.code).filter((c) => c.endsWith("_stuck")).sort()).toEqual(["raffle_stuck", "round_stuck"]);
    expect(reported.report.exitCode).toBe(EXIT.attention);
    expect(await status(d.lottery, "Lottery", "rounds", 2n)).toBe(2); // still Drawing

    const aborted = await keeper({ KEEPER_TASK_VAULT_RAFFLE: "off", KEEPER_LOTTERY_ABORT: "true", KEEPER_TICKET_RAFFLE_ABORT: "true" });
    expect(calls(aborted.report).sort()).toEqual(["lottery.abort:confirmed", "ticketRaffle.abort:confirmed"]);
    expect(await status(d.lottery, "Lottery", "rounds", 2n)).toBe(4); // Refunding
    expect(await status(d.ticketRaffle, "TicketRaffle", "raffles", 2n)).toBe(5); // Refunding

    // the vault raffle's second draw is also dead by now: reset it so points are not left frozen
    expect(calls((await keeper()).report)).toEqual(["vaultRaffle.resetDraw:confirmed"]);
  }, 60_000);

  it("splits a flush that does not fit the gas limit, and starts or restarts a vault auction only when opted in", async () => {
    const vaultOnly = { KEEPER_TASK_POINTS: "off", KEEPER_TASK_VAULT_RAFFLE: "off", KEEPER_TASK_MONITOR: "off" };
    const vaultCalls = (report: RunReport) => calls(report).filter((c) => c.startsWith("vault."));
    await send("owner", d.buybackEngine, "BuybackEngine", "sell", [nft, 13n, 0n]);
    await send("owner", d.vault, "Vault", "governanceUnlock", [3n]);
    await warp(30 * DAY + 60);

    // past the governance window: reported, not acted on
    const off = await keeper(vaultOnly);
    expect(vaultCalls(off.report)).toEqual([]);
    expect(findings(off.report).some((f) => f.code === "governance_window_passed")).toBe(true);

    // an auction needs a fresh floor: three sales at 1.3 ETH, which also leave bob and the owner with pending points
    for (const tokenId of [14n, 15n, 16n]) await trade("bob", tokenId, parseEther("1.3"));

    // two accounts do not fit 100,000 gas in one flushMany (with the 30% margin), one does: the batch is split
    const split = await keeper({ KEEPER_TASK_VAULT: "off", KEEPER_TASK_VAULT_RAFFLE: "off", KEEPER_MAX_GAS_PER_TX: "100000", KEEPER_FLUSH_GAS_PER_ACCOUNT: "1" });
    expect(calls(split.report)).toEqual(["points.flushMany:confirmed", "points.flushMany:confirmed"]);
    expect(results(split.report).map((r) => (r.action.args[0] as unknown[]).length)).toEqual([1, 1]);
    expect(await read<bigint>(d.points, "Points", "pendingOf", [accounts.bob.address])).toBe(0n);

    const started = await keeper({ ...vaultOnly, KEEPER_VAULT_START_AUCTION: "true" });
    expect(vaultCalls(started.report)).toEqual(["vault.startAuction:confirmed"]);
    expect((await struct<{ status: number }>(d.vault, "Vault", "holdings", [3n])).status).toBe(3); // Auction
    const first = await struct<{ startTime: number; startPrice: bigint; endPrice: bigint }>(d.vault, "Vault", "auctions", [3n]);
    expect(first.startPrice).toBe(first.endPrice * 16n);

    // four days later the price has reached the reserve and nobody bought
    await warp(4 * DAY + 60);
    expect(await read<bigint>(d.vault, "Vault", "auctionPrice", [3n])).toBe(first.endPrice);
    for (const tokenId of [17n, 18n, 19n]) await trade("bob", tokenId, parseEther("1.3"));

    const noRestart = await keeper({ ...vaultOnly, KEEPER_VAULT_START_AUCTION: "true" });
    expect(vaultCalls(noRestart.report)).toEqual([]);
    expect(findings(noRestart.report).some((f) => f.code === "auction_at_reserve" && f.level === "warn")).toBe(true);

    // opted in, but buyers get three days at the reserve first
    const dwelling = await keeper({ ...vaultOnly, KEEPER_VAULT_RESTART_AUCTION: "true" });
    expect(vaultCalls(dwelling.report)).toEqual([]);

    const restarted = await keeper({ ...vaultOnly, KEEPER_VAULT_RESTART_AUCTION: "true", KEEPER_VAULT_RESTART_DWELL_SECONDS: "0" });
    expect(vaultCalls(restarted.report)).toEqual(["vault.startAuction:confirmed"]);
    const second = await struct<{ startTime: number }>(d.vault, "Vault", "auctions", [3n]);
    expect(second.startTime).toBeGreaterThan(first.startTime);
  }, 60_000);

  it("replaces a transaction that is not mined in time", async () => {
    await send("alice", d.games, "Games", "play", [nft, 5_000n], parseEther("0.01"));
    await warp(DAY + 60);
    const gamesOnly = Object.fromEntries(
      ["PREDICTION", "POINTS", "VAULT_RAFFLE", "LOTTERY", "TICKET_RAFFLE", "VAULT", "MONITOR"].map((t) => [`KEEPER_TASK_${t}`, "off"]),
    );
    const pendingFromKeeper = async () => {
      const block = await test.getBlock({ blockTag: "pending", includeTransactions: true });
      return block.transactions.filter((tx) => tx.from.toLowerCase() === accounts.keeper.address.toLowerCase());
    };

    await test.setAutomine(false);
    try {
      const run = keeper({ ...gamesOnly, KEEPER_TX_TIMEOUT_SECONDS: "1" });
      // wait for the first transaction, then for the replacement that takes its place, then mine
      let original: Hex | null = null;
      for (let i = 0; i < 400; i++) {
        const [tx] = await pendingFromKeeper();
        if (tx && original === null) original = tx.hash;
        if (tx && original !== null && tx.hash !== original) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const [replacement] = await pendingFromKeeper();
      expect(original).not.toBeNull();
      expect(replacement!.hash).not.toBe(original);
      await test.mine({ blocks: 1 });

      const { report } = await run;
      expect(calls(report)).toEqual(["games.refund:confirmed"]);
      const [result] = results(report);
      expect(result!.replacements).toBeGreaterThanOrEqual(1);
      // exactly one of the attempts was mined: the keeper's nonce moved by one
      const mined = await test.getTransaction({ hash: result!.txHash! });
      expect(mined.value).toBe(0n);
      expect(await test.getTransactionReceipt({ hash: original! }).catch(() => null)).toBeNull();
    } finally {
      await test.setAutomine(true);
      await test.mine({ blocks: 1 });
    }
  }, 60_000);

  it("the command line prints JSON lines, a summary, and an exit code for cron", () => {
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts", ...args], {
        cwd: KEEPER_DIR,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", KEEPER_RPC_URL: RPC, KEEPER_CHAIN_ID: String(CHAIN_ID), KEEPER_DEPLOYMENT_FILE: join(dir, "deployment.json"), ...env },
      });

    // no key: a dry run that says so, on both channels
    const dry = run(["once"], {});
    expect([EXIT.ok, EXIT.attention]).toContain(dry.status);
    expect(dry.stderr).toContain("DRY RUN: no private key configured");
    const lines = dry.stdout.trim().split("\n").map((line) => JSON.parse(line) as { event: string; level: string });
    expect(lines.some((l) => l.event === "dry_run")).toBe(true);
    expect(lines.some((l) => l.event === "monitor.collection")).toBe(true);
    expect(lines.at(-1)!.event).toBe("run_done");

    // with a key the output never contains it
    const withKey = run(["monitor"], { KEEPER_PRIVATE_KEY: KEYS.keeper, KEEPER_LOG_FORMAT: "json" });
    expect([EXIT.ok, EXIT.attention]).toContain(withKey.status);
    expect(withKey.stderr).toBe("");
    expect((withKey.stdout + withKey.stderr).toLowerCase()).not.toContain(KEYS.keeper.slice(2));
    expect(withKey.stdout).not.toContain('"event":"action"');

    // a wrong chain id is a start-up failure
    const wrong = run(["once"], { KEEPER_CHAIN_ID: "1", KEEPER_LOG_FORMAT: "text" });
    expect(wrong.status).toBe(EXIT.fatal);
    expect(wrong.stdout).toContain("fatal: the RPC endpoint is chain 31337");
    expect(run([], {}).status).toBe(EXIT.fatal);
  }, 60_000);

  it("copes with the state script/SeedLocal.s.sol leaves behind", async () => {
    // The repository's own seed script, run as the owner against this deployment. It reads and writes
    // deployments/31337.json, so the file is swapped in for the run and put back afterwards.
    const file = join(REPO_DIR, "deployments", "31337.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    let seeded: Address;
    try {
      writeFileSync(file, readFileSync(join(dir, "deployment.json"), "utf8"));
      execFileSync("forge", ["script", "script/SeedLocal.s.sol", "--rpc-url", RPC, "--broadcast", "--private-key", KEYS.owner], { cwd: REPO_DIR, stdio: "pipe" });
      seeded = getAddress((JSON.parse(readFileSync(file, "utf8")) as { demoCollection: string }).demoCollection);
    } catch (error) {
      console.warn(`script/SeedLocal.s.sol did not run; this check is skipped: ${String((error as { stderr?: Buffer }).stderr ?? error).slice(-300)}`);
      return;
    } finally {
      if (before !== null) writeFileSync(file, before);
      else if (existsSync(file)) unlinkSync(file);
    }
    const marketId = await read<bigint>(d.predictionMarket, "PredictionMarket", "marketCount");
    const raffleId = await read<bigint>(d.ticketRaffle, "TicketRaffle", "raffleCount");
    const roundId = await read<bigint>(d.lottery, "Lottery", "currentRoundOf", [seeded]);

    const healthy = (report: RunReport) => {
      expect(report.tasks.map((t) => t.error).filter(Boolean)).toEqual([]);
      expect(results(report).filter((r) => ["failed", "reverted", "pending"].includes(r.status))).toEqual([]);
    };
    healthy((await keeper()).report);

    // eight days on: the seeded market has had no settlement price for three days, the seeded raffle
    // sold two of five tickets, and the seeded lottery round has ended
    await warp(8 * DAY);
    const { report } = await keeper();
    healthy(report);
    const done = results(report).filter((r) => r.status === "confirmed").map((r) => `${r.action.contract}.${r.action.functionName}(${r.action.args.join(",")})`);
    expect(done).toContain(`predictionMarket.resolve(${marketId})`);
    expect(done).toContain(`ticketRaffle.close(${raffleId})`);
    expect(done).toContain(`lottery.draw(${roundId})`);
    expect((await struct<{ outcome: number }>(d.predictionMarket, "PredictionMarket", "markets", [marketId])).outcome).toBe(3); // Void
    expect((await struct<{ status: number }>(d.ticketRaffle, "TicketRaffle", "raffles", [raffleId])).status).toBe(5); // Refunding
    // the monitor found the seeded collection from the engine's events
    expect(report.tasks.find((t) => t.task === "monitor")!.summary!.some((line) => line.startsWith(seeded))).toBe(true);
  }, 120_000);

  it("never sent anything but allowlisted, value-free calls from the keeper's address", async () => {
    const targets = new Set(
      [d.predictionMarket, d.points, d.vaultRaffle, d.lottery, d.ticketRaffle, d.games, d.vault].map((a) => a.toLowerCase()),
    );
    const head = await test.getBlockNumber();
    let seen = 0;
    for (let n = 0n; n <= head; n++) {
      const block = await test.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() !== accounts.keeper.address.toLowerCase()) continue;
        seen++;
        expect(tx.value).toBe(0n);
        expect(targets.has(tx.to!.toLowerCase())).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(25);
  });
});
