import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { eth, dateTime } from "./format";

type Args = readonly unknown[];
const wei = (v: unknown) => (typeof v === "bigint" ? `${eth(v)} ETH` : String(v));
const when = (v: unknown) => (typeof v === "bigint" || typeof v === "number" ? dateTime(v) : String(v));

/** Readable text for the protocol's custom errors, keyed by error name. */
const MESSAGES: Record<string, (args: Args) => string> = {
  // Marketplace
  InvalidPrice: () => "The price must be greater than zero.",
  InvalidQuantity: () => "Invalid quantity: it must be at least 1 and divide the total ETH exactly.",
  InvalidExpiry: () => "The expiry must be in the future.",
  OfferInactive: () => "This offer is no longer open (filled or cancelled).",
  OfferExpired: () => "This offer has expired.",
  NotOfferer: () => "Only the account that made the offer can cancel it.",
  WrongToken: () => "This offer is for a different token id.",
  ProceedsTooLow: ([proceeds, min]) =>
    `Proceeds would be ${wei(proceeds)}, below your minimum of ${wei(min)} (the fee or royalty changed).`,
  TooHigh: () => "The value exceeds the allowed maximum.",
  TransferFailed: () => "An ETH transfer failed (the recipient rejected it).",
  // Treasury / BuybackEngine
  NotSpender: () => "Only the buyback engine can spend the treasury.",
  InsufficientBudget: ([budget, wanted]) =>
    `The collection's buyback budget (${wei(budget)}) does not cover ${wei(wanted)}.`,
  InactiveCollection: () => "There is no active floor bid for this collection.",
  InvalidConfig: () => "Invalid bid configuration.",
  BidBelowMinimum: ([bid, min]) => `The floor bid is now ${wei(bid)}, below your minimum of ${wei(min)}.`,
  // Vault
  NotEngine: () => "Only the buyback engine can register vault deposits.",
  NotHeld: () => "The vault does not hold this token.",
  WrongStatus: ([status]) => `Not possible in the item's current state (status code ${String(status)}).`,
  UnlockConditionsNotMet: () =>
    "Unlock conditions are not met: the lock must have ended and the floor must be at least 130% of the purchase price.",
  GovernanceWindowOpen: ([opensAt]) =>
    `Only the owner can start this auction until the governance window ends on ${when(opensAt)}.`,
  AuctionRunning: () => "The auction is still running.",
  InvalidLock: () => "Invalid lock time.",
  InvalidPrices: () => "Invalid auction prices.",
  StaleOracle: () => "The floor oracle has no fresh price for this collection.",
  PriceNotMet: ([price, sent]) => `The auction price is ${wei(price)} but only ${wei(sent)} was sent.`,
  // PredictionMarket
  UnsupportedCollection: () => "The owner has not enabled this collection here.",
  InvalidDuration: () => "Invalid betting period or duration.",
  OracleUnavailable: () =>
    "The floor oracle has no fresh price. Opening a market needs a recent price; settling one needs a price published after its resolve time.",
  UnknownMarket: () => "This market does not exist.",
  BettingClosed: () => "Betting on this market has closed.",
  BetTooSmall: () => "The bet is below the minimum bet.",
  NotResolvable: () => "This market cannot be resolved yet, or is already resolved.",
  NotResolved: () => "This market is not resolved yet.",
  NothingToClaim: () => "You have nothing to claim in this market.",
  // Points / VaultRaffle
  NotAuthorised: () => "The caller is not authorised.",
  NoPoints: () => "Nobody holds active points yet, so there is no one to draw.",
  TooManyUsers: () => "The points registry is full.",
  Frozen: () => "Points cannot be activated while a raffle draw is in flight.",
  StaleRequest: () => "This randomness request has been superseded.",
  InvalidBps: () => "Invalid basis-points value.",
  NotVault: () => "Only the vault can open raffles.",
  NotRandomness: () => "Only the randomness provider can call this.",
  TooEarly: ([readyAt]) => `Too early: possible from ${when(readyAt)}.`,
  // Games / Treasury project share
  InvalidChance: () => "The chance of winning must be between 1% and 95%.",
  ExposureTooHigh: ([exposure, limit]) =>
    `This bet would put ${wei(exposure)} of the bankroll at risk; the limit per bet is ${wei(limit)}. Lower the wager or raise the chance.`,
  TotalExposureTooHigh: ([total, limit]) =>
    `Too many open bets: this one would bring the house's total at risk to ${wei(total)}; the limit is ${wei(limit)}. Lower the wager or wait for open bets to settle.`,
  RequestIdInUse: () => "The randomness provider reused the id of a bet that is still open. Try again later.",
  UnknownBet: () => "This bet does not exist or is already settled or refunded.",
  NothingOwed: () => "There is nothing owed to this account.",
  InsufficientBankroll: () => "The bankroll is smaller than the requested amount.",
  InvalidShare: () => "Invalid project share.",
  // Oracles
  NotReporter: () => "The caller is not an authorised price reporter.",
  InsufficientData: ([usable, required]) =>
    `Not enough recent sales: ${String(usable)} usable, ${String(required)} required.`,
  InvalidParams: () => "Invalid parameters.",
  NoPrice: () => "No price has been pushed for this collection.",
  // Ownable / ReentrancyGuard
  OwnableUnauthorizedAccount: () => "Only the contract owner can do this.",
  ReentrancyGuardReentrantCall: () => "Re-entrant call blocked.",
  // ERC-721
  ERC721NonexistentToken: ([tokenId]) => `Token #${String(tokenId)} does not exist.`,
  ERC721InsufficientApproval: () => "The contract is not approved to transfer this token.",
  ERC721IncorrectOwner: () => "The seller does not own this token.",
  ERC721InvalidReceiver: () => "The recipient cannot receive NFTs.",
  ERC721InvalidApprover: () => "Only the token owner can approve it.",
};

export type DecodedError = {
  /** Custom error name when viem could decode one. */
  name?: string;
  args?: Args;
  message: string;
};

/** Turn anything thrown by viem / wagmi into a short readable message. */
export function decodeError(error: unknown): DecodedError {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return { message: "Request rejected in the wallet." };
    }
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const args = (revert.data?.args ?? []) as Args;
      if (name && name !== "Error" && name !== "Panic") {
        const describe = MESSAGES[name];
        // Unknown custom error: still show its name and arguments.
        const message = describe ? describe(args) : `${name}(${args.map(String).join(", ")})`;
        return { name, args, message };
      }
      if (revert.reason) return { message: `Reverted: ${revert.reason}` };
      if (revert.signature) return { message: `Reverted with unknown error ${revert.signature}.` };
      return { message: "The transaction would revert (no reason given)." };
    }
    return { message: error.shortMessage || error.message };
  }
  if (error instanceof Error) {
    // wagmi's own errors are not viem BaseErrors but follow the same shape.
    if (error.name === "ProviderNotFoundError") {
      return { message: "No browser wallet found. Install an injected wallet extension and reload." };
    }
    const short = (error as { shortMessage?: unknown }).shortMessage;
    return { message: typeof short === "string" && short ? short : error.message };
  }
  return { message: String(error) };
}
