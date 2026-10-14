// The explainer's own little model of the flywheel, used by the landing page's interactive diagram.
// It follows the contracts' rules (2% marketplace fee, half of the 2% games edge, a curve that rises and steps
// down, a bid that is never more than the budget can pay, a curve that restarts when money reaches a
// budget that could not cover it, the moving lock: a daily draw from 90 days with a chance that rises
// with age, and a floor that must reach a multiple of the price paid falling from 130% to 100% over
// the year; an auction opening at 16 times its reserve and halving daily). It leaves out the 30-day
// median (the floor here is the median), the weekly release cap and the players' share.
// with EXAMPLE amounts the visitor changes. It is an illustration and is labelled as one; it is not
// the demo simulation and not a chain. Plain numbers (ETH as floats), pure functions.

export const RULES = {
  marketFee: 0.02,
  gamesEdge: 0.02,
  /** The games bankroll keeps half of each edge by default; the other half is the fee. */
  gamesBankrollShare: 0.5,
  /** No part in the unlock draw before this age (`Vault.MIN_LOCK`)... */
  minLockDays: 90,
  /** ...and at this age the chance and the required floor stop changing (`Vault.FULL_AGE`). */
  fullAgeDays: 365,
  /** The floor a picked holding needs, as a multiple of its price: 130% at 90 days, 100% at a year. */
  unlockStart: 1.3,
  unlockEnd: 1,
  /** Chance of being picked in one daily draw: 0.5% at 90 days, 5% at a year. */
  drawStart: 0.005,
  drawEnd: 0.05,
  auctionStartMultiple: 16,
  /** Example bid curve. On a real deployment the owner sets these per collection. */
  growthPerDay: 0.1,
  stepDown: 0.15,
  maxBid: 1.5,
  /** No buyback below this share of the curve's base (`BuybackEngine.minBidBpsOf`, a tenth by default). */
  minBidShare: 0.1,
} as const;

/** The minimum bid: a tenth of the base the curve is climbing from. */
export const modelMinBid = (m: Pick<Model, "bidBase">): number => m.bidBase * RULES.minBidShare;

export type ModelHolding = {
  id: number;
  price: number;
  boughtDay: number;
  status: "locked" | "unlocked" | "auction" | "sold" | "raffled";
  /** Set while on auction. */
  auction?: { startDay: number; reserve: number; start: number };
  soldFor?: number;
  unlockedDay?: number;
  /** The day (whole days) of the last draw it took part in, and whether that draw picked it. */
  drawnDay?: number;
  picked?: boolean;
  /** The multiple of its price it unlocked at; the auction's reserve never goes below it. */
  unlockMultiple?: number;
};

export type Model = {
  day: number;
  floor: number;
  budget: number;
  bidBase: number;
  bidResetDay: number;
  holdings: ModelHolding[];
  /** Fees that have reached the budget so far, by source. */
  fees: { trading: number; games: number };
};

export type FlowEvent =
  | { flow: "trade" | "games"; amount: number }
  | { flow: "pay"; amount: number }
  | { flow: "deposit"; id: number }
  | { flow: "toAuction"; id: number }
  | { flow: "proceeds"; amount: number }
  | { flow: "toRaffle"; id: number }
  /** The curve went back to its base because money reached a budget that could not cover it. */
  | { flow: "restart" };

export const initialModel = (): Model => ({
  day: 0,
  floor: 1,
  budget: 0.6,
  bidBase: 0.9,
  bidResetDay: 0,
  holdings: [],
  fees: { trading: 0, games: 0 },
});

/** Where the curve stands, whatever the budget. */
export const modelCurve = (m: Model): number => Math.min(RULES.maxBid, m.bidBase * (1 + RULES.growthPerDay * Math.max(0, m.day - m.bidResetDay)));
/** What a seller is paid: the curve, or the budget when it holds less. */
export const modelBid = (m: Model): number => Math.min(modelCurve(m), m.budget);

/** Money reaches the budget. If it could not cover the curve until now, the curve restarts from its base. */
function credit(m: Model, amount: number): { model: Model; restarted: boolean } {
  const restarted = amount > 0 && m.budget < modelCurve(m) - 1e-12;
  // the bid until now was the budget: restart from there if that is above the base
  return { model: { ...m, budget: m.budget + amount, bidResetDay: restarted ? m.day : m.bidResetDay, bidBase: restarted ? Math.max(m.bidBase, m.budget) : m.bidBase }, restarted };
}

