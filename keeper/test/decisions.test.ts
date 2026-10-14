// The decision logic of every task: pure functions over fetched state.
import { describe, expect, it } from "vitest";
import { decideGames, openBetIds } from "../src/tasks/games.ts";
import { LOT, type LotteryState, type RoundState, decideLottery } from "../src/tasks/lottery.ts";
import { type PointsState, chunk, decidePoints, flushBatchSize, flushReason } from "../src/tasks/points.ts";
import { type MarketState, type PredictionState, decidePrediction } from "../src/tasks/prediction.ts";
import { TR, type TicketRaffleEntry, type TicketRaffleState, decideTicketRaffle } from "../src/tasks/ticketRaffle.ts";
import { type HoldingState, VS, type VaultState, decideVault, secondsToReserve } from "../src/tasks/vault.ts";
import { VR, type VaultRaffleEntry, type VaultRaffleState, decideVaultRaffle } from "../src/tasks/vaultRaffle.ts";
import type { Decision } from "../src/types.ts";
import { A, DAY, HOUR } from "./helpers.ts";

const NOW = 1_800_000_000n;
const calls = (d: Decision) => d.actions.map((a) => `${a.functionName}(${a.args.map(String).join(",")})`);
const codes = (d: Decision) => d.findings.map((f) => `${f.level}:${f.code}`);

// ------------------------------------------------------------------ prediction

describe("prediction: resolve", () => {
  const market = (over: Partial<MarketState> = {}): MarketState => ({
    id: 1n,
    collection: A(1),
    resolveTime: NOW - 60n,
    higherPool: 5n,
    lowerPool: 3n,
    outcome: 0,
    oracle: { price: 100n, updatedAt: NOW - 30n },
    ...over,
  });
  const state = (markets: MarketState[], over: Partial<PredictionState> = {}): PredictionState => ({
    now: NOW,
    maxOracleAge: DAY,
    voidGrace: 3n * DAY,
    stuckWarnSeconds: HOUR,
    markets,
    ...over,
  });

  it("resolves as soon as a price published at or after the settlement time exists", () => {
    expect(calls(decidePrediction(state([market()])))).toEqual(["resolve(1)"]);
    // published in the very second of settlement counts: the contract compares with >=
    expect(calls(decidePrediction(state([market({ oracle: { price: 100n, updatedAt: NOW - 60n } })])))).toEqual(["resolve(1)"]);
  });

  it("does nothing before the settlement time and asks to be woken for it", () => {
    const d = decidePrediction(state([market({ resolveTime: NOW + 500n })]));
    expect(d.actions).toEqual([]);
    expect(d.findings).toEqual([]);
    expect(d.wakeAt).toEqual([NOW + 500n]);
  });

  it("waits, and reports, while the only price is from before the settlement time", () => {
    const d = decidePrediction(state([market({ oracle: { price: 100n, updatedAt: NOW - 61n } })]));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["info:market_waiting_for_price"]);
    // polls again at once: the price may be in the next block
    expect(d.wakeAt).toEqual([NOW]);
  });

  it("escalates a long wait to a warning", () => {
    const d = decidePrediction(state([market({ resolveTime: NOW - 2n * HOUR, oracle: null })]));
    expect(codes(d)).toEqual(["warn:market_waiting_for_price"]);
    expect(d.findings[0]!.message).toContain("no price");
  });

  it("does not use a price the contract would reject as stale or zero", () => {
    const stale = market({ resolveTime: NOW - 2n * DAY, oracle: { price: 100n, updatedAt: NOW - DAY - 1n } });
    expect(decidePrediction(state([stale])).actions).toEqual([]);
    const justFresh = market({ resolveTime: NOW - 2n * DAY, oracle: { price: 100n, updatedAt: NOW - DAY } });
    expect(calls(decidePrediction(state([justFresh])))).toEqual(["resolve(1)"]);
    expect(decidePrediction(state([market({ oracle: { price: 0n, updatedAt: NOW - 30n } })])).actions).toEqual([]);
  });

  it("resolves a one-sided market at once: it is void whatever the oracle says", () => {
    const d = decidePrediction(state([market({ lowerPool: 0n, oracle: null })]));
    expect(calls(d)).toEqual(["resolve(1)"]);
    expect(d.actions[0]!.reason).toContain("void");
  });

  it("resolves into void once the grace period has passed without a usable price", () => {
    const before = market({ resolveTime: NOW - 3n * DAY + 1n, oracle: null });
    expect(decidePrediction(state([before])).actions).toEqual([]);
    const after = market({ resolveTime: NOW - 3n * DAY, oracle: null });
    expect(calls(decidePrediction(state([after])))).toEqual(["resolve(1)"]);
  });

  it("ignores resolved markets and handles several at once", () => {
    const d = decidePrediction(
      state([market({ id: 1n, outcome: 1 }), market({ id: 2n }), market({ id: 3n, outcome: 3 }), market({ id: 4n, resolveTime: NOW + 10n })]),
    );
    expect(calls(d)).toEqual(["resolve(2)"]);
    expect(d.wakeAt).toEqual([NOW + 10n]);
  });
});

