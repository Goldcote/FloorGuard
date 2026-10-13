import type { Address } from "viem";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { claimProjectShareCall, flushPointsCall } from "../lib/calls";
import { bps, dateTime, eth, points } from "../lib/format";
import { readActivity, readOverview, type Floor } from "../lib/reads";
import { href } from "../routes";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, QueryView, Stat, Time } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";

function FloorStat({ label, floor, now, usedBy }: { label: string; floor: Floor; now: number; usedBy: string }) {
  if (!floor.ok) {
    return <Stat label={label} value={<Badge tone="muted">No price</Badge>} hint={`${floor.reason} ${usedBy}`} />;
  }
  return (
    <Stat
      label={label}
      value={`${eth(floor.price)} ETH`}
      hint={
        <>
          Updated <Time at={floor.updatedAt} now={now} />. {usedBy}
        </>
      }
    />
  );
}

const HOW_IT_WORKS = [
  ["Offers, not listings", "Buyers post ETH offers on one token or on a whole collection, and holders accept. A 2% fee goes to the collection's own buyback budget."],
  ["A bid that finds the floor", "The protocol quotes a standing bid for each collection. It rises over time until a holder sells into it, then steps down and rises again."],
  ["A vault that holds", "Bought NFTs are locked for at least 180 days and until the floor is 30% above their purchase price. Then they are auctioned, with proceeds returning to the budget, or raffled."],
  ["Other fees feed the same budget", "Prediction markets, dice, slots, the lottery, ticket raffles and artwork licences all pay their fee into the budget of the collection the user backs."],
  ["Points", "Users earn points for the fees they generate. Points are their odds of winning NFTs raffled from the vault; they are not transferable."],
  ["What it is not", "There is no token and no promise of profit. Each budget only ever buys its own collection's floor, and the software is unaudited."],
] as const;