/** Price of a holding's auction on `day`: halves every day, linear within a day, holds at the reserve. */
export function modelAuctionPrice(a: NonNullable<ModelHolding["auction"]>, day: number): number {
  const elapsed = Math.max(0, day - a.startDay);
  const whole = Math.floor(elapsed);
  const top = a.start / 2 ** Math.min(60, whole);
  return Math.max(a.reserve, top - (top / 2) * (elapsed - whole));
}

/** Linear from `atStart` at 90 days to `atEnd` at a year, flat outside (`Vault._ramp`). */
function ramp(age: number, atStart: number, atEnd: number): number {
  const t = Math.min(1, Math.max(0, (age - RULES.minLockDays) / (RULES.fullAgeDays - RULES.minLockDays)));
  return atStart + (atEnd - atStart) * t;
}
/** The floor multiple a holding of this age (in days) needs. */
export const modelRequiredMultiple = (age: number): number => ramp(age, RULES.unlockStart, RULES.unlockEnd);
/** The chance a holding of this age (in days) is picked in one daily draw. */
export const modelDrawChance = (age: number): number => ramp(age, RULES.drawStart, RULES.drawEnd);

/** Where a holding stands against the moving lock, as the Vault checks it. */
export function modelLock(m: Model, h: ModelHolding): { eligible: boolean; daysLeft: number; chance: number; multiple: number; trigger: number; price: boolean; drawnToday: boolean; picked: boolean } {
  const age = m.day - h.boughtDay;
  const daysLeft = Math.max(0, RULES.minLockDays - age);
  const multiple = modelRequiredMultiple(age);
  const trigger = h.price * multiple;
  const drawnToday = h.drawnDay === Math.floor(m.day);
  return { eligible: daysLeft === 0, daysLeft, chance: modelDrawChance(age), multiple, trigger, price: m.floor >= trigger - 1e-12, drawnToday, picked: drawnToday && !!h.picked };
}

type Result = { model: Model; events: FlowEvent[]; refused?: string };
const ok = (model: Model, ...events: FlowEvent[]): Result => ({ model, events });
const refuse = (model: Model, refused: string): Result => ({ model, events: [], refused });
const patch = (m: Model, id: number, change: Partial<ModelHolding>): ModelHolding[] => m.holdings.map((h) => (h.id === id ? { ...h, ...change } : h));

/** A marketplace sale at `price`: 2% of it becomes buyback budget. */
export function trade(m: Model, price: number): Result {
  const fee = price * RULES.marketFee;
  const { model, restarted } = credit(m, fee);
  return ok({ ...model, fees: { ...m.fees, trading: m.fees.trading + fee } }, { flow: "trade", amount: fee }, ...(restarted ? [{ flow: "restart" } as const] : []));
}

/** A dice or slots wager: half of the 2% edge becomes buyback budget, whatever the outcome; the bankroll keeps the rest. */
export function wager(m: Model, amount: number): Result {
  const fee = amount * RULES.gamesEdge * (1 - RULES.gamesBankrollShare);
  const { model, restarted } = credit(m, fee);
  return ok({ ...model, fees: { ...m.fees, games: m.fees.games + fee } }, { flow: "games", amount: fee }, ...(restarted ? [{ flow: "restart" } as const] : []));
}

/**
 * A holder sells into the bid: paid the bid from the budget, the token goes to the vault, and the
 * curve restarts one step below the higher of the sale price and its old base less three steps.
 */
export function sellIntoBid(m: Model): Result {
  const price = modelBid(m);
  if (price < modelMinBid(m)) return refuse(m, `There is nothing to bid with: the budget holds less than the minimum bid of ${modelMinBid(m).toFixed(3)} ETH. Fees have to come in first.`);
  const id = m.holdings.length + 1;
  return ok(
    {
      ...m,
      budget: m.budget - price,
      bidBase: Math.max(price, m.bidBase * Math.max(0, 1 - 3 * RULES.stepDown)) * (1 - RULES.stepDown),
      bidResetDay: m.day,
      holdings: [...m.holdings, { id, price, boughtDay: m.day, status: "locked" }],
    },
    { flow: "pay", amount: price },
    { flow: "deposit", id },
  );
}

