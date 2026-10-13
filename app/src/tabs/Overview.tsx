import type { Address } from "viem";
import { useProtocol, useChainTime, useRead } from "../hooks";
import { claimProjectShareCall, flushPointsCall } from "../lib/calls";
import { bps, dateTime, eth, points, relative } from "../lib/format";
import { readOverview, type Floor } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, QueryView, Stat } from "../ui";

function FloorStat({ label, floor, now, usedBy }: { label: string; floor: Floor; now: number; usedBy: string }) {
  if (!floor.ok) {
    return <Stat label={label} value={<Badge tone="muted">No price</Badge>} hint={`${floor.reason} ${usedBy}`} />;
  }
  return (
    <Stat
      label={label}
      value={`${eth(floor.price)} ETH`}
      hint={`Updated ${relative(floor.updatedAt, now)}. ${usedBy}`}
    />
  );
}

export function Overview({ collection }: { collection: Address }) {
  const { user, deployment: d } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const activate = () => {
    if (!d || !user) return;
    void run("Activate pending points", (send) => send("Activate points", flushPointsCall(d, user)));
  };
  const query = useRead(["overview", collection, user], (client, d) => readOverview(client, d, collection, user));

  const claimShare = () => {
    if (!d) return;
    void run("Claim project share", (send) => send("Claim", claimProjectShareCall(d)));
  };

  return (
    <Card title="Overview">
      <QueryView query={query}>
        {(o) => {
          const bid = o.floorBid;
          const share = o.userPoints !== undefined && o.totalPoints > 0n
            ? Number((o.userPoints * 1_000_000n) / o.totalPoints) / 10_000
            : undefined;
          return (
            <div className="stats">
              <Stat label="Treasury buyback budget" value={`${eth(bid.budget)} ETH`} hint="Earmarked for this collection" />
              <Stat
                label="Floor bid"
                value={bid.active ? `${eth(bid.currentBid)} ETH` : <Badge tone="muted">No active bid</Badge>}
                hint={
                  bid.active
                    ? `Base ${eth(bid.basePrice)} ETH since ${dateTime(bid.lastReset)}, +${bps(bid.growthBpsPerDay)}/day, cap ${eth(bid.maxPrice)} ETH, −${bps(bid.stepDownBps)} after a fill`
                    : "The owner has not configured a bid for this collection"
                }
              />
              <Stat
                label="Bid fillable"
                value={bid.isFillable ? <Badge tone="good">Yes</Badge> : <Badge tone="bad">No</Badge>}
                hint={bid.isFillable ? "The budget covers the current bid" : bid.active ? "The budget is below the current bid" : "No active bid"}
              />
              <FloorStat label="Sales oracle floor" floor={o.salesFloor} now={now} usedBy="Used by the vault." />
              <FloorStat label="Push oracle floor" floor={o.pushFloor} now={now} usedBy="Used by prediction markets." />
              <Stat
                label="Vault holdings"
                value={`${o.collectionHoldingsInVault}${o.holdingsTruncated ? "+" : ""}`}
                hint={`Of this collection, still in the vault. ${o.holdingCount.toString()} deposits registered across all collections.`}
              />
              <Stat
                label="Marketplace support"
                value={o.marketplaceSupported ? <Badge tone="good">Supported</Badge> : <Badge tone="warn">Not supported</Badge>}
                hint={
                  o.marketplaceSupported
                    ? "Trading fees fund this collection's buybacks and earn points"
                    : "It can be traded, but fees go to the unallocated pool and earn no points"
                }
              />
              <Stat
                label="Project share"
                value={o.projectShare.bps > 0 ? bps(o.projectShare.bps) : <Badge tone="muted">None</Badge>}
                hint={
                  <>
                    {o.projectShare.bps > 0 ? (
                      <>
                        Of this collection's protocol fees, paid to <Addr address={o.projectShare.recipient} />. The rest
                        funds buybacks.
                      </>
                    ) : (
                      "All of this collection's protocol fees fund buybacks."
                    )}
                    {o.userProjectShareOwed !== undefined && o.userProjectShareOwed > 0n && (
                      <span className="pending">
                        {eth(o.userProjectShareOwed)} ETH of project shares is owed to you.
                        <ActionButton onClick={claimShare}>Claim</ActionButton>
                      </span>
                    )}
                  </>
                }
              />
              <Stat
                label="Your points"
                value={o.userPoints !== undefined ? points(o.userPoints) : <span className="muted">Connect a wallet</span>}
                hint={
                  o.userPoints !== undefined && (
                    <>
                      Active: your weight in raffles{share !== undefined && `, ${share}% of all active points`}.
                      {o.userPendingPoints ? (
                        <span className="pending">
                          {points(o.userPendingPoints)} pending. Pending points do not count until activated.
                          <ActionButton
                            onClick={activate}
                            blocked={o.pointsFrozen && "A raffle draw is in flight; try again when it has ended"}
                          >
                            Activate
                          </ActionButton>
                        </span>
                      ) : (
                        " Nothing pending."
                      )}
                    </>
                  )
                }
              />
              <Stat
                label="Total active points"
                value={points(o.totalPoints)}
                hint={
                  o.pointsFrozen
                    ? "A raffle draw is in flight: pending points cannot be activated until it ends"
                    : "Fees earn pending points; only activated points count"
                }
              />
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
