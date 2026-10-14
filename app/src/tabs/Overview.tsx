// The overview as a living dashboard: the flywheel drawn with this collection's real numbers, the
// figures that matter, what to do next, and a stream of what actually happened. Nothing on this page
// moves unless the protocol (or, in demo mode, the simulation) changed.
import { useEffect, useRef } from "react";
import type { Address } from "viem";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { claimProjectShareCall, flushPointsCall } from "../lib/calls";
import { bps, dateTime, eth, points } from "../lib/format";
import { HoldingStatus, readActivity, readHoldings, readOverview, type ActivityItem, type Floor, type Overview as OverviewData } from "../lib/reads";
import { href } from "../routes";
import { useTx, single } from "../tx";
import { ActionButton, Addr, Badge, Empty, PageHead, Panel, QueryView, Time } from "../ui";
import { BID_STATE_TEXT, bidState } from "../viz/charts";
import { auctionEndsAt, toEth } from "../viz/curves";
import { Flywheel, type FlyData, type FlyFlow, type FlyHandle, type FlyTile } from "../viz/Flywheel";
import { Num, useWidth } from "../viz/motion";
import { LiveDot } from "../viz/parts";
import { LOGS_FROM_BLOCK } from "../wagmi";

const f4 = (n: number) => n.toFixed(4);

function Figure({ label, children, hint, tone }: { label: string; children: React.ReactNode; hint?: React.ReactNode; tone?: "accent" | "warn" }) {
  return (
    <div className={tone ? `figure tone-${tone}` : "figure"}>
      <div className="figure-label">{label}</div>
      <div className="figure-value">{children}</div>
      {hint && <div className="figure-hint">{hint}</div>}
    </div>
  );
}

function FloorFigure({ label, floor, now, usedBy }: { label: string; floor: Floor; now: number; usedBy: string }) {
  if (!floor.ok) {
    return (
      <Figure label={label} hint={`${floor.reason} ${usedBy}`}>
        <Badge tone="muted">No price</Badge>
      </Figure>
    );
  }
  return (
    <Figure
      label={label}
      hint={
        <>
          Updated <Time at={floor.updatedAt} now={now} />. {usedBy}
        </>
      }
    >
      <Num value={toEth(floor.price)} format={f4} /> <small>ETH</small>
    </Figure>
  );
}

/** Which flow of the diagram an activity item travelled along. */
function flowOf(item: ActivityItem | undefined): FlyFlow {
  if (!item) return "more";
  if (item.module === "Marketplace") return "trade";
  if (item.module === "Games") return "games";
  if (item.module === "Floor bid" && /auction/i.test(item.text)) return "proceeds";
  return "more";
}

const MODULE_TONE: Record<string, string> = { Marketplace: "trade", "Floor bid": "bid", Games: "games", Lottery: "pots", "Ticket raffle": "pots", Predictions: "pots" };

const HOW_IT_WORKS = [
  ["Offers, not listings", "Buyers post ETH offers on one token or on a whole collection, and holders accept. A 2% fee goes to the Treasury; a project can be given up to half of its collection's fees, and the rest is that collection's buyback budget."],
  ["A bid that finds the lowest price", "The protocol quotes a standing bid for each collection. Its curve rises until a holder sells into it, then steps down and rises again. The bid is never more than the budget can pay, and the rise only counts while the budget covers it."],
  ["A vault that holds", "Bought tokens are locked for at least 180 days and until the floor is 30% above their purchase price. Then they are auctioned, with proceeds returning to the budget, or raffled. If the floor never gets there they stay locked unless the owner releases them."],
  ["Other fees feed the same budget", "Prediction markets (3% of winnings), dice and slots (half of the 2% edge; the bankroll keeps the other half), the lottery and ticket raffles (5% of the pot) and artwork licences all pay into the budget of the collection the user backs."],
  ["Points", "Each fee is credited once as points, split between the two sides of a trade. Activated points are a user's weight in vault raffles. They are not transferable, and they can be bought by trading with oneself."],
  ["What it is not", "There is no token and no promise of a price or a profit. The buying is modest (about one token for every fifty traded), each budget only ever buys its own collection, and the software is unaudited."],
] as const;