export const advance = (m: Model, days: number): Model => ({ ...m, day: m.day + Math.max(0, days) });
export const setDay = (m: Model, day: number): Model => ({ ...m, day: Math.max(firstFreeDay(m), day) });
export const setFloor = (m: Model, floor: number): Model => ({ ...m, floor: Math.max(0.01, floor) });

/** Time cannot go back past something that already happened. */
function firstFreeDay(m: Model): number {
  return Math.max(m.bidResetDay, ...m.holdings.map((h) => Math.max(h.boughtDay, h.unlockedDay ?? 0, h.auction?.startDay ?? 0)));
}

/** Today's draw for a holding: `roll` in [0, 1) picks it if below its chance. One draw a day. */
export function drawHolding(m: Model, id: number, roll: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "locked") return refuse(m, "This holding is not locked.");
  const lock = modelLock(m, h);
  if (!lock.eligible) return refuse(m, `It joins the daily draw in ${Math.ceil(lock.daysLeft)} days.`);
  if (lock.drawnToday) return refuse(m, "Today's draw has run. Wait a day for the next.");
  return ok({ ...m, holdings: patch(m, id, { drawnDay: Math.floor(m.day), picked: roll < lock.chance }) });
}

/** Anyone can unlock a holding on a day the draw picked it and the floor is at the multiple its age requires. */
export function unlock(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "locked") return refuse(m, "This holding is not locked.");
  const lock = modelLock(m, h);
  if (!lock.eligible) return refuse(m, `It joins the daily draw in ${Math.ceil(lock.daysLeft)} days.`);
  if (!lock.picked) return refuse(m, "Today's draw has not picked it.");
  if (!lock.price) return refuse(m, `The floor has to reach ${lock.trigger.toFixed(3)} ETH (${(lock.multiple * 100).toFixed(1)}% of the purchase price).`);
  return ok({ ...m, holdings: patch(m, id, { status: "unlocked", unlockedDay: m.day, unlockMultiple: lock.multiple }) });
}

/**
 * Skip ahead: from the day the holding joins the draw, run a draw each day with `random` until one
 * picks it, keep the floor at least at the multiple that day requires, and unlock it.
 */
export function skipToUnlock(m: Model, id: number, random: () => number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "locked") return refuse(m, "This holding is not locked.");
  let day = Math.max(Math.floor(m.day), Math.ceil(h.boughtDay + RULES.minLockDays));
  for (let i = 0; i < 2_000; i++, day++) {
    const age = day - h.boughtDay;
    if (random() < modelDrawChance(age)) {
      const at = setDay(m, day);
      const floor = Math.max(at.floor, Math.ceil(h.price * modelRequiredMultiple(age) * 1000) / 1000);
      const drawn = { ...setFloor(at, floor), holdings: patch(at, id, { drawnDay: day, picked: true }) };
      return unlock(drawn, id);
    }
  }
  return refuse(m, "No draw picked it.");
}

/** The auction's reserve is the higher of the floor and the multiple the holding unlocked at; it opens at 16 times that. */
export function startAuction(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "unlocked") return refuse(m, "Only an unlocked holding can go to auction.");
  const reserve = Math.max(m.floor, h.price * (h.unlockMultiple ?? RULES.unlockStart));
  const auction = { startDay: m.day, reserve, start: reserve * RULES.auctionStartMultiple };
  return ok({ ...m, holdings: patch(m, id, { status: "auction", auction }) }, { flow: "toAuction", id });
}

/** A buyer takes the auction at its price on this day; the proceeds go back to the budget. */
export function catchAuction(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "auction" || !h.auction) return refuse(m, "This holding is not on auction.");
  const price = modelAuctionPrice(h.auction, m.day);
  const { model, restarted } = credit(m, price);
  return ok({ ...model, holdings: patch(m, id, { status: "sold", auction: undefined, soldFor: price }) }, { flow: "proceeds", amount: price }, ...(restarted ? [{ flow: "restart" } as const] : []));
}

/** The owner can send an unlocked holding to a raffle among points holders instead. */
export function raffle(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "unlocked") return refuse(m, "Only an unlocked holding can be raffled.");
  return ok({ ...m, holdings: patch(m, id, { status: "raffled" }) }, { flow: "toRaffle", id });
}
