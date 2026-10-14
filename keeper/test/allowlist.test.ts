import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type AbiFunction, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { ALLOWED_SELECTORS, ALLOWLIST, NotAllowedError, assertSendable, encodeAction, isAllowed, verifyAbis } from "../src/allowlist.ts";
import { loadAbis } from "../src/chain.ts";
import { REPO_DIR } from "../src/config.ts";
import { TARGET_CONTRACTS, type TargetContract } from "../src/types.ts";
import { A, ABIS, ADDRESSES, ALL_OPT_INS, NO_OPT_INS } from "./helpers.ts";

describe("allowlist", () => {
  it("is exactly these eighteen calls", () => {
    // Selectors computed independently with `cast sig`. Adding to the allowlist means changing this too.
    expect(ALLOWED_SELECTORS).toEqual({
      predictionMarket: { resolve: "0x4f896d4f" },
      points: { flushMany: "0x7159ca96" },
      vaultRaffle: { draw: "0x3b304147", resetDraw: "0xe1cfc041", claim: "0x379607f5" },
      lottery: { draw: "0x3b304147", resetDraw: "0xe1cfc041", abort: "0xe50701f4" },
      ticketRaffle: { close: "0x0aebeb4e", settle: "0x8df82800", resetDraw: "0xe1cfc041", abort: "0xe50701f4" },
      games: { refund: "0x278ecde1" },
      vault: {
        sampleFloor: "0x3ab2f409",
        requestUnlockRound: "0x303bb381",
        unlock: "0x6198e339",
        releaseToPlayers: "0xca4bafe2",
        startAuction: "0x065de74c",
      },
    });
    expect(Object.values(ALLOWLIST).flat()).toHaveLength(18);
  });

  it("encodes an allowlisted call with no value", () => {
    const call = encodeAction({ contract: "predictionMarket", functionName: "resolve", args: [7n] }, ABIS, ADDRESSES, NO_OPT_INS);
    expect(call.to).toBe(ADDRESSES.predictionMarket);
    expect(call.value).toBe(0n);
    expect(call.data).toBe(encodeFunctionData({ abi: ABIS.predictionMarket, functionName: "resolve", args: [7n] }));
  });

  it("refuses every other function of the hand-written ABIs", () => {
    for (const contract of TARGET_CONTRACTS) {
      for (const item of ABIS[contract].filter((i): i is AbiFunction => i.type === "function")) {
        if (isAllowed(contract, item.name)) continue;
        expect(() => encodeAction({ contract, functionName: item.name, args: [] }, ABIS, ADDRESSES, ALL_OPT_INS), `${contract}.${item.name}`).toThrow(
          NotAllowedError,
        );
      }
    }
  });

  it("refuses unknown contracts and prototype names", () => {
    const bad = (contract: string, functionName: string) => () =>
      encodeAction({ contract: contract as TargetContract, functionName, args: [] }, ABIS, ADDRESSES, ALL_OPT_INS);
    expect(bad("treasury", "spend")).toThrow(NotAllowedError);
    expect(bad("buybackEngine", "sell")).toThrow(NotAllowedError);
    expect(bad("vault", "constructor")).toThrow(NotAllowedError);
    expect(bad("vault", "toString")).toThrow(NotAllowedError);
    expect(bad("__proto__", "resolve")).toThrow(NotAllowedError);
  });

  it("keeps abort and startAuction behind their opt-ins", () => {
    const encode = (contract: TargetContract, functionName: string, optIns = NO_OPT_INS) => () =>
      encodeAction({ contract, functionName, args: [1n] }, ABIS, ADDRESSES, optIns);
    expect(encode("lottery", "abort")).toThrow(/opt-in/);
    expect(encode("ticketRaffle", "abort")).toThrow(/opt-in/);
    expect(encode("vault", "startAuction")).toThrow(/opt-in/);
    expect(encode("lottery", "abort", { ...NO_OPT_INS, lotteryAbort: true })).not.toThrow();
    // one opt-in does not open another
    expect(encode("ticketRaffle", "abort", { ...NO_OPT_INS, lotteryAbort: true })).toThrow(/opt-in/);
    expect(encode("vault", "startAuction", { ...NO_OPT_INS, vaultStartAuction: true })).not.toThrow();
    // calls without an opt-in are unaffected
    expect(encode("lottery", "draw")).not.toThrow();
  });

  it("refuses an ABI in which an allowlisted function is payable or has other arguments", () => {
    expect(() => verifyAbis(ABIS)).not.toThrow();
    const payable = { ...ABIS, games: parseAbi(["function refund(uint256 requestId) payable"]) as Abi };
    expect(() => verifyAbis(payable)).toThrow(/payable/);
    const other = { ...ABIS, vault: [...ABIS.vault.filter((i) => !("name" in i) || i.name !== "unlock"), ...parseAbi(["function unlock(address who)"])] as Abi };
    expect(() => verifyAbis(other)).toThrow(/does not match/);
    const missing = { ...ABIS, points: parseAbi(["function flush(address user)"]) as Abi };
    expect(() => verifyAbis(missing)).toThrow(/exactly one/);
    // encodeAction checks mutability again on its own
    expect(() => encodeAction({ contract: "games", functionName: "refund", args: [1n] }, payable, ADDRESSES, NO_OPT_INS)).toThrow(/non-payable/);
  });

  describe("assertSendable, the check on the bytes about to be signed", () => {
    const resolve = encodeFunctionData({ abi: ABIS.predictionMarket, functionName: "resolve", args: [1n] });

    it("accepts an allowlisted selector on its own contract", () => {
      expect(() => assertSendable({ to: ADDRESSES.predictionMarket, data: resolve, value: 0n }, ADDRESSES)).not.toThrow();
      expect(() => assertSendable({ to: ADDRESSES.predictionMarket, data: resolve }, ADDRESSES)).not.toThrow();
    });

    it("refuses any value", () => {
      expect(() => assertSendable({ to: ADDRESSES.predictionMarket, data: resolve, value: 1n }, ADDRESSES)).toThrow(/never sends value/);
    });

    it("refuses a target that is not one of the seven contracts", () => {
      expect(() => assertSendable({ to: A(0xdead), data: resolve, value: 0n }, ADDRESSES)).toThrow(/not a keeper target/);
    });

    it("refuses a selector that is allowlisted for a different contract", () => {
      // resolve() belongs to the prediction market, not the vault
      expect(() => assertSendable({ to: ADDRESSES.vault, data: resolve, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
      const unlock = encodeFunctionData({ abi: ABIS.vault, functionName: "unlock", args: [1n] });
      expect(() => assertSendable({ to: ADDRESSES.games, data: unlock, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
    });

    it("refuses owner functions, payable functions and empty calldata", () => {
      const governanceUnlock = encodeFunctionData({ abi: ABIS.vault, functionName: "governanceUnlock", args: [1n] });
      expect(() => assertSendable({ to: ADDRESSES.vault, data: governanceUnlock, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
      const buy = encodeFunctionData({ abi: ABIS.vault, functionName: "buy", args: [1n] });
      expect(() => assertSendable({ to: ADDRESSES.vault, data: buy, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
      expect(() => assertSendable({ to: ADDRESSES.vault, data: "0x", value: 0n }, ADDRESSES)).toThrow(/no selector/);
    });

    it("refuses the Vault's randomness callback and owner-only raffle path, and accepts the new maintenance calls", () => {
      // fulfillRandomness is permissioned to the provider; a keeper calling it could only fail, and must not try
      const fulfill = encodeFunctionData({ abi: ABIS.vault, functionName: "fulfillRandomness", args: [1n, 2n] });
      expect(() => assertSendable({ to: ADDRESSES.vault, data: fulfill, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
      const sendToRaffle = encodeFunctionData({ abi: ABIS.vault, functionName: "sendToRaffle", args: [1n] });
      expect(() => assertSendable({ to: ADDRESSES.vault, data: sendToRaffle, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
      for (const [functionName, args] of [
        ["sampleFloor", [A(1)]],
        ["requestUnlockRound", []],
        ["releaseToPlayers", [3n]],
      ] as const) {
        const call = encodeAction({ contract: "vault", functionName, args }, ABIS, ADDRESSES, NO_OPT_INS);
        expect(call.to).toBe(ADDRESSES.vault);
        expect(call.value).toBe(0n);
        expect(call.data).toBe(encodeFunctionData({ abi: ABIS.vault, functionName, args } as never));
      }
      // the same selectors are refused on any other target
      const sample = encodeFunctionData({ abi: ABIS.vault, functionName: "sampleFloor", args: [A(1)] });
      expect(() => assertSendable({ to: ADDRESSES.vaultRaffle, data: sample, value: 0n }, ADDRESSES)).toThrow(/not allowlisted/);
    });
  });

  // The real ABIs, when the contracts have been built.
  describe.skipIf(!existsSync(join(REPO_DIR, "out", "Vault.sol", "Vault.json")))("against Foundry's out/", () => {
    const abis = loadAbis(join(REPO_DIR, "out"));
    const targets = Object.fromEntries(TARGET_CONTRACTS.map((c) => [c, abis[c]])) as Record<TargetContract, Abi>;

    it("every allowlisted function exists, matches its signature and is non-payable", () => {
      expect(() => verifyAbis(targets)).not.toThrow();
    });

    it("refuses every function of the seven contracts that is not allowlisted", () => {
      let refused = 0;
      for (const contract of TARGET_CONTRACTS) {
        for (const item of targets[contract].filter((i): i is AbiFunction => i.type === "function")) {
          const allowed = Object.values(ALLOWED_SELECTORS[contract]).includes(toFunctionSelector(item));
          if (allowed) continue;
          refused++;
          expect(() => assertSendable({ to: ADDRESSES[contract], data: toFunctionSelector(item), value: 0n }, ADDRESSES), `${contract}.${item.name}`).toThrow(
            NotAllowedError,
          );
        }
      }
      expect(refused).toBeGreaterThan(100);
    });
  });
});
