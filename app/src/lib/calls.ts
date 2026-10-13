// Every transaction the UI can send, as plain builders. The tabs pass these to the transaction
// runner (tx.tsx); test/flows.anvil.test.ts sends the same objects with a local test account.
import type { Abi, Address } from "viem";
import {
  buybackEngineAbi,
  erc721Abi,
  gamesAbi,
  marketplaceAbi,
  mockRandomnessAbi,
  pointsAbi,
  predictionMarketAbi,
  treasuryAbi,
  vaultAbi,
  vaultRaffleAbi,
} from "../generated/abis";
import type { Deployment } from "../generated/addresses";

export type Call = {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
};

/** Approve `operator` (marketplace or buyback engine) for a single token. */
export const approveCall = (collection: Address, operator: Address, tokenId: bigint): Call => ({
  address: collection,
  abi: erc721Abi,
  functionName: "approve",
  args: [operator, tokenId],
});

// ---------------------------------------------------------------- marketplace

export const makeOfferCall = (
  d: Deployment,
  collection: Address,
  tokenId: bigint,
  expiry: bigint,
  price: bigint,
): Call => ({
  address: d.marketplace,
  abi: marketplaceAbi,
  functionName: "makeOffer",
  args: [collection, tokenId, expiry],
  value: price,
});

/** The contract derives the per-item price as `msg.value / quantity`, so the value is the total. */
export const makeCollectionOfferCall = (
  d: Deployment,
  collection: Address,
  quantity: bigint,
  expiry: bigint,
  pricePerItem: bigint,
): Call => ({
  address: d.marketplace,
  abi: marketplaceAbi,
  functionName: "makeCollectionOffer",
  args: [collection, quantity, expiry],
  value: pricePerItem * quantity,
});

export const acceptOfferCall = (d: Deployment, offerId: bigint, tokenId: bigint, minProceeds: bigint): Call => ({
  address: d.marketplace,
  abi: marketplaceAbi,
  functionName: "acceptOffer",
  args: [offerId, tokenId, minProceeds],
});

export const cancelOfferCall = (d: Deployment, offerId: bigint): Call => ({
  address: d.marketplace,
  abi: marketplaceAbi,
  functionName: "cancelOffer",
  args: [offerId],
});

// ---------------------------------------------------------------- floor bid

export const sellCall = (d: Deployment, collection: Address, tokenId: bigint, minPrice: bigint): Call => ({
  address: d.buybackEngine,
  abi: buybackEngineAbi,
  functionName: "sell",
  args: [collection, tokenId, minPrice],
});

// ---------------------------------------------------------------- predictions

export const placeBetCall = (d: Deployment, marketId: bigint, higher: boolean, amount: bigint): Call => ({
  address: d.predictionMarket,
  abi: predictionMarketAbi,
  functionName: "placeBet",
  args: [marketId, higher],
  value: amount,
});

/** Open a market: betting runs for `bettingPeriod` seconds, it settles `duration` seconds from now. */
export const createMarketCall = (d: Deployment, collection: Address, bettingPeriod: bigint, duration: bigint): Call => ({
  address: d.predictionMarket,
  abi: predictionMarketAbi,
  functionName: "createMarket",
  args: [collection, bettingPeriod, duration],
});

export const resolveMarketCall = (d: Deployment, marketId: bigint): Call => ({
  address: d.predictionMarket,
  abi: predictionMarketAbi,
  functionName: "resolve",
  args: [marketId],
});

export const claimMarketCall = (d: Deployment, marketId: bigint): Call => ({
  address: d.predictionMarket,
  abi: predictionMarketAbi,
  functionName: "claim",
  args: [marketId],
});

// ---------------------------------------------------------------- vault

export const unlockCall = (d: Deployment, vaultId: bigint): Call => ({
  address: d.vault,
  abi: vaultAbi,
  functionName: "unlock",
  args: [vaultId],
});

export const startAuctionCall = (d: Deployment, vaultId: bigint): Call => ({
  address: d.vault,
  abi: vaultAbi,
  functionName: "startAuction",
  args: [vaultId],
});

/**
 * `price` is the auction price just read. It only falls, and the contract refunds any excess, so the
 * value sent always covers the price at inclusion.
 *
 * One wei is added on purpose. With exactly `price`, gas is estimated at the moment of the read, when
 * nothing is refunded; by the time the transaction is mined the price has dropped, the refund
 * transfer runs after all, and the transaction can run out of gas. One wei of excess makes the
 * estimate include the refund.
 */
export const buyCall = (d: Deployment, vaultId: bigint, price: bigint): Call => ({
  address: d.vault,
  abi: vaultAbi,
  functionName: "buy",
  args: [vaultId],
  value: price + 1n,
});

// ---------------------------------------------------------------- points

/** Activate a user's pending points so they count in raffles. Anyone may call it for anyone. */
export const flushPointsCall = (d: Deployment, user: Address): Call => ({
  address: d.points,
  abi: pointsAbi,
  functionName: "flush",
  args: [user],
});

// ---------------------------------------------------------------- raffles

export const drawRaffleCall = (d: Deployment, raffleId: bigint): Call => ({
  address: d.vaultRaffle,
  abi: vaultRaffleAbi,
  functionName: "draw",
  args: [raffleId],
});

export const claimRaffleCall = (d: Deployment, raffleId: bigint): Call => ({
  address: d.vaultRaffle,
  abi: vaultRaffleAbi,
  functionName: "claim",
  args: [raffleId],
});

// ---------------------------------------------------------------- treasury

/** Withdraw the project fee shares accrued to the caller. */
export const claimProjectShareCall = (d: Deployment): Call => ({
  address: d.treasury,
  abi: treasuryAbi,
  functionName: "claimProjectShare",
  args: [],
});

// ---------------------------------------------------------------- games

/** Bet `wager` on a roll with a `chanceBps` chance of winning; the edge funds `collection`'s buybacks. */
export const playCall = (d: Deployment, collection: Address, chanceBps: number, wager: bigint): Call => ({
  address: d.games,
  abi: gamesAbi,
  functionName: "play",
  args: [collection, BigInt(chanceBps)],
  value: wager,
});

export const refundBetCall = (d: Deployment, requestId: bigint): Call => ({
  address: d.games,
  abi: gamesAbi,
  functionName: "refund",
  args: [requestId],
});

/** Collect winnings or refunds that could not be sent directly. */
export const withdrawGamesCall = (d: Deployment): Call => ({
  address: d.games,
  abi: gamesAbi,
  functionName: "withdraw",
  args: [],
});

/**
 * LOCAL CHAINS ONLY. Answers a randomness request (a game bet or a raffle draw) through
 * test/mocks/MockRandomness.sol, where whoever calls `fulfill` picks the random word. `provider` is
 * the deployment's `gamesRandomness` or `randomness` address. On public networks the provider is Chainlink VRF and this
 * function does not exist.
 */
export const mockFulfillCall = (provider: Address, requestId: bigint, randomWord: bigint): Call => ({
  address: provider,
  abi: mockRandomnessAbi,
  functionName: "fulfill",
  args: [requestId, randomWord],
});
