// What a transaction is, in the terms a wallet shows: the contract, the function, the ETH sent and,
// for an approval, who is approved. Shown in every review dialog so the visitor can compare it with
// what the wallet then asks them to sign.
import { formatEther, type Address } from "viem";
import type { Deployment } from "../generated/addresses";
import type { Call } from "./calls";

export type CallSummary = {
  /** The protocol's name for the contract, when the address is one of the deployment's. */
  contractName?: string;
  contract: Address;
  functionName: string;
  /** ETH sent with the call, as text. */
  value: string;
  /** For an ERC-721 approval: the account allowed to move the token(s), and which. */
  approval?: { spender: Address; spenderName?: string; scope: string };
};

const NAMES: Partial<Record<keyof Deployment, string>> = {
  treasury: "Treasury",
  marketplace: "Marketplace",
  buybackEngine: "Buyback engine",
  vault: "Vault",
  predictionMarket: "Prediction market",
  points: "Points",
  vaultRaffle: "Vault raffle",
  games: "Games",
  ticketRaffle: "Ticket raffle",
  lottery: "Lottery",
  ipLicenseManager: "Licence manager",
  salesFloorOracle: "Sales floor oracle",
  pushFloorOracle: "Push floor oracle",
};

/** The deployment's name for an address, if it is one of its contracts (the randomness providers included). */
export function contractName(d: Deployment | undefined, address: Address): string | undefined {
  if (!d) return undefined;
  const lower = address.toLowerCase();
  for (const [key, name] of Object.entries(NAMES) as [keyof Deployment, string][]) {
    if (d[key]?.toLowerCase() === lower) return name;
  }
  if ([d.randomness, d.gamesRandomness, d.ticketRaffleRandomness, d.lotteryRandomness].some((a) => a.toLowerCase() === lower)) return "Randomness provider";
  return undefined;
}

export function summariseCall(call: Call, d: Deployment | undefined): CallSummary {
  const summary: CallSummary = {
    contractName: contractName(d, call.address),
    contract: call.address,
    functionName: call.functionName,
    value: `${formatEther(call.value ?? 0n)} ETH`,
  };
  if (call.functionName === "approve") {
    const [spender, tokenId] = call.args as [Address, bigint];
    summary.approval = { spender, spenderName: contractName(d, spender), scope: `token #${tokenId}` };
    // an approval is sent to the NFT collection itself, which is not one of the protocol's contracts
    summary.contractName ??= "NFT collection";
  } else if (call.functionName === "setApprovalForAll") {
    const [spender, approved] = call.args as [Address, boolean];
    summary.approval = { spender, spenderName: contractName(d, spender), scope: approved ? "every token of the collection" : "none (revoked)" };
    summary.contractName ??= "NFT collection";
  }
  return summary;
}
