// DEMO MODE: a simulated protocol that lives in this browser tab. No chain, no wallet, play money.
//
// It answers the same read functions as lib/reads.ts and accepts the same Call objects as the
// contracts (lib/calls.ts), so every page works unchanged. The rules are the contracts' rules: all
// arithmetic comes from lib/gameMath.ts, the same module the live path uses. Randomness comes from a
// seeded pseudo-random generator, which is why the demo is not, and is never labelled, fair play.
//
// Simulated time runs faster than real time (see DEMO_SPEED) so that rounds end, bids rise and
// auctions fall while someone is watching. Nothing here is persisted: a reload starts over.
import type { Address, Client, Hash } from "viem";
import type { Deployment } from "../generated/addresses";
import type { Call } from "../lib/calls";
import { BPS, diceQuote, gameExposure, recomputeBet, slotsExposure, splitPot } from "../lib/gameMath";
import { depositWithinSpread, houseGain, lastHolderBlocked, previewDeposit, previewRedeem, redeemRequestShares, redeemWithinSpread, type HouseEvent, type HouseRequest, type HouseState } from "../lib/houseMath";
import type * as R from "../lib/reads";
import { dateTime } from "../lib/format";
import { drawChanceBps, releaseCap, requiredFloor, requiredFloorBps, VAULT } from "../viz/curves";

/** Simulated seconds per real second: a simulated day passes in 2.4 real minutes. */
export const DEMO_SPEED = 600;
export const DEMO_CHAIN_ID = 0;
const DAY = 86_400;
const ETH = 10n ** 18n;
const milli = (n: number) => (BigInt(Math.round(n * 1000)) * ETH) / 1000n;

const addr = (n: number): Address => `0x00000000000000000000000000000000d3${n.toString(16).padStart(6, "0")}` as Address;
export const DEMO_USER = addr(1);
const NPC_A = addr(0xa11ce);
const NPC_B = addr(0xb0b);
const PROJECT = addr(0xface);
export const DEMO_COLLECTION = addr(0xc011);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export const DEMO_DEPLOYMENT: Deployment = {
  treasury: addr(0x101),
  marketplace: addr(0x102),
  buybackEngine: addr(0x103),
  vault: addr(0x104),
  predictionMarket: addr(0x105),
  points: addr(0x106),
  vaultRaffle: addr(0x107),
  games: addr(0x108),
  ticketRaffle: addr(0x109),
  lottery: addr(0x10a),
  ipLicenseManager: addr(0x10b),
  salesFloorOracle: addr(0x10c),
  pushFloorOracle: addr(0x10d),
  randomness: addr(0x10e),
  gamesRandomness: addr(0x10e),
  vaultRandomness: addr(0x10e),
  ticketRaffleRandomness: addr(0x10e),
  lotteryRandomness: addr(0x10e),
  owner: addr(0x10f),
  demoCollection: DEMO_COLLECTION,
};

/** The stand-in for a viem client: lib/reads.ts hands every call that carries it to this module. */
export const DEMO_CLIENT = { demo: true } as unknown as Client;
export const isDemo = (client: unknown): boolean => (client as { demo?: boolean } | undefined)?.demo === true;

// ---------------------------------------------------------------- state

type Offer = Omit<R.Offer, "filled"> & { filled: number };
/** `seq`: the bet's number in the order bets were placed (`Games.placedCount` when it was placed). */
type Bet = R.GameBet & { player: Address; edgeBps: bigint; placedAt: number; kept?: bigint; seq: number };
type Entry = { buyer: Address; count: number };
type Round = Omit<R.LotteryRound, "userPaid" | "userTickets" | "pot" | "prize"> & { entries: Entry[]; ticket?: bigint };
type Raffle = Omit<R.TicketRaffle, "userPaid" | "userTickets"> & { entries: Entry[]; ticket?: bigint };
type Market = Omit<R.Market, "stake"> & { stakes: Map<Address, { higher: bigint; lower: bigint }> };

/** The Vault's moving lock: floor samples, the daily draw, the weekly release cap, the players' share. */
type VaultSim = {
  /** Daily samples, oldest first: the last 60, enough for the median now and as of the last draw (`Vault._samples` with its snapshot). */
  samples: { price: bigint; takenAt: number }[];
  sampleCount: number;
  /** Day index of the last sample plus one (`Vault.lastSampleSlot`). */
  lastSampleSlot: number;
  /** The draw, and the random word behind the current result. */
  draw: R.UnlockDraw & { seed: number };
  /** `Vault.releaseWindows` for the demo collection. */
  window: { start: number; cap: number; used: number };
  /** `Vault.playersCredit`: decides which purchases are set aside for players. */
  playersCredit: number;
  /** `Vault.unlockBpsOf`: the multiple a holding unlocked at by the draw. */
  unlockBps: Map<bigint, number>;
  /** Simulated time up to which the demo's keeper has done its daily rounds. */
  keeperUpTo: number;
  /** The draw result (by arrival time) whose picks the keeper has already unlocked. */
  keeperUnlocked: number;
};

type State = {
  balance: bigint;
  budget: bigint;
  projectOwed: bigint;
  owner: Map<bigint, Address>;
  bid: { basePrice: bigint; maxPrice: bigint; lastReset: number; growthBpsPerDay: number; stepDownBps: number };
  sales: { price: bigint; time: number }[];
  pushFloor: { price: bigint; updatedAt: number };
  offers: Offer[];
  holdings: R.Holding[];
  bankroll: bigint;
  reserved: bigint;
  bets: Bet[];
  nextRequest: bigint;
  rounds: Round[];
  lotteryOwed: bigint;
  raffles: Raffle[];
  raffleOwed: bigint;
  markets: Market[];
  vaultRaffles: R.Raffle[];
  points: { active: bigint; pending: bigint; others: bigint };
  licenses: { vaultId: bigint; tier: number; end: number }[];
  activity: R.ActivityItem[];
  block: bigint;
  /** Players' wagers on the open bets (`Games.openWagers`). */
  openWagers: bigint;
  /** Shares in the games bankroll: all of them, and the visitor's. */
  totalShares: bigint;
  userShares: bigint;
  /** The visitor's requests that wait for open bets (`Games.pendingDepositOf` / `pendingRedeemOf`), with the bet number at request time. */
  pendingDeposit?: { amount: bigint; seq: number };
  pendingRedeem?: { shares: bigint; seq: number };
  /** `Games.placedCount`: bets placed so far. */
  placedCount: number;
  /** `Games.betsResumeAt`: no bet before this; betting pauses for ten minutes after any refund. */
  betsResumeAt: number;
  /** `VaultRaffle.nextDrawAt`: no draw before this, an hour after any draw ends. */
  nextDrawAt: number;
  /** `Vault.unlockFloorOf`: the floor seen when a holding unlocked on its own. */
  unlockFloor: Map<bigint, bigint>;
  houseEvents: HouseEvent[];
  /** When the bid curve restarted because money reached a budget that could not cover it, and the base it restarted from. */
  restarts: { time: number; base: bigint }[];
  vault: VaultSim;
};

const EDGE = 200n;
const MARKET_FEE = 200n;
const POT_FEE = 500n;
const MIN_POT = milli(0.05);
const MIN_BET = milli(0.001);
const PROJECT_SHARE = 1_000n;
const POINTS_PER_ETH = 2_500n;
const INITIAL_BID_BASE = milli(0.9);
/** `BuybackEngine.minBidBpsOf`: no buyback below this share of the current base (the contract's default, a tenth). */
const MIN_BID_BPS = 1_000n;
/** `BuybackEngine.minBidOf`: base * bps / 10000. It follows the base down and up. */
const minBid = () => (s.bid.basePrice * MIN_BID_BPS) / BPS;
/** How long before the demo starts its seeded bid curve began to climb, in simulated seconds. */
const BID_HEAD_START = (DAY * 4) / 5;
/** `Games.maxWagerBps`: one wager is at most this share of the free bankroll. */
const MAX_WAGER_BPS = 100n;
/** `Games.bankrollShareBps`: the share of each edge the bankroll keeps (half, the contracts' default); the rest goes to the Treasury. */
const BANKROLL_SHARE = 5_000n;
/** `PredictionMarket.deadBandBps`: a market is void unless the price moved at least this much. */
const DEAD_BAND = 200n;
const MAX_START_PRICE_AGE = 3_600;
/** `VaultRaffle.minPointsToDraw`: no draw while fewer points than this are activated. */
const MIN_POINTS_TO_DRAW = 100n * ETH;
/** `VaultRaffle.pointsPerPrizeWei`: a raffle also needs this many activated points per wei the Vault paid for its prize. */
const POINTS_PER_PRIZE_WEI = 10_000n;
const minPointsFor = (prizeValue: bigint) => (prizeValue * POINTS_PER_PRIZE_WEI > MIN_POINTS_TO_DRAW ? prizeValue * POINTS_PER_PRIZE_WEI : MIN_POINTS_TO_DRAW);
/** `Vault.playersShareBps`: one purchase in five is set aside for players (the contracts' default). */
const PLAYERS_SHARE = 2_000;
/** `VaultRaffle.vestingPeriod`: a won prize can be claimed this long after the draw. */
const VESTING_PERIOD = 30 * DAY;
/** `VaultRaffle.announcePeriod`: a new vault raffle can be drawn this long after it opens. */
const ANNOUNCE_PERIOD = 7 * DAY;
/**
 * The demo's keeper: anyone may take the daily floor sample, request the daily draw, unlock what it
 * picked and send players' holdings to the raffle (keeper/ does this on a chain). The simulated one
 * does each at this time of the simulated day, unless the visitor has done it first.
 */
