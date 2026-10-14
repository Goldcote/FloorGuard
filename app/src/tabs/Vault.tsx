// The vault: what the bid bought, behind a moving lock (a daily draw from 90 days, a 30-day median
// floor, a weekly release cap), a share set aside for players, and the auctions that release
// holdings as a falling price to catch. Every state is read from the Vault contract (or the demo).
import type { Address } from "viem";
import { buyCall, mockFulfillCall, releaseToPlayersCall, requestUnlockRoundCall, sampleFloorCall, startAuctionCall, unlockCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { LOCAL_CHAIN_ID, LOCAL_ENABLED } from "../local";
import { dateTime, duration, eth } from "../lib/format";
import { randomWord } from "../lib/parse";
import {
  auctionReachesReserveAt,
  auctionRestartableAt,
  HoldingStatus,
  MAX_ITEMS,
  readAuctionPrice,
  readHoldings,
  readLicensing,
  sampledToday,
  unlockDrawState,
  type Holding,
  type HoldingLicense,
  type VaultCollection,
  type VaultState,
} from "../lib/reads";
import { href } from "../routes";
import { ReviewAgain, useTx, single } from "../tx";
import { ActionButton, Addr, Badge, Empty, PageHead, Panel, QueryView, Time } from "../ui";
import { AuctionChart, useLiveNow } from "../viz/charts";
import { auctionPriceAt, bpsPercent, drawChanceBps, requiredFloorBps, toEth, VAULT } from "../viz/curves";
import { useClock } from "../viz/motion";
import { DrawDial, LiveDot, PriceLockGauge, StatePlate, TimeLockDial, TokenTile, type TileState } from "../viz/parts";

const STATE: Record<number, Exclude<TileState, "plain">> = { 1: "locked", 2: "unlocked", 3: "auction", 4: "released" };

/** The auction's price, ticking down between reads. */
function LivePrice({ holding, halfLife, clock }: { holding: Holding; halfLife: number; clock: () => number }) {
  const now = useLiveNow(clock, true);
  const price = holding.auction ? auctionPriceAt(holding.auction, now, halfLife) : 0n;
  return <>{toEth(price).toFixed(5)}</>;
}

type Check = { state: "yes" | "no" | "wait"; label: string; text: string };

/** Where a locked holding stands against each condition of the moving lock, and why it cannot unlock yet. */
function unlockChecks(h: Holding, vault: VaultState, collection: VaultCollection | undefined, now: number): { age: number; chanceBps: number; requiredBps: number; median: bigint | undefined; checks: Check[]; blocked: string | false } {
  const draw = unlockDrawState(vault.draw, now);
  // A live draw result was rolled at the age the holding had when the draw was requested.
  const inDraw = draw.live && h.lockedUntil <= vault.draw.seedRequestedAt && h.acquiredAt <= vault.draw.seedRequestedAt;
  const age = inDraw ? vault.draw.seedRequestedAt - h.acquiredAt : now - h.acquiredAt;
  const chanceBps = drawChanceBps(age);
  const requiredBps = requiredFloorBps(age);
  const required = (h.purchasePrice * BigInt(requiredBps)) / 10_000n;
  // The unlock condition uses the median as it stood when the draw was requested; without a draw
  // result to judge, the current median is the best guide.
  const median = inDraw ? collection?.drawMedian : collection?.median;
  const medianName = inDraw ? "median as of today's draw" : "median now";
  const allowance = collection?.allowance ?? 0;
  const resetsAt = collection && collection.window.start !== 0 ? collection.window.start + VAULT.RELEASE_PERIOD : 0;

  const drawCheck: Check =
    now < h.lockedUntil
      ? { state: "wait", label: "Draw", text: `joins the daily draw ${dateTime(h.lockedUntil)}` }
      : h.picked
        ? { state: "yes", label: "Draw", text: "picked in today's draw" }
        : inDraw
          ? { state: "no", label: "Draw", text: "not picked today" }
          : { state: "wait", label: "Draw", text: "no draw result yet today" };
  const floorCheck: Check =
    median === undefined
      ? { state: "wait", label: "Floor", text: `not enough daily samples for a 30-day median (needs ${VAULT.MIN_FLOOR_SAMPLES})` }
      : { state: median >= required ? "yes" : "no", label: "Floor", text: `${medianName} ${eth(median, 4)} ETH, needs ${eth(required, 4)} ETH (${bpsPercent(requiredBps)} of the price paid)` };
  const capCheck: Check =
    allowance > 0
      ? { state: "yes", label: "Weekly cap", text: `${allowance} more of this collection can unlock this week` }
      : { state: "no", label: "Weekly cap", text: `reached; room again ${resetsAt ? dateTime(resetsAt) : "next week"}` };

  const blocked =
    !h.canUnlock &&
    (now < h.lockedUntil
      ? `It joins the daily draw ${dateTime(h.lockedUntil)}`
      : !h.picked
        ? "Today's draw did not pick it"
        : median === undefined
          ? "There is no 30-day median floor yet"
          : median < required
            ? `The 30-day median floor has to reach ${eth(required, 4)} ETH`
            : "This week's release cap for the collection is used up");
  return { age, chanceBps, requiredBps, median, checks: [drawCheck, floorCheck, capCheck], blocked };
}

export function Vault() {
  const { chainId, client, deployment: d, user, demo } = useProtocol();
  const now = useChainTime();
  const clock = useClock();
  const { run } = useTx();
  const query = useRead(["vault"], readHoldings);
  const licensing = useRead(["licences", user], (c, dep) => readLicensing(c, dep, user));
  const licenceOf = new Map<string, HoldingLicense>((licensing.data?.holdings ?? []).map((l) => [l.holding.id.toString(), l]));
  const isLocal = LOCAL_ENABLED && chainId === LOCAL_CHAIN_ID;

  const unlock = (h: Holding) =>
    void run(`Unlock vault holding #${h.id}`, single("Unlock", unlockCall(d!, h.id)), [
      "Today's draw picked this holding, the 30-day median floor is at the multiple its age requires, and the weekly cap has room.",
      "Unlocking marks it as unlocked, so the owner can auction or raffle it. No ETH is sent; you pay only the transaction fee.",
    ]);
  const sample = (collection: Address) =>
    void run("Take today's floor sample", single("Sample the floor", sampleFloorCall(d!, collection)), [
      "Records the oracle's floor for this collection today. The unlock condition uses the median of the last 30 days of these samples.",
      "One sample a day per collection; anyone may take it. No ETH is sent; you pay only the transaction fee.",
    ]);
  const requestDraw = () =>
    void run("Request today's unlock draw", single("Request the draw", requestUnlockRoundCall(d!)), [
      "Asks the randomness provider for today's random number. When it arrives, it decides which holdings are picked today.",
      "Once a day; anyone may request it. No ETH is sent; you pay only the transaction fee.",
    ]);
  const answerDrawLocally = (requestId: bigint) =>
    void run("Answer the unlock draw with mock randomness", single("Mock fulfil", mockFulfillCall(d!.vaultRandomness, requestId, randomWord())), [
      "Local chain only: answers the draw's randomness request through the mock provider.",
      "The random word comes from this browser, so this is for testing, not a fair draw.",
    ]);
  const releaseToPlayers = (h: Holding) =>
    void run(`Send holding #${h.id} to the players' raffle`, single("Send to the raffle", releaseToPlayersCall(d!, h.id)), [
      `Sends token #${h.tokenId} to the vault raffle, where points holders can win it. Anyone may do this once its 30 days are over.`,
      "No ETH is sent; you pay only the transaction fee.",
    ]);
  const startAuction = (h: Holding) =>
    void run(`Start auction for holding #${h.id}`, single("Start auction", startAuctionCall(d!, h.id)), [
      "Starts a falling-price auction for this token far above its reserve, halving every day down to the reserve.",
      "No ETH is sent; you pay only the transaction fee.",
    ]);
  const buy = (h: Holding) => {
    if (!client || !d || !h.auction) return;
    // The most this purchase may cost is fixed now, at the price on screen, and it is what the
    // review shows. An auction can be restarted at 16 times its reserve between the review and the
    // transaction: the purchase must then stop, not pay the new price.
    const maxPrice = h.auction.currentPrice;
    const call = buyCall(d, h.id, maxPrice);
    void run(
      `Catch vault holding #${h.id}`,
      async (send) => {
        const price = await readAuctionPrice(client, d, h.id);
        if (price > maxPrice) throw new ReviewAgain(`The auction price is now ${eth(price)} ETH, above the ${eth(maxPrice)} ETH you reviewed (the auction was restarted).`);
        // Exactly the reviewed maximum is sent; the contract keeps the price at inclusion and refunds the rest.
        await send(`Buy for at most ${eth(maxPrice)} ETH`, call);
      },
      [
        `You buy token #${h.tokenId} and pay at most ${eth(maxPrice, 18)} ETH. That amount is sent with the transaction.`,
        "The price keeps falling: you pay the price at the moment the transaction is mined, and the difference is refunded to you in the same transaction.",
        "If the price is higher than that maximum when you confirm, nothing is sent and you are asked to review again.",
        "The payment goes to the collection's buyback budget and the token comes to you.",
      ],
      {
        plan: [{ step: "Buy", call }],
        preview: (
          <div className="swap-preview">
            <div className="swap-side">
              <strong className="swap-amount">{eth(maxPrice, 5)} ETH</strong>
              <span>
                from you at most, likely less
                <small>to the collection's budget</small>
              </span>
            </div>
            <span className="swap-arrow" aria-hidden="true">
              ⇄
            </span>
            <div className="swap-side">
              <TokenTile tokenId={h.tokenId} size={56} />
              <span>
                Token #{h.tokenId.toString()}
                <small>to you, out of the vault</small>
              </span>
            </div>
          </div>
        ),
      },
    );
  };

  return (
    <>
      <PageHead eyebrow="Vault" title="Holdings and auctions">
        What the floor bid bought. From 90 days a holding is in a daily draw no one can predict; once picked, it unlocks if the month's median floor is up to
        30% above what was paid (less as it ages), within a weekly cap. One purchase in five goes to players after 30 days.
      </PageHead>
      <QueryView query={query} lines={6}>
        {(vault) => {
          const { holdings, holdingCount, owner, governanceWindow, auctionStartMultiple, auctionHalfLife, auctionRestartDwell } = vault;
          const isOwner = !!user && user.toLowerCase() === owner.toLowerCase();
          const auctions = holdings.filter((h) => h.status === HoldingStatus.Auction && h.auction);
          const counts = { locked: 0, unlocked: 0, auction: 0, released: 0 };
          holdings.forEach((h) => STATE[h.status] && counts[STATE[h.status]]++);
          const collectionOf = (h: Holding) => vault.collections[h.collection.toLowerCase()];
          const draw = unlockDrawState(vault.draw, now);
          const noDraw = /^0x0{40}$/i.test(vault.draw.randomness);
          const pickedNow = holdings.filter((h) => h.status === HoldingStatus.Locked && !h.players && h.picked);
          if (holdings.length === 0) {
            return (
              <Empty icon="vault" title="The vault is empty.">
                Tokens appear here when a holder sells into the floor bid.
              </Empty>
            );
          }
          return (
            <>
              <ul className="vault-tally" aria-label="Holdings by state">
                {(["locked", "unlocked", "auction", "released"] as const).map((state) => (
                  <li key={state} className={counts[state] === 0 ? "is-zero" : undefined}>
                    <strong>{counts[state]}</strong> <StatePlate state={state} />
                  </li>
                ))}
              </ul>

              <Panel title="The daily draw" aside={<span className="muted small">{demo ? "Anyone can do these. In the demo a simulated keeper does them each afternoon if you have not." : "Anyone can do these, once a day."}</span>}>
                <div className="vault-draw">
                  <div>
                    <span className="figure-label">Today's unlock draw</span>
                    {noDraw ? (
                      <p className="muted small">The vault has no randomness provider, so there is no draw: holdings unlock only by governance.</p>
                    ) : (
                      <>
                        <strong className="draw-figure">
                          {draw.inFlight ? "Waiting for its random number" : draw.live ? (pickedNow.length ? `Picked: ${pickedNow.map((h) => `#${h.id}`).join(", ")}` : "Picked no holding") : "No result yet"}
                        </strong>
                        <p className="muted small">
                          {vault.draw.requestedAt === 0 ? (
                            "No draw has been requested yet."
                          ) : (
                            <>
                              Last requested <Time at={vault.draw.requestedAt} now={now} />.{" "}
                              {draw.live && (
                                <>
                                  Its result can be used until <Time at={vault.draw.seedArrivedAt + VAULT.SEED_LIFETIME} now={now} />.{" "}
                                </>
                              )}
                              {now < draw.nextAt ? (
                                <>
                                  The next can be requested <Time at={draw.nextAt} now={now} />.
                                </>
                              ) : (
                                "The next can be requested now."
                              )}
                            </>
                          )}
                        </p>
                        <ActionButton className="secondary" onClick={requestDraw} blocked={draw.inFlight ? "Today's draw is waiting for its random number" : now < draw.nextAt && `Possible from ${dateTime(draw.nextAt)}`}>
                          Request today's draw
                        </ActionButton>
                        {isLocal && vault.draw.pending && (
                          <ActionButton className="secondary local" onClick={() => answerDrawLocally(vault.draw.requestId)}>
                            Local only: answer with mock randomness
                          </ActionButton>
                        )}
                      </>
                    )}
                  </div>
                  {Object.entries(vault.collections).map(([address, c]) => {
                    const taken = sampledToday(c, now);
                    const resetsAt = c.window.start !== 0 && now < c.window.start + VAULT.RELEASE_PERIOD ? c.window.start + VAULT.RELEASE_PERIOD : 0;
                    return (
                      <div key={address}>
                        <span className="figure-label">
                          30-day median floor · <Addr address={address as Address} />
                        </span>
                        <strong className="draw-figure">{c.median === undefined ? "Not enough samples yet" : `${eth(c.median, 4)} ETH`}</strong>
                        <p className="muted small">
                          {c.median === undefined && `It needs ${VAULT.MIN_FLOOR_SAMPLES} daily samples in the last 30 days; ${c.samples} taken so far. `}
                          {draw.live && c.drawMedian !== c.median && `As of today's draw, which is what unlocking uses: ${c.drawMedian === undefined ? "not enough samples" : `${eth(c.drawMedian, 4)} ETH`}. `}
                          {taken ? "Today's sample is taken." : "Today's sample is not taken yet."} Weekly release cap: {c.allowance} more can unlock
                          {resetsAt ? <> until <Time at={resetsAt} now={now} /></> : " this week"} ({bpsPercent(VAULT.RELEASE_CAP_BPS)} of the {c.held} held, at least one).
                        </p>
                        <ActionButton className="secondary" onClick={() => sample(address as Address)} blocked={taken && "Today's sample has been taken"}>
                          Take today's floor sample
                        </ActionButton>
                      </div>
                    );
                  })}
                </div>
              </Panel>

              {auctions.length > 0 && (
                <Panel title="On auction: a falling price to catch">
                  {auctions.map((h) => {
                    const a = h.auction!;
                    const reserveAt = auctionReachesReserveAt(a, auctionHalfLife);
                    // An unsold auction can be restarted once it has rested at the reserve for a day; one the
                    // owner priced by hand only by the owner.
                    const restartAt = auctionRestartableAt(a, auctionHalfLife, auctionRestartDwell);
                    const canRestart = now >= restartAt && (!a.ownerPriced || isOwner);
                    return (
                      <article key={h.id.toString()} className={a.atReserve ? "auction-catch at-reserve" : "auction-catch"}>
                        <header className="catch-head">
                          <TokenTile tokenId={h.tokenId} size={72} state="auction" />
                          <div>
                            <h3>
                              Token #{h.tokenId.toString()} <span className="muted">· holding #{h.id.toString()}</span>
                            </h3>
                            <p className="muted small">
                              <Addr address={h.collection} /> · the vault paid {eth(h.purchasePrice, 4)} ETH
                              {a.ownerPriced && " · priced by the owner"}
                            </p>
                          </div>
                        </header>
                        <div className="catch-body">
                          <AuctionChart auction={a} halfLife={auctionHalfLife} clock={clock} />
                          <div className="catch-side">
                            <span className="figure-label">
                              <LiveDot /> Price now
                            </span>
                            <strong className="catch-price">
                              <LivePrice holding={h} halfLife={auctionHalfLife} clock={clock} /> <small>ETH</small>
                            </strong>
                            <p className="muted small">
                              Opened at {eth(a.startPrice, 4)} ETH and halves every {duration(auctionHalfLife)}.{" "}
                              {a.atReserve ? (
                                now >= restartAt ? (
                                  "It has reached the reserve and waits there, unsold."
                                ) : (
                                  <>
                                    It has reached the reserve and rests there; it can be restarted <Time at={restartAt} now={now} />.
                                  </>
                                )
                              ) : (
                                <>
                                  It reaches the {eth(a.endPrice, 4)} ETH reserve <Time at={reserveAt} now={now} />.
                                </>
                              )}
                            </p>
                            <ActionButton className="big catch-btn" onClick={() => buy(h)}>
                              Catch it
                            </ActionButton>
                            {canRestart && (
                              <ActionButton className="secondary" onClick={() => startAuction(h)}>
                                Restart the auction
                              </ActionButton>
                            )}
                            <p className="muted small">The first buyer sets the price; with a single interested buyer that is the reserve. Proceeds go to the collection's buyback budget.</p>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </Panel>
              )}

              <Panel
                title="In the vault"
                aside={holdingCount > BigInt(holdings.length) ? <span className="muted small">Showing the latest {MAX_ITEMS} of {holdingCount.toString()}</span> : undefined}
              >
                <div className="vault-wall">
                  {holdings.map((h) => {
                    const state = STATE[h.status] ?? "released";
                    const windowEnds = h.unlockedAt + governanceWindow;
                    const licence = licenceOf.get(h.id.toString());
                    const collection = collectionOf(h);
                    const lock = state === "locked" && !h.players ? unlockChecks(h, vault, collection, now) : undefined;
                    const playersDue = now >= h.lockedUntil;
                    return (
                      <article key={h.id.toString()} className={`holding is-${state}`}>
                        <div className="holding-door">
                          <TokenTile tokenId={h.tokenId} size={96} state={state} />
                          <StatePlate state={state} />
                        </div>
                        <div className="holding-main">
                          <h3>
                            Token #{h.tokenId.toString()} <span className="muted">· holding #{h.id.toString()}</span>
                            {(h.players || lock?.checks[0].state === "yes") && (
                              <span className="holding-tags">
                                {h.players && <Badge tone="accent">For players</Badge>}
                                {lock?.checks[0].state === "yes" && <Badge tone="good">Picked today</Badge>}
                              </span>
                            )}
                          </h3>
                          <p className="muted small">
                            <Addr address={h.collection} /> · bought for {eth(h.purchasePrice, 4)} ETH <Time at={h.acquiredAt} now={now} />
                          </p>

                          {lock && (
                            <>
                              <div className="holding-locks">
                                <DrawDial age={now - h.acquiredAt} chanceBps={lock.chanceBps} eligibleIn={h.lockedUntil - now} picked={h.picked} size={78}>
                                  {now < h.lockedUntil
                                    ? `Joins ${dateTime(h.lockedUntil)}, at ${bpsPercent(drawChanceBps(VAULT.MIN_LOCK))} a day, rising to ${bpsPercent(VAULT.DRAW_END_BPS)} at a year.`
                                    : `${bpsPercent(lock.chanceBps)} chance in each daily draw at this age, rising to ${bpsPercent(VAULT.DRAW_END_BPS)} at a year.`}
                                </DrawDial>
                                <PriceLockGauge
                                  purchasePrice={h.purchasePrice}
                                  floor={lock.median}
                                  requiredBps={lock.requiredBps}
                                  title={`Floor ${bpsPercent(lock.requiredBps)}`}
                                  floorLabel="30-day median"
                                  floorNote={`No 30-day median yet: it needs ${VAULT.MIN_FLOOR_SAMPLES} daily samples.`}
                                />
                              </div>
                              <ul className="unlock-checks" aria-label="Unlock conditions">
                                {lock.checks.map((c) => (
                                  <li key={c.label} className={`is-${c.state}`}>
                                    <i aria-hidden="true" />
                                    <span>
                                      <strong>{c.label}:</strong> {c.text}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              <div className="holding-actions">
                                <ActionButton onClick={() => unlock(h)} blocked={lock.blocked}>
                                  Unlock
                                </ActionButton>
                                <span className="muted small">{h.canUnlock ? "All three conditions are met. Anyone can unlock it until today's result expires." : "Anyone can unlock it on a day all three are met."}</span>
                              </div>
                            </>
                          )}
                          {state === "locked" && h.players && (
                            <>
                              <div className="holding-locks">
                                <TimeLockDial
                                  acquiredAt={h.acquiredAt}
                                  lockedUntil={h.lockedUntil}
                                  now={now}
                                  size={78}
                                  title="Players' share"
                                  waitText={(left) => `Goes to the players' raffle in ${left}.`}
                                  openText="Its 30 days are over: it can go to the players' raffle."
                                />
                              </div>
                              <div className="holding-actions">
                                <ActionButton onClick={() => releaseToPlayers(h)} blocked={!playersDue && `Possible from ${dateTime(h.lockedUntil)}`}>
                                  Send to the players' raffle
                                </ActionButton>
                                <span className="muted small">Set aside for players: it is never sold. Points holders can win it in a vault raffle.</span>
                              </div>
                            </>
                          )}
                          {state === "unlocked" && (
                            <div className="holding-actions">
                              <ActionButton onClick={() => startAuction(h)} blocked={!isOwner && now < windowEnds && `Only the owner can start it until ${dateTime(windowEnds)}`}>
                                Start the auction
                              </ActionButton>
                              <span className="muted small">
                                Unlocked <Time at={h.unlockedAt} now={now} />. The owner can auction, raffle or relock it; from {dateTime(windowEnds)} anyone can start the auction.
                              </span>
                            </div>
                          )}
                          {state === "auction" && h.auction && (
                            <p className="small">
                              On auction at <strong>{eth(h.auction.currentPrice, 4)} ETH</strong>, falling to a reserve of {eth(h.auction.endPrice, 4)} ETH. Catch it above.
                            </p>
                          )}
                          {state === "released" && <p className="muted small">{h.players ? "Went to the players' raffle." : "Left the vault: sold at auction or raffled."}</p>}

                          {licence && (
                            <p className="holding-licence small">
                              <span className="figure-label">Artwork licences</span>
                              {licence.tiers.length === 0 ? (
                                <span className="muted">No tiers set for this collection.</span>
                              ) : (
                                <span>
                                  {licence.tiers.map((t) => `Tier ${t.tier}: ${t.price === 0n ? "free" : `${eth(t.price)} ETH`} / ${duration(t.duration)}`).join(" · ")}
                                </span>
                              )}
                              {licence.licenses.length > 0 && <span className="ok">Yours: {licence.licenses.map((l) => `tier ${l.tier} until ${dateTime(l.end)}`).join(", ")}</span>}
                              {state === "locked" && !h.players && licence.tiers.length > 0 && <a href={`${href("/vault/licences")}?holding=${h.id}`}>Request a licence</a>}
                              {state === "locked" && h.players && <span className="muted">No licences: it goes to the players' raffle.</span>}
                              {state !== "locked" && <span className="muted">No new licences: only locked holdings can be licensed.</span>}
                            </p>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </Panel>

              <details className="fine-print">
                <summary>The vault's rules in full</summary>
                <p className="muted">
                  For {duration(VAULT.MIN_LOCK)} after purchase a holding takes no part in the unlock draw. After that, a random number is requested once
                  a day; it picks each holding with a chance that rises with age, from {bpsPercent(VAULT.DRAW_START_BPS)} at 90 days to{" "}
                  {bpsPercent(VAULT.DRAW_END_BPS)} at a year, so nobody can know an unlock date in advance. A picked holding can be unlocked that day if the
                  collection's median floor over the last 30 daily samples, as it stood when the draw was requested, (at least {VAULT.MIN_FLOOR_SAMPLES} of them) is at least a multiple of what the
                  vault paid: {bpsPercent(VAULT.UNLOCK_START_BPS)} at 90 days, falling evenly to {bpsPercent(VAULT.UNLOCK_END_BPS)} at a year, never below
                  the price paid. At most {bpsPercent(VAULT.RELEASE_CAP_BPS)} of a collection's holdings (and at least one) unlock in any{" "}
                  {duration(VAULT.RELEASE_PERIOD)}. If the floor never gets there a holding stays locked unless the owner releases it.
                </p>
                <p className="muted">
                  Why: a fixed date let traders see supply coming, a single oracle reading could be pushed for a moment, and in a falling market most
                  holdings never unlocked at all.
                </p>
                <p className="muted">
                  {vault.playersShareBps > 0
                    ? `One purchase in ${Math.round(10_000 / vault.playersShareBps)} (${bpsPercent(vault.playersShareBps)}) is set aside for players. `
                    : "The players' share is switched off. "}
                  Such a holding is never sold: after {duration(VAULT.PLAYERS_LOCK)} anyone can send it to the vault raffle, where points holders can win it.
                </p>
                <p className="muted">
                  After unlocking, the owner can auction, raffle or relock a holding; anyone can start the auction once the governance window of{" "}
                  {duration(governanceWindow)} has passed. An auction opens at {auctionStartMultiple} times its reserve (or the floor at unlock, if higher)
                  and halves every {duration(auctionHalfLife)} until it reaches the reserve, which is the highest of the floor, the multiple the holding
                  unlocked at (130% after a governance unlock) and an owner-set minimum. An unsold auction can be restarted once it has rested at the reserve
                  for {duration(auctionRestartDwell)}. Auctions start far above the market on purpose and fall until someone buys. Proceeds return to the
                  buyback budget; selling one token brings in about enough to buy one back.
                </p>
              </details>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