// ------------------------------------------------------------------ points

describe("points: flushMany", () => {
  const state = (over: Partial<PointsState> = {}): PointsState => ({
    now: NOW,
    freezeCount: 0n,
    pending: [
      { address: A(1), pending: 30n },
      { address: A(2), pending: 20n },
      { address: A(3), pending: 10n },
    ],
    openRaffleDrawAfter: [],
    nextDrawAt: 0n,
    lastFlushAt: NOW - 100n,
    intervalSeconds: DAY,
    leadSeconds: HOUR,
    onlyWithOpenRaffle: false,
    batchSize: 2,
    ...over,
  });

  it("does nothing when nobody has pending points", () => {
    expect(decidePoints(state({ pending: [], lastFlushAt: null })).actions).toEqual([]);
  });

  it("flushes on schedule, in batches", () => {
    const d = decidePoints(state({ lastFlushAt: NOW - DAY }));
    expect(d.reason).toBe("schedule");
    expect(d.actions.map((a) => a.args[0])).toEqual([[A(1), A(2)], [A(3)]]);
    expect(d.actions.every((a) => a.contract === "points" && a.functionName === "flushMany")).toBe(true);
  });

  it("flushes when the last flush is unknown", () => {
    expect(decidePoints(state({ lastFlushAt: null })).reason).toBe("schedule");
  });

  it("waits for the schedule otherwise", () => {
    const d = decidePoints(state());
    expect(d.actions).toEqual([]);
    expect(d.wakeAt).toContain(NOW - 100n + DAY);
  });

  it("flushes shortly before a raffle can be drawn, whatever the schedule", () => {
    const inTwoHours = state({ openRaffleDrawAfter: [NOW + 2n * HOUR] });
    expect(decidePoints(inTwoHours).actions).toEqual([]);
    expect(decidePoints(inTwoHours).wakeAt).toContain(NOW + HOUR);
    const inOneHour = decidePoints(state({ openRaffleDrawAfter: [NOW + HOUR] }));
    expect(inOneHour.reason).toBe("pre-draw");
    expect(inOneHour.actions).toHaveLength(2);
    // a raffle that is already drawable is the most urgent case
    expect(decidePoints(state({ openRaffleDrawAfter: [NOW - DAY] })).reason).toBe("pre-draw");
  });

  it("measures the lead against the redraw cooldown when that is later than drawAfter", () => {
    const base = { openRaffleDrawAfter: [NOW - DAY], lastFlushAt: NOW - 100n };
    expect(flushReason({ ...state(base), nextDrawAt: NOW + 2n * HOUR })).toBeNull();
    expect(flushReason({ ...state(base), nextDrawAt: NOW + HOUR })).toBe("pre-draw");
  });

  it("never flushes while a draw is in flight, and says so", () => {
    const d = decidePoints(state({ freezeCount: 1n, lastFlushAt: null, openRaffleDrawAfter: [NOW - 1n] }));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["info:points_frozen"]);
  });

  it("can be limited to times when a raffle is open", () => {
    const quiet = state({ lastFlushAt: null, onlyWithOpenRaffle: true });
    expect(decidePoints(quiet).actions).toEqual([]);
    expect(decidePoints({ ...quiet, openRaffleDrawAfter: [NOW + 5n * DAY] }).reason).toBe("schedule");
  });

  it("sizes batches by gas", () => {
    // 3,000,000 gas with a 30% margin leaves 2,307,692; less 30,000 overhead, at 190,000 an account: 11
    expect(flushBatchSize(3_000_000n, 3_000n, 190_000n, 100)).toBe(11);
    expect(flushBatchSize(3_000_000n, 3_000n, 190_000n, 5)).toBe(5);
    expect(flushBatchSize(100_000n, 3_000n, 190_000n, 100)).toBe(1);
    expect(flushBatchSize(30_000_000n, 0n, 100_000n, 1_000)).toBe(299);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

// ------------------------------------------------------------------ vault raffle

describe("vault raffle: draw, resetDraw, claim", () => {
  const raffle = (over: Partial<VaultRaffleEntry> = {}): VaultRaffleEntry => ({
    id: 1n,
    collection: A(1),
    tokenId: 1n,
    drawAfter: NOW - 10n,
    requestedAt: 0n,
    status: VR.Open,
    winner: A(0),
    ...over,
  });
  const state = (raffles: VaultRaffleEntry[], over: Partial<VaultRaffleState> = {}): VaultRaffleState => ({
    now: NOW,
    nextDrawAt: 0n,
    drawTimeout: DAY,
    minPointsToDraw: 100n,
    freezeCount: 0n,
    totalPoints: 500n,
    pendingAccounts: 0,
    requireFlushed: true,
    raffles,
    ...over,
  });

  it("draws when every condition holds", () => {
    expect(calls(decideVaultRaffle(state([raffle()])))).toEqual(["draw(1)"]);
  });

  it("waits for drawAfter and for nextDrawAt, whichever is later", () => {
    const early = decideVaultRaffle(state([raffle({ drawAfter: NOW + 5n })]));
    expect(early.actions).toEqual([]);
    expect(early.wakeAt).toEqual([NOW + 5n]);
    const cooling = decideVaultRaffle(state([raffle()], { nextDrawAt: NOW + 50n }));
    expect(cooling.actions).toEqual([]);
    expect(cooling.wakeAt).toEqual([NOW + 50n]);
    expect(calls(decideVaultRaffle(state([raffle()], { nextDrawAt: NOW })))).toEqual(["draw(1)"]);
  });

  it("does not draw while another draw is in flight", () => {
    const d = decideVaultRaffle(state([raffle()], { freezeCount: 1n }));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["info:draw_in_flight"]);
  });

  it("does not draw while points are still pending, so nobody is locked out", () => {
    const d = decideVaultRaffle(state([raffle()], { pendingAccounts: 3 }));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["warn:waiting_for_flush"]);
    // unless told not to care
    expect(calls(decideVaultRaffle(state([raffle()], { pendingAccounts: 3, requireFlushed: false })))).toEqual(["draw(1)"]);
    // not knowing is not the same as knowing there are none
    expect(codes(decideVaultRaffle(state([raffle()], { pendingAccounts: null })))).toEqual(["warn:flush_state_unknown"]);
  });

  it("does not draw below minPointsToDraw or with no points at all", () => {
    expect(codes(decideVaultRaffle(state([raffle()], { totalPoints: 99n })))).toEqual(["warn:below_min_points"]);
    expect(calls(decideVaultRaffle(state([raffle()], { totalPoints: 100n })))).toEqual(["draw(1)"]);
    expect(codes(decideVaultRaffle(state([raffle()], { totalPoints: 0n, minPointsToDraw: 0n })))).toEqual(["warn:no_points"]);
  });

  it("requests one draw per pass: the first freezes points for the rest", () => {
    const d = decideVaultRaffle(state([raffle({ id: 1n }), raffle({ id: 2n })]));
    expect(calls(d)).toEqual(["draw(1)"]);
    expect(codes(d)).toEqual(["info:draw_in_flight"]);
  });

  it("resets a draw without an answer after the timeout, not before", () => {
    const waiting = decideVaultRaffle(state([raffle({ status: VR.Drawing, requestedAt: NOW - DAY + 1n })], { freezeCount: 1n }));
    expect(waiting.actions).toEqual([]);
    expect(waiting.wakeAt).toEqual([NOW + 1n]);
    const late = decideVaultRaffle(state([raffle({ status: VR.Drawing, requestedAt: NOW - DAY })], { freezeCount: 1n }));
    expect(calls(late)).toEqual(["resetDraw(1)"]);
  });

  it("claims for raffles with a winner and leaves claimed ones alone", () => {
    const d = decideVaultRaffle(state([raffle({ id: 1n, status: VR.Won, winner: A(9) }), raffle({ id: 2n, status: VR.Claimed })]));
    expect(calls(d)).toEqual(["claim(1)"]);
  });

  it("orders resets and claims before draws", () => {
    const d = decideVaultRaffle(
      state([raffle({ id: 1n }), raffle({ id: 2n, status: VR.Won }), raffle({ id: 3n, status: VR.Drawing, requestedAt: NOW - 2n * DAY })], {
        freezeCount: 1n,
      }),
    );
    expect(calls(d)).toEqual(["resetDraw(3)", "claim(2)"]);
  });
});

// ------------------------------------------------------------------ lottery

describe("lottery: draw, resetDraw, abort", () => {
  const round = (over: Partial<RoundState> = {}): RoundState => ({
    id: 1n,
    collection: A(1),
    ticketPrice: 10n,
    ticketsSold: 10n,
    endTime: NOW - 60n,
    requestedAt: 0n,
    status: LOT.Open,
    minPot: 50n,
    ...over,
  });
  const state = (rounds: RoundState[], over: Partial<LotteryState> = {}): LotteryState => ({
    now: NOW,
    drawTimeout: DAY,
    abortDelay: 7n * DAY,
    abortEnabled: false,
    abortGuard: 900n,
    rounds,
    ...over,
  });

  it("draws a round that has ended", () => {
    expect(calls(decideLottery(state([round()])))).toEqual(["draw(1)"]);
    expect(calls(decideLottery(state([round({ endTime: NOW })])))).toEqual(["draw(1)"]);
  });

  it("leaves a running round alone", () => {
    const d = decideLottery(state([round({ endTime: NOW + 1n })]));
    expect(d.actions).toEqual([]);
    expect(d.wakeAt).toEqual([NOW + 1n]);
  });

  it("draws a round whose pot is below the minimum, which opens refunds", () => {
    const d = decideLottery(state([round({ ticketsSold: 4n })]));
    expect(calls(d)).toEqual(["draw(1)"]);
    expect(d.actions[0]!.reason).toContain("refunds");
    // even long after its end: there is nothing to draw, only refunds to open
    expect(calls(decideLottery(state([round({ ticketsSold: 4n, endTime: NOW - 30n * DAY })])))).toEqual(["draw(1)"]);
  });

  it("resets a draw whose randomness is a day late", () => {
    const waiting = round({ status: LOT.Drawing, requestedAt: NOW - DAY + 1n });
    expect(decideLottery(state([waiting])).actions).toEqual([]);
    expect(calls(decideLottery(state([round({ status: LOT.Drawing, requestedAt: NOW - DAY })])))).toEqual(["resetDraw(1)"]);
  });

  it("past the abort time, reports instead of aborting unless abort is on", () => {
    // `draw` on such a round would not draw: it would open refunds, which is an abort by another name
    const stale = round({ endTime: NOW - 7n * DAY });
    const off = decideLottery(state([stale]));
    expect(off.actions).toEqual([]);
    expect(codes(off)).toEqual(["warn:round_stuck"]);
    expect(calls(decideLottery(state([stale], { abortEnabled: true })))).toEqual(["abort(1)"]);

    const drawing = round({ status: LOT.Drawing, endTime: NOW - 8n * DAY, requestedAt: NOW - 2n * DAY });
    expect(decideLottery(state([drawing])).actions).toEqual([]);
    expect(codes(decideLottery(state([drawing])))).toEqual(["warn:round_stuck"]);
    expect(calls(decideLottery(state([drawing], { abortEnabled: true })))).toEqual(["abort(1)"]);
  });

  it("never aborts while an answer to the pending draw would still be accepted", () => {
    const drawing = round({ status: LOT.Drawing, endTime: NOW - 8n * DAY, requestedAt: NOW - HOUR });
    const d = decideLottery(state([drawing], { abortEnabled: true }));
    expect(d.actions).toEqual([]);
    expect(d.wakeAt).toEqual([NOW - HOUR + DAY]);
  });

  it("does not request a draw so close to the abort time that it could land as refunds", () => {
    const close = round({ endTime: NOW - 7n * DAY + 600n });
    const d = decideLottery(state([close]));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["warn:round_stuck"]);
    expect(calls(decideLottery(state([round({ endTime: NOW - 7n * DAY + 901n })])))).toEqual(["draw(1)"]);
  });

  it("ignores finished rounds", () => {
    expect(decideLottery(state([round({ status: LOT.Won }), round({ status: LOT.Refunding })])).actions).toEqual([]);
  });
});

