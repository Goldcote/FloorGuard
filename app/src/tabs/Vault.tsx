import { vaultAbi } from "../generated/abis";
import { buyCall, startAuctionCall, unlockCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { dateTime, duration, eth, relative } from "../lib/format";
import { HOLDING_STATUS_NAMES, HoldingStatus, MAX_ITEMS, readHoldings, type Holding } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, QueryView } from "../ui";
import { readContract } from "viem/actions";

const TONE = ["muted", "warn", "good", "good", "muted"] as const;

export function Vault() {
  const { client, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["vault"], readHoldings);

  const unlock = (h: Holding) =>
    void run(`Unlock vault holding #${h.id}`, (send) => send("Unlock", unlockCall(d!, h.id)));
  const startAuction = (h: Holding) =>
    void run(`Start auction for holding #${h.id}`, (send) =>
      send("Start auction", startAuctionCall(d!, h.id)),
    );
  const buy = (h: Holding) =>
    void run(`Buy vault holding #${h.id}`, async (send) => {
      // The price only falls, so the price read now always covers the price at inclusion; the
      // contract refunds the difference (see buyCall for why it sends one wei more).
      const price = await readContract(client!, {
        address: d!.vault,
        abi: vaultAbi,
        functionName: "auctionPrice",
        args: [h.id],
      });
      await send(`Buy at ${eth(price)} ETH`, buyCall(d!, h.id, price));
    });

  return (
    <Card title="Vault holdings">
      <QueryView query={query}>
        {({ holdings, holdingCount, owner, governanceWindow, auctionDuration, auctionStartMultiple, auctionHalfLife }) => {
          const isOwner = !!user && user.toLowerCase() === owner.toLowerCase();
          return (
            <>
              <p className="muted">
                Tokens bought by the floor bid. A holding unlocks once its lock has ended and the sales-oracle floor is
                at least 130% of the purchase price. After unlocking, the owner can auction or raffle it; anyone can
                start the auction once the governance window has passed. An auction starts at {auctionStartMultiple} times its reserve
                and halves every {duration(auctionHalfLife)} until it reaches the reserve, which is the floor or 130%
                of the purchase price, whichever is higher. Auctions start far above the market price on purpose and
                fall until someone buys, so the first buyer sets the price. Proceeds return to the buyback budget.
                {holdingCount > BigInt(holdings.length) && ` Showing the latest ${MAX_ITEMS} of ${holdingCount}.`}
              </p>
              {holdings.length === 0 ? (
                <p className="muted">The vault is empty.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Collection</th>
                        <th>Token</th>
                        <th>Bought for</th>
                        <th>Status</th>
                        <th>Lock ends</th>
                        <th>Can unlock</th>
                        <th>Auction price</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((h) => {
                        const auctionEnded = !!h.auction && now >= h.auction.startTime + auctionDuration;
                        const windowEnds = h.unlockedAt + governanceWindow;
                        return (
                          <tr key={h.id.toString()}>
                            <td>{h.id.toString()}</td>
                            <td><Addr address={h.collection} /></td>
                            <td>#{h.tokenId.toString()}</td>
                            <td>{eth(h.purchasePrice)} ETH</td>
                            <td><Badge tone={TONE[h.status] ?? "muted"}>{HOLDING_STATUS_NAMES[h.status] ?? h.status}</Badge></td>
                            <td title={dateTime(h.lockedUntil)}>
                              {h.status === HoldingStatus.Locked ? relative(h.lockedUntil, now) : dateTime(h.lockedUntil)}
                            </td>
                            <td>
                              {h.status !== HoldingStatus.Locked ? "–" : h.canUnlock ? <Badge tone="good">Yes</Badge> : <Badge tone="muted">No</Badge>}
                            </td>
                            <td>
                              {h.auction ? (
                                <>
                                  {eth(h.auction.currentPrice)} ETH
                                  <div className="muted small">
                                    {eth(h.auction.startPrice)} → {eth(h.auction.endPrice)} ETH
                                    {auctionEnded && ", ended unsold"}
                                  </div>
                                </>
                              ) : (
                                "–"
                              )}
                            </td>
                            <td className="actions">
                              {h.status === HoldingStatus.Locked && (
                                <ActionButton onClick={() => unlock(h)} blocked={!h.canUnlock && "Unlock conditions are not met yet"}>
                                  Unlock
                                </ActionButton>
                              )}
                              {h.status === HoldingStatus.Unlocked && (
                                <ActionButton
                                  onClick={() => startAuction(h)}
                                  blocked={
                                    !isOwner && now < windowEnds && `Only the owner can start it until ${dateTime(windowEnds)}`
                                  }
                                >
                                  Start auction
                                </ActionButton>
                              )}
                              {h.status === HoldingStatus.Auction && (
                                <>
                                  <ActionButton onClick={() => buy(h)}>Buy</ActionButton>
                                  {auctionEnded && (
                                    <ActionButton className="secondary" onClick={() => startAuction(h)}>
                                      Restart auction
                                    </ActionButton>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </Card>
  );
}
