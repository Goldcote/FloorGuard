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
import type * as R from "../lib/reads";

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
type Bet = R.GameBet & { player: Address; edgeBps: bigint; placedAt: number };
type Entry = { buyer: Address; count: number };
type Round = Omit<R.LotteryRound, "userPaid" | "userTickets" | "pot" | "prize"> & { entries: Entry[]; ticket?: bigint };
type Raffle = Omit<R.TicketRaffle, "userPaid" | "userTickets"> & { entries: Entry[]; ticket?: bigint };
type Market = Omit<R.Market, "stake"> & { stakes: Map<Address, { higher: bigint; lower: bigint }> };

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
};

const EDGE = 200n;
const MARKET_FEE = 200n;
const POT_FEE = 500n;
const MIN_POT = milli(0.05);
const MIN_BET = milli(0.001);
const PROJECT_SHARE = 1_000n;
const POINTS_PER_ETH = 2_500n;
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

function log(module: string, route: string, text: string, actor?: Address) {
  s.block += 1n;
  s.activity.unshift({ key: `${s.block}`, route, module, text, actor, blockNumber: s.block, time: demoNow() });
  s.activity = s.activity.slice(0, 40);
}
const wei = (v: bigint) => {
  const text = (Number(v / 10n ** 12n) / 1e6).toFixed(4).replace(/\.?0+$/, "");
  return `${text} ETH`;
};

export function resetDemo() {
  startedReal = Date.now();
  seed = 0x5f100d;
  const now = T0;
  s = {
    balance: 10n * ETH,
    budget: 5n * ETH,
    projectOwed: 0n,
    owner: new Map(),
    bid: { basePrice: milli(0.9), maxPrice: milli(1.5), lastReset: now, growthBpsPerDay: 1_000, stepDownBps: 500 },
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
    points: { active: 0n, pending: 0n, others: 400n * ETH },
    licenses: [],
    activity: [],
    block: 100n,
  };
  for (let id = 1n; id <= 6n; id++) s.owner.set(id, DEMO_USER);
  for (let id = 7n; id <= 12n; id++) s.owner.set(id, id % 2n ? NPC_A : NPC_B);
  s.owner.set(20n, DEMO_DEPLOYMENT.vault);
  s.owner.set(21n, DEMO_DEPLOYMENT.vault);
  s.owner.set(22n, DEMO_DEPLOYMENT.ticketRaffle);
  s.owner.set(23n, DEMO_DEPLOYMENT.vaultRaffle);

  s.offers.push(
    { id: 1n, offerer: NPC_A, collection: DEMO_COLLECTION, tokenId: 0n, price: ETH, remaining: 3, expiry: now + 7 * DAY, collectionWide: true, filled: 0 },
    { id: 2n, offerer: NPC_B, collection: DEMO_COLLECTION, tokenId: 3n, price: milli(1.2), remaining: 1, expiry: now + 5 * DAY, collectionWide: false, filled: 0 },
  );
  s.holdings.push(
    { id: 1n, collection: DEMO_COLLECTION, tokenId: 20n, purchasePrice: milli(0.8), acquiredAt: now - 200 * DAY, lockedUntil: now - 20 * DAY, unlockedAt: now - 2 * DAY, status: 3, canUnlock: false,
      auction: { startPrice: 16n * milli(1.04), endPrice: milli(1.04), startTime: now - 3 * DAY - DAY / 2, currentPrice: 0n, atReserve: false, ownerPriced: false } },
    { id: 2n, collection: DEMO_COLLECTION, tokenId: 21n, purchasePrice: milli(0.86), acquiredAt: now - 30 * DAY, lockedUntil: now + 150 * DAY, unlockedAt: 0, status: 1, canUnlock: false },
  );
  s.rounds.push({
    id: 1n, collection: DEMO_COLLECTION, ticketPrice: milli(0.01), ticketsSold: 12, endTime: now + DAY, requestedAt: 0, feeBps: Number(POT_FEE), status: 1, winner: ZERO, minPot: MIN_POT,
    entries: [{ buyer: NPC_A, count: 7 }, { buyer: NPC_B, count: 5 }],
  });
  s.raffles.push({
    id: 1n, creator: NPC_A, collection: DEMO_COLLECTION, tokenId: 22n, ticketPrice: milli(0.05), minTickets: 5, maxTickets: 20, ticketsSold: 9, endTime: now + 2 * DAY, requestedAt: 0, status: 1, winner: ZERO,
    feeBps: POT_FEE, minPot: MIN_POT, nftReturned: false, entries: [{ buyer: NPC_B, count: 9 }],
  });
  s.markets.push({
    id: 1n, collection: DEMO_COLLECTION, startPrice: ETH, closeTime: now + DAY / 2, resolveTime: now + DAY, higherPool: milli(0.5), lowerPool: milli(0.3), outcome: 0, feeBps: 300n,
    stakes: new Map(),
  });
  s.vaultRaffles.push({ id: 1n, collection: DEMO_COLLECTION, tokenId: 23n, drawAfter: now + DAY / 4, requestedAt: 0, status: 1, winner: ZERO });
  log("Marketplace", "/trade/marketplace", "Collection offer: 3 × 1 ETH", NPC_A);
  log("Lottery", "/play/lottery", "Lottery round #1 opened at 0.01 ETH a ticket");
  log("Ticket raffle", "/play/ticket-raffles", "Raffle #1 opened for token #22 at 0.05 ETH a ticket", NPC_A);
}
resetDemo();