// ------------------------------------------------------------------ ticket raffle

describe("ticket raffle: close, settle, resetDraw, abort", () => {
  const raffle = (over: Partial<TicketRaffleEntry> = {}): TicketRaffleEntry => ({
    id: 1n,
    collection: A(1),
    ticketPrice: 10n,
    minTickets: 5n,
    maxTickets: 40n,
    ticketsSold: 10n,
    endTime: NOW - 60n,
    requestedAt: 0n,
    status: TR.Open,
    minPot: 50n,
    settleReverts: null,
    ...over,
  });
  const state = (raffles: TicketRaffleEntry[], over: Partial<TicketRaffleState> = {}): TicketRaffleState => ({
    now: NOW,
    drawTimeout: DAY,
    abortDelay: 7n * DAY,
    abortEnabled: false,
    abortGuard: 900n,
    raffles,
    ...over,
  });

  it("closes a raffle that has ended", () => {
    expect(calls(decideTicketRaffle(state([raffle()])))).toEqual(["close(1)"]);
  });

  it("closes a raffle that sold out before its end, and no other running raffle", () => {
    expect(calls(decideTicketRaffle(state([raffle({ endTime: NOW + DAY, ticketsSold: 40n })])))).toEqual(["close(1)"]);
    const running = decideTicketRaffle(state([raffle({ endTime: NOW + DAY, ticketsSold: 39n })]));
    expect(running.actions).toEqual([]);
    expect(running.wakeAt).toEqual([NOW + DAY]);
  });

  it("closes a raffle that missed its minimum, which opens refunds", () => {
    for (const short of [raffle({ ticketsSold: 4n }), raffle({ ticketsSold: 0n }), raffle({ minPot: 101n })]) {
      const d = decideTicketRaffle(state([short]));
      expect(calls(d)).toEqual(["close(1)"]);
      expect(d.actions[0]!.reason).toContain("refunds");
    }
  });

  it("settles a raffle with a winner", () => {
    expect(calls(decideTicketRaffle(state([raffle({ status: TR.Won, requestedAt: NOW - 60n })])))).toEqual(["settle(1)"]);
  });

  it("resets a draw whose randomness is a day late", () => {
    expect(decideTicketRaffle(state([raffle({ status: TR.Drawing, requestedAt: NOW - DAY + 1n })])).actions).toEqual([]);
    expect(calls(decideTicketRaffle(state([raffle({ status: TR.Drawing, requestedAt: NOW - DAY })])))).toEqual(["resetDraw(1)"]);
  });

  it("past the abort time, reports instead of aborting unless abort is on", () => {
    const stale = raffle({ endTime: NOW - 7n * DAY });
    expect(decideTicketRaffle(state([stale])).actions).toEqual([]);
    expect(codes(decideTicketRaffle(state([stale])))).toEqual(["warn:raffle_stuck"]);
    expect(calls(decideTicketRaffle(state([stale], { abortEnabled: true })))).toEqual(["abort(1)"]);

    const drawing = raffle({ status: TR.Drawing, endTime: NOW - 8n * DAY, requestedAt: NOW - 2n * DAY });
    expect(codes(decideTicketRaffle(state([drawing])))).toEqual(["warn:raffle_stuck"]);
    expect(calls(decideTicketRaffle(state([drawing], { abortEnabled: true })))).toEqual(["abort(1)"]);
    // never while the pending answer would still be accepted
    const fresh = raffle({ status: TR.Drawing, endTime: NOW - 8n * DAY, requestedAt: NOW - HOUR });
    expect(decideTicketRaffle(state([fresh], { abortEnabled: true })).actions).toEqual([]);
  });

  it("keeps a draw request away from the abort time", () => {
    expect(decideTicketRaffle(state([raffle({ endTime: NOW - 7n * DAY + 600n })])).actions).toEqual([]);
  });

  it("when settle reverts: reports, and aborts only a week after the draw and only if abort is on", () => {
    const stuck = raffle({ status: TR.Won, requestedAt: NOW - DAY, settleReverts: "ERC721InsufficientApproval" });
    const early = decideTicketRaffle(state([stuck], { abortEnabled: true }));
    expect(early.actions).toEqual([]);
    expect(codes(early)).toEqual(["warn:raffle_stuck"]);
    expect(early.wakeAt).toEqual([NOW + 6n * DAY]);

    const old = { ...stuck, requestedAt: NOW - 7n * DAY };
    expect(decideTicketRaffle(state([old])).actions).toEqual([]);
    expect(calls(decideTicketRaffle(state([old], { abortEnabled: true })))).toEqual(["abort(1)"]);
  });

  it("ignores finished raffles", () => {
    const done = [TR.Settled, TR.Refunding, TR.Cancelled].map((status) => raffle({ status }));
    expect(decideTicketRaffle(state(done)).actions).toEqual([]);
  });
});

