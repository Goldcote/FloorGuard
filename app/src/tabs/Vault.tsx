import { buyCall, startAuctionCall, unlockCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { dateTime, duration, eth, relative } from "../lib/format";
import { auctionReachesReserveAt, readAuctionPrice, HOLDING_STATUS_NAMES, HoldingStatus, MAX_ITEMS, readHoldings, type Holding } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, QueryView, Time } from "../ui";

const TONE = ["muted", "warn", "good", "good", "muted"] as const;

export function Vault() {
  const { client, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["vault"], readHoldings);

  const unlock = (h: Holding) =>
    void run(`Unlock vault holding #${h.id}`, (send) => send("Unlock", unlockCall(d!, h.id)), [
      "Marks the holding as unlocked, so the owner can auction or raffle it. No ETH is sent; you pay only the transaction fee.",
    ]);
  const startAuction = (h: Holding) =>
    void run(`Start auction for holding #${h.id}`, (send) =>
      send("Start auction", startAuctionCall(d!, h.id)),
      [
        "Starts a falling-price auction for this token far above its reserve, halving every day down to the reserve.",
        "No ETH is sent; you pay only the transaction fee.",
      ],
    );
  const buy = (h: Holding) =>
    void run(`Buy vault holding #${h.id}`, async (send) => {
      // The price only falls, so the price read now always covers the price at inclusion; the
      // contract refunds the difference (see buyCall for why it sends one wei more).
      const price = await readAuctionPrice(client!, d!, h.id);
      await send(`Buy at ${eth(price)} ETH`, buyCall(d!, h.id, price));
    }, [
      `You buy token #${h.tokenId} at the auction's current price${h.auction ? `, about ${eth(h.auction.currentPrice)} ETH` : ""}.`,
      "The price keeps falling: you pay the price at the moment the transaction is mined, and anything sent above it is refunded.",
      "The payment goes to the collection's buyback budget and the token comes to you.",
    ]);

  return (
    <Card title="Vault holdings">
      <QueryView query={query}>
        {({ holdings, holdingCount, owner, governanceWindow, auctionStartMultiple, auctionHalfLife }) => {
          const isOwner = !!user && user.toLowerCase() === owner.toLowerCase();
          return (
            <>
              <p className="muted">
                Tokens bought by the floor bid. A holding unlocks once its lock has ended and the sales-oracle floor is
                at least 130% of the purchase price. After unlocking, the owner can auction or raffle it; anyone can
                start the auction once the governance window has passed. An auction opens at {auctionStartMultiple} times its reserve
                (or the floor at unlock, if higher) and halves every {duration(auctionHalfLife)} until it reaches the
                reserve, which is the floor or 130% of the purchase price, whichever is higher. An unsold auction can
                be restarted once its price sits at the reserve. Auctions start far above the market price on purpose and
                fall until someone buys, so the first buyer sets the price. Proceeds return to the buyback budget.
                {holdingCount > BigInt(holdings.length) && ` Showing the latest ${MAX_ITEMS} of ${holdingCount}.`}
              </p>
              {holdings.length === 0 ? (
                <Empty title="The vault is empty.">Tokens appear here when a holder sells into the floor bid.</Empty>
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
                        const reserveAt = h.auction ? auctionReachesReserveAt(h.auction, auctionHalfLife) : 0;
                        // An unsold auction can be restarted once its price sits at the reserve; one the
                        // owner priced by hand only by the owner.
                        const canRestart = !!h.auction && h.auction.atReserve && (!h.auction.ownerPriced || isOwner);
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
                                    From {eth(h.auction.startPrice)} down to the {eth(h.auction.endPrice)} ETH reserve
                                    {h.auction.atReserve ? "; at the reserve, unsold" : <>; reaches it <Time at={reserveAt} now={now} /></>}
                                    {h.auction.ownerPriced && "; priced by the owner"}
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
                                  {canRestart && (
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