// ---------------------------------------------------------------- helpers

function fail(message: string): never {
  throw new Error(message);
}
function pay(amount: bigint) {
  if (amount > s.balance) fail(`You only have ${wei(s.balance)} of play money left. Reset the demo to start over.`);
  s.balance -= amount;
}
/** A protocol fee: the project's share is set aside, the rest becomes buyback budget and points. */
function fee(amount: bigint, earner?: Address) {
  const toProject = (amount * PROJECT_SHARE) / BPS;
  s.projectOwed += toProject;
  s.budget += amount - toProject;
  // Points follow what reached the buyback budget: 2,500 per ETH of it.
  const earned = (amount - toProject) * POINTS_PER_ETH;
  if (earner === DEMO_USER) s.points.pending += earned;
  else if (earner) s.points.others += earned;
}
function currentBid(now = demoNow()): bigint {
  const b = s.bid;
  const price = b.basePrice + (b.basePrice * BigInt(b.growthBpsPerDay) * BigInt(Math.max(0, now - b.lastReset))) / (BPS * BigInt(DAY));
  return price > b.maxPrice ? b.maxPrice : price;
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

function floorBid(): R.FloorBid {
  const bid = currentBid();
  return { budget: s.budget, currentBid: bid, isFillable: s.budget >= bid, active: true, ...s.bid, fillCooldown: 0, nextFillAt: 0 };
}
function holdingsNow(): R.Holding[] {
  return [...s.holdings]
    .reverse()
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
    };
  },
  holdings: (): R.VaultState => ({ holdings: holdingsNow(), holdingCount: BigInt(s.holdings.length), owner: DEMO_DEPLOYMENT.owner, governanceWindow: 30 * DAY, auctionStartMultiple: 16, auctionHalfLife: DAY }),
  raffles: (): R.Raffles => ({ raffles: [...s.vaultRaffles].reverse(), raffleCount: BigInt(s.vaultRaffles.length), totalPoints: s.points.active + s.points.others, nextDrawAt: 0, drawInFlight: s.vaultRaffles.some((r) => r.status === 2) }),
  games: (): R.GamesState => ({ bankroll: s.bankroll, reserved: s.reserved, maxTotalExposureBps: 2_000n, edgeBps: EDGE, minBet: MIN_BET, maxExposureBps: 100n, supported: true, refundTimeout: DAY, userOwed: 0n }),
  gameQuote: (wager: bigint, chanceBps: number): R.GameQuote => diceQuote(wager, chanceBps, EDGE),
  userBets: (): R.GameBet[] => [...s.bets].reverse().map(({ player: _p, edgeBps: _e, placedAt: _t, ...bet }) => bet),
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
  points: (): R.PointsBalance => ({ active: s.points.active, pending: s.points.pending }),
  activity: (): R.ActivityItem[] => s.activity.slice(0, 12),
  fairness: (): R.FairnessStatus => ({
    sources: (["Games", "Lottery", "Ticket raffles", "Vault raffles"] as const).map((module) => ({ module, provider: DEMO_DEPLOYMENT.randomness, isMock: true })),
    anyMock: true, gamesOwner: DEMO_DEPLOYMENT.owner, ownerIsContract: false,
    games: { edgeBps: EDGE, minBet: MIN_BET, maxExposureBps: 100n, maxTotalExposureBps: 2_000n, refundTimeout: DAY },
    lottery: { feeBps: POT_FEE, minPot: MIN_POT }, ticketRaffle: { feeBps: POT_FEE, minPot: MIN_POT },
  }),
  betProof(requestId: bigint): R.BetProof | undefined {
    const bet = s.bets.find((b) => b.requestId === requestId);
    if (!bet || bet.roll === undefined) return undefined;
    return { requestId, wager: bet.wager, chanceBps: bet.chanceBps, edgeBps: bet.edgeBps, edgeSource: "stored", roll: bet.roll, paidPayout: bet.payout ?? 0n, paidFee: bet.fee ?? 0n, placedTx: fakeHash(requestId, 1), settledTx: fakeHash(requestId, 2) };
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
  s.bankroll += r.stake + exposure - r.payout;
  s.balance += r.payout;
  fee(r.fee, DEMO_USER);
  Object.assign(bet, { status: r.payout > 0n ? "won" : "lost", roll, payout: r.payout, fee: r.fee, refundableAt: undefined });
}
function placeBet(kind: Bet["kind"], wager: bigint, chanceBps: number) {
  if (wager < MIN_BET) fail(`The minimum bet is ${wei(MIN_BET)}.`);
  if (kind === "dice" && (chanceBps < 100 || chanceBps > 9_500)) fail("The chance of winning must be between 1% and 95%.");
  const exposure = kind === "slots" ? slotsExposure(wager, EDGE) : gameExposure(wager, chanceBps, EDGE);
  const limit = (s.bankroll * 100n) / BPS;
  if (exposure > limit) fail(`This bet would put ${wei(exposure)} of the bankroll at risk; the limit per bet is ${wei(limit)}. Lower the wager or raise the chance.`);
  pay(wager);
  s.bankroll -= exposure;
  s.reserved += exposure;
  const bet: Bet = { requestId: s.nextRequest++, collection: DEMO_COLLECTION, wager, kind, chanceBps, status: "pending", refundableAt: demoNow() + DAY, player: DEMO_USER, edgeBps: EDGE, placedAt: demoNow() };
  s.bets.push(bet);
  log("Games", kind === "slots" ? "/play/slots" : "/play/dice", kind === "slots" ? `Slots spin of ${wei(wager)}` : `Dice bet of ${wei(wager)} at ${chanceBps / 100}%`, DEMO_USER);
  later(kind === "slots" ? 1_700 : 1_300, () => settleBet(bet));
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
    fee(f, DEMO_USER);
    if (offer.collectionWide) s.sales.push({ price: offer.price, time: demoNow() });
    log("Marketplace", "/trade/marketplace", `Token #${tokenId} sold for ${wei(offer.price)} (${wei(f)} fee)`, DEMO_USER);
  },

  sell([, tokenId, minPrice]) {
    const id = tokenId as bigint;
    if (s.owner.get(id) !== DEMO_USER) fail(`You do not own token #${id}.`);
    const price = currentBid();
    if (price < (minPrice as bigint)) fail(`The floor bid is now ${wei(price)}, below your minimum of ${wei(minPrice as bigint)}.`);
    if (s.budget < price) fail(`The collection's buyback budget (${wei(s.budget)}) does not cover ${wei(price)}.`);
    const now = demoNow();
    s.budget -= price;
    s.balance += price;
    s.bid.basePrice = (price * (BPS - BigInt(s.bid.stepDownBps))) / BPS;
    s.bid.lastReset = now;
    s.owner.set(id, DEMO_DEPLOYMENT.vault);
    s.sales.push({ price, time: now });
    const vaultId = BigInt(s.holdings.length + 1);
    s.holdings.push({ id: vaultId, collection: DEMO_COLLECTION, tokenId: id, purchasePrice: price, acquiredAt: now, lockedUntil: now + 180 * DAY, unlockedAt: 0, status: 1, canUnlock: false });
    log("Floor bid", "/vault/holdings", `Bought token #${id} for ${wei(price)}, now vault holding #${vaultId}`, DEMO_USER);
  },

  unlock: () => fail("Unlock conditions are not met: the lock must have ended and the floor must be at least 130% of the purchase price."),
  startAuction: () => fail("In the demo only the simulated owner starts auctions."),
  buy([vaultId, count], value) {
    // Vault.buy(vaultId) and TicketRaffle.buy(raffleId, count) share a name; the address tells them apart.
    void count;
    const h = s.holdings.find((x) => x.id === vaultId);
    if (!h?.auction || h.status !== 3) fail("This holding is not in an auction.");
    const price = auctionPrice(h.auction);
    if (value < price) fail(`The auction price is ${wei(price)} but only ${wei(value)} was sent.`);
    pay(price);
    s.budget += price;
    h.status = 4;
    h.auction = undefined;
    s.owner.set(h.tokenId, DEMO_USER);
    log("Floor bid", "/vault/holdings", `Vault holding #${vaultId} sold at auction for ${wei(price)}`, DEMO_USER);
  },

  createMarket([, bettingPeriod, duration]) {
    const now = demoNow();
    s.markets.push({ id: BigInt(s.markets.length + 1), collection: DEMO_COLLECTION, startPrice: s.pushFloor.price, closeTime: now + Number(bettingPeriod), resolveTime: now + Number(duration), higherPool: 0n, lowerPool: 0n, outcome: 0, feeBps: 300n, stakes: new Map() });
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
    // The demo's "oracle" is the simulated sales floor at this moment.
    s.pushFloor = { price: (salesFloor() * BigInt(970 + randomInt(61))) / 1000n, updatedAt: demoNow() };
    const end = s.pushFloor.price;
    m.outcome = m.higherPool === 0n || m.lowerPool === 0n || end === m.startPrice ? 3 : end > m.startPrice ? 1 : 2;
  },
  claim([id]) {
    // PredictionMarket.claim(marketId) and VaultRaffle.claim(raffleId) share a name.
    const m = s.markets.find((x) => x.id === id) ?? fail("This market does not exist.");
    if (m.outcome === 0) fail("This market is not resolved yet.");
    const stake = m.stakes.get(DEMO_USER);
    if (!stake || (stake.higher === 0n && stake.lower === 0n)) fail("You have nothing to claim in this market.");
    m.stakes.delete(DEMO_USER);
    if (m.outcome === 3) return void (s.balance += stake.higher + stake.lower);
    const [won, winPool, losePool] = m.outcome === 1 ? [stake.higher, m.higherPool, m.lowerPool] : [stake.lower, m.lowerPool, m.higherPool];
    if (won === 0n) return;
    const profit = (won * losePool) / winPool;
    const f = (profit * m.feeBps) / BPS;
    s.balance += won + profit - f;
    fee(f, DEMO_USER);
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
    if (!h || h.status !== 1) fail("Only holdings locked in the vault can be licensed.");
    if (value !== t.price) fail(`The payment must be exactly ${wei(t.price)}.`);
    pay(value);
    fee(value);
    s.licenses = s.licenses.filter((l) => !(l.vaultId === vaultId && l.tier === t.tier));
    s.licenses.push({ vaultId: vaultId as bigint, tier: t.tier, end: demoNow() + t.duration });
  },
};

