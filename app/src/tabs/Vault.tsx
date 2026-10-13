// The vault: what the bid bought, as objects behind two locks, and the auctions that release them
// as a falling price to catch. Every state is read from the Vault contract (or the demo).
import type { Address } from "viem";
import { buyCall, startAuctionCall, unlockCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { dateTime, duration, eth } from "../lib/format";
import { auctionReachesReserveAt, HoldingStatus, MAX_ITEMS, readAuctionPrice, readHoldings, readLicensing, type Holding, type HoldingLicense } from "../lib/reads";
import { href } from "../routes";
import { useTx } from "../tx";
import { ActionButton, Addr, Empty, PageHead, Panel, QueryView, Time } from "../ui";
import { AuctionChart, useLiveNow } from "../viz/charts";
import { auctionPriceAt, toEth, unlockPrice } from "../viz/curves";
import { readSalesFloors } from "../viz/data";
import { useClock } from "../viz/motion";
import { LiveDot, PriceLockGauge, StatePlate, TimeLockDial, TokenTile, type TileState } from "../viz/parts";

const STATE: Record<number, Exclude<TileState, "plain">> = { 1: "locked", 2: "unlocked", 3: "auction", 4: "released" };

/** The auction's price, ticking down between reads. */
function LivePrice({ holding, halfLife, clock }: { holding: Holding; halfLife: number; clock: () => number }) {
  const now = useLiveNow(clock, true);
  const price = holding.auction ? auctionPriceAt(holding.auction, now, halfLife) : 0n;
  return <>{toEth(price).toFixed(5)}</>;
}

export function Vault() {
  const { client, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const clock = useClock();
  const { run } = useTx();
  const query = useRead(["vault"], readHoldings);
  const licensing = useRead(["licences", user], (c, dep) => readLicensing(c, dep, user));
  const collections = [...new Set((query.data?.holdings ?? []).map((h) => h.collection.toLowerCase()))].sort();
  const floors = useRead(["vaultFloors", collections.join(",")], (c, dep) => readSalesFloors(c, dep, collections as Address[]), collections.length > 0);
  const licenceOf = new Map<string, HoldingLicense>((licensing.data?.holdings ?? []).map((l) => [l.holding.id.toString(), l]));

  const unlock = (h: Holding) =>
    void run(`Unlock vault holding #${h.id}`, (send) => send("Unlock", unlockCall(d!, h.id)), [
      "Marks the holding as unlocked, so the owner can auction or raffle it. No ETH is sent; you pay only the transaction fee.",
    ]);
  const startAuction = (h: Holding) =>
    void run(`Start auction for holding #${h.id}`, (send) => send("Start auction", startAuctionCall(d!, h.id)), [
      "Starts a falling-price auction for this token far above its reserve, halving every day down to the reserve.",
      "No ETH is sent; you pay only the transaction fee.",
    ]);
  const buy = (h: Holding) =>
    void run(
      `Catch vault holding #${h.id}`,
      async (send) => {
        // The price only falls, so the price read now always covers the price at inclusion; the
        // contract refunds the difference (see buyCall for why it sends one wei more).
        const price = await readAuctionPrice(client!, d!, h.id);
        await send(`Buy at ${eth(price)} ETH`, buyCall(d!, h.id, price));
      },
      [
        `You buy token #${h.tokenId} at the auction's current price${h.auction ? `, about ${eth(h.auction.currentPrice)} ETH` : ""}.`,
        "The price keeps falling: you pay the price at the moment the transaction is mined, and anything sent above it is refunded.",
        "The payment goes to the collection's buyback budget and the token comes to you.",
      ],
      {
        preview: (
          <div className="swap-preview">
            <div className="swap-side">
              <strong className="swap-amount">{h.auction ? eth(h.auction.currentPrice, 5) : "–"} ETH</strong>
              <span>
                from you, or less
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

  return (
    <>
      <PageHead eyebrow="Vault" title="Holdings and auctions">
        What the floor bid bought. Each token sits behind two locks, 180 days and a floor 30% above its purchase price, and leaves by a falling-price
        auction or a raffle.
      </PageHead>
      <QueryView query={query} lines={6}>
        {({ holdings, holdingCount, owner, governanceWindow, auctionStartMultiple, auctionHalfLife }) => {
          const isOwner = !!user && user.toLowerCase() === owner.toLowerCase();
          const auctions = holdings.filter((h) => h.status === HoldingStatus.Auction && h.auction);
          const counts = { locked: 0, unlocked: 0, auction: 0, released: 0 };
          holdings.forEach((h) => STATE[h.status] && counts[STATE[h.status]]++);
          const floorOf = (h: Holding) => {
            const floor = floors.data?.[h.collection.toLowerCase()];
            return floor?.ok ? floor.price : undefined;
          };
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

              {auctions.length > 0 && (
                <Panel title="On auction: a falling price to catch">
                  {auctions.map((h) => {
                    const a = h.auction!;
                    const reserveAt = auctionReachesReserveAt(a, auctionHalfLife);
                    // An unsold auction can be restarted once its price sits at the reserve; one the
                    // owner priced by hand only by the owner.
                    const canRestart = a.atReserve && (!a.ownerPriced || isOwner);
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
                                "It has reached the reserve and waits there, unsold."
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
                    const floor = floors.data?.[h.collection.toLowerCase()];
                    return (
                      <article key={h.id.toString()} className={`holding is-${state}`}>
                        <div className="holding-door">
                          <TokenTile tokenId={h.tokenId} size={96} state={state} />
                          <StatePlate state={state} />
                        </div>
                        <div className="holding-main">
                          <h3>
                            Token #{h.tokenId.toString()} <span className="muted">· holding #{h.id.toString()}</span>
                          </h3>
                          <p className="muted small">
                            <Addr address={h.collection} /> · bought for {eth(h.purchasePrice, 4)} ETH <Time at={h.acquiredAt} now={now} />
                          </p>

                          {state === "locked" && (
                            <>
                              <div className="holding-locks">
                                <TimeLockDial acquiredAt={h.acquiredAt} lockedUntil={h.lockedUntil} now={now} size={78} />
                                <PriceLockGauge purchasePrice={h.purchasePrice} floor={floorOf(h)} floorNote={floor && !floor.ok ? `No floor price: ${floor.reason}` : undefined} />
                              </div>
                              <div className="holding-actions">
                                <ActionButton onClick={() => unlock(h)} blocked={!h.canUnlock && "Both locks have to be open: the time lock, and a fresh floor at 130% of the purchase price"}>
                                  Unlock
                                </ActionButton>
                                <span className="muted small">{h.canUnlock ? "Both locks are open. Anyone can unlock it." : `Opens at a floor of ${eth(unlockPrice(h.purchasePrice), 4)} ETH, not before ${dateTime(h.lockedUntil)}.`}</span>
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
                          {state === "released" && <p className="muted small">Left the vault: sold at auction or raffled.</p>}

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
                              {state === "locked" && licence.tiers.length > 0 && <a href={`${href("/vault/licences")}?holding=${h.id}`}>Request a licence</a>}
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
                  A holding unlocks once its lock has ended and the sales-oracle floor is fresh and at least 130% of the purchase price. If the floor never
                  gets there it stays locked unless the owner releases it. After unlocking, the owner can auction, raffle or relock it; anyone can start the
                  auction once the governance window of {duration(governanceWindow)} has passed. An auction opens at {auctionStartMultiple} times its reserve
                  (or the floor at unlock, if higher) and halves every {duration(auctionHalfLife)} until it reaches the reserve, which is the highest of the
                  floor, 130% of the purchase price and an owner-set minimum. An unsold auction can be restarted once its price sits at the reserve.
                  Auctions start far above the market on purpose and fall until someone buys. Proceeds return to the buyback budget; selling one token
                  brings in about enough to buy one back.
                </p>
              </details>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
