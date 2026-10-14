// The explainer's own little model of the flywheel, used by the landing page's interactive diagram.
// It follows the contracts' rules (2% marketplace fee, half of the 2% games edge, a curve that rises and steps
// down, a bid that is never more than the budget can pay, a curve that restarts when money reaches a
// budget that could not cover it, the 180-day and +30% locks, an auction opening at 16 times its
// reserve and halving daily)
// with EXAMPLE amounts the visitor changes. It is an illustration and is labelled as one; it is not
// the demo simulation and not a chain. Plain numbers (ETH as floats), pure functions.

export const RULES = {
  marketFee: 0.02,
  gamesEdge: 0.02,
  /** The games bankroll keeps half of each edge by default; the other half is the fee. */
  gamesBankrollShare: 0.5,
  lockDays: 180,
  unlockMultiple: 1.3,
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

/** The two lock conditions of a holding, as the Vault checks them. */
export function modelLock(m: Model, h: ModelHolding): { time: boolean; price: boolean; daysLeft: number; trigger: number } {
  const daysLeft = Math.max(0, h.boughtDay + RULES.lockDays - m.day);
  const trigger = h.price * RULES.unlockMultiple;
  return { time: daysLeft === 0, price: m.floor >= trigger - 1e-12, daysLeft, trigger };
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

/** Anyone can unlock a holding once both locks are open. */
export function unlock(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "locked") return refuse(m, "This holding is not locked.");
  const lock = modelLock(m, h);
  if (!lock.time) return refuse(m, `The time lock has ${Math.ceil(lock.daysLeft)} days left.`);
  if (!lock.price) return refuse(m, `The floor has to reach ${lock.trigger.toFixed(3)} ETH (130% of the purchase price).`);
  return ok({ ...m, holdings: patch(m, id, { status: "unlocked", unlockedDay: m.day }) });
}

/** The auction's reserve is the higher of the floor and 130% of the purchase price; it opens at 16 times that. */
export function startAuction(m: Model, id: number): Result {
  const h = m.holdings.find((x) => x.id === id);
  if (!h || h.status !== "unlocked") return refuse(m, "Only an unlocked holding can go to auction.");
  const reserve = Math.max(m.floor, h.price * RULES.unlockMultiple);
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
