// Every transaction the UI can send, as plain builders. The tabs pass these to the transaction
// runner (tx.tsx); test/flows.anvil.test.ts sends the same objects with a local test account.
import type { Abi, Address } from "viem";
import {
  buybackEngineAbi,
  erc721Abi,
  gamesAbi,
  ipLicenseManagerAbi,
  lotteryAbi,
  marketplaceAbi,
  mockRandomnessAbi,
  pointsAbi,
  predictionMarketAbi,
  ticketRaffleAbi,
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
 * Buy an auctioned holding, sending `maxPrice`: the most the buyer has agreed to pay. The contract
 * charges the price at inclusion and refunds the rest; if the price is above `maxPrice` by then (an
 * auction that was restarted, for example) it reverts with `PriceNotMet`. The value is exactly what
 * the review showed, never more. (The refund makes the transaction cost more gas than a node
 * estimates for the moment of asking; lib/gas.ts adds the margin.)
 */
export const buyCall = (d: Deployment, vaultId: bigint, maxPrice: bigint): Call => ({
  address: d.vault,
  abi: vaultAbi,
  functionName: "buy",
  args: [vaultId],
  value: maxPrice,
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

// ---------------------------------------------------------------- ticket raffles

const ticketRaffleCall = (d: Deployment, functionName: string, args: readonly unknown[], value?: bigint): Call => ({
  address: d.ticketRaffle,
  abi: ticketRaffleAbi,
  functionName,
  args,
  value,
});

/** Raffle a token. The caller must own it and have approved the TicketRaffle contract. */
export const createTicketRaffleCall = (
  d: Deployment,
  collection: Address,
  tokenId: bigint,
  ticketPrice: bigint,
  minTickets: number,
  maxTickets: number,
  durationSeconds: bigint,
): Call => ticketRaffleCall(d, "create", [collection, tokenId, ticketPrice, minTickets, maxTickets, durationSeconds]);

/** The contract requires exactly `count * ticketPrice`. */
export const buyTicketsCall = (d: Deployment, raffleId: bigint, count: number, ticketPrice: bigint): Call =>
  ticketRaffleCall(d, "buy", [raffleId, count], ticketPrice * BigInt(count));

export const cancelTicketRaffleCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "cancel", [raffleId]);
export const closeTicketRaffleCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "close", [raffleId]);
export const settleTicketRaffleCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "settle", [raffleId]);
export const refundTicketsCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "refund", [raffleId]);
export const reclaimTicketRaffleCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "reclaim", [raffleId]);
export const abortTicketRaffleCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "abort", [raffleId]);
export const resetTicketDrawCall = (d: Deployment, raffleId: bigint): Call => ticketRaffleCall(d, "resetDraw", [raffleId]);
/** Withdraw raffle revenue owed to the caller as a creator. */
export const withdrawTicketRaffleCall = (d: Deployment): Call => ticketRaffleCall(d, "withdraw", []);

// ---------------------------------------------------------------- licences

/** Buy a licence on a locked vault holding. The contract requires exactly the tier price. */
export const requestLicenseCall = (d: Deployment, vaultId: bigint, tier: number, usageScope: string, price: bigint): Call => ({
  address: d.ipLicenseManager,
  abi: ipLicenseManagerAbi,
  functionName: "requestLicense",
  args: [vaultId, tier, usageScope],
  value: price,
});

// ---------------------------------------------------------------- slots

/** Spin the slots with `wager`; the edge funds `collection`'s buybacks. */
export const spinCall = (d: Deployment, collection: Address, wager: bigint): Call => ({
  address: d.games,
  abi: gamesAbi,
  functionName: "spin",
  args: [collection],
  value: wager,
});

// ---------------------------------------------------------------- lottery

const lotteryCall = (d: Deployment, functionName: string, args: readonly unknown[], value?: bigint): Call => ({
  address: d.lottery,
  abi: lotteryAbi,
  functionName,
  args,
  value,
});

/**
 * Buy tickets in the collection's open round; opens the next round if the latest has ended. The
 * contract requires exactly `count * ticketPrice` at the price of the round the tickets land in:
 * the open round's price, or the configured price when a new round opens.
 */
export const buyLotteryTicketsCall = (d: Deployment, collection: Address, count: number, ticketPrice: bigint): Call =>
  lotteryCall(d, "buy", [collection, count], ticketPrice * BigInt(count));

export const drawLotteryCall = (d: Deployment, roundId: bigint): Call => lotteryCall(d, "draw", [roundId]);
export const resetLotteryDrawCall = (d: Deployment, roundId: bigint): Call => lotteryCall(d, "resetDraw", [roundId]);
export const abortLotteryCall = (d: Deployment, roundId: bigint): Call => lotteryCall(d, "abort", [roundId]);
export const refundLotteryCall = (d: Deployment, roundId: bigint): Call => lotteryCall(d, "refund", [roundId]);
/** Withdraw the caller's lottery winnings. */
export const withdrawLotteryCall = (d: Deployment): Call => lotteryCall(d, "withdraw", []);

// ---------------------------------------------------------------- the house

const gamesCall = (d: Deployment, functionName: string, args: readonly unknown[], value?: bigint): Call => ({ address: d.games, abi: gamesAbi, functionName, args, value });

/**
 * `Games.deposit`: ask to fund the bankroll for shares. Carried out at once if no bet from before is
 * open and it would give up no more than `maxSpreadBps` against fair value; otherwise the ETH waits
 * (and can be cancelled) until `executeDeposit`. `maxSpreadBps` is the most the caller will give up
 * because other bets are open, in basis points.
 */
export const depositHouseCall = (d: Deployment, amount: bigint, maxSpreadBps: bigint): Call => gamesCall(d, "deposit", [maxSpreadBps], amount);
/** `Games.executeDeposit`: turn the caller's pending deposit into shares now, giving up at most `maxSpreadBps`. */
export const executeDepositHouseCall = (d: Deployment, maxSpreadBps: bigint): Call => gamesCall(d, "executeDeposit", [maxSpreadBps]);
/** `Games.cancelDeposit`: take a pending deposit back. */
export const cancelDepositHouseCall = (d: Deployment): Call => gamesCall(d, "cancelDeposit", []);

/**
 * `Games.redeem`: ask to redeem shares (replacing any earlier request), paid to `to`. Carried out at
 * once if no bet from before is open and it would give up no more than `maxSpreadBps`; otherwise
 * the shares stay at risk until `executeRedeem`.
 */
export const redeemHouseCall = (d: Deployment, shares: bigint, maxSpreadBps: bigint, to: Address): Call => gamesCall(d, "redeem", [shares, maxSpreadBps, to]);
/** `Games.executeRedeem`: carry out the caller's pending redemption now, giving up at most `maxSpreadBps`. */
export const executeRedeemHouseCall = (d: Deployment, maxSpreadBps: bigint, to: Address): Call => gamesCall(d, "executeRedeem", [maxSpreadBps, to]);
/** `Games.cancelRedeem`: withdraw a pending redemption request. */
export const cancelRedeemHouseCall = (d: Deployment): Call => gamesCall(d, "cancelRedeem", []);