export function Overview({ collection }: { collection: Address }) {
  const { user, deployment: d } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["overview", collection, user], (client, dep) => readOverview(client, dep, collection, user));
  const activity = useRead(["activity", collection], (client, dep) => readActivity(client, dep, collection, LOGS_FROM_BLOCK));

  return (
    <>
      <QueryView query={query} lines={6}>
        {(o) => {
          const bid = o.floorBid;
          const fillable = bid.isFillable && now >= bid.nextFillAt;
          const share =
            o.userPoints !== undefined && o.totalPoints > 0n ? Number((o.userPoints * 1_000_000n) / o.totalPoints) / 10_000 : undefined;
          return (
            <>
              <section className="hero card">
                <div>
                  <p className="eyebrow">Collection</p>
                  <p className="hero-title">
                    <Addr address={collection} />{" "}
                    {o.marketplaceSupported ? <Badge tone="good">Supported</Badge> : <Badge tone="warn">Not supported</Badge>}
                  </p>
                  <p className="muted">
                    {o.marketplaceSupported
                      ? "Every fee earned on this collection becomes a budget for buying its floor."
                      : "This collection can be traded, but it is not part of the flywheel: its fees go to the unallocated pool and earn no points."}
                  </p>
                </div>
                <div className="hero-actions">
                  <a className="btn" href={href("/trade/floor-bid")}>
                    Sell into the floor bid
                  </a>
                  <a className="btn secondary" href={href("/trade/marketplace")}>
                    Make or accept an offer
                  </a>
                  <a className="btn secondary" href={href("/play/dice")}>
                    Play
                  </a>
                </div>
              </section>

              <Card title="The flywheel right now">
                <ol className="flywheel">
                  <li>
                    <span className="step-label">Fees in</span>
                    <strong>Trades, bets, tickets</strong>
                    <span className="muted small">2% of sales, 3% of prediction winnings, the 2% games edge, 5% of lottery and raffle pots, licence fees</span>
                  </li>
                  <li>
                    <span className="step-label">Budget</span>
                    <strong>{eth(bid.budget)} ETH</strong>
                    <span className="muted small">
                      Earmarked for this collection
                      {o.projectShare.bps > 0 && `, after ${bps(o.projectShare.bps)} of fees to the project`}
                    </span>
                  </li>
                  <li>
                    <span className="step-label">Floor bid</span>
                    <strong>{bid.active ? `${eth(bid.currentBid)} ETH` : "No bid"}</strong>
                    <span className="small">
                      {bid.active ? (fillable ? <Badge tone="good">Fillable</Badge> : <Badge tone="bad">Not fillable</Badge>) : <Badge tone="muted">Not configured</Badge>}
                    </span>
                  </li>
                  <li>
                    <span className="step-label">Vault</span>
                    <strong>
                      {o.collectionHoldingsInVault}
                      {o.holdingsTruncated ? "+" : ""} held
                    </strong>
                    <span className="muted small">Locked 180 days and until the floor is 30% up</span>
                  </li>
                  <li>
                    <span className="step-label">Out</span>
                    <strong>Auction or raffle</strong>
                    <span className="muted small">Auction proceeds return to the budget; raffles go to points holders</span>
                  </li>
                </ol>
              </Card>

              <Card title="Key numbers">
                <div className="stats">
                  <Stat label="Buyback budget" value={`${eth(bid.budget)} ETH`} hint="Only ever spent on this collection's floor" />
                  <Stat
                    label="Live floor bid"
                    value={bid.active ? `${eth(bid.currentBid)} ETH` : <Badge tone="muted">No active bid</Badge>}
                    hint={
                      bid.active
                        ? `From ${eth(bid.basePrice)} ETH on ${dateTime(bid.lastReset)}, +${bps(bid.growthBpsPerDay)} a day, capped at ${eth(bid.maxPrice)} ETH, −${bps(bid.stepDownBps)} after a fill`
                        : "The owner has not configured a bid for this collection"
                    }
                  />
                  <Stat
                    label="Bid fillable"
                    value={fillable ? <Badge tone="good">Yes</Badge> : <Badge tone="bad">No</Badge>}
                    hint={
                      fillable
                        ? "The budget covers the current bid"
                        : !bid.active
                          ? "No active bid"
                          : now < bid.nextFillAt
                            ? `Pausing between fills until ${dateTime(bid.nextFillAt)}`
                            : "The budget is below the current bid"
                    }
                  />
                  <FloorStat label="Sales oracle floor" floor={o.salesFloor} now={now} usedBy="Used by the vault." />
                  <FloorStat label="Push oracle floor" floor={o.pushFloor} now={now} usedBy="Used by prediction markets." />
                  <Stat
                    label="Vault holdings"
                    value={`${o.collectionHoldingsInVault}${o.holdingsTruncated ? "+" : ""}`}
                    hint={`Of this collection, still in the vault. ${o.holdingCount.toString()} deposits registered across all collections.`}
                  />
                  <Stat
                    label="Project share"
                    value={o.projectShare.bps > 0 ? bps(o.projectShare.bps) : <Badge tone="muted">None</Badge>}
                    hint={
                      o.projectShare.bps > 0 ? (
                        <>
                          Of this collection's fees, paid to <Addr address={o.projectShare.recipient} />. The rest funds buybacks.
                        </>
                      ) : (
                        "All of this collection's protocol fees fund buybacks."
                      )
                    }
                  />
                  <Stat
                    label="Total active points"
                    value={points(o.totalPoints)}
                    hint={o.pointsFrozen ? "A raffle draw is in flight: pending points cannot be activated until it ends" : "Across all users; fees earn pending points, activated points count"}
                  />
                </div>
              </Card>

              <Card title="Your position">
                {!user ? (
                  <Empty title="Connect a wallet to see your points and anything owed to you." />
                ) : (
                  <div className="stats">
                    <Stat
                      label="Your points"
                      value={points(o.userPoints ?? 0n)}
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
                                  void run("Activate pending points", (send) => send("Activate points", flushPointsCall(d, user)), [
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
                    />
                    <Stat
                      label="Project share owed to you"
                      value={`${eth(o.userProjectShareOwed ?? 0n)} ETH`}
                      hint={
                        o.userProjectShareOwed ? (
                          <span className="pending">
                            Accrued to your address as a project's fee recipient.
                            <ActionButton
                              className="small"
                              onClick={() =>
                                d &&
                                void run("Claim project share", (send) => send("Claim", claimProjectShareCall(d)), [
                                  `You receive ${eth(o.userProjectShareOwed!)} ETH from the Treasury.`,
                                ])
                              }
                            >
                              Claim
                            </ActionButton>
                          </span>
                        ) : (
                          "Only a project's fee recipient accrues a share."
                        )
                      }
                    />
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </QueryView>

      <Card title="Recent activity">
        <QueryView query={activity}>
          {(items) =>
            items.length === 0 ? (
              <Empty title="No recent activity for this collection.">Events appear here as people trade, play and sell into the bid.</Empty>
            ) : (
              <ul className="activity">
                {items.map((item) => (
                  <li key={item.key}>
                    <a className="activity-module" href={href(item.route)}>
                      {item.module}
                    </a>
                    <span className="activity-text">
                      {item.text}
                      {item.actor && (
                        <>
                          {" "}
                          by <Addr address={item.actor} />
                        </>
                      )}
                    </span>
                    <span className="activity-time muted small">{item.time !== undefined ? <Time at={item.time} now={now} /> : `block ${item.blockNumber}`}</span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      </Card>

      <Card title="How FloorGuard works">
        <p className="muted">
          Zero-royalty marketplaces reward sellers for undercutting each other, and floors bleed as a result.
          FloorGuard reverses the incentive: every fee the protocol earns on a collection becomes a budget for buying
          that collection's floor.
        </p>
        <ol className="how">
          {HOW_IT_WORKS.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