const KEEPER_AT = 16 * 3_600;
/** The keeper leaves the visitor this long to unlock a picked holding, or release a players' holding, first. */
const KEEPER_GRACE = 8 * 3_600;
/** The simulated randomness provider answers the unlock draw this long after the request. */
const DRAW_ANSWER_DELAY = 600;
const TIERS: R.LicenseTier[] = [
  { tier: 0, price: 0n, duration: 30 * DAY },
  { tier: 1, price: milli(0.1), duration: 90 * DAY },
  { tier: 2, price: milli(0.5), duration: 365 * DAY },
];

let startedReal = Date.now();
const T0 = 1_800_000_000;
/** Simulated time, in seconds. */
export const demoNow = (): number => T0 + Math.floor(((Date.now() - startedReal) / 1000) * DEMO_SPEED);

// A small seeded generator (mulberry32). Deterministic per page load: this is a demo, not a draw.
let seed = 0x5f100d;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randomInt = (below: number) => Math.floor(random() * below);

let s: State;
const listeners = new Set<() => void>();
export const subscribeDemo = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());

function log(module: string, route: string, text: string, actor?: Address, time = demoNow()) {
  s.block += 1n;
  s.activity.unshift({ key: `${s.block}`, route, module, text, actor, blockNumber: s.block, time });
  s.activity = s.activity.slice(0, 40);
}
const wei = (v: bigint) => {
  const text = (Number(v / 10n ** 12n) / 1e6).toFixed(4).replace(/\.?0+$/, "");
  return `${text} ETH`;
};

/**
 * For tests: while on, the simulated randomness provider answers nothing, so bets stay open (and can
 * be refunded after `Games.REFUND_TIMEOUT`). The demo itself never turns it on.
 */
let withhold = false;
export function demoWithholdRandomness(on: boolean) {
  withhold = on;
}

export function resetDemo() {
  withhold = false;
  startedReal = Date.now();
  seed = 0x5f100d;
  const now = T0;
  s = {
    balance: 10n * ETH,
    budget: 5n * ETH,
    projectOwed: 0n,
    owner: new Map(),
    // the seed: the curve has been climbing from its base for most of a simulated day
    bid: { basePrice: INITIAL_BID_BASE, maxPrice: milli(1.5), lastReset: now - BID_HEAD_START, growthBpsPerDay: 1_000, stepDownBps: 1_500 },
    sales: [
      { price: milli(1.02), time: now - 3_000 },
      { price: milli(0.98), time: now - 2_000 },
      { price: milli(1), time: now - 1_000 },
    ],
    pushFloor: { price: ETH, updatedAt: now },
    offers: [],
    holdings: [],
    bankroll: 50n * ETH,
    reserved: 0n,
    bets: [],
    nextRequest: 1n,
    rounds: [],
    lotteryOwed: 0n,
    raffles: [],
    raffleOwed: 0n,
    markets: [],
    vaultRaffles: [],
    // other players' activated points: enough for the seeded open raffle's prize (0.55 ETH needs 5,500)
    points: { active: 0n, pending: 0n, others: 6_000n * ETH },
    licenses: [],
    activity: [],
    block: 100n,
    restarts: [],
    openWagers: 0n,
    totalShares: 0n,
    userShares: 0n,
    placedCount: 0,
    betsResumeAt: 0,
    nextDrawAt: 0,
    unlockFloor: new Map(),
    houseEvents: [],
    vault: {
      samples: [],
      sampleCount: 0,
      lastSampleSlot: 0,
      draw: { randomness: DEMO_DEPLOYMENT.vaultRandomness, requestedAt: 0, pending: false, requestId: 0n, seedRequestedAt: 0, seedArrivedAt: 0, seed: 0 },
      window: { start: 0, cap: 0, used: 0 },
      playersCredit: 0,
      unlockBps: new Map(),
      keeperUpTo: now,
      keeperUnlocked: 0,
    },
  };
  // the seed: the house was funded with 50 ETH by a simulated depositor, who holds every share
  s.bankroll = 0n;
  s.totalShares = previewDeposit(houseFunds(), 50n * ETH);
  s.bankroll = 50n * ETH;
  houseEvent({ kind: "deposit", amount: 50n * ETH, shares: s.totalShares });
  for (let id = 1n; id <= 6n; id++) s.owner.set(id, DEMO_USER);
  for (let id = 7n; id <= 12n; id++) s.owner.set(id, id % 2n ? NPC_A : NPC_B);
  for (const id of [20n, 21n, 24n, 25n, 26n, 27n, 28n, 29n]) s.owner.set(id, DEMO_DEPLOYMENT.vault);
  s.owner.set(22n, DEMO_DEPLOYMENT.ticketRaffle);
  s.owner.set(14n, DEMO_DEPLOYMENT.vaultRaffle);
  s.owner.set(23n, DEMO_DEPLOYMENT.vaultRaffle);

  s.offers.push(
    { id: 1n, offerer: NPC_A, collection: DEMO_COLLECTION, tokenId: 0n, price: ETH, remaining: 3, expiry: now + 7 * DAY, collectionWide: true, filled: 0 },
    { id: 2n, offerer: NPC_B, collection: DEMO_COLLECTION, tokenId: 3n, price: milli(1.2), remaining: 1, expiry: now + 5 * DAY, collectionWide: false, filled: 0 },
  );
  // The seeded vault, bought over the past year: holdings at every stage of the moving lock. Every
  // fifth purchase was set aside for players (#5 and #10), as the contracts do by default.
  const held = (id: bigint, tokenId: bigint, price: number, daysAgo: number, extra: Partial<R.Holding> = {}): R.Holding => {
    const acquiredAt = now - Math.round(daysAgo * DAY);
    const players = id % 5n === 0n;
    return { id, collection: DEMO_COLLECTION, tokenId, purchasePrice: milli(price), acquiredAt, lockedUntil: acquiredAt + (players ? VAULT.PLAYERS_LOCK : VAULT.MIN_LOCK), unlockedAt: 0, status: 1, canUnlock: false, players, picked: false, ...extra };
  };
  s.holdings.push(
    held(1n, 23n, 0.55, 400, { status: 4, unlockedAt: now - 20 * DAY }), // unlocked, then sent to vault raffle #2 by the owner
    held(2n, 25n, 0.62, 340), // old: a high chance, and the floor it needs is close to what was paid
    held(3n, 26n, 0.95, 210), // bought high: the median floor is still below what it needs
    held(4n, 20n, 0.8, 200, {
      // unlocked by governance and on auction
      status: 3, unlockedAt: now - 4 * DAY,
      auction: { startPrice: 16n * milli(1.04), endPrice: milli(1.04), startTime: now - 3 * DAY - DAY / 2, currentPrice: 0n, atReserve: false, ownerPriced: false },
    }),
    held(5n, 14n, 0.7, 170, { status: 4 }), // players' share: raffled (vault raffle #1)
    held(6n, 27n, 0.75, 150),
    held(7n, 21n, 0.86, 88), // joins the daily draw in two days
    held(8n, 28n, 0.88, 60),
    held(9n, 29n, 0.9, 40),
    held(10n, 24n, 0.92, 29.6), // players' share: its 30 days end soon
  );
  // A month of daily floor samples (the keeper takes one each afternoon), the market drifting up.
  for (let day = 29; day >= 1; day--) {
    const at = (Math.floor(now / DAY) - day) * DAY + KEEPER_AT;
    const price = milli(0.93 + 0.0015 * (29 - day) + (((day * 7) % 5) - 2) * 0.004);
    s.vault.samples.push({ price, takenAt: at });
    s.vault.sampleCount++;
    s.vault.lastSampleSlot = Math.floor(at / DAY) + 1;
  }
  // This morning's draw has already been answered; the next can be requested a day after it.
  const d = s.vault.draw;
  Object.assign(d, { requestedAt: now - 2 * 3_600, requestId: 1n, seedRequestedAt: now - 2 * 3_600, seedArrivedAt: now - 2 * 3_600 + DRAW_ANSWER_DELAY });
  // The simulated provider's words come from a fixed salt. Choose the one under which this morning's
  // draw picked only holding #2, so that a visit starts with something to unlock. Later draws fall
  // where they fall.
  for (drawSalt = 1; drawSalt < 100_000; drawSalt++) {
    d.seed = drawWord(d.requestId);
    const picked = s.holdings.filter((h) => h.status === 1 && !h.players && isPicked(h, now)).map((h) => h.id);
    if (picked.length === 1 && picked[0] === 2n) break;
  }
  s.rounds.push({
    id: 1n, collection: DEMO_COLLECTION, ticketPrice: milli(0.01), ticketsSold: 12, endTime: now + DAY, requestedAt: 0, feeBps: Number(POT_FEE), status: 1, winner: ZERO, minPot: MIN_POT,
    entries: [{ buyer: NPC_A, count: 7 }, { buyer: NPC_B, count: 5 }],
  });
  s.raffles.push({
    id: 1n, creator: NPC_A, collection: DEMO_COLLECTION, tokenId: 22n, ticketPrice: milli(0.05), minTickets: 5, maxTickets: 20, ticketsSold: 9, endTime: now + 2 * DAY, requestedAt: 0, status: 1, winner: ZERO,
    feeBps: POT_FEE, minPot: MIN_POT, nftReturned: false, entries: [{ buyer: NPC_B, count: 9 }],
  });
  s.markets.push({
    id: 1n, collection: DEMO_COLLECTION, startPrice: ETH, closeTime: now + DAY / 3, resolveTime: now + (10 * DAY) / 3, higherPool: milli(0.5), lowerPool: milli(0.3), outcome: 0, feeBps: 300n, deadBandBps: DEAD_BAND,
    stakes: new Map(),
  });
  s.vaultRaffles.push(
    // holding #5, set aside for players; won ten days ago and still vesting
    { id: 1n, collection: DEMO_COLLECTION, tokenId: 14n, drawAfter: now - 133 * DAY, requestedAt: now - 10 * DAY, status: 3, winner: NPC_B, claimableAt: now - 10 * DAY + VESTING_PERIOD, minPointsRequired: minPointsFor(milli(0.7)) },
    // holding #1, sent to a raffle by the owner
    { id: 2n, collection: DEMO_COLLECTION, tokenId: 23n, drawAfter: now + DAY / 4, requestedAt: 0, status: 1, winner: ZERO, claimableAt: 0, minPointsRequired: minPointsFor(milli(0.55)) },
  );
  log("Marketplace", "/trade/marketplace", "Collection offer: 3 × 1 ETH", NPC_A);
  log("Lottery", "/play/lottery", "Lottery round #1 opened at 0.01 ETH a ticket");
  log("Ticket raffle", "/play/ticket-raffles", "Raffle #1 opened for token #22 at 0.05 ETH a ticket", NPC_A);
}

