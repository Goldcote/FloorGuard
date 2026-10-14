// The house's share arithmetic and the replay of its history, mirroring `Games.sol` exactly. Pure:
// no chain and no simulator, so the page, the demo simulator and the tests can all use it.

const BPS = 10_000n;
/** `Games.VIRTUAL_SHARES`: makes the first deposit's price well defined and rounding attacks pointless. */
export const VIRTUAL_SHARES = 1_000_000n;
/** Shares are shown in units of a million raw shares: one unit is what 1 wei bought at the start. */
export const SHARE_UNIT = VIRTUAL_SHARES;

export type HouseFunds = {
  /** House funds not set aside for open bets. */
  bankroll: bigint;
  /** House funds set aside to pay the open bets, should they win. */
  reserved: bigint;
  /** Players' wagers on the open bets. Not the house's, and not part of the share price. */
  openWagers: bigint;
  totalShares: bigint;
};

/** The house's funds: free and set aside. What the shares are a part of. */
export const houseFundsOf = (h: Pick<HouseFunds, "bankroll" | "reserved">): bigint => h.bankroll + h.reserved;

/**
 * `Games.previewDeposit`: shares a deposit receives if carried out right now, priced as if the
 * house wins every bet that is open.
 */
export function previewDeposit(h: HouseFunds, assets: bigint): bigint {
  return (assets * (h.totalShares + VIRTUAL_SHARES)) / (h.bankroll + h.reserved + h.openWagers + 1n);
}

/** Shares the same deposit receives with no bet open: at the house's funds per share. */
export function quietDeposit(h: HouseFunds, assets: bigint): bigint {
  return (assets * (h.totalShares + VIRTUAL_SHARES)) / (h.bankroll + h.reserved + 1n);
}

/** `Games.shareValue`: the fair value of shares, their part of the house's funds, free and set aside. */
export function shareValue(h: HouseFunds, shares: bigint): bigint {
  return (shares * (h.bankroll + h.reserved + 1n)) / (h.totalShares + VIRTUAL_SHARES);
}

/**
 * `Games.previewRedeem`: what shares are paid if redeemed right now, their part of the free bankroll,
 * as if the house loses every bet that is open. Equal to `shareValue` when no bet is open.
 */
export function previewRedeem(h: HouseFunds, shares: bigint): bigint {
  return (shares * (h.bankroll + 1n)) / (h.totalShares + VIRTUAL_SHARES);
}

/** What redeeming right now gives up to the holders who stay, because bets are open. Zero when none is. */
export function givenUpByRedeemingNow(h: HouseFunds, shares: bigint): bigint {
  return shareValue(h, shares) - previewRedeem(h, shares);
}

/** `Games._executeRedeem`: the last holder cannot leave while bets are open (what is set aside for them would be ownerless). */
export function lastHolderBlocked(h: HouseFunds, shares: bigint): boolean {
  return shares === h.totalShares && h.reserved !== 0n;
}

/**
 * What carrying out a deposit right now gives up against fair value, in basis points (rounded up):
 * `1 - previewDeposit / quietDeposit`. Zero when no bet is open.
 */
export function depositSpreadBps(h: HouseFunds, assets: bigint): bigint {
  const fair = quietDeposit(h, assets);
  if (fair === 0n) return 0n;
  const now = previewDeposit(h, assets);
  return now >= fair ? 0n : ((fair - now) * BPS + fair - 1n) / fair;
}

/** The same for a redemption: `1 - previewRedeem / shareValue`, in basis points (rounded up). */
export function redeemSpreadBps(h: HouseFunds, shares: bigint): bigint {
  const fair = shareValue(h, shares);
  if (fair === 0n) return 0n;
  const now = previewRedeem(h, shares);
  return now >= fair ? 0n : ((fair - now) * BPS + fair - 1n) / fair;
}

/**
 * `Games._executeDeposit`'s test: a deposit is carried out only if it gets at least the fair number
 * of shares less `maxSpreadBps` (and at least one share).
 */
export function depositWithinSpread(h: HouseFunds, assets: bigint, maxSpreadBps: bigint): boolean {
  const shares = previewDeposit(h, assets);
  return shares !== 0n && shares >= (quietDeposit(h, assets) * (BPS - maxSpreadBps)) / BPS;
}