/** Handlers of functions whose name exists on more than one contract, keyed by contract address. */
const byContract: Record<string, Record<string, Handler>> = {
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
      if (Number(maxTickets) < 1 || Number(minTickets) > Number(maxTickets) || (ticketPrice as bigint) === 0n) fail("Invalid parameters.");
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
      r.status = 2;
      r.requestedAt = demoNow();
      later(2_600, () => {
        const total = s.points.active + s.points.others;
        // point number = random mod total points; the demo user holds the first `active` points
        const point = (BigInt(randomInt(1_000_000)) * total) / 1_000_000n;
        r.winner = point < s.points.active ? DEMO_USER : NPC_A;
        r.status = 3;
        if (r.winner === DEMO_USER) s.points.active = (s.points.active * 2_000n) / BPS;
      });
    },
    claim([id]) {
      const r = s.vaultRaffles.find((x) => x.id === id) ?? fail("This raffle does not exist.");
      if (r.status !== 3) fail("This raffle has no prize to deliver.");
      r.status = 4;
      s.owner.set(r.tokenId, r.winner);
    },
  },
};

/** Apply a transaction to the simulated state. Throws a readable Error if the contract would revert. */
export async function demoWrite(call: Call): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  const handler = byContract[call.address]?.[call.functionName] ?? handlers[call.functionName];
  if (!handler) fail(`"${call.functionName}" is not part of the demo.`);
  handler(call.args, call.value ?? 0n);
  s.block += 1n;
  changed();
}