// ------------------------------------------------------------------ games

describe("games: refund", () => {
  const bet = (requestId: bigint, placedAt: bigint) => ({ requestId, player: A(1), wager: 10n, placedAt });

  it("refunds a bet whose randomness is a day late, and no sooner", () => {
    const d = decideGames({ now: NOW, refundTimeout: DAY, bets: [bet(1n, NOW - DAY), bet(2n, NOW - DAY + 1n), bet(3n, NOW - 3n * DAY)] });
    expect(calls(d)).toEqual(["refund(1)", "refund(3)"]);
    expect(d.wakeAt).toEqual([NOW + 1n]);
  });

  it("finds open bets from events, whatever order the ranges arrive in", () => {
    const log = (eventName: string, requestId: bigint) => ({ eventName, args: { requestId } });
    const open = openBetIds([5n], [log("BetSettled", 2n), log("BetPlaced", 1n), log("BetPlaced", 2n), log("BetPlaced", 3n), log("BetRefunded", 3n), log("BetSettled", 5n)]);
    expect([...open]).toEqual([1n]);
  });
});

// ------------------------------------------------------------------ vault

describe("vault: unlock, startAuction", () => {
  const holding = (over: Partial<HoldingState> = {}): HoldingState => ({
    id: 1n,
    collection: A(1),
    tokenId: 1n,
    purchasePrice: 100n,
    lockedUntil: NOW - 10n,
    unlockedAt: 0n,
    status: VS.Locked,
    canUnlock: true,
    auction: null,
    ...over,
  });
  const state = (holdings: HoldingState[], over: Partial<VaultState> = {}): VaultState => ({
    now: NOW,
    governanceWindow: 30n * DAY,
    halfLife: DAY,
    startAuctionEnabled: false,
    restartAuctionEnabled: false,
    restartDwell: 3n * DAY,
    holdings,
    ...over,
  });

  it("unlocks when canUnlock is true", () => {
    expect(calls(decideVault(state([holding()])))).toEqual(["unlock(1)"]);
  });

  it("waits for the time lock, then for the floor, and reports the latter once", () => {
    const locked = decideVault(state([holding({ lockedUntil: NOW + 99n, canUnlock: false })]));
    expect(locked.actions).toEqual([]);
    expect(locked.wakeAt).toEqual([NOW + 99n]);
    const waiting = decideVault(state([holding({ canUnlock: false }), holding({ id: 2n, canUnlock: false })]));
    expect(waiting.actions).toEqual([]);
    expect(codes(waiting)).toEqual(["info:waiting_for_floor"]);
    expect(waiting.findings[0]!.data).toEqual({ holdings: 2 });
  });

  it("reports an unlocked holding and leaves it to governance during the window", () => {
    const d = decideVault(state([holding({ status: VS.Unlocked, unlockedAt: NOW - DAY })], { startAuctionEnabled: true }));
    expect(d.actions).toEqual([]);
    expect(codes(d)).toEqual(["info:holding_unlocked"]);
    expect(d.wakeAt).toEqual([NOW + 29n * DAY]);
  });

  it("starts the auction after the governance window only when opted in", () => {
    const old = holding({ status: VS.Unlocked, unlockedAt: NOW - 30n * DAY });
    const off = decideVault(state([old]));
    expect(off.actions).toEqual([]);
    expect(codes(off)).toEqual(["warn:governance_window_passed"]);
    expect(calls(decideVault(state([old], { startAuctionEnabled: true })))).toEqual(["startAuction(1)"]);
  });

  it("restarts an auction only after it has sat at its reserve for the dwell time, and only when opted in", () => {
    // opens at 16x the reserve: reaches it after exactly four half-lives
    const auction = (startTime: bigint, ownerPriced = false) =>
      holding({ status: VS.Auction, auction: { startPrice: 1_600n, endPrice: 100n, startTime, ownerPriced } });
    const on = { restartAuctionEnabled: true };

    const running = decideVault(state([auction(NOW - 4n * DAY + 1n)], on));
    expect(running.actions).toEqual([]);
    expect(running.wakeAt).toEqual([NOW + 1n]);

    const justThere = decideVault(state([auction(NOW - 4n * DAY)], on));
    expect(justThere.actions).toEqual([]);
    expect(codes(justThere)).toEqual(["info:auction_at_reserve"]);
    expect(justThere.wakeAt).toEqual([NOW + 3n * DAY]);

    expect(calls(decideVault(state([auction(NOW - 7n * DAY)], on)))).toEqual(["startAuction(1)"]);
    expect(codes(decideVault(state([auction(NOW - 7n * DAY)])))).toEqual(["warn:auction_at_reserve"]);
    // an owner-priced auction can only be restarted by the owner
    const ownerPriced = decideVault(state([auction(NOW - 30n * DAY, true)], on));
    expect(ownerPriced.actions).toEqual([]);
    expect(codes(ownerPriced)).toEqual(["info:auction_at_reserve"]);
  });

  it("ignores released holdings", () => {
    expect(decideVault(state([holding({ status: VS.Released })]))).toEqual({ actions: [], findings: [], wakeAt: [] });
  });

  describe("secondsToReserve mirrors Vault.auctionPrice", () => {
    // Vault.auctionPrice, transcribed
    const price = (start: bigint, end: bigint, elapsed: bigint, halfLife = DAY) => {
      const halvings = elapsed / halfLife;
      if (halvings >= 128n) return end;
      let p = start >> halvings;
      p -= ((p / 2n) * (elapsed % halfLife)) / halfLife;
      return p > end ? p : end;
    };

    it("is the first second at which the price equals the end price", () => {
      const cases: [bigint, bigint][] = [
        [1_600n, 100n],
        [16n * 10n ** 18n, 10n ** 18n],
        [20n * 10n ** 18n, 117n * 10n ** 16n],
        [1_000n, 999n],
        [1_000n, 1n],
        [7n, 3n],
        [5n, 5n],
        [2n ** 127n, 1n],
      ];
      for (const [start, end] of cases) {
        const t = secondsToReserve(start, end, DAY);
        expect(price(start, end, t), `${start} -> ${end} at ${t}`).toBe(end);
        if (t > 0n) expect(price(start, end, t - 1n), `${start} -> ${end} just before ${t}`).toBeGreaterThan(end);
      }
      expect(secondsToReserve(1_600n, 100n, DAY)).toBe(4n * DAY);
      expect(secondsToReserve(5n, 5n, DAY)).toBe(0n);
    });
  });
});
