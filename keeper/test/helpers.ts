import { type Abi, type Address, parseAbi } from "viem";
import type { TargetContract } from "../src/types.ts";

/** The allowlisted functions as a hand-written ABI, so unit tests do not need Foundry's out/. */
export const ABIS: Record<TargetContract, Abi> = {
  predictionMarket: parseAbi(["function resolve(uint256 marketId)", "function placeBet(uint256 marketId, bool higher) payable", "function setOracle(address oracle)"]),
  points: parseAbi(["function flushMany(address[] users)", "function flush(address user)", "function setRate(address source, uint256 rate)"]),
  vaultRaffle: parseAbi(["function draw(uint256 raffleId)", "function resetDraw(uint256 raffleId)", "function claim(uint256 raffleId)", "function setRandomness(address r)"]),
  lottery: parseAbi(["function draw(uint256 roundId)", "function resetDraw(uint256 roundId)", "function abort(uint256 roundId)", "function buy(address c, uint32 n) payable returns (uint256)", "function withdraw()"]),
  ticketRaffle: parseAbi(["function close(uint256 raffleId)", "function settle(uint256 raffleId)", "function resetDraw(uint256 raffleId)", "function abort(uint256 raffleId)", "function withdraw()"]),
  games: parseAbi(["function refund(uint256 requestId)", "function withdraw()", "function fundBankroll() payable returns (uint256)"]),
  vault: parseAbi([
    "function sampleFloor(address collection)",
    "function requestUnlockRound()",
    "function unlock(uint256 vaultId)",
    "function releaseToPlayers(uint256 vaultId) returns (uint256)",
    "function startAuction(uint256 vaultId)",
    "function buy(uint256 vaultId) payable",
    "function governanceUnlock(uint256 vaultId)",
    "function fulfillRandomness(uint256 requestId, uint256 randomWord)",
    "function sendToRaffle(uint256 vaultId) returns (uint256)",
  ]),
};

export const ADDRESSES: Record<TargetContract, Address> = {
  predictionMarket: "0x1000000000000000000000000000000000000001",
  points: "0x1000000000000000000000000000000000000002",
  vaultRaffle: "0x1000000000000000000000000000000000000003",
  lottery: "0x1000000000000000000000000000000000000004",
  ticketRaffle: "0x1000000000000000000000000000000000000005",
  games: "0x1000000000000000000000000000000000000006",
  vault: "0x1000000000000000000000000000000000000007",
};

export const ALL_OPT_INS = { lotteryAbort: true, ticketRaffleAbort: true, vaultStartAuction: true };
export const NO_OPT_INS = { lotteryAbort: false, ticketRaffleAbort: false, vaultStartAuction: false };

export const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const DAY = 86_400n;
export const HOUR = 3_600n;