// ---------------------------------------------------------------- helpers

function fail(message: string): never {
  throw new Error(message);
}
function pay(amount: bigint) {
  if (amount > s.balance) fail(`You only have ${wei(s.balance)} of play money left. Reset the demo to start over.`);
  s.balance -= amount;
}
/** `BuybackEngine.curvePrice`: where the curve stands, whatever the budget. */
function curvePrice(now = demoNow()): bigint {
  const b = s.bid;
  const price = b.basePrice + (b.basePrice * BigInt(b.growthBpsPerDay) * BigInt(Math.max(0, now - b.lastReset))) / (BPS * BigInt(DAY));
  return price > b.maxPrice ? b.maxPrice : price;
}
/** `BuybackEngine.currentBid`: the curve, limited by what the budget can pay. */
function currentBid(now = demoNow()): bigint {
  const curve = curvePrice(now);
  return curve < s.budget ? curve : s.budget;
}
/**
 * `Treasury._credit`: add to the budget and tell the engine. If the budget could not cover the curve
 * until now, the curve restarts from its base (`BuybackEngine.onBudgetIncrease`).
 */
/**
 * The base after a sale (`BuybackEngine.sell`): one step below the higher of the sale price and the
 * old base less three steps, and never below 1 wei.
 */
export function baseAfterSale(price: bigint, base: bigint, stepDownBps: number): bigint {
  const drop = 3n * BigInt(stepDownBps);
  let anchor = drop >= BPS ? 0n : (base * (BPS - drop)) / BPS;
  if (price > anchor) anchor = price;
  const next = (anchor * (BPS - BigInt(stepDownBps))) / BPS;
  return next === 0n ? 1n : next;
}
function credit(amount: bigint) {
  if (amount === 0n) return;
  const now = demoNow();
  if (s.budget < curvePrice(now)) {
    // The bid until now was the budget: restart from there if it is above the base, so that money
    // arriving never lowers the bid.
    if (s.budget > s.bid.basePrice) s.bid.basePrice = s.budget;
    s.bid.lastReset = now;
    s.restarts.push({ time: now, base: s.bid.basePrice });
    log("Floor bid", "/trade/floor-bid", "The bid curve restarted: money reached a budget that could not cover it");
  }
  s.budget += amount;
}
/** Points are 2,500 per ETH of fee that reached the buyback budget. */
function creditPoints(who: Address | undefined, feeToBudget: bigint) {
  const earned = feeToBudget * POINTS_PER_ETH;
  if (who === DEMO_USER) s.points.pending += earned;
  else if (who) s.points.others += earned;
}
/**
 * A protocol fee (`Treasury.depositFee`): the project's share is set aside and the rest becomes
 * buyback budget, which is returned. With `earner`, that account gets the points for all of it.
 */
function fee(amount: bigint, earner?: Address): bigint {
  const toProject = (amount * PROJECT_SHARE) / BPS;
  s.projectOwed += toProject;
  credit(amount - toProject);
  creditPoints(earner, amount - toProject);
  return amount - toProject;
}
function salesFloor(): bigint {
  const prices = s.sales.slice(-7).map((x) => x.price).sort((a, b) => (a < b ? -1 : 1));
  return prices[Math.floor((prices.length - 1) / 2)];
}
function auctionPrice(a: NonNullable<R.Holding["auction"]>, now = demoNow()): bigint {
  const elapsed = Math.max(0, now - a.startTime);
  let price = a.startPrice >> BigInt(Math.min(127, Math.floor(elapsed / DAY)));
  price -= ((price / 2n) * BigInt(elapsed % DAY)) / BigInt(DAY);
  return price > a.endPrice ? price : a.endPrice;
}
/** `Vault._checkAuctionable`: the end of the half-life in which the price reaches the reserve, plus a day's rest there. */
function restartableAt(a: { startPrice: bigint; endPrice: bigint; startTime: number }): number {
  let price = a.startPrice;
  let halvings = 0;
  while (price > a.endPrice && halvings < 128) {
    price >>= 1n;
    halvings++;
  }
  return a.startTime + halvings * DAY + DAY;
}
// ---------------------------------------------------------------- the vault's moving lock