/** `Games._executeRedeem`'s test: a redemption is carried out only if it pays at least fair value less `maxSpreadBps`. */
export function redeemWithinSpread(h: HouseFunds, shares: bigint, maxSpreadBps: bigint): boolean {
  return previewRedeem(h, shares) >= (shareValue(h, shares) * (BPS - maxSpreadBps)) / BPS;
}

/**
 * The shares a redemption request is recorded for (`Games.redeem`): a remainder of fewer than a
 * million raw shares could never be redeemed, so the request is rounded up to the whole holding.
 */
export function redeemRequestShares(held: bigint, shares: bigint): bigint {
  return held - shares < VIRTUAL_SHARES ? held : shares;
}

/** Spread tolerances the page offers, the default, and where the hard warning starts. */
export const SPREAD_PRESETS_BPS = [0n, 50n, 100n, 200n] as const;
export const DEFAULT_SPREAD_BPS = 50n;
export const SPREAD_WARN_BPS = 200n;

/** Fair value of one share unit in wei-per-wei terms, as a float: 1 at the very first deposit. `funds` is free plus set aside. */
export function sharePrice(funds: bigint, totalShares: bigint): number {
  return Number(((funds + 1n) * 1_000_000_000n * SHARE_UNIT) / (totalShares + VIRTUAL_SHARES)) / 1e9;
}

/** A request of the connected account that has not been carried out. */
export type HouseRequest = {
  /** Wei for a deposit, raw shares for a redemption. */
  amount: bigint;
  /** Every bet that was open when the request was made has closed: it can be carried out now. */
  ready: boolean;
  /**
   * How many of those bets are still open. Undefined when it cannot be counted (the bets are not
   * enumerable on-chain; the count comes from the event log).
   */
  waitingFor?: number;
};

export type HouseState = HouseFunds & {
  /** The share of each edge the bankroll keeps; the rest goes to the Treasury. */
  bankrollShareBps: bigint;
  edgeBps: bigint;
  /** One bet may put at most this share of the free bankroll at risk; all open bets this share of the house's funds. */
  maxExposureBps: bigint;
  maxTotalExposureBps: bigint;
  /** Deposits of all accounts waiting to become shares. Held apart from the bankroll. */
  totalPendingDeposits: bigint;
  /** How many bets are open right now. Undefined when it cannot be counted (it comes from the event log). */
  openBets?: number;
  userShares?: bigint;
  /** The connected account's deposit waiting to become shares, if any. */
  pendingDeposit?: HouseRequest;
  /** The connected account's shares waiting to be redeemed, if any. They stay at risk meanwhile. */
  pendingRedeem?: HouseRequest;
};

export type HouseEvent =
  | { kind: "deposit"; amount: bigint; shares: bigint; order: number; time?: number }
  | { kind: "redeem"; amount: bigint; shares: bigint; order: number; time?: number }
  /** A settled bet: what the house gained (negative: lost) on it, its part of the edge included. */
  | { kind: "bet"; gain: bigint; order: number; time?: number };

export type HousePoint = { order: number; time?: number; kind: HouseEvent["kind"]; equity: bigint; shares: bigint; price: number; change: bigint };

/**
 * The share price after each event, replayed from an empty house: deposits and redemptions (when
 * they are carried out) move funds and shares together, a settled bet moves funds only. `equity` is
 * the house's funds, free and set aside. Each bet counts at its settlement, so the series is the
 * realised history and says nothing about bets still open.
 */
export function housePoints(events: readonly HouseEvent[]): HousePoint[] {
  let equity = 0n;
  let shares = 0n;
  return [...events]
    .sort((a, b) => a.order - b.order)
    .map((event) => {
      let change: bigint;
      if (event.kind === "deposit") {
        equity += event.amount;
        shares += event.shares;
        change = event.amount;
      } else if (event.kind === "redeem") {
        equity -= event.amount;
        shares -= event.shares;
        change = -event.amount;
      } else {
        equity += event.gain;
        change = event.gain;
      }
      if (equity < 0n) equity = 0n;
      return { order: event.order, time: event.time, kind: event.kind, equity, shares, price: sharePrice(equity, shares), change };
    });
}

/** What the house gained on a settled bet: the wager, less the payout, less the Treasury's part of the edge. */
export function houseGain(wager: bigint, payout: bigint, fee: bigint, bankrollShareBps: bigint): bigint {
  return wager - payout - (fee - (fee * bankrollShareBps) / BPS);
}
