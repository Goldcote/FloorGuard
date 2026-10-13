// The only place that says what the keeper is allowed to send.
//
// Every entry is a permissionless, non-payable maintenance function. The signatures are written out
// here, by hand, so that the allowlist does not depend on whatever ABI files happen to be on disk: an
// ABI that disagrees with a signature below is refused at start-up.
import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  encodeFunctionData,
  getAbiItem,
  isAddressEqual,
  toFunctionSelector,
} from "viem";
import { TARGET_CONTRACTS, type Action, type TargetContract } from "./types.ts";

export const ALLOWLIST = {
  predictionMarket: ["resolve(uint256)"],
  points: ["flushMany(address[])"],
  vaultRaffle: ["draw(uint256)", "resetDraw(uint256)", "claim(uint256)"],
  lottery: ["draw(uint256)", "resetDraw(uint256)", "abort(uint256)"],
  ticketRaffle: ["close(uint256)", "settle(uint256)", "resetDraw(uint256)", "abort(uint256)"],
  games: ["refund(uint256)"],
  vault: ["unlock(uint256)", "startAuction(uint256)"],
} as const satisfies Record<TargetContract, readonly string[]>;

/** Calls that are on the allowlist but still need an explicit opt-in in the configuration. */
export interface OptIns {
  lotteryAbort: boolean;
  ticketRaffleAbort: boolean;
  vaultStartAuction: boolean;
}

const OPT_IN_OF: Record<string, keyof OptIns | undefined> = {
  "lottery.abort": "lotteryAbort",
  "ticketRaffle.abort": "ticketRaffleAbort",
  "vault.startAuction": "vaultStartAuction",
};

export class NotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAllowedError";
  }
}

const nameOf = (signature: string) => signature.slice(0, signature.indexOf("("));

/** contract -> function name -> 4-byte selector */
export const ALLOWED_SELECTORS: Record<TargetContract, Record<string, Hex>> = Object.fromEntries(
  TARGET_CONTRACTS.map((contract) => [
    contract,
    Object.fromEntries(ALLOWLIST[contract].map((s) => [nameOf(s), toFunctionSelector(s)])),
  ]),
) as Record<TargetContract, Record<string, Hex>>;

export function isAllowed(contract: string, functionName: string): contract is TargetContract {
  const entry = (ALLOWED_SELECTORS as Record<string, Record<string, Hex> | undefined>)[contract];
  return entry !== undefined && Object.hasOwn(entry, functionName);
}

/**
 * Check, once at start-up, that each allowlisted function exists in the ABI read from disk with exactly
 * the allowlisted signature and is non-payable. Throws otherwise.
 */
export function verifyAbis(abis: Record<TargetContract, Abi>): void {
  for (const contract of TARGET_CONTRACTS) {
    for (const signature of ALLOWLIST[contract]) {
      const name = nameOf(signature);
      const matches = abis[contract].filter(
        (item): item is AbiFunction => item.type === "function" && item.name === name,
      );
      if (matches.length !== 1) {
        throw new NotAllowedError(`${contract}: expected exactly one function named ${name} in the ABI`);
      }
      const item = matches[0]!;
      if (toFunctionSelector(item) !== toFunctionSelector(signature)) {
        throw new NotAllowedError(`${contract}.${name}: ABI does not match the allowlisted ${signature}`);
      }
      if (item.stateMutability !== "nonpayable") {
        throw new NotAllowedError(`${contract}.${name} is ${item.stateMutability}; only non-payable calls are sent`);
      }
    }
  }
}

export interface EncodedCall {
  to: Address;
  data: Hex;
  /** Always zero. The keeper never sends value. */
  value: 0n;
}

/** Turn an action into calldata, refusing anything that is not on the allowlist or not opted in. */
export function encodeAction(
  action: Pick<Action, "contract" | "functionName" | "args">,
  abis: Record<TargetContract, Abi>,
  addresses: Record<TargetContract, Address>,
  optIns: OptIns,
): EncodedCall {
  const { contract, functionName } = action;
  if (!isAllowed(contract, functionName)) {
    throw new NotAllowedError(`${contract}.${functionName} is not on the allowlist`);
  }
  const optIn = OPT_IN_OF[`${contract}.${functionName}`];
  if (optIn !== undefined && !optIns[optIn]) {
    throw new NotAllowedError(`${contract}.${functionName} is opt-in and ${optIn} is off`);
  }
  const item = getAbiItem({ abi: abis[contract], name: functionName }) as AbiFunction | undefined;
  if (!item || item.type !== "function" || item.stateMutability !== "nonpayable") {
    throw new NotAllowedError(`${contract}.${functionName} is not a non-payable function in the ABI`);
  }
  const data = encodeFunctionData({ abi: [item], functionName, args: action.args as unknown[] });
  const call: EncodedCall = { to: addresses[contract], data, value: 0n };
  assertSendable(call, addresses);
  return call;
}

/**
 * The last check before anything is signed: the target is one of the seven contracts, the selector is
 * allowlisted for that contract, and no value is attached. It looks only at the bytes about to be sent.
 */
export function assertSendable(
  call: { to: Address; data: Hex; value?: bigint },
  addresses: Record<TargetContract, Address>,
): void {
  if (call.value !== undefined && call.value !== 0n) {
    throw new NotAllowedError("the keeper never sends value");
  }
  if (call.data.length < 10) throw new NotAllowedError("calldata has no selector");
  const selector = call.data.slice(0, 10).toLowerCase();
  // several keys may share an address only by misconfiguration; accept the call if any of them allows it
  const targets = TARGET_CONTRACTS.filter((c) => isAddressEqual(addresses[c], call.to));
  if (targets.length === 0) throw new NotAllowedError(`${call.to} is not a keeper target`);
  const ok = targets.some((c) => Object.values(ALLOWED_SELECTORS[c]).includes(selector as Hex));
  if (!ok) throw new NotAllowedError(`selector ${selector} is not allowlisted for ${call.to}`);
}
