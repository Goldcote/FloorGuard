import { useState } from "react";
import type { Address } from "viem";
import { acceptOfferCall, approveCall, cancelOfferCall, makeCollectionOfferCall, makeOfferCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, eth, relative } from "../lib/format";
import { parseEth, parsePercentBps, parseUint } from "../lib/parse";
import { readExpectedProceeds, readOpenOffers, readTokenState, withSlippage, type Offer } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, Field, QueryView } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";

const DAY = 86_400;

export function Marketplace({ collection }: { collection: Address }) {
  const { client, deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["offers"], (c, dep) => readOpenOffers(c, dep, LOGS_FROM_BLOCK));

  const [onlyCollection, setOnlyCollection] = useState(true);
  const [tolerance, setTolerance] = useState("0");
  const [acceptToken, setAcceptToken] = useState<Record<string, string>>({});
  const [tokenOffer, setTokenOffer] = useState({ tokenId: "", price: "", days: "7" });
  const [collectionOffer, setCollectionOffer] = useState({ price: "", quantity: "1", days: "7" });

  const toleranceBps = parsePercentBps(tolerance);
  const feeBps = query.data?.feeBps ?? 0n;

  const accept = (offer: Offer) => {
    const tokenId = offer.collectionWide ? parseUint(acceptToken[offer.id.toString()] ?? "") : offer.tokenId;
    if (!client || !d || !user || tokenId === undefined || toleranceBps === undefined) return;
    void run(`Accept offer #${offer.id}`, async (send) => {
      const token = await readTokenState(client, offer.collection, tokenId, d.marketplace);
      if (token.owner.toLowerCase() !== user.toLowerCase()) throw new Error(`You do not own token #${tokenId}.`);
      if (!token.approved) {
        await send("Approve marketplace", approveCall(offer.collection, d.marketplace, tokenId));
      }
      // Fee and royalty are read just before signing; minProceeds then rejects a later change.
      const expected = await readExpectedProceeds(client, d, offer.collection, tokenId, offer.price);
      const minProceeds = withSlippage(expected.proceeds, toleranceBps);
      await send("Accept offer", acceptOfferCall(d, offer.id, tokenId, minProceeds));
    }, [
      `You sell token #${tokenId} to the offerer for ${eth(offer.price)} ETH.`,
      `The ${bps(feeBps)} protocol fee, and any royalty the collection sets, are deducted; you receive the rest.`,
      `The sale is rejected if you would receive more than ${tolerance}% less than the proceeds read just before signing.`,
      "If the marketplace is not yet approved for this token, an approval transaction comes first.",
    ]);
  };

  const cancel = (offer: Offer) => {
    if (!d) return;
    void run(`Cancel offer #${offer.id}`, (send) => send("Cancel offer", cancelOfferCall(d, offer.id)), [
      `The unfilled part of the offer, ${eth(offer.price * BigInt(offer.remaining))} ETH, returns from escrow to you.`,
    ]);
  };

  const tokenOfferInput = {
    tokenId: parseUint(tokenOffer.tokenId),
    price: parseEth(tokenOffer.price),
    days: Number(tokenOffer.days),
  };
  const collectionOfferInput = {
    price: parseEth(collectionOffer.price),
    quantity: parseUint(collectionOffer.quantity),
    days: Number(collectionOffer.days),
  };
  const validDays = (days: number) => Number.isFinite(days) && days > 0;

  const makeTokenOffer = () => {
    const { tokenId, price, days } = tokenOfferInput;
    if (!d || tokenId === undefined || price === undefined || !validDays(days)) return;
    void run(`Offer ${eth(price)} ETH for token #${tokenId}`, (send) =>
      send("Make offer", makeOfferCall(d, collection, tokenId, BigInt(now + Math.round(days * DAY)), price)),
      [
        `${eth(price)} ETH moves from your wallet into escrow in the marketplace.`,
        `The owner of token #${tokenId} can accept at any time in the next ${days} day(s); the token then comes to you.`,
        "You can cancel and take the ETH back at any time before it is accepted.",
      ],
    );
  };

  const makeCollectionOffer = () => {
    const { price, quantity, days } = collectionOfferInput;
    if (!d || price === undefined || quantity === undefined || quantity === 0n || !validDays(days)) return;
    void run(`Collection offer: ${quantity} × ${eth(price)} ETH`, (send) =>
      send(
        "Make collection offer",
        makeCollectionOfferCall(d, collection, quantity, BigInt(now + Math.round(days * DAY)), price),
      ),
      [
        `${eth(price * quantity)} ETH (${quantity} × ${eth(price)}) moves from your wallet into escrow in the marketplace.`,
        `Any holder can sell you any token of the collection at ${eth(price)} ETH each for the next ${days} day(s).`,
        "You can cancel the unfilled part and take that ETH back at any time.",
      ],
    );
  };

  return (
    <>
      <Card
        title="Open offers"
        aside={
          <label className="inline">
            <input type="checkbox" checked={onlyCollection} onChange={(e) => setOnlyCollection(e.target.checked)} />
            Selected collection only
          </label>
        }
      >
        <QueryView query={query}>
          {({ offers, source, feeBps }) => {
            const shown = onlyCollection
              ? offers.filter((o) => o.collection.toLowerCase() === collection.toLowerCase())
              : offers;
            return (
              <>
                <p className="muted">
                  Protocol fee {bps(feeBps)} of the price, plus the collection's ERC-2981 royalty if any; both are
                  deducted from the seller's proceeds.
                  {source === "scan" && " The RPC refused the log query, so recent offer ids were scanned instead."}
                </p>
                {shown.length === 0 ? (
                  <Empty title="No open offers.">Make the first one below.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>For</th>
                          <th>Collection</th>
                          <th>Price each</th>
                          <th>Wanted</th>
                          <th>Expires</th>
                          <th>Offerer</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((offer) => {
                          const key = offer.id.toString();
                          const expired = now > offer.expiry;
                          const mine = !!user && offer.offerer.toLowerCase() === user.toLowerCase();
                          const tokenText = acceptToken[key] ?? "";
                          const needsToken = offer.collectionWide && parseUint(tokenText) === undefined;
                          return (
                            <tr key={key}>
                              <td>{key}</td>
                              <td>{offer.collectionWide ? "Any token" : `Token #${offer.tokenId}`}</td>
                              <td><Addr address={offer.collection} /></td>
                              <td>{eth(offer.price)} ETH</td>
                              <td>
                                {offer.remaining}
                                {offer.filled > 0 && <span className="muted"> ({offer.filled} filled)</span>}
                              </td>
                              <td>
                                {expired ? <Badge tone="bad">Expired</Badge> : relative(offer.expiry, now)}
                              </td>
                              <td>
                                <Addr address={offer.offerer} /> {mine && <Badge tone="muted">You</Badge>}
                              </td>
                              <td className="actions">
                                {offer.collectionWide && (
                                  <input
                                    className="narrow"
                                    placeholder="Token id"
                                    aria-label={`Token id to sell into offer ${key}`}
                                    inputMode="numeric"
                                    value={tokenText}
                                    onChange={(e) => setAcceptToken((s) => ({ ...s, [key]: e.target.value }))}
                                  />
                                )}
                                <ActionButton
                                  onClick={() => accept(offer)}
                                  blocked={
                                    expired
                                      ? "This offer has expired"
                                      : needsToken
                                        ? "Enter the id of the token to sell"
                                        : toleranceBps === undefined && "Enter a valid tolerance"
                                  }
                                >
                                  Accept
                                </ActionButton>
                                {mine && (
                                  <ActionButton className="secondary" onClick={() => cancel(offer)}>
                                    Cancel
                                  </ActionButton>
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
        <div className="form-row">
          <Field label="Proceeds tolerance when accepting (%)">
            <input className="narrow" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </Field>
          <p className="muted grow">
            Accepting sends <code>minProceeds</code> = price − fee − royalty as read just before you sign, less this
            tolerance. At 0% the sale reverts if the fee or royalty rises in the meantime. The marketplace is
            approved for the token first if it is not already.
          </p>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Offer on one token">
          <p className="muted">Escrows the ETH for a specific token of the selected collection.</p>
          <div className="form">
            <Field label="Token id">
              <input inputMode="numeric" value={tokenOffer.tokenId} onChange={(e) => setTokenOffer({ ...tokenOffer, tokenId: e.target.value })} />
            </Field>
            <Field label="Price (ETH)">
              <input inputMode="decimal" value={tokenOffer.price} onChange={(e) => setTokenOffer({ ...tokenOffer, price: e.target.value })} />
            </Field>
            <Field label="Expires in (days)">
              <input inputMode="decimal" value={tokenOffer.days} onChange={(e) => setTokenOffer({ ...tokenOffer, days: e.target.value })} />
            </Field>
            <ActionButton
              onClick={makeTokenOffer}
              blocked={
                (tokenOfferInput.tokenId === undefined || tokenOfferInput.price === undefined || !validDays(tokenOfferInput.days)) &&
                "Enter a token id, a price and an expiry"
              }
            >
              Make offer
            </ActionButton>
          </div>
        </Card>

        <Card title="Collection offer">
          <p className="muted">Escrows price × quantity for any tokens of the selected collection.</p>
          <div className="form">
            <Field label="Price per token (ETH)">
              <input inputMode="decimal" value={collectionOffer.price} onChange={(e) => setCollectionOffer({ ...collectionOffer, price: e.target.value })} />
            </Field>
            <Field label="Quantity">
              <input inputMode="numeric" value={collectionOffer.quantity} onChange={(e) => setCollectionOffer({ ...collectionOffer, quantity: e.target.value })} />
            </Field>
            <Field label="Expires in (days)">
              <input inputMode="decimal" value={collectionOffer.days} onChange={(e) => setCollectionOffer({ ...collectionOffer, days: e.target.value })} />
            </Field>
            {collectionOfferInput.price !== undefined && collectionOfferInput.quantity ? (
              <p className="muted">Total escrow: {eth(collectionOfferInput.price * collectionOfferInput.quantity)} ETH</p>
            ) : null}
            <ActionButton
              onClick={makeCollectionOffer}
              blocked={
                (collectionOfferInput.price === undefined || !collectionOfferInput.quantity || !validDays(collectionOfferInput.days)) &&
                "Enter a price, a quantity of at least 1 and an expiry"
              }
            >
              Make collection offer
            </ActionButton>
          </div>
        </Card>
      </div>
    </>
  );
}