const dayOf = (t: number) => Math.floor(t / DAY);
/** A 32-bit integer hash (murmur3's finaliser over two inputs). */
function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x6d2b79f5) | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
let drawSalt = 1;
/** The simulated provider's random word for an unlock-draw request. */
const drawWord = (requestId: bigint) => mix(Number(requestId), drawSalt);
/** `Vault.medianFloorAt`: the lower median of the samples of the 30 days up to `asOf`, with at least 15 of them. */
function medianFloor(asOf = demoNow()): bigint | undefined {
  const prices = s.vault.samples.filter((x) => x.takenAt <= asOf && x.takenAt + VAULT.FLOOR_SAMPLES * DAY > asOf).map((x) => x.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return prices.length < VAULT.MIN_FLOOR_SAMPLES ? undefined : prices[Math.floor((prices.length - 1) / 2)];
}
/** `Vault.drawMedianFloor`: the median as it stood when the current draw was requested. */
const drawMedianFloor = () => (s.vault.draw.seedRequestedAt === 0 ? undefined : medianFloor(s.vault.draw.seedRequestedAt));
/** `Vault.heldCount`: holdings still in the vault. */
const heldCount = () => s.holdings.filter((h) => h.status !== 4).length;
/** `Vault.releaseAllowance`. */
function releaseAllowance(now = demoNow()): number {
  const w = s.vault.window;
  if (w.start === 0 || now >= w.start + VAULT.RELEASE_PERIOD) return releaseCap(heldCount());
  return Math.max(0, w.cap - w.used);
}
/** `Vault.isPicked`: only holdings whose lock had ended when the draw was requested take part. */
function isPicked(h: R.Holding, now = demoNow()): boolean {
  const d = s.vault.draw;
  if (h.status !== 1 || h.players) return false;
  if (d.seedArrivedAt === 0 || now >= d.seedArrivedAt + VAULT.SEED_LIFETIME) return false;
  if (h.lockedUntil > d.seedRequestedAt || h.acquiredAt > d.seedRequestedAt) return false;
  return mix(d.seed, Number(h.id)) % 10_000 < drawChanceBps(d.seedRequestedAt - h.acquiredAt);
}
/** `Vault.canUnlock`: picked, the median floor at the multiple the holding's age requires, and room under the cap. */
function canUnlock(h: R.Holding, now = demoNow()): boolean {
  if (!isPicked(h, now)) return false;
  const median = drawMedianFloor();
  if (median === undefined || median < requiredFloor(h.purchasePrice, s.vault.draw.seedRequestedAt - h.acquiredAt)) return false;
  return releaseAllowance(now) !== 0;
}
function sampleFloor(now: number) {
  const v = s.vault;
  if (v.lastSampleSlot >= dayOf(now) + 1) fail("Today's floor sample for this collection has already been taken.");
  v.lastSampleSlot = dayOf(now) + 1;
  v.samples.push({ price: salesFloor(), takenAt: now });
  if (v.samples.length > 2 * VAULT.FLOOR_SAMPLES) v.samples.shift();
  v.sampleCount++;
}
function requestDraw(now: number) {
  const d = s.vault.draw;
  if (d.pending && now < d.requestedAt + VAULT.ROUND_TIMEOUT) fail("Today's draw has been requested and is waiting for its random number.");
  if (d.requestedAt !== 0 && now < d.requestedAt + VAULT.ROUND_INTERVAL) fail(`Too early: possible from ${dateTime(d.requestedAt + VAULT.ROUND_INTERVAL)}.`);
  // one word at a time: a new request retires the last result
  Object.assign(d, { pending: true, requestedAt: now, requestId: d.requestId + 1n, seedArrivedAt: 0 });
}
function answerDraw(now: number) {
  const d = s.vault.draw;
  Object.assign(d, { pending: false, seed: drawWord(d.requestId), seedRequestedAt: d.requestedAt, seedArrivedAt: now });
  const picked = s.holdings.filter((h) => isPicked(h, now)).map((h) => `#${h.id}`);
  log("Vault", "/vault/holdings", picked.length ? `Today's unlock draw picked holding ${picked.join(", ")}` : "Today's unlock draw picked no holding", undefined, now);
}
function unlockHolding(h: R.Holding, now: number, by?: Address) {
  if (!h || h.status !== 1 || !canUnlock(h, now)) {
    fail("Unlock conditions are not met: today's draw must have picked this holding, the 30-day median floor must reach the multiple its age requires, and the collection's weekly release cap must have room.");
  }
  const w = s.vault.window;
  if (w.start === 0 || now >= w.start + VAULT.RELEASE_PERIOD) Object.assign(w, { start: now, cap: releaseCap(heldCount()), used: 0 });
  w.used++;
  const bps = requiredFloorBps(s.vault.draw.seedRequestedAt - h.acquiredAt);
  s.vault.unlockBps.set(h.id, bps);
  // `Vault.unlock` remembers the median floor as of the draw, capped at 16 times the unlock price
  const median = drawMedianFloor()!;
  const cap = ((h.purchasePrice * BigInt(bps)) / BPS) * 16n;
  s.unlockFloor.set(h.id, median > cap ? cap : median);
  h.status = 2;
  h.unlockedAt = now;
  log("Vault", "/vault/holdings", `Vault holding #${h.id} unlocked`, by, now);
}
function releaseToPlayers(h: R.Holding | undefined, now: number, by?: Address) {
  if (!h?.players) fail("This holding is not set aside for players.");
  if (h.status !== 1) fail(`Not possible in the item's current state (status code ${h.status}).`);
  if (now < h.lockedUntil) fail(`Too early: possible from ${dateTime(h.lockedUntil)}.`);
  h.status = 4;
  s.owner.set(h.tokenId, DEMO_DEPLOYMENT.vaultRaffle);
  const id = BigInt(s.vaultRaffles.length + 1);
  s.vaultRaffles.push({ id, collection: h.collection, tokenId: h.tokenId, drawAfter: now + ANNOUNCE_PERIOD, requestedAt: 0, status: 1, winner: ZERO, claimableAt: 0, minPointsRequired: minPointsFor(h.purchasePrice) });
  log("Vault", "/vault/raffles", `Holding #${h.id} sent to the players' raffle (vault raffle #${id})`, by, now);
}
/**
 * The demo's keeper catches up to `now`, in time order: the draw's answer arrives, the day's floor
 * sample is taken, picked holdings are unlocked and due players' holdings sent to the raffle (each a
 * few hours late, leaving the visitor time to do it), and the next draw is requested. Whatever the
 * visitor already did is skipped.
 */
function keeper(now = demoNow()) {
  const v = s.vault;
  for (let guard = 0; guard < 10_000; guard++) {
    const from = v.keeperUpTo;
    const steps: [number, () => void][] = [];
    if (v.draw.pending) {
      const at = v.draw.requestedAt + DRAW_ANSWER_DELAY;
      steps.push([at, () => answerDraw(at)]);
    }
    let day = Math.max(v.lastSampleSlot, dayOf(from));
    if (day * DAY + KEEPER_AT < from) day++;
    const sampleAt = day * DAY + KEEPER_AT;
    steps.push([sampleAt, () => sampleFloor(sampleAt)]);
    const seed = v.draw.seedArrivedAt;
    if (seed !== 0 && v.keeperUnlocked !== seed) {
      const at = Math.max(seed + KEEPER_GRACE, from);
      steps.push([
        at,
        () => {
          v.keeperUnlocked = seed;
          for (const h of s.holdings) if (canUnlock(h, at)) unlockHolding(h, at);
        },
      ]);
    }
    for (const h of s.holdings) {
      if (!h.players || h.status !== 1) continue;
      const at = Math.max(h.lockedUntil + KEEPER_GRACE, from);
      steps.push([at, () => releaseToPlayers(h, at)]);
    }
    if (!v.draw.pending) {
      const readyAt = v.draw.requestedAt + VAULT.ROUND_INTERVAL;
      const at = Math.max(readyAt, dayOf(readyAt) * DAY + KEEPER_AT, from);
      steps.push([at, () => requestDraw(at)]);
    }
    const [at, step] = steps.sort((a, b) => a[0] - b[0])[0];
    if (at > now) break;
    step();
    v.keeperUpTo = Math.max(from, at);
  }
  v.keeperUpTo = Math.max(v.keeperUpTo, now);
}

const ticketsOf = (entries: Entry[], who: Address) => entries.filter((e) => e.buyer === who).reduce((n, e) => n + e.count, 0);
function holderOf(entries: Entry[], ticket: number): Address {
  let upTo = 0;
  for (const e of entries) {
    upTo += e.count;
    if (ticket < upTo) return e.buyer;
  }
  return ZERO;
}
const fakeHash = (n: bigint, salt: number): Hash => `0x${"de30".repeat(2)}${salt.toString(16).padStart(8, "0")}${n.toString(16).padStart(48, "0")}` as Hash;
/** Something the simulated randomness provider will do a moment from now. */
function later(ms: number, fn: () => void) {
  setTimeout(() => {
    fn();
    changed();
  }, ms);
}

// ---------------------------------------------------------------- reads

function houseFunds() {
  return { bankroll: s.bankroll, reserved: s.reserved, openWagers: s.openWagers, totalShares: s.totalShares };
}
type NewHouseEvent = HouseEvent extends infer E ? (E extends unknown ? Omit<E, "order" | "time"> : never) : never;
function houseEvent(event: NewHouseEvent) {
  s.houseEvents.push({ ...event, order: s.houseEvents.length, time: demoNow() } as HouseEvent);
}
/** `Games.isClosedThrough`: every bet numbered below `seq` has been settled. */
const closedThrough = (seq: number) => !s.bets.some((bet) => bet.status === "pending" && bet.seq < seq);
const stillOpenBefore = (seq: number) => s.bets.filter((bet) => bet.status === "pending" && bet.seq < seq).length;
const SLIPPAGE = "Carrying this out right now would give up more against fair value than the limit you set, because bets are open. Nothing was done; wait for a quieter moment.";
/** `Games.REFUND_TIMEOUT`: an unanswered bet can be refunded after this long. */
const REFUND_TIMEOUT = 6 * 3_600;
/** `Games.MAX_OPEN_WAGERS_BPS`: all wagers in play may be at most this share of the house's funds. */
const MAX_OPEN_WAGERS_BPS = 2_000n;
/** `Games.REFUND_PAUSE`: after any refund no bet is accepted for this long. */
const REFUND_PAUSE = 600;
const STILL_OPEN = "Not yet: a bet that was open when you made the request has not finished (or you hold every share and bets are open).";
const checkSpread = (maxSpreadBps: bigint) => {
  if (maxSpreadBps > BPS) fail("Invalid parameters.");
};
/**
 * `Games._executeDeposit`: turn the visitor's pending deposit into shares, priced as if the house
 * wins every bet open right now, if every bet that was open when it was requested has closed and
 * that gives up no more than `maxSpreadBps` against fair value. `strict` is `executeDeposit`: it
 * refuses where `deposit` just leaves the request pending.
 */
function executeDeposit(maxSpreadBps: bigint, strict: boolean): bigint {
  checkSpread(maxSpreadBps);
  const pending = s.pendingDeposit;
  if (!pending) return strict ? fail("You have no pending request of that kind.") : 0n;
  if (!closedThrough(pending.seq)) return strict ? fail(STILL_OPEN) : 0n;
  if (!depositWithinSpread(houseFunds(), pending.amount, maxSpreadBps)) return strict ? fail(SLIPPAGE) : 0n;
  const shares = previewDeposit(houseFunds(), pending.amount);
  s.totalShares += shares;
  s.userShares += shares;
  s.bankroll += pending.amount;
  houseEvent({ kind: "deposit", amount: pending.amount, shares });
  s.pendingDeposit = undefined;
  log("Games", "/play/house", `Deposit of ${wei(pending.amount)} into the house carried out`, DEMO_USER);
  return shares;
}
/**
 * `Games._executeRedeem`: redeem the visitor's pending shares for their part of the free bankroll
 * right now (as if the house loses every open bet), in full or not at all, if that gives up no
 * more than `maxSpreadBps` against their fair value.
 */
function executeRedeem(maxSpreadBps: bigint, strict: boolean): bigint {
  checkSpread(maxSpreadBps);
  const pending = s.pendingRedeem;
  if (!pending) return strict ? fail("You have no pending request of that kind.") : 0n;
  if (!closedThrough(pending.seq)) return strict ? fail(STILL_OPEN) : 0n;
  const shares = pending.shares > s.userShares ? s.userShares : pending.shares;
  if (lastHolderBlocked(houseFunds(), shares)) return strict ? fail(STILL_OPEN) : 0n;
  if (!redeemWithinSpread(houseFunds(), shares, maxSpreadBps)) return strict ? fail(SLIPPAGE) : 0n;
  const assets = previewRedeem(houseFunds(), shares);
  s.pendingRedeem = undefined;
  s.userShares -= shares;
  s.totalShares -= shares;
  s.bankroll -= assets;
  s.balance += assets;
  houseEvent({ kind: "redeem", amount: assets, shares });
  log("Games", "/play/house", `Redeemed house shares for ${wei(assets)}`, DEMO_USER);
  // (the contract's return value is the ETH paid; a redemption worth nothing still burns its shares)
  return assets === 0n ? 1n : assets;
}
const requestView = (amount: bigint, seq: number): HouseRequest => ({ amount, ready: closedThrough(seq), waitingFor: stillOpenBefore(seq) });

function floorBid(): R.FloorBid {
  const bid = currentBid();
  return { budget: s.budget, currentBid: bid, curvePrice: curvePrice(), minBid: minBid(), isFillable: bid !== 0n && bid >= minBid(), active: true, ...s.bid, fillCooldown: 0, nextFillAt: 0 };
}
function holdingsNow(): R.Holding[] {
  keeper();
  return [...s.holdings]
    .reverse()
    .map((h) => ({ ...h, picked: isPicked(h), canUnlock: canUnlock(h) }))
    .map((h) => (h.auction ? { ...h, auction: { ...h.auction, currentPrice: auctionPrice(h.auction), atReserve: auctionPrice(h.auction) <= h.auction.endPrice } } : h));
}
function roundView(r: Round): R.LotteryRound {
  const { pot, rest } = splitPot(r.ticketPrice, r.ticketsSold, BigInt(r.feeBps));
  const mine = r.status === 4 && !r.entries.some((e) => e.buyer === DEMO_USER) ? 0 : ticketsOf(r.entries, DEMO_USER);
  return { ...r, pot, prize: rest, userTickets: mine, userPaid: r.ticketPrice * BigInt(mine) };
}
function raffleView(r: Raffle): R.TicketRaffle {
  const mine = ticketsOf(r.entries, DEMO_USER);
  return { ...r, userTickets: mine, userPaid: r.ticketPrice * BigInt(mine) };
}

export const demoReads = {
  chainTime: () => demoNow(),
  balance: () => s.balance,
  floorBid,
  overview(): R.Overview {
    const now = demoNow();
    return {
      floorBid: floorBid(),
      salesFloor: { ok: true, price: salesFloor(), updatedAt: s.sales[s.sales.length - 1].time },
      pushFloor: { ok: true, ...s.pushFloor, updatedAt: Math.min(now, s.pushFloor.updatedAt) },
      holdingCount: BigInt(s.holdings.length),
      collectionHoldingsInVault: s.holdings.filter((h) => h.status !== 4).length,
      holdingsTruncated: false,
      marketplaceSupported: true,
      projectShare: { recipient: PROJECT, bps: Number(PROJECT_SHARE) },
      userProjectShareOwed: 0n,
      totalPoints: s.points.active + s.points.others,
      pointsFrozen: false,
      userPoints: s.points.active,
      userPendingPoints: s.points.pending,
    };
  },
  openOffers: (): R.OpenOffers => ({ offers: [...s.offers].filter((o) => o.remaining > 0).reverse(), source: "logs", feeBps: MARKET_FEE }),
  tokenState(tokenId: bigint): R.TokenState {
    const owner = s.owner.get(tokenId);
    if (!owner) fail(`Token #${tokenId} does not exist in the demo collection. You own tokens ${[...s.owner].filter(([, o]) => o === DEMO_USER).map(([id]) => `#${id}`).join(", ") || "none"}.`);
    return { owner, approved: true };
  },
  expectedProceeds(price: bigint): R.Proceeds {
    const f = (price * MARKET_FEE) / BPS;
    return { fee: f, royalty: 0n, proceeds: price - f };
  },
  markets(): R.Markets {
    return {
      markets: [...s.markets].reverse().map(({ stakes, ...m }) => ({ ...m, stake: stakes.get(DEMO_USER) ?? { higher: 0n, lower: 0n } })),
      marketCount: BigInt(s.markets.length),
      feeBps: 300n,
      minBet: MIN_BET,
      minBettingPeriod: 600,
      maxDuration: 30 * DAY,
      deadBandBps: DEAD_BAND,
      maxStartPriceAge: MAX_START_PRICE_AGE,
    };
  },
  holdings(): R.VaultState {
    const holdings = holdingsNow();
    const v = s.vault;
    const { seed: _seed, ...draw } = v.draw;
    return {
      holdings, holdingCount: BigInt(s.holdings.length), owner: DEMO_DEPLOYMENT.owner, governanceWindow: 30 * DAY, auctionStartMultiple: 16, auctionHalfLife: DAY, auctionRestartDwell: DAY,
      draw,
      collections: { [DEMO_COLLECTION.toLowerCase()]: { median: medianFloor(), drawMedian: drawMedianFloor(), samples: v.sampleCount, lastSampleSlot: v.lastSampleSlot, allowance: releaseAllowance(), held: heldCount(), window: { ...v.window } } },
      playersShareBps: PLAYERS_SHARE,
    };
  },
  raffles(): R.Raffles {
    keeper();
    return { raffles: [...s.vaultRaffles].reverse(), raffleCount: BigInt(s.vaultRaffles.length), totalPoints: s.points.active + s.points.others, nextDrawAt: s.nextDrawAt, drawInFlight: s.vaultRaffles.some((r) => r.status === 2), minPointsToDraw: MIN_POINTS_TO_DRAW, vestingPeriod: VESTING_PERIOD, pointsPerPrizeWei: POINTS_PER_PRIZE_WEI };
  },
  games: (): R.GamesState => ({ bankroll: s.bankroll, reserved: s.reserved, openWagers: s.openWagers, maxOpenWagersBps: MAX_OPEN_WAGERS_BPS, betsResumeAt: s.betsResumeAt, maxTotalExposureBps: 2_000n, edgeBps: EDGE, minBet: MIN_BET, maxExposureBps: 100n, maxWagerBps: MAX_WAGER_BPS, maxWager: (s.bankroll * MAX_WAGER_BPS) / BPS, bankrollShareBps: BANKROLL_SHARE, supported: true, refundTimeout: REFUND_TIMEOUT, userOwed: 0n }),
  gameQuote: (wager: bigint, chanceBps: number): R.GameQuote => diceQuote(wager, chanceBps, EDGE),
  userBets: (): R.GameBet[] => [...s.bets].reverse().map(({ player: _p, edgeBps: _e, placedAt: _t, kept: _k, seq: _s, ...bet }) => bet),
  ticketRaffles: (): R.TicketRaffles => ({
    raffles: [...s.raffles].reverse().map(raffleView), raffleCount: BigInt(s.raffles.length), minPot: MIN_POT, feeBps: POT_FEE,
    minDuration: 3_600, maxDuration: 30 * DAY, drawTimeout: DAY, abortDelay: 7 * DAY, collectionSupported: true, userOwed: s.raffleOwed,
  }),
  licensing(): R.Licensing {
    const now = demoNow();
    return {
      holdings: holdingsNow().filter((h) => h.status === 1 || h.status === 2).map((holding) => ({
        holding, tiers: TIERS, banned: false,
        licenses: s.licenses.filter((l) => l.vaultId === holding.id && l.end > now).map(({ tier, end }) => ({ tier, end })).sort((a, b) => a.tier - b.tier),
      })),
      maxScopeLength: 280,
    };
  },
  lottery(): R.LotteryState {
    const all = [...s.rounds].reverse().map(roundView);
    return { config: { ticketPrice: milli(0.01), duration: DAY, active: true }, current: all[0], past: all.slice(1), minPot: MIN_POT, feeBps: POT_FEE, drawTimeout: DAY, abortDelay: 7 * DAY, userOwed: s.lotteryOwed };
  },
  house: (): HouseState => ({
    ...houseFunds(), bankrollShareBps: BANKROLL_SHARE, edgeBps: EDGE, maxExposureBps: 100n, maxTotalExposureBps: 2_000n,
    totalPendingDeposits: s.pendingDeposit?.amount ?? 0n, openBets: s.bets.filter((bet) => bet.status === "pending").length, userShares: s.userShares,
    pendingDeposit: s.pendingDeposit && requestView(s.pendingDeposit.amount, s.pendingDeposit.seq),
    pendingRedeem: s.pendingRedeem && requestView(s.pendingRedeem.shares, s.pendingRedeem.seq),
  }),
  houseEvents: (): HouseEvent[] => [...s.houseEvents],
  points: (): R.PointsBalance => ({ active: s.points.active, pending: s.points.pending }),
  activity: (): R.ActivityItem[] => s.activity.slice(0, 12),
  fairness: (): R.FairnessStatus => ({
    sources: (["Games", "Lottery", "Ticket raffles", "Vault raffles", "Vault unlock draw"] as const).map((module) => ({ module, provider: DEMO_DEPLOYMENT.randomness, kind: "mock" as const, isMock: true })),
    anyMock: true, anyUnknown: false, gamesOwner: DEMO_DEPLOYMENT.owner, ownerIsContract: false,
    games: { edgeBps: EDGE, minBet: MIN_BET, maxExposureBps: 100n, maxTotalExposureBps: 2_000n, refundTimeout: REFUND_TIMEOUT, maxWagerBps: MAX_WAGER_BPS, bankrollShareBps: BANKROLL_SHARE },
    lottery: { feeBps: POT_FEE, minPot: MIN_POT }, ticketRaffle: { feeBps: POT_FEE, minPot: MIN_POT },
  }),
  betProof(requestId: bigint): R.BetProof | undefined {
    const bet = s.bets.find((b) => b.requestId === requestId);
    if (!bet || bet.roll === undefined) return undefined;
    return { requestId, wager: bet.wager, chanceBps: bet.chanceBps, edgeBps: bet.edgeBps, edgeSource: "stored", roll: bet.roll, paidPayout: bet.payout ?? 0n, paidFee: bet.fee ?? 0n, feeKeptByBankroll: bet.kept, feeToTreasury: bet.kept === undefined ? undefined : (bet.fee ?? 0n) - bet.kept, placedTx: fakeHash(requestId, 1), settledTx: fakeHash(requestId, 2) };
  },
  drawProof(kind: "lottery" | "ticketRaffle", id: bigint): R.DrawProof | undefined {
    const item = kind === "lottery" ? s.rounds.find((r) => r.id === id) : s.raffles.find((r) => r.id === id);
    if (!item || item.ticket === undefined) return undefined;
    return { ticketsSold: item.ticketsSold, ticket: item.ticket, winner: item.winner, ticketHolder: holderOf(item.entries, Number(item.ticket)), drawTx: fakeHash(id, kind === "lottery" ? 3 : 4) };
  },
  auctionPrice(vaultId: bigint): bigint {
    const h = s.holdings.find((x) => x.id === vaultId);
    if (!h?.auction) fail("This holding is not in an auction.");
    return auctionPrice(h.auction);
  },
};

// ---------------------------------------------------------------- writes

function settleBet(bet: Bet) {
  const roll = randomInt(10_000);
  const r = recomputeBet({ wager: bet.wager, edgeBps: bet.edgeBps, chanceBps: bet.chanceBps, roll });
  const exposure = bet.kind === "slots" ? slotsExposure(bet.wager, bet.edgeBps) : gameExposure(bet.wager, bet.chanceBps, bet.edgeBps);
  s.reserved -= exposure;
  s.openWagers -= bet.wager;
  s.bankroll += r.stake + exposure - r.payout;
  houseEvent({ kind: "bet", gain: houseGain(bet.wager, r.payout, r.fee, BANKROLL_SHARE) });
  s.balance += r.payout;
  // the bankroll's share of the edge, if any, stays in the bankroll; the rest goes to the Treasury
  const kept = (r.fee * BANKROLL_SHARE) / BPS;
  bet.kept = kept;
  s.bankroll += kept;
  fee(r.fee - kept, DEMO_USER);
  Object.assign(bet, { status: r.payout > 0n ? "won" : "lost", roll, payout: r.payout, fee: r.fee, refundableAt: undefined });
}
function placeBet(kind: Bet["kind"], wager: bigint, chanceBps: number) {
  if (wager < MIN_BET) fail(`The minimum bet is ${wei(MIN_BET)}.`);
  if (kind === "dice" && (chanceBps < 100 || chanceBps > 9_500)) fail("The chance of winning must be between 1% and 95%.");
  if (demoNow() < s.betsResumeAt) fail(`Betting is paused for a few minutes after a refund; it resumes in ${s.betsResumeAt - demoNow()} seconds.`);
  const maxWager = (s.bankroll * MAX_WAGER_BPS) / BPS;
  if (wager > maxWager) fail(`The largest wager is ${wei(maxWager)} right now (${Number(MAX_WAGER_BPS) / 100}% of the bankroll); ${wei(wager)} is above it.`);
  const exposure = kind === "slots" ? slotsExposure(wager, EDGE) : gameExposure(wager, chanceBps, EDGE);
  const limit = (s.bankroll * 100n) / BPS;
  if (exposure > limit) fail(`This bet would put ${wei(exposure)} of the bankroll at risk; the limit per bet is ${wei(limit)}. Lower the wager or raise the chance.`);
  // `Games.MAX_TOTAL_EXPOSURE_BPS`: all open bets together may reserve at most 20% of the house's funds
  const totalLimit = ((s.bankroll + s.reserved) * 2_000n) / BPS;
  if (s.reserved + exposure > totalLimit) fail(`Too many open bets: this one would bring the house's total at risk to ${wei(s.reserved + exposure)}; the limit is ${wei(totalLimit)}. Lower the wager or wait for open bets to settle.`);
  // `Games.MAX_OPEN_WAGERS_BPS`: all wagers in play together may be at most 20% of the house's funds
  const wagerLimit = ((s.bankroll + s.reserved) * MAX_OPEN_WAGERS_BPS) / BPS;
  if (s.openWagers + wager > wagerLimit) fail(`Too much is in play already: this wager would bring the open wagers to ${wei(s.openWagers + wager)}; the limit is ${wei(wagerLimit)}. Lower the wager or wait for open bets to settle.`);
  pay(wager);
  s.bankroll -= exposure;
  s.reserved += exposure;
  s.openWagers += wager;
  const bet: Bet = { seq: s.placedCount++, requestId: s.nextRequest++, collection: DEMO_COLLECTION, wager, kind, chanceBps, status: "pending", refundableAt: demoNow() + REFUND_TIMEOUT, player: DEMO_USER, edgeBps: EDGE, placedAt: demoNow() };
  s.bets.push(bet);
  log("Games", kind === "slots" ? "/play/slots" : "/play/dice", kind === "slots" ? `Slots spin of ${wei(wager)}` : `Dice bet of ${wei(wager)} at ${chanceBps / 100}%`, DEMO_USER);
  later(kind === "slots" ? 1_700 : 1_300, () => {
    if (!withhold && bet.status === "pending") settleBet(bet);
  });
}
function draw(item: Round | Raffle, onWon: (winner: Address) => void) {
  item.status = 2;
  item.requestedAt = demoNow();
  later(2_600, () => {
    const ticket = randomInt(item.ticketsSold);
    item.ticket = BigInt(ticket);
    item.winner = holderOf(item.entries, ticket);
    item.status = 3;
    onWon(item.winner);
  });
}

type Handler = (args: readonly unknown[], value: bigint) => void;
const handlers: Record<string, Handler> = {
  // ERC-721 approvals are not needed in the demo, but the UI may still send one.
  approve: () => undefined,

  makeOffer([, tokenId, expiry], value) {
    if (value === 0n) fail("The price must be greater than zero.");
    pay(value);
    s.offers.push({ id: BigInt(s.offers.length + 1), offerer: DEMO_USER, collection: DEMO_COLLECTION, tokenId: tokenId as bigint, price: value, remaining: 1, expiry: Number(expiry), collectionWide: false, filled: 0 });
    log("Marketplace", "/trade/marketplace", `Offer of ${wei(value)} for token #${tokenId}`, DEMO_USER);
  },
  makeCollectionOffer([, quantity, expiry], value) {
    const q = Number(quantity);
    if (q < 1 || value === 0n) fail("Enter a price and a quantity of at least 1.");
    pay(value);
    s.offers.push({ id: BigInt(s.offers.length + 1), offerer: DEMO_USER, collection: DEMO_COLLECTION, tokenId: 0n, price: value / BigInt(q), remaining: q, expiry: Number(expiry), collectionWide: true, filled: 0 });
    log("Marketplace", "/trade/marketplace", `Collection offer: ${q} × ${wei(value / BigInt(q))}`, DEMO_USER);
  },
  cancelOffer([id]) {
    const offer = s.offers.find((o) => o.id === id);
    if (!offer || offer.remaining === 0) fail("This offer is no longer open (filled or cancelled).");
    if (offer.offerer !== DEMO_USER) fail("Only the account that made the offer can cancel it.");
    s.balance += offer.price * BigInt(offer.remaining);
    offer.remaining = 0;
  },
  acceptOffer([id, tokenId]) {
    const offer = s.offers.find((o) => o.id === id);
    if (!offer || offer.remaining === 0) fail("This offer is no longer open (filled or cancelled).");
    if (demoNow() > offer.expiry) fail("This offer has expired.");
    if (!offer.collectionWide && tokenId !== offer.tokenId) fail("This offer is for a different token id.");
    if (s.owner.get(tokenId as bigint) !== DEMO_USER) fail(`You do not own token #${tokenId}.`);
    const f = (offer.price * MARKET_FEE) / BPS;
    s.owner.set(tokenId as bigint, offer.offerer);
    offer.remaining -= 1;
    offer.filled += 1;
    s.balance += offer.price - f;
    // each fee is credited once: half of what reached the budget to the seller, the rest to the buyer
    const toBudget = fee(f);
    creditPoints(DEMO_USER, toBudget / 2n);
    creditPoints(offer.offerer, toBudget - toBudget / 2n);
    if (offer.collectionWide) s.sales.push({ price: offer.price, time: demoNow() });
    log("Marketplace", "/trade/marketplace", `Token #${tokenId} sold for ${wei(offer.price)} (${wei(f)} fee)`, DEMO_USER);
  },

  sell([, tokenId, minPrice]) {
    const id = tokenId as bigint;
    if (s.owner.get(id) !== DEMO_USER) fail(`You do not own token #${id}.`);
    const price = currentBid();
    // a bid below the collection's minimum is not a bid: it would buy a token for dust
    if (price === 0n || price < minBid()) fail(price === 0n ? "There is nothing to bid with: the collection's buyback budget is empty." : `There is nothing to bid with: the budget can pay ${wei(price)}, below the collection's minimum bid of ${wei(minBid())}.`);
    if (price < (minPrice as bigint)) fail(`The floor bid is now ${wei(price)}, below your minimum of ${wei(minPrice as bigint)}.`);
    const now = demoNow();
    s.budget -= price;
    s.balance += price;
    // A sale limited by a thin budget may be far below the base: it pulls the base down by at most
    // three steps, so the base follows a falling market without one cheap sale collapsing the curve.
    s.bid.basePrice = baseAfterSale(price, s.bid.basePrice, s.bid.stepDownBps);
    s.bid.lastReset = now;
    s.owner.set(id, DEMO_DEPLOYMENT.vault);
    s.sales.push({ price, time: now });
    const vaultId = BigInt(s.holdings.length + 1);
    // `Vault.deposit`: a running remainder sets aside exactly one purchase in five for players
    const credit = s.vault.playersCredit + PLAYERS_SHARE;
    const players = credit >= Number(BPS);
    s.vault.playersCredit = players ? credit - Number(BPS) : credit;
    s.holdings.push({ id: vaultId, collection: DEMO_COLLECTION, tokenId: id, purchasePrice: price, acquiredAt: now, lockedUntil: now + (players ? VAULT.PLAYERS_LOCK : VAULT.MIN_LOCK), unlockedAt: 0, status: 1, canUnlock: false, players, picked: false });
    log("Floor bid", "/vault/holdings", `Bought token #${id} for ${wei(price)}, now vault holding #${vaultId}${players ? ", set aside for players" : ""}`, DEMO_USER);
  },

  unlock([vaultId]) {
    unlockHolding(s.holdings.find((x) => x.id === vaultId)!, demoNow(), DEMO_USER);
  },
  sampleFloor() {
    sampleFloor(demoNow());
    log("Vault", "/vault/holdings", `Today's floor sample taken: ${wei(salesFloor())}`, DEMO_USER);
  },
  requestUnlockRound() {
    requestDraw(demoNow());
    log("Vault", "/vault/holdings", "Today's unlock draw requested", DEMO_USER);
  },
  releaseToPlayers([vaultId]) {
    releaseToPlayers(s.holdings.find((x) => x.id === vaultId), demoNow(), DEMO_USER);
  },
  startAuction([vaultId]) {
    const h = s.holdings.find((x) => x.id === vaultId);
    const now = demoNow();
    // `Vault.startAuction`: the owner at once, anyone 30 days after unlocking; and anyone can restart
    // an oracle-priced auction whose price has reached its reserve without a buyer.
    // an oracle-priced auction that has rested at its reserve for a day without a buyer.
    const restart = !!h && h.status === 3 && !!h.auction && !h.auction.ownerPriced && now >= restartableAt(h.auction);
    if (!h || !(restart || (h.status === 2 && now >= h.unlockedAt + 30 * DAY))) {
      fail(h?.status === 3 ? "The auction is still running: it can be restarted only once its price has rested at the reserve for a day." : "Only the owner can start this auction yet; anyone can 30 days after the holding unlocked.");
    }
    // the reserve is the higher of the floor and the multiple recorded at unlock (130% after a
    // governance unlock) of the purchase price; it opens at 16 times that
    const unlockAt = (h.purchasePrice * BigInt(s.vault.unlockBps.get(h.id) ?? VAULT.UNLOCK_START_BPS)) / BPS;
    const reserve = salesFloor() > unlockAt ? salesFloor() : unlockAt;
    // ...or at 16 times the floor seen when the holding unlocked on its own, if that is higher
    const seen = s.unlockFloor.get(h.id) ?? 0n;
    const opening = 16n * (seen > reserve ? seen : reserve);
    h.status = 3;
    h.auction = { startPrice: opening, endPrice: reserve, startTime: now, currentPrice: 0n, atReserve: false, ownerPriced: false };
    log("Floor bid", "/vault/holdings", `Auction for vault holding #${vaultId} ${restart ? "restarted" : "started"} at ${wei(opening)}`, DEMO_USER);
  },
  buy([vaultId, count], value) {
    // Vault.buy(vaultId) and TicketRaffle.buy(raffleId, count) share a name; the address tells them apart.
    void count;
    const h = s.holdings.find((x) => x.id === vaultId);
    if (!h?.auction || h.status !== 3) fail("This holding is not in an auction.");
    const price = auctionPrice(h.auction);
    if (value < price) fail(`The auction price is ${wei(price)} but only ${wei(value)} was sent.`);
    pay(price);
    credit(price);
    h.status = 4;
    h.auction = undefined;
    s.owner.set(h.tokenId, DEMO_USER);
    log("Floor bid", "/vault/holdings", `Vault holding #${vaultId} sold at auction for ${wei(price)}`, DEMO_USER);
  },

  createMarket([, bettingPeriod, duration]) {
    const now = demoNow();
    if (Number(bettingPeriod) < 600 || Number(duration) < 10 * Number(bettingPeriod) || Number(duration) > 30 * DAY) {
      fail("Betting must stay open for at least 10 minutes, the market must run at least ten times as long as its betting period, and at most 30 days.");
    }
    // A market needs a start price at most an hour old. The demo's simulated reporter publishes one now.
    s.pushFloor = { ...s.pushFloor, updatedAt: now };
    s.markets.push({ id: BigInt(s.markets.length + 1), collection: DEMO_COLLECTION, startPrice: s.pushFloor.price, closeTime: now + Number(bettingPeriod), resolveTime: now + Number(duration), higherPool: 0n, lowerPool: 0n, outcome: 0, feeBps: 300n, deadBandBps: DEAD_BAND, stakes: new Map() });
    log("Predictions", "/play/predictions", `Prediction market #${s.markets.length} opened at a ${wei(s.pushFloor.price)} floor`);
  },
  placeBet([id, higher], value) {
    const m = s.markets.find((x) => x.id === id) ?? fail("This market does not exist.");
    if (demoNow() >= m.closeTime) fail("Betting on this market has closed.");
    if (value < MIN_BET) fail("The bet is below the minimum bet.");
    pay(value);
    const stake = m.stakes.get(DEMO_USER) ?? { higher: 0n, lower: 0n };
    if (higher) (m.higherPool += value), (stake.higher += value);
    else (m.lowerPool += value), (stake.lower += value);
    m.stakes.set(DEMO_USER, stake);
  },
  resolve([id]) {
    const m = s.markets.find((x) => x.id === id) ?? fail("This market does not exist.");
    if (m.outcome !== 0 || demoNow() < m.resolveTime) fail("This market cannot be resolved yet, or is already resolved.");
    // The demo's "oracle" is the simulated sales floor at this moment, moved by up to 8% either way.
    s.pushFloor = { price: (salesFloor() * BigInt(920 + randomInt(161))) / 1000n, updatedAt: demoNow() };
    const end = s.pushFloor.price;
    const move = end > m.startPrice ? end - m.startPrice : m.startPrice - end;
    // void unless both sides have bets and the price moved by at least the market's dead band
    const tooSmall = move === 0n || move * BPS < m.startPrice * m.deadBandBps;
    m.outcome = m.higherPool === 0n || m.lowerPool === 0n || tooSmall ? 3 : end > m.startPrice ? 1 : 2;
  },
  claim([id]) {
    // PredictionMarket.claim(marketId) and VaultRaffle.claim(raffleId) share a name.
    const m = s.markets.find((x) => x.id === id) ?? fail("This market does not exist.");
    if (m.outcome === 0) fail("This market is not resolved yet.");
    const stake = m.stakes.get(DEMO_USER);
    if (!stake || (stake.higher === 0n && stake.lower === 0n)) fail("You have nothing to claim in this market.");
    m.stakes.delete(DEMO_USER);
    if (m.outcome === 3) return void (s.balance += stake.higher + stake.lower);
    const [won, lost, winPool, losePool] = m.outcome === 1 ? [stake.higher, stake.lower, m.higherPool, m.lowerPool] : [stake.lower, stake.higher, m.lowerPool, m.higherPool];
    let f = 0n;
    if (won !== 0n) {
      const profit = (won * losePool) / winPool;
      f = (profit * m.feeBps) / BPS;
      s.balance += won + profit - f;
    }
    // each fee is credited once: half to the winners who pay it, half to the losers who fund it;
    // points follow the part that reaches the budget, not the project's share
    let pointsFee = (((lost * m.feeBps) / BPS) * (BPS - PROJECT_SHARE)) / BPS;
    if (f !== 0n) pointsFee += fee(f);
    creditPoints(DEMO_USER, pointsFee / 2n);
  },

  play([, chanceBps], value) {
    placeBet("dice", value, Number(chanceBps));
  },
  spin(_args, value) {
    placeBet("slots", value, 0);
  },

  flush() {
    s.points.active += s.points.pending;
    s.points.pending = 0n;
  },
  claimProjectShare: () => fail("There is nothing owed to this account."),
  requestLicense([vaultId, tier], value) {
    const t = TIERS[Number(tier)] ?? fail("This licence tier is not available for the collection.");
    const h = s.holdings.find((x) => x.id === vaultId);
    if (!h || h.status !== 1 || h.players) fail("Only holdings locked in the vault, and not set aside for players, can be licensed.");
    if (value !== t.price) fail(`The payment must be exactly ${wei(t.price)}.`);
    pay(value);
    fee(value);
    s.licenses = s.licenses.filter((l) => !(l.vaultId === vaultId && l.tier === t.tier));
    s.licenses.push({ vaultId: vaultId as bigint, tier: t.tier, end: demoNow() + t.duration });
  },
};

/** Handlers of functions whose name exists on more than one contract, keyed by contract address. */
const byContract: Record<string, Record<string, Handler>> = {
  [DEMO_DEPLOYMENT.games]: {
    /** `Games.refund`: return the wager of a bet whose randomness never arrived; betting then pauses. */
    refund([requestId]) {
      const bet = s.bets.find((b) => b.requestId === requestId && b.status === "pending") ?? fail("This bet does not exist or is already settled or refunded.");
      if (demoNow() < bet.placedAt + REFUND_TIMEOUT) fail("Too early: a bet can be refunded six hours after it was placed.");
      const exposure = bet.kind === "slots" ? slotsExposure(bet.wager, bet.edgeBps) : gameExposure(bet.wager, bet.chanceBps, bet.edgeBps);
      s.reserved -= exposure;
      s.openWagers -= bet.wager;
      s.bankroll += exposure;
      s.balance += bet.wager;
      s.betsResumeAt = demoNow() + REFUND_PAUSE;
      Object.assign(bet, { status: "refunded", refundableAt: undefined });
    },
    // Deposits and redemptions are requests (`Games.deposit` and friends): carried out at once when
    // no bet is open; otherwise once every bet that was open when they were made has closed, and
    // only while that gives up no more than the caller's `maxSpreadBps` against fair value.
    deposit([maxSpreadBps], value) {
      checkSpread(maxSpreadBps as bigint);
      if (value === 0n) fail("Enter an amount to deposit.");
      pay(value);
      s.pendingDeposit = { amount: (s.pendingDeposit?.amount ?? 0n) + value, seq: s.placedCount };
      // not ready, or too costly right now: the request simply stays pending
      if (executeDeposit(maxSpreadBps as bigint, false) === 0n) log("Games", "/play/house", `Deposit of ${wei(value)} into the house requested`, DEMO_USER);
    },
    fundBankroll(_args, value) {
      byContract[DEMO_DEPLOYMENT.games].deposit([0n], value);
    },
    executeDeposit([maxSpreadBps]) {
      executeDeposit(maxSpreadBps as bigint, true);
    },
    cancelDeposit() {
      if (!s.pendingDeposit) fail("You have no pending request of that kind.");
      s.balance += s.pendingDeposit.amount;
      s.pendingDeposit = undefined;
    },
    redeem([shares, maxSpreadBps]) {
      checkSpread(maxSpreadBps as bigint);
      const amount = shares as bigint;
      if (amount === 0n || amount > s.userShares) fail("You do not hold that many shares in the house.");
      // a remainder too small to ever be redeemed is taken along
      s.pendingRedeem = { shares: redeemRequestShares(s.userShares, amount), seq: s.placedCount };
      executeRedeem(maxSpreadBps as bigint, false);
    },
    executeRedeem([maxSpreadBps]) {
      executeRedeem(maxSpreadBps as bigint, true);
    },
    cancelRedeem() {
      if (!s.pendingRedeem) fail("You have no pending request of that kind.");
      s.pendingRedeem = undefined;
    },
  },
  [DEMO_DEPLOYMENT.lottery]: {
    buy([, count], value) {
      const n = Number(count);
      if (n < 1) fail("Enter a number of tickets of at least 1.");
      const now = demoNow();
      let round = s.rounds[s.rounds.length - 1];
      if (!round || round.status !== 1 || now >= round.endTime) {
        round = { id: BigInt(s.rounds.length + 1), collection: DEMO_COLLECTION, ticketPrice: milli(0.01), ticketsSold: 0, endTime: now + DAY, requestedAt: 0, feeBps: Number(POT_FEE), status: 1, winner: ZERO, minPot: MIN_POT, entries: [] };
        s.rounds.push(round);
        log("Lottery", "/play/lottery", `Lottery round #${round.id} opened at ${wei(round.ticketPrice)} a ticket`);
      }
      const cost = round.ticketPrice * BigInt(n);
      if (value !== cost) fail(`The payment must be exactly ${wei(cost)}.`);
      pay(cost);
      round.entries.push({ buyer: DEMO_USER, count: n });
      round.ticketsSold += n;
    },
    draw([id]) {
      const round = s.rounds.find((r) => r.id === id) ?? fail("This round does not exist.");
      if (round.status !== 1) fail("This round is not open.");
      if (demoNow() < round.endTime) fail("The round is still running: it can be drawn once its time is up.");
      const { pot, fee: f, rest } = splitPot(round.ticketPrice, round.ticketsSold, BigInt(round.feeBps));
      // the contract's rule: too small a pot, or a week past the end, means refunds instead of a draw
      if (round.ticketsSold === 0 || pot < round.minPot || demoNow() >= round.endTime + 7 * DAY) return void (round.status = 4);
      draw(round, (winner) => {
        if (winner === DEMO_USER) s.lotteryOwed += rest;
        fee(f);
      });
    },
    refund([id]) {
      const round = s.rounds.find((r) => r.id === id) ?? fail("This round does not exist.");
      const mine = ticketsOf(round.entries, DEMO_USER);
      if (round.status !== 4 || mine === 0) fail("There is nothing owed to this account.");
      round.entries = round.entries.filter((e) => e.buyer !== DEMO_USER);
      s.balance += round.ticketPrice * BigInt(mine);
    },
    withdraw() {
      if (s.lotteryOwed === 0n) fail("There is nothing owed to this account.");
      s.balance += s.lotteryOwed;
      s.lotteryOwed = 0n;
    },
  },
  [DEMO_DEPLOYMENT.ticketRaffle]: {
    create([, tokenId, ticketPrice, minTickets, maxTickets, duration]) {
      const id = tokenId as bigint;
      if (s.owner.get(id) !== DEMO_USER) fail(`You do not own token #${id}.`);
      if (Number(maxTickets) < 1 || Number(minTickets) > Number(maxTickets) || (ticketPrice as bigint) === 0n || Number(duration) < 3_600 || Number(duration) > 30 * DAY) fail("Invalid parameters.");
      s.owner.set(id, DEMO_DEPLOYMENT.ticketRaffle);
      s.raffles.push({ id: BigInt(s.raffles.length + 1), creator: DEMO_USER, collection: DEMO_COLLECTION, tokenId: id, ticketPrice: ticketPrice as bigint, minTickets: Number(minTickets), maxTickets: Number(maxTickets), ticketsSold: 0, endTime: demoNow() + Number(duration), requestedAt: 0, status: 1, winner: ZERO, feeBps: POT_FEE, minPot: MIN_POT, nftReturned: false, entries: [] });
      log("Ticket raffle", "/play/ticket-raffles", `Raffle #${s.raffles.length} opened for token #${id} at ${wei(ticketPrice as bigint)} a ticket`, DEMO_USER);
    },
    buy([id, count], value) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      const n = Number(count);
      if (r.status !== 1 || demoNow() >= r.endTime) fail("Ticket sales for this raffle have ended.");
      if (n < 1 || n > r.maxTickets - r.ticketsSold) fail(`Only ${r.maxTickets - r.ticketsSold} ticket(s) are left (and at least one must be bought).`);
      const cost = r.ticketPrice * BigInt(n);
      if (value !== cost) fail(`The payment must be exactly ${wei(cost)}.`);
      pay(cost);
      r.entries.push({ buyer: DEMO_USER, count: n });
      r.ticketsSold += n;
    },
    cancel([id]) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.creator !== DEMO_USER) fail("Only the raffle's creator can do this.");
      if (r.ticketsSold !== 0) fail("Tickets have been sold, so the raffle can no longer be cancelled.");
      r.status = 6;
      r.nftReturned = true;
      s.owner.set(r.tokenId, DEMO_USER);
    },
    close([id]) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 1) fail("This raffle is not open.");
      if (demoNow() < r.endTime && r.ticketsSold < r.maxTickets) fail("The raffle is still running: it can be closed once its time is up or it has sold out.");
      // a raffle that sold out early has ended now
      if (demoNow() < r.endTime) r.endTime = demoNow();
      if (r.ticketsSold === 0 || r.ticketsSold < r.minTickets || r.ticketPrice * BigInt(r.ticketsSold) < r.minPot || demoNow() >= r.endTime + 7 * DAY) return void (r.status = 5);
      draw(r, () => undefined);
    },
    settle([id]) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 3) fail("This raffle has no winner to settle.");
      const { fee: f, rest } = splitPot(r.ticketPrice, r.ticketsSold, r.feeBps);
      r.status = 4;
      s.owner.set(r.tokenId, r.winner);
      if (r.creator === DEMO_USER) s.raffleOwed += rest;
      fee(f);
    },
    refund([id]) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      const mine = ticketsOf(r.entries, DEMO_USER);
      if (r.status !== 5 || mine === 0) fail("There is nothing owed to this account.");
      r.entries = r.entries.filter((e) => e.buyer !== DEMO_USER);
      s.balance += r.ticketPrice * BigInt(mine);
    },
    reclaim([id]) {
      const r = s.raffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 5 || r.creator !== DEMO_USER || r.nftReturned) fail("There is nothing to reclaim.");
      r.nftReturned = true;
      s.owner.set(r.tokenId, DEMO_USER);
    },
    withdraw() {
      if (s.raffleOwed === 0n) fail("There is nothing owed to this account.");
      s.balance += s.raffleOwed;
      s.raffleOwed = 0n;
    },
  },
  [DEMO_DEPLOYMENT.vaultRaffle]: {
    draw([id]) {
      const r = s.vaultRaffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 1) fail("This raffle is not open.");
      if (demoNow() < r.drawAfter) fail("Too early: the announce period has not passed.");
      if (demoNow() < s.nextDrawAt) fail("Too early: no draw within an hour of the previous one.");
      if (s.vaultRaffles.some((x) => x.status === 2)) fail("Another raffle's draw is in flight. Wait for it to complete or be reset.");
      const activated = s.points.active + s.points.others;
      // `VaultRaffle.minPointsRequired`: the minimum, or the prize's value times the points per wei, if more
      if (activated < r.minPointsRequired) fail(`Only ${wei(activated).replace(" ETH", "")} points are activated; a draw needs at least ${wei(r.minPointsRequired).replace(" ETH", "")}.`);
      r.status = 2;
      r.requestedAt = demoNow();
      later(2_600, () => {
        const total = s.points.active + s.points.others;
        // point number = random mod total points; the demo user holds the first `active` points
        const point = (BigInt(randomInt(1_000_000)) * total) / 1_000_000n;
        r.winner = point < s.points.active ? DEMO_USER : NPC_A;
        r.status = 3;
        r.claimableAt = demoNow() + VESTING_PERIOD;
        // leave a window for points to be activated before the next raffle is drawn
        s.nextDrawAt = demoNow() + 3_600;
        if (r.winner === DEMO_USER) s.points.active = (s.points.active * 2_000n) / BPS;
      });
    },
    claim([id]) {
      const r = s.vaultRaffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 3) fail("This raffle has no prize to deliver.");
      if (demoNow() < r.claimableAt) fail(`Too early: possible from ${dateTime(r.claimableAt)}.`);
      r.status = 4;
      s.owner.set(r.tokenId, r.winner);
    },
  },
};