function Machine({ collection, o, now }: { collection: Address; o: OverviewData; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 900);
  const fly = useRef<FlyHandle>(null);
  const vault = useRead(["vault"], readHoldings);
  const activity = useRead(["activity", collection], (client, dep) => readActivity(client, dep, collection, LOGS_FROM_BLOCK));
  const bid = o.floorBid;

  const held = (vault.data?.holdings ?? []).filter((h) => h.collection.toLowerCase() === collection.toLowerCase() && h.status !== HoldingStatus.Released && h.status !== HoldingStatus.None);
  const tiles: FlyTile[] = held
    .map((h) => ({ key: h.id.toString(), state: h.status === HoldingStatus.Auction ? ("auction" as const) : h.status === HoldingStatus.Unlocked ? ("unlocked" as const) : ("locked" as const) }))
    .reverse();
  const onAuction = held.find((h) => h.auction);
  const halfLife = vault.data?.auctionHalfLife ?? 86_400;
  const data: FlyData = {
    budget: toEth(bid.budget),
    bid: toEth(bid.currentBid),
    curve: toEth(bid.curvePrice),
    bidBase: toEth(bid.basePrice),
    bidCap: toEth(bid.maxPrice),
    minBid: toEth(bid.minBid),
    tiles,
    auction: onAuction?.auction
      ? {
          price: toEth(onAuction.auction.currentPrice),
          reserve: toEth(onAuction.auction.endPrice),
          progress: Math.min(1, (now - onAuction.auction.startTime) / Math.max(1, auctionEndsAt(onAuction.auction, halfLife) - onAuction.auction.startTime)),
        }
      : undefined,
  };

  // A particle travels when, and only when, the budget or the vault actually changed.
  const last = useRef<{ budget: bigint; held: number }>();
  const newest = activity.data?.[0];
  useEffect(() => {
    const before = last.current;
    last.current = { budget: bid.budget, held: held.length };
    if (!before) return;
    const delta = bid.budget - before.budget;
    if (delta > 0n) fly.current?.emit(flowOf(newest), "eth", `+${eth(delta, 4)}`);
    if (delta < 0n) {
      fly.current?.emit("pay", "eth", `${eth(-delta, 4)} ETH`);
      window.setTimeout(() => fly.current?.emit("deposit", "nft"), 260);
    }
    // `newest` is read at the moment of the change; it is not itself a reason to emit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid.budget, held.length]);

  return (
    <div className="ov-machine" ref={box}>
      <Flywheel
        ref={fly}
        layout={width < 720 ? "tall" : "strip"}
        data={data}
        label={`The flywheel for this collection: a budget of ${eth(bid.budget, 4)} ETH, a bid of ${eth(bid.currentBid, 4)} ETH, ${tiles.length} token${tiles.length === 1 ? "" : "s"} in the vault${onAuction ? ", one of them on auction" : ""}.`}
      />
      <p className="ov-machine-note small muted">
        <LiveDot /> This collection's real numbers. A dot travels only when something happened: a fee reaching the budget, a sale into the bid, auction proceeds
        coming back.
      </p>
    </div>
  );
}

export function Overview({ collection }: { collection: Address }) {
  const { user, deployment: d } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["overview", collection, user], (client, dep) => readOverview(client, dep, collection, user));
  const activity = useRead(["activity", collection], (client, dep) => readActivity(client, dep, collection, LOGS_FROM_BLOCK));

  return (
    <>
      <PageHead
        eyebrow="Overview"
        title="The flywheel, right now"
        aside={
          <>
            <span className="muted small">Collection</span> <Addr address={collection} />
            {query.data && (query.data.marketplaceSupported ? <Badge tone="good">Supported</Badge> : <Badge tone="warn">Not supported</Badge>)}
          </>
        }
      >
        {query.data && !query.data.marketplaceSupported
          ? "This collection can be traded, but it is not part of the flywheel: its fees go to the unallocated pool and earn no points."
          : "The part of each fee earned on this collection that is not paid to its project becomes a budget for buying its cheapest tokens."}
      </PageHead>

      <QueryView query={query} lines={6}>
        {(o) => {
          const bid = o.floorBid;
          const state = bidState(bid, now);
          const limited = state === "budget" || state === "empty";
          const share = o.userPoints !== undefined && o.totalPoints > 0n ? Number((o.userPoints * 1_000_000n) / o.totalPoints) / 10_000 : undefined;
          return (
            <>
              <Machine collection={collection} o={o} now={now} />

              <Panel title="What you can do">
                <div className="next-actions">
                  <a className="next-action primary" href={href("/trade/floor-bid")}>
                    <span className="next-kicker">Floor bid · {BID_STATE_TEXT[state].toLowerCase()}</span>
                    <strong>Sell into the bid</strong>
                    <span className="next-figure">
                      <Num value={toEth(bid.currentBid)} format={f4} /> <small>ETH, no fee</small>
                    </span>
                  </a>
                  <a className="next-action" href={href("/trade/marketplace")}>
                    <span className="next-kicker">Marketplace · 2% fee</span>
                    <strong>Make or accept an offer</strong>
                    <span className="muted small">Offers on one token or on any token of the collection.</span>
                  </a>
                  <a className="next-action" href={href("/vault/holdings")}>
                    <span className="next-kicker">Vault · {o.collectionHoldingsInVault} held</span>
                    <strong>See the locks and auctions</strong>
                    <span className="muted small">180 days and a floor 30% up, then a falling price to catch.</span>
                  </a>
                  <a className="next-action" href={href("/play/dice")}>
                    <span className="next-kicker">Play · negative expected return</span>
                    <strong>Dice, slots, lottery</strong>
                    <span className="muted small">The fee on each game funds this collection's budget.</span>
                  </a>
                </div>
              </Panel>

              <Panel title="Key figures">
                <div className="figures">
                  <Figure label="Buyback budget" tone="accent" hint={`Only ever spent on this collection${o.projectShare.bps > 0 ? `, after ${bps(o.projectShare.bps)} of fees to the project` : ""}`}>
                    <Num value={toEth(bid.budget)} format={f4} /> <small>ETH</small>
                  </Figure>
                  <Figure
                    label="Floor bid"
                    tone={limited ? "warn" : undefined}
                    hint={
                      !bid.active
                        ? "The owner has not configured a bid for this collection"
                        : limited
                          ? `The curve is at ${eth(bid.curvePrice, 4)} ETH; the budget can pay ${eth(bid.budget, 4)}, so that is the bid.`
                          : `The curve, from ${eth(bid.basePrice, 4)} ETH on ${dateTime(bid.lastReset)}, +${bps(bid.growthBpsPerDay)} a day, capped at ${eth(bid.maxPrice)} ETH, −${bps(bid.stepDownBps)} after a sale`
                    }
                  >
                    {bid.active ? (
                      <>
                        <Num value={toEth(bid.currentBid)} format={f4} /> <small>ETH</small>
                      </>
                    ) : (
                      <Badge tone="muted">No active bid</Badge>
                    )}
                  </Figure>
                  <Figure
                    label="Bid state"
                    hint={
                      state === "cooldown"
                        ? `Pausing between sales until ${dateTime(bid.nextFillAt)}`
                        : state === "empty"
                          ? `The budget holds less than the minimum bid of ${eth(bid.minBid, 4)} ETH, so there is nothing to bid with`
                          : state === "budget"
                            ? "The rise does not count while the budget cannot cover the curve; new money restarts the curve"
                            : state === "capped"
                              ? "The curve has reached the owner's maximum price"
                              : state === "inactive"
                                ? "No active bid"
                                : "The budget covers the curve"
                    }
                  >
                    <Badge tone={state === "rising" ? "good" : state === "inactive" ? "muted" : "warn"}>{BID_STATE_TEXT[state]}</Badge>
                  </Figure>
                  <FloorFigure label="Sales oracle floor" floor={o.salesFloor} now={now} usedBy="Used by the vault." />
                  <FloorFigure label="Push oracle floor" floor={o.pushFloor} now={now} usedBy="Used by prediction markets." />
                  <Figure label="Vault holdings" hint={`Of this collection, still in the vault. ${o.holdingCount.toString()} deposits registered across all collections.`}>
                    <Num value={o.collectionHoldingsInVault} format={(n) => Math.round(n).toString()} />
                    {o.holdingsTruncated ? "+" : ""}
                  </Figure>
                  <Figure
                    label="Project share"
                    hint={
                      o.projectShare.bps > 0 ? (
                        <>
                          Of this collection's fees, paid to <Addr address={o.projectShare.recipient} />. The rest funds buybacks.
                        </>
                      ) : (
                        "All of this collection's protocol fees fund buybacks."
                      )
                    }
                  >
                    {o.projectShare.bps > 0 ? bps(o.projectShare.bps) : <Badge tone="muted">None</Badge>}
                  </Figure>
                  <Figure label="Total active points" hint={o.pointsFrozen ? "A raffle draw is in flight: pending points cannot be activated until it ends" : "Across all users; fees earn pending points, activated points count"}>
                    <Num value={toEth(o.totalPoints)} format={(n) => n.toFixed(2)} />
                  </Figure>
                </div>
              </Panel>

              <Panel title="Your position">
                {!user ? (
                  <Empty title="Connect a wallet to see your points and anything owed to you." />
                ) : (
                  <div className="figures">
                    <Figure
                      label="Your points"
                      hint={
                        <>
                          Active: your weight in vault raffles{share !== undefined && `, ${share}% of all active points`}.
                          {o.userPendingPoints ? (
                            <span className="pending">
                              {points(o.userPendingPoints)} pending. Pending points do not count until activated.
                              <ActionButton
                                className="small"
                                onClick={() =>
                                  d &&
                                  void run("Activate pending points", single("Activate points", flushPointsCall(d, user)), [
                                    `Moves your ${points(o.userPendingPoints!)} pending points into your active balance, so they count in vault raffles.`,
                                    "No ETH is sent; you pay only the transaction fee.",
                                  ])
                                }
                                blocked={o.pointsFrozen && "A raffle draw is in flight; try again when it has ended"}
                              >
                                Activate
                              </ActionButton>
                            </span>
                          ) : (
                            " Nothing pending."
                          )}
                        </>
                      }
                    >
                      <Num value={toEth(o.userPoints ?? 0n)} format={(n) => n.toFixed(2)} />
                    </Figure>
                    <Figure
                      label="Project share owed to you"
                      hint={
                        o.userProjectShareOwed ? (
                          <span className="pending">
                            Accrued to your address as a project's fee recipient.
                            <ActionButton
                              className="small"
                              onClick={() => d && void run("Claim project share", single("Claim", claimProjectShareCall(d)), [`You receive ${eth(o.userProjectShareOwed!)} ETH from the Treasury.`])}
                            >
                              Claim
                            </ActionButton>
                          </span>
                        ) : (
                          "Only a project's fee recipient accrues a share."
                        )
                      }
                    >
                      {eth(o.userProjectShareOwed ?? 0n)} <small>ETH</small>
                    </Figure>
                  </div>
                )}
              </Panel>
            </>
          );
        }}
      </QueryView>

      <Panel title="What happened" aside={<span className="muted small">From the protocol's events for this collection, newest first</span>}>
        <QueryView query={activity}>
          {(items) =>
            items.length === 0 ? (
              <Empty icon="stream" title="Nothing has happened yet for this collection.">
                Events appear here as people trade, play and sell into the bid.
              </Empty>
            ) : (
              <ol className="stream">
                {items.map((item) => (
                  <li key={item.key} className={`stream-item tone-${MODULE_TONE[item.module] ?? "other"}`}>
                    <i className="stream-dot" aria-hidden="true" />
                    <a className="stream-module" href={href(item.route)}>
                      {item.module}
                    </a>
                    <span className="stream-text">
                      {item.text}
                      {item.actor && (
                        <>
                          {" "}
                          by <Addr address={item.actor} />
                        </>
                      )}
                    </span>
                    <span className="stream-time muted small">{item.time !== undefined ? <Time at={item.time} now={now} /> : `block ${item.blockNumber}`}</span>
                  </li>
                ))}
              </ol>
            )
          }
        </QueryView>
      </Panel>

      <Panel title="How it works, in six lines">
        <ol className="how-lines">
          {HOW_IT_WORKS.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
