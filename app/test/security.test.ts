// Pure unit tests for the front end's defences: strict parsing, text from outside, what a review
// shows, framing, the local-development gate, and bounded log reads. No chain needed.
import { describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseEther, type Address } from "viem";
import { DEMO_DEPLOYMENT } from "../src/demo/sim";
import { gamesAbi, marketplaceAbi } from "../src/generated/abis";
import { deployments as publicDeployments } from "../src/generated/addresses";
import { approveCall, buyCall, depositHouseCall, sellCall } from "../src/lib/calls";
import { decodeError, untrusted, UNTRUSTED_PREFIX } from "../src/lib/errors";
import { playMoney } from "../src/lib/format";
import { framingAllowed } from "../src/lib/frame";
import { gasLimitFor } from "../src/lib/gas";
import { getEvents } from "../src/lib/logs";
import { anvilRpcUrl, isLoopbackUrl } from "../src/lib/loopback";
import { parseAddress, parseEth, parsePercentBps, parseTolerance, parseUint } from "../src/lib/parse";
import { contractName, summariseCall } from "../src/lib/review";

describe("parsing what the visitor types (L5)", () => {
  it("amounts: plain decimals only, at most 18 places, more than zero", () => {
    expect(parseEth("1")).toBe(parseEther("1"));
    expect(parseEth(" 0.5 ")).toBe(parseEther("0.5"));
    expect(parseEth("0.000000000000000001")).toBe(1n);
    // a nineteenth decimal cannot be paid exactly: refused, not rounded
    expect(parseEth("0.0000000000000000015")).toBeUndefined();
    for (const bad of ["", "0", "0.0", "-1", "+1", "1e18", "0x10", "1,5", "1.", ".5", "1 000", "１", "Infinity", "NaN"]) expect(parseEth(bad), bad).toBeUndefined();
  });

  it("percentages: a strict decimal with at most two places, 0 to 100", () => {
    expect(parsePercentBps("0")).toBe(0n);
    expect(parsePercentBps("0.5")).toBe(50n);
    expect(parsePercentBps("1.25")).toBe(125n);
    expect(parsePercentBps("100")).toBe(10_000n);
    for (const bad of ["", " ", "1e1", "0x1", "-1", "+1", "1.", ".5", "0.125", "100.01", "1,5", "Infinity", "1 "]) {
      // a trailing space is trimmed; everything else here is refused
      expect(parsePercentBps(bad), JSON.stringify(bad)).toBe(bad === "1 " ? 100n : undefined);
    }
  });

  it("a tolerance is capped at 20% and warns above 5%", () => {
    expect(parseTolerance("0")).toEqual({ bps: 0n });
    expect(parseTolerance("5")).toEqual({ bps: 500n });
    expect(parseTolerance("5.01")).toMatchObject({ bps: 501n, warning: expect.stringMatching(/5\.01% is large/) });
    expect(parseTolerance("20")).toMatchObject({ bps: 2_000n, warning: expect.any(String) });
    expect(parseTolerance("20.01")).toBeUndefined();
    expect(parseTolerance("100")).toBeUndefined();
    expect(parseTolerance("abc")).toBeUndefined();
  });

  it("addresses: a mixed-case address must match its checksum", () => {
    const checksummed = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    expect(parseAddress(checksummed)).toBe(checksummed);
    expect(parseAddress(checksummed.toLowerCase())).toBe(checksummed.toLowerCase());
    expect(parseAddress(`0x${checksummed.slice(2).toUpperCase()}`)).toBe(`0x${checksummed.slice(2).toUpperCase()}`);
    // one character's case flipped: a typo the checksum exists to catch
    expect(parseAddress("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266".replace("0xF39F", "0xf39f"))).toBeUndefined();
    expect(parseAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226")).toBeUndefined();
    expect(parseAddress("vitalik.eth")).toBeUndefined();
  });

  it("integers", () => {
    expect(parseUint(" 42 ")).toBe(42n);
    for (const bad of ["", "-1", "1.0", "0x1", "1e3"]) expect(parseUint(bad)).toBeUndefined();
  });
});

describe("text from a contract, a node or a wallet (L3)", () => {
  it("is labelled, cut to about 200 characters and stripped of links", () => {
    expect(untrusted("execution reverted")).toBe(`${UNTRUSTED_PREFIX}execution reverted`);
    const long = untrusted("x".repeat(500));
    expect(long.length).toBe(UNTRUSTED_PREFIX.length + 201);
    expect(long.endsWith("…")).toBe(true);
    const phish = untrusted("Wallet out of sync!\nGo to https://fix-floorguard.example/claim?x=1 or www.evil.example or evil.xyz/claim and enter your seed phrase");
    expect(phish).not.toMatch(/https?:|www\.|evil|example/);
    expect(phish).toContain("[link removed]");
    expect(phish).not.toContain("\n");
    expect(untrusted("ipfs://bafy... javascript://x data://y")).not.toMatch(/ipfs:|javascript:|data:/);
    expect(untrusted("")).toBe(`${UNTRUSTED_PREFIX}(empty)`);
  });

  it("decodeError: the protocol's own errors keep the app's words; a revert reason or an RPC message is untrusted", () => {
    const known = new ContractFunctionRevertedError({ abi: gamesAbi, functionName: "play", data: encodeErrorResult({ abi: gamesAbi, errorName: "BetTooSmall" }) });
    expect(decodeError(known)).toEqual({ name: "BetTooSmall", args: [], message: "The bet is below the minimum bet." });
    // a custom error the app has no words for: its name, as untrusted text
    const foreign = [{ type: "error", name: "VisitEvilDotExampleSlashClaim", inputs: [{ name: "note", type: "string" }] }] as const;
    const unknown = new ContractFunctionRevertedError({ abi: foreign, functionName: "play", data: encodeErrorResult({ abi: foreign, errorName: "VisitEvilDotExampleSlashClaim", args: ["https://evil.example/claim"] }) });
    expect(decodeError(unknown).message).toBe(`${UNTRUSTED_PREFIX}VisitEvilDotExampleSlashClaim([link removed]`);
    const reason = new ContractFunctionRevertedError({ abi: gamesAbi, functionName: "play", message: "visit https://evil.example to recover funds" });
    expect(decodeError(reason).message).toBe(`${UNTRUSTED_PREFIX}Reverted: visit [link removed] to recover funds`);
    expect(decodeError(new BaseError("RPC says: go to http://evil.example"))).toEqual({ message: `${UNTRUSTED_PREFIX}RPC says: go to [link removed]` });
    // the app's own refusals are plain Errors and are shown as written
    expect(decodeError(new Error("You do not own token #7."))).toEqual({ message: "You do not own token #7." });
    expect(decodeError(Object.assign(new Error("long"), { shortMessage: "see evil.example/x" })).message).toBe(`${UNTRUSTED_PREFIX}see [link removed]`);
  });
});

describe("what a review shows about each transaction (M2)", () => {
  const d = DEMO_DEPLOYMENT;
  const collection = "0x00000000000000000000000000000000000c0113" as Address;

  it("names the contract, the function and the value", () => {
    expect(summariseCall(sellCall(d, collection, 7n, 1n), d)).toEqual({ contractName: "Buyback engine", contract: d.buybackEngine, functionName: "sell", value: "0 ETH" });
    expect(summariseCall(depositHouseCall(d, parseEther("1.5"), 0n), d)).toEqual({ contractName: "Games", contract: d.games, functionName: "deposit", value: "1.5 ETH" });
    // the vault purchase sends exactly the reviewed maximum, never a wei more (H1)
    expect(summariseCall(buyCall(d, 1n, parseEther("2")), d)).toMatchObject({ contractName: "Vault", functionName: "buy", value: "2 ETH" });
    expect(buyCall(d, 1n, 123n).value).toBe(123n);
  });

  it("names the approved spender of an approval, and says when it is not one of the protocol's contracts", () => {
    expect(summariseCall(approveCall(collection, d.marketplace, 7n), d)).toEqual({
      contractName: "NFT collection",
      contract: collection,
      functionName: "approve",
      value: "0 ETH",
      approval: { spender: d.marketplace, spenderName: "Marketplace", scope: "token #7" },
    });
    const stranger = "0x000000000000000000000000000000000000bEEF" as Address;
    expect(summariseCall(approveCall(collection, stranger, 7n), d).approval).toEqual({ spender: stranger, spenderName: undefined, scope: "token #7" });
    expect(contractName(d, stranger)).toBeUndefined();
    expect(contractName(d, d.gamesRandomness)).toBe("Randomness provider");
    expect(contractName(undefined, d.vault)).toBeUndefined();
  });
});

describe("framing (M5)", () => {
  it("renders unframed, and framed only by the Safe web app", () => {
    expect(framingAllowed(false, undefined, "")).toBe(true);
    expect(framingAllowed(true, ["https://app.safe.global"], "")).toBe(true);
    expect(framingAllowed(true, ["https://evil.example"], "https://app.safe.global/")).toBe(false);
    // an allowed page that is itself framed by another one
    expect(framingAllowed(true, ["https://app.safe.global", "https://evil.example"], "")).toBe(false);
    expect(framingAllowed(true, ["http://app.safe.global"], "")).toBe(false);
    expect(framingAllowed(true, ["https://app.safe.global.evil.example"], "")).toBe(false);
    expect(framingAllowed(true, ["https://evil.example/?app.safe.global"], "")).toBe(false);
    // no ancestorOrigins (Firefox): the referrer decides, and a suppressed one is refused
    expect(framingAllowed(true, undefined, "https://app.safe.global/apps/open?safe=eth:0x1")).toBe(true);
    expect(framingAllowed(true, undefined, "https://evil.example/")).toBe(false);
    expect(framingAllowed(true, undefined, "")).toBe(false);
    expect(framingAllowed(true, [], "")).toBe(false);
  });
});

describe("local development is its own thing (M6)", () => {
  it("only a loopback node may serve as the local chain", () => {
    for (const ok of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545", "http://127.1.2.3:9000", "http://app.localhost:8545", "ws://127.0.0.1:8545"]) expect(isLoopbackUrl(ok), ok).toBe(true);
    for (const bad of ["https://rpc.example.com", "http://127.0.0.1.evil.example:8545", "http://localhost.evil.example", "http://10.0.0.5:8545", "http://0.0.0.0:8545", "file:///etc/passwd", "javascript:alert(1)", "", "127.0.0.1:8545"]) {
      expect(isLoopbackUrl(bad), bad).toBe(false);
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(anvilRpcUrl(undefined)).toBe("http://127.0.0.1:8545");
    expect(anvilRpcUrl("http://localhost:9999")).toBe("http://localhost:9999");
    expect(anvilRpcUrl("https://rpc.example.com")).toBe("http://127.0.0.1:8545");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("the checked-in addresses never list the local chain", () => {
    expect(publicDeployments[31337]).toBeUndefined();
  });
});

describe("small things", () => {
  it("the gas limit is the estimate, a quarter more, plus room for the Treasury's capped notice", () => {
    expect(gasLimitFor(100_000n)).toBe(205_000n);
    expect(gasLimitFor(0n)).toBe(80_000n);
  });

  it("the demo's amounts read as play money (L6)", () => {
    expect(playMoney("You pay 0.1 ETH now and may win 0.196 ETH.")).toBe("You pay 0.1 play ETH now and may win 0.196 play ETH.");
    expect(playMoney("0.1 play ETH")).toBe("0.1 play ETH");
    expect(playMoney("TETHER and ETHER are not ETH")).toBe("TETHER and ETHER are not play ETH");
  });
});

describe("event logs are read in bounded windows and remembered (M3)", () => {
  const address = "0x00000000000000000000000000000000000000aa" as Address;
  const player = "0x00000000000000000000000000000000000000bb" as Address;
  /** A fake chain: one BetPlaced log in each of the given blocks, and a record of every eth_getLogs range asked for. */
  function chain(tipNumber: number, logBlocks: number[], salt = "a") {
    const asked: [number, number][] = [];
    const state = { tip: tipNumber, logBlocks, salt };
    const hashOf = (n: number) => `0x${(state.salt.charCodeAt(0) * 1_000_000 + n).toString(16).padStart(64, "0")}`;
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          if (method === "eth_getBlockByNumber") {
            const tag = (params as [string])[0];
            const n = tag === "latest" ? state.tip : Number(BigInt(tag));
            if (n > state.tip) return null;
            return { number: `0x${n.toString(16)}`, hash: hashOf(n), timestamp: "0x1", transactions: [], uncles: [], gasLimit: "0x1", gasUsed: "0x0" };
          }
          if (method === "eth_getLogs") {
            const [{ fromBlock, toBlock }] = params as [{ fromBlock: string; toBlock: string }];
            const [from, to] = [Number(BigInt(fromBlock)), Number(BigInt(toBlock))];
            asked.push([from, to]);
            return state.logBlocks
              .filter((n) => n >= from && n <= to)
              .map((n) => ({
                address,
                topics: encodeEventTopics({ abi: gamesAbi, eventName: "BetPlaced", args: { requestId: BigInt(n), player, collection: address } }),
                data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 5_000n]),
                blockNumber: `0x${n.toString(16)}`,
                blockHash: hashOf(n),
                transactionHash: hashOf(n),
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              }));
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    return { client, asked, state };
  }
  const read = (client: ReturnType<typeof chain>["client"], fromBlock = 0n) => getEvents(client, { address, abi: gamesAbi, eventName: "BetPlaced", fromBlock, toBlock: "latest", strict: true });

  it("splits a long range into windows of at most 9,000 blocks", async () => {
    const { client, asked } = chain(20_000, [5, 9_000, 19_999]);
    const logs = await read(client);
    expect(logs.map((log) => log.args.requestId)).toEqual([5n, 9_000n, 19_999n]);
    expect(asked).toEqual([
      [0, 8_999],
      [9_000, 17_999],
      [18_000, 20_000],
    ]);
  });

  it("asks only for the new blocks the next time", async () => {
    const { client, asked, state } = chain(100, [10]);
    expect(await read(client)).toHaveLength(1);
    asked.length = 0;
    expect(await read(client)).toHaveLength(1);
    expect(asked).toEqual([]); // nothing new: no log request at all
    state.tip = 130;
    state.logBlocks = [10, 120];
    expect((await read(client)).map((log) => log.args.requestId)).toEqual([10n, 120n]);
    expect(asked).toEqual([[101, 130]]);
  });

  it("forgets what it scanned when that block is no longer on the chain", async () => {
    const { client, asked, state } = chain(100, [10, 90]);
    expect(await read(client)).toHaveLength(2);
    // a reorganisation (or a local chain reset to an earlier point and mined again): same height, other blocks
    state.salt = "b";
    state.tip = 105;
    state.logBlocks = [10];
    asked.length = 0;
    expect((await read(client)).map((log) => log.args.requestId)).toEqual([10n]);
    expect(asked).toEqual([[0, 105]]);
    // and when the chain is shorter than what was scanned
    state.tip = 50;
    asked.length = 0;
    expect(await read(client)).toHaveLength(1);
    expect(asked).toEqual([[0, 50]]);
  });

  it("does not scan further back than forty windows, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, asked } = chain(1_000_000, [3, 999_999]);
    const logs = await read(client);
    expect(asked).toHaveLength(40);
    expect(asked[0][0]).toBe(1_000_000 - 40 * 9_000 + 1);
    expect(logs.map((log) => log.args.requestId)).toEqual([999_999n]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/VITE_LOGS_FROM_BLOCK/));
    warn.mockRestore();
  });

  it("a single-block query goes straight through", async () => {
    const { client, asked } = chain(100, [10]);
    await getEvents(client, { address, abi: gamesAbi, eventName: "BetPlaced", fromBlock: 10n, toBlock: 10n, strict: true });
    expect(asked).toEqual([[10, 10]]);
  });

  it("the marketplace ABI has the indexed offerer topic the own-offers query relies on", () => {
    const made = marketplaceAbi.find((item) => item.type === "event" && item.name === "OfferMade")!;
    expect("inputs" in made && made.inputs.find((input) => input.name === "offerer")).toMatchObject({ indexed: true });
    const placed = gamesAbi.find((item) => item.type === "event" && item.name === "BetPlaced")!;
    expect("inputs" in placed && placed.inputs.find((input) => input.name === "player")).toMatchObject({ indexed: true });
  });
});