/** Apply a transaction to the simulated state. Throws a readable Error if the contract would revert. */
export async function demoWrite(call: Call): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  keeper();
  const handler = byContract[call.address]?.[call.functionName] ?? handlers[call.functionName];
  if (!handler) fail(`"${call.functionName}" is not part of the demo.`);
  handler(call.args, call.value ?? 0n);
  s.block += 1n;
  changed();
}

// ---------------------------------------------------------------- read helpers for visualisations
// Additive, read-only views of the simulated state for the charts and diagrams in src/viz/.

/** Simulated time at which this run of the demo started. */
export const demoStartedAt = (): number => T0;
/** The base price the bid curve started this run of the demo from. */
export const demoBidStart = (): { time: number; base: bigint } => ({ time: T0 - BID_HEAD_START, base: INITIAL_BID_BASE });
/** What ended each climb of the bid curve so far, oldest first: sales into the bid and curve restarts. */
export const demoBidEvents = (): ({ time: number; kind: "fill"; price: bigint } | { time: number; kind: "restart"; base: bigint })[] =>
  [...demoBidFills().map((f) => ({ time: f.time, kind: "fill" as const, price: f.price })), ...s.restarts.map((r) => ({ time: r.time, kind: "restart" as const, base: r.base }))].sort((a, b) => a.time - b.time);
/** Tokens of the demo collection the visitor holds, lowest id first. */
export const demoOwnedTokens = (): bigint[] => [...s.owner].filter(([, owner]) => owner === DEMO_USER).map(([id]) => id).sort((a, b) => (a < b ? -1 : 1));
/** Every sale into the floor bid since the demo started, oldest first: each one created a vault holding. */
export const demoBidFills = (): { time: number; price: bigint; tokenId: bigint; vaultId: bigint }[] =>
  s.holdings.filter((h) => h.acquiredAt >= T0).map((h) => ({ time: h.acquiredAt, price: h.purchasePrice, tokenId: h.tokenId, vaultId: h.id }));
/** The activity log, newest first, up to `limit` entries (the overview read returns the first 12). */
/** Times the bid curve restarted because money reached a budget that could not cover it, oldest first. */
export const demoCurveRestarts = (): number[] => s.restarts.map((r) => r.time);
export const demoActivityFeed = (limit = 40): R.ActivityItem[] => s.activity.slice(0, limit);

// Last, once every helper above exists.
resetDemo();
