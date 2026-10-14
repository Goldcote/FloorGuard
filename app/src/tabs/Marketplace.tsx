// The marketplace as a living book of offers. There are no listings: buyers escrow ETH on one token
// or on any token of a collection, a holder accepts, and before anything is signed the page shows
// who receives what (seller, royalty, project, buyback budget).
import { useState } from "react";
import type { Address } from "viem";
import { acceptOfferCall, approveCall, cancelOfferCall, makeCollectionOfferCall, makeOfferCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, eth, relative } from "../lib/format";
import { parseEth, parseTolerance, parseUint, TOLERANCE_HINT } from "../lib/parse";
import { readExpectedProceeds, readFloorBid, readOpenOffers, readOverview, readTokenState, withSlippage, type Offer } from "../lib/reads";
import { href } from "../routes";
import { ReviewAgain, useTx, single } from "../tx";
import { ActionButton, Addr, Badge, Empty, Field, PageHead, Panel, QueryView } from "../ui";
import { saleSplit, toEth } from "../viz/curves";
import { ownedTokens } from "../viz/data";
import { LiveDot, SplitBar, TokenTile, type SplitPart } from "../viz/parts";
import { LOGS_FROM_BLOCK } from "../wagmi";

const DAY = 86_400;

function splitParts(price: bigint, feeBps: bigint, royalty: bigint, projectBps: number, sellerLabel: string): SplitPart[] {
  const split = saleSplit(price, feeBps, royalty, projectBps);
  return [
    { key: "seller", label: sellerLabel, value: split.seller, tone: "you" },
    { key: "budget", label: "Buyback budget", value: split.toBudget, tone: "budget", hint: `the ${bps(feeBps)} protocol fee${projectBps > 0 ? ", less the project's share" : ""}: it buys this collection's cheapest tokens` },
    { key: "project", label: "The NFT project", value: split.toProject, tone: "project", hint: projectBps > 0 ? `${bps(projectBps)} of the fee` : "no share is set for this collection" },
    { key: "royalty", label: "Royalty", value: split.royalty, tone: "royalty", hint: "ERC-2981, up to the marketplace's cap" },
  ];
}

export function Marketplace({ collection }: { collection: Address }) {
  const { client, deployment: d, user, demo } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["offers", user], (c, dep) => readOpenOffers(c, dep, LOGS_FROM_BLOCK, user));
  const overview = useRead(["overview", collection, user], (c, dep) => readOverview(c, dep, collection, user));
  const floorBid = useRead(["floorBid", collection], (c, dep) => readFloorBid(c, dep, collection));

  const [onlyCollection, setOnlyCollection] = useState(true);
  const [tolerance, setTolerance] = useState("0");
  const [selectedId, setSelectedId] = useState<string>();
  const [acceptToken, setAcceptToken] = useState("");
  const [kind, setKind] = useState<"collection" | "token">("collection");
  const [form, setForm] = useState({ tokenId: "", price: "", quantity: "1", days: "7" });

  const toleranceChoice = parseTolerance(tolerance);
  const toleranceBps = toleranceChoice?.bps;
  /** Ticked by the visitor before selling into an offer on a collection other than the selected one. */
  const [otherCollectionOk, setOtherCollectionOk] = useState<string>();
  const feeBps = query.data?.feeBps ?? 0n;
  const projectBps = overview.data?.projectShare.bps ?? 0;
  const owned = ownedTokens(demo);

  const offers = query.data?.offers ?? [];
  const selected = offers.find((o) => o.id.toString() === selectedId);
  const sameCollection = (o: Offer) => o.collection.toLowerCase() === collection.toLowerCase();
  const sellToken = selected ? (selected.collectionWide ? parseUint(acceptToken) : selected.tokenId) : undefined;
  // Fee and royalty for exactly this token and price, as the contract would compute them now.
  const proceeds = useRead(
    ["proceeds", selectedId, sellToken?.toString()],
    (c, dep) => readExpectedProceeds(c, dep, selected!.collection, sellToken!, selected!.price),
    !!selected && sellToken !== undefined,
  );

  const accept = (offer: Offer) => {
    const tokenId = offer.collectionWide ? parseUint(acceptToken) : offer.tokenId;
    // The figures on screen are the ones the sale is bound to: nothing is sold on a figure that
    // was not shown, and the minimum is not re-derived after confirming.
    const shown = proceeds.data;
    if (!client || !d || !user || tokenId === undefined || toleranceBps === undefined || !shown) return;
    if (!sameCollection(offer) && otherCollectionOk !== offer.id.toString()) return;
    const minProceeds = withSlippage(shown.proceeds, toleranceBps);
    const acceptance = acceptOfferCall(d, offer.id, tokenId, minProceeds);
    void run(
      `Accept offer #${offer.id}`,
      async (send) => {
        const token = await readTokenState(client, offer.collection, tokenId, d.marketplace);
        if (token.owner.toLowerCase() !== user.toLowerCase()) throw new Error(`You do not own token #${tokenId}.`);
        if (!token.approved) {
          await send("Approve marketplace", approveCall(offer.collection, d.marketplace, tokenId));
        }
        // Fee and royalty are read again just before signing. If they would now leave less than the
        // minimum that was reviewed, stop: the contract would refuse it anyway, and the visitor
        // should see the new figures.
        const expected = await readExpectedProceeds(client, d, offer.collection, tokenId, offer.price);
        if (expected.proceeds < minProceeds) throw new ReviewAgain(`The fee or royalty changed: you would now receive ${eth(expected.proceeds)} ETH, below the minimum of ${eth(minProceeds)} ETH you reviewed.`);
        await send("Accept offer", acceptance);
        setSelectedId(undefined);
        setAcceptToken("");
        setOtherCollectionOk(undefined);
      },
      [
        `You sell token #${tokenId} of the collection ${offer.collection} to the offerer for ${eth(offer.price)} ETH.`,
        ...(sameCollection(offer) ? [] : [`This is NOT the collection selected at the top of the page (${collection}). The token leaves that other collection's contract.`]),
        `The ${bps(feeBps)} protocol fee (${eth(shown.fee)} ETH) and the collection's royalty (${eth(shown.royalty)} ETH) are deducted; you receive ${eth(shown.proceeds)} ETH.`,
        `You receive at least ${eth(minProceeds, 18)} ETH: that minimum (${tolerance}% under the figure above) is sent with the sale, which is rejected if the fee or royalty has risen past it.`,
        "If the marketplace is not yet approved for this token, an approval transaction comes first.",
      ],
      {
        plan: [
          { step: "Approve marketplace (only if it is not approved for this token yet)", call: approveCall(offer.collection, d.marketplace, tokenId) },
          { step: "Accept offer", call: acceptance },
        ],
        preview: <SplitBar title={`Who receives the ${eth(offer.price)} ETH`} parts={splitParts(offer.price, feeBps, shown.royalty, projectBps, "You, the seller")} />,
      },
    );
  };

  const cancel = (offer: Offer) => {
    if (!d) return;
    void run(`Cancel offer #${offer.id}`, single("Cancel offer", cancelOfferCall(d, offer.id)), [
      `The unfilled part of the offer, ${eth(offer.price * BigInt(offer.remaining))} ETH, returns from escrow to you.`,
    ]);
  };

  const input = { tokenId: parseUint(form.tokenId), price: parseEth(form.price), quantity: parseUint(form.quantity), days: Number(form.days) };
  const validDays = Number.isFinite(input.days) && input.days > 0;
  const quantity = kind === "collection" ? input.quantity : 1n;
  const escrow = input.price !== undefined && quantity ? input.price * quantity : undefined;

  const makeOffer = () => {
    const { tokenId, price, days } = input;
    if (!d || price === undefined || !validDays) return;
    const expiry = BigInt(now + Math.round(days * DAY));
    const preview = { preview: <SplitBar title={`If a holder accepts, of each ${eth(price)} ETH`} parts={splitParts(price, feeBps, 0n, projectBps, "The seller")} /> };
    if (kind === "token") {
      if (tokenId === undefined) return;
      void run(
        `Offer ${eth(price)} ETH for token #${tokenId}`,
        single("Make offer", makeOfferCall(d, collection, tokenId, expiry, price)),
        [
          `${eth(price)} ETH moves from your wallet into escrow in the marketplace.`,
          `The owner of token #${tokenId} can accept at any time in the next ${days} day(s); the token then comes to you.`,
          "You can cancel and take the ETH back at any time before it is accepted.",
        ],
        preview,
      );
    } else {
      if (!input.quantity) return;
      const q = input.quantity;
      void run(
        `Collection offer: ${q} × ${eth(price)} ETH`,
        single("Make collection offer", makeCollectionOfferCall(d, collection, q, expiry, price)),
        [
          `${eth(price * q)} ETH (${q} × ${eth(price)}) moves from your wallet into escrow in the marketplace.`,
          `Any holder can sell you any token of the collection at ${eth(price)} ETH each for the next ${days} day(s).`,
          "You can cancel the unfilled part and take that ETH back at any time.",
        ],
        preview,
      );
    }
  };

  return (
    <>
      <PageHead eyebrow="Trade · marketplace" title="Offers, not listings">
        Buyers escrow ETH in an offer on one token or on any token of a collection. A holder accepts and the swap is atomic. There is no listing to
        undercut.
      </PageHead>

      <div className="market-layout">
        <div className="market-book">
          <QueryView query={query} lines={5}>
            {({ offers, source, feeBps }) => {
              const shown = onlyCollection ? offers.filter((o) => o.collection.toLowerCase() === collection.toLowerCase()) : offers;
              const wide = shown.filter((o) => o.collectionWide).sort((a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1));
              const singles = shown.filter((o) => !o.collectionWide);
              const bid = floorBid.data;
              const top = [...wide.map((o) => o.price * BigInt(o.remaining)), bid?.active ? bid.currentBid : 0n].reduce((a, b) => (a > b ? a : b), 1n);
              const bar = (value: bigint) => `${Math.max(4, Number((value * 1000n) / top) / 10)}%`;
              // the protocol's own standing bid sits in the same ladder, at its price
              const rows: ({ kind: "offer"; offer: Offer } | { kind: "protocol"; price: bigint })[] = wide.map((offer) => ({ kind: "offer", offer }));
              if (bid?.active && bid.currentBid > 0n) {
                const at = rows.findIndex((r) => r.kind === "offer" && r.offer.price < bid.currentBid);
                rows.splice(at === -1 ? rows.length : at, 0, { kind: "protocol", price: bid.currentBid });
              }
              return (
                <>
                  <Panel
                    title="Bids for any token of the collection"
                    aside={
                      <label className="inline">
                        <input type="checkbox" checked={onlyCollection} onChange={(e) => setOnlyCollection(e.target.checked)} />
                        Selected collection only
                      </label>
                    }
                  >
                    {rows.length === 0 ? (
                      <Empty icon="book" title="No collection offers are open.">
                        Make the first one on the right.
                      </Empty>
                    ) : (
                      <ol className="ladder">
                        {rows.map((row) =>
                          row.kind === "protocol" ? (
                            <li key="protocol" className="rung protocol">
                              <span className="rung-depth" style={{ width: bar(row.price) }} />
                              <span className="rung-price">
                                {eth(row.price, 4)} <small>ETH</small>
                              </span>
                              <span className="rung-what">
                                <LiveDot /> The protocol's floor bid
                                <small>one token at a time, no fee, the token goes to the vault</small>
                              </span>
                              <a className="btn secondary small" href={href("/trade/floor-bid")}>
                                Open
                              </a>
                            </li>
                          ) : (
                            <OfferRung key={row.offer.id.toString()} offer={row.offer} now={now} user={user} other={!sameCollection(row.offer)} width={bar(row.offer.price * BigInt(row.offer.remaining))} selected={selectedId === row.offer.id.toString()} onSelect={setSelectedId} onCancel={cancel} />
                          ),
                        )}
                      </ol>
                    )}
                    <p className="muted small">
                      Highest price first. The bar is the ETH each bid still has in escrow.
                      {source === "scan" && " The RPC refused the log query, so recent offer ids were scanned instead."}
                    </p>
                  </Panel>

                  <Panel title="Offers on single tokens">
                    {singles.length === 0 ? (
                      <Empty icon="book" title="No offers on single tokens." />
                    ) : (
                      <ul className="token-offers">
                        {singles.map((offer) => {
                          const expired = now > offer.expiry;
                          const mine = !!user && offer.offerer.toLowerCase() === user.toLowerCase();
                          const on = selectedId === offer.id.toString();
                          return (
                            <li key={offer.id.toString()} className={on ? "token-offer on" : "token-offer"}>
                              <TokenTile tokenId={offer.tokenId} size={60} />
                              <div className="token-offer-main">
                                <strong>
                                  {eth(offer.price, 4)} <small>ETH</small>
                                </strong>
                                <span className="muted small">
                                  for token #{offer.tokenId.toString()} of <Addr address={offer.collection} /> {!sameCollection(offer) && <Badge tone="bad">Another collection</Badge>} · by{" "}
                                  <Addr address={offer.offerer} /> {mine && <Badge tone="muted">You</Badge>} ·{" "}
                                  {expired ? <Badge tone="bad">Expired</Badge> : `expires ${relative(offer.expiry, now)}`}
                                </span>
                              </div>
                              <div className="rung-actions">
                                {!mine && (
                                  <button type="button" className="btn small" aria-pressed={on} disabled={expired} onClick={() => setSelectedId(on ? undefined : offer.id.toString())}>
                                    {on ? "Selected" : "Sell into it"}
                                  </button>
                                )}
                                {mine && (
                                  <ActionButton className="secondary small" onClick={() => cancel(offer)}>
                                    Cancel
                                  </ActionButton>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Panel>

                  {selected && (
                    <Panel title={`Accept offer #${selected.id}`} className="accept-panel">
                      <p className="muted small">
                        {selected.collectionWide ? `Any token of the collection, at ${eth(selected.price)} ETH. Choose which of yours to sell.` : `Token #${selected.tokenId} at ${eth(selected.price)} ETH.`}{" "}
                        Collection: <code>{selected.collection}</code>
                      </p>
                      {!sameCollection(selected) && (
                        <div className="callout warn" role="alert">
                          <p>
                            This offer is for a <strong>different collection</strong> than the one selected at the top of the page. Selling into it approves the marketplace for,
                            and sells, a token of <code>{selected.collection}</code>.
                          </p>
                          <label className="inline">
                            <input type="checkbox" checked={otherCollectionOk === selected.id.toString()} onChange={(e) => setOtherCollectionOk(e.target.checked ? selected.id.toString() : undefined)} />
                            I mean to sell a token of that collection
                          </label>
                        </div>
                      )}
                      {selected.collectionWide && (
                        <>
                          {owned.length > 0 && (
                            <div className="token-picks" role="group" aria-label="Your tokens in the demo">
                              {owned.map((id) => (
                                <button key={id.toString()} type="button" className={sellToken === id ? "token-pick on" : "token-pick"} aria-pressed={sellToken === id} onClick={() => setAcceptToken(id.toString())}>
                                  <TokenTile tokenId={id} size={48} />
                                </button>
                              ))}
                            </div>
                          )}
                          <Field label="Token id to sell">
                            <input className="narrow" inputMode="numeric" value={acceptToken} onChange={(e) => setAcceptToken(e.target.value)} />
                          </Field>
                        </>
                      )}
                      {proceeds.data ? (
                        <SplitBar title={`Who receives the ${eth(selected.price)} ETH`} parts={splitParts(selected.price, feeBps, proceeds.data.royalty, projectBps, "You, the seller")} />
                      ) : (
                        // no split is drawn on a royalty that has not been read: it would show the seller too much
                        <p className="notice">
                          {sellToken === undefined
                            ? "Who receives what is shown once a token is chosen: the royalty, if the collection sets one, depends on it."
                            : proceeds.isError
                              ? "The fee and royalty for this token could not be read, so the sale cannot be previewed or made. Check that the token exists."
                              : "Reading the fee and royalty for this token…"}
                        </p>
                      )}
                      <p className="muted small">
                        {proceeds.data && `You receive ${eth(proceeds.data.proceeds)} ETH${toleranceBps !== undefined ? `, and at least ${eth(withSlippage(proceeds.data.proceeds, toleranceBps))} ETH` : ""}. Read from the contract's rules for this token just now. `}
                        Points: half of what reaches the budget is credited to you and half to the buyer, once.
                      </p>
                      <div className="form-row">
                        <Field label="Proceeds tolerance (%)">
                          <input className="narrow" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} aria-invalid={toleranceChoice === undefined} />
                        </Field>
                        <ActionButton
                          className="big"
                          onClick={() => accept(selected)}
                          blocked={
                            now > selected.expiry
                              ? "This offer has expired"
                              : sellToken === undefined
                                ? "Choose the token to sell"
                                : toleranceBps === undefined
                                  ? `Enter a valid tolerance. ${TOLERANCE_HINT}`
                                  : !proceeds.data
                                    ? "The fee and royalty for this token have not been read yet"
                                    : !sameCollection(selected) && otherCollectionOk !== selected.id.toString() && "Confirm above that you mean to sell a token of that other collection"
                          }
                        >
                          {sellToken !== undefined ? `Sell #${sellToken} for ${eth(selected.price)} ETH` : "Accept"}
                        </ActionButton>
                        <button type="button" className="btn secondary" onClick={() => setSelectedId(undefined)}>
                          Not now
                        </button>
                      </div>
                      {toleranceChoice?.warning && <p className="notice">{toleranceChoice.warning}</p>}
                      <p className="muted small">
                        Accepting sends <code>minProceeds</code> = the proceeds shown here, less this tolerance. At 0% the sale reverts if the fee or royalty rises
                        in the meantime. The marketplace is approved for the token first if it is not already.
                      </p>
                    </Panel>
                  )}
                </>
              );
            }}
          </QueryView>
        </div>

        <aside className="market-make">
          <Panel title="Make an offer">
            <div className="segmented" role="group" aria-label="Kind of offer">
              <button type="button" className={kind === "collection" ? "on" : undefined} aria-pressed={kind === "collection"} onClick={() => setKind("collection")}>
                Any token
              </button>
              <button type="button" className={kind === "token" ? "on" : undefined} aria-pressed={kind === "token"} onClick={() => setKind("token")}>
                One token
              </button>
            </div>
            <p className="muted small">
              {kind === "collection" ? "Escrows price × quantity for any tokens of the selected collection. The seller chooses which token to give up." : "Escrows the ETH for one specific token of the selected collection."}
            </p>
            <div className="form">
              {kind === "token" && (
                <Field label="Token id">
                  <input inputMode="numeric" value={form.tokenId} onChange={(e) => setForm({ ...form, tokenId: e.target.value })} />
                </Field>
              )}
              <Field label={kind === "collection" ? "Price per token (ETH)" : "Price (ETH)"}>
                <input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
              </Field>
              {kind === "collection" && (
                <Field label="Quantity">
                  <input inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                </Field>
              )}
              <Field label="Expires in (days)">
                <input inputMode="decimal" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
              </Field>
            </div>
            <div className="escrow-line">
              <span className="figure-label">Into escrow</span>
              <strong>{escrow !== undefined ? `${eth(escrow)} ETH` : "–"}</strong>
              <span className="muted small">yours again if you cancel before it is accepted</span>
            </div>
            {input.price !== undefined && <SplitBar title={`If a holder accepts, of each ${eth(input.price)} ETH`} parts={splitParts(input.price, feeBps, 0n, projectBps, "The seller")} />}
            {input.price !== undefined && floorBid.data?.active && kind === "collection" && (
              <p className="muted small">
                For scale: the protocol's own bid is {eth(floorBid.data.currentBid, 4)} ETH now, {toEth(input.price) >= toEth(floorBid.data.currentBid) ? "at or below yours" : "above yours"}.
              </p>
            )}
            <ActionButton
              className="big"
              onClick={makeOffer}
              blocked={
                (input.price === undefined || !validDays || (kind === "token" ? input.tokenId === undefined : !input.quantity)) &&
                (kind === "token" ? "Enter a token id, a price and an expiry" : "Enter a price, a quantity of at least 1 and an expiry")
              }
            >
              {kind === "token" ? "Make the offer" : "Make the collection offer"}
            </ActionButton>
            <p className="muted small">The royalty, if the collection sets one through ERC-2981, also comes off the seller's side, up to the marketplace's cap.</p>
          </Panel>
        </aside>
      </div>
    </>
  );
}

function OfferRung({ offer, now, user, other, width, selected, onSelect, onCancel }: { offer: Offer; now: number; user: Address | undefined; other: boolean; width: string; selected: boolean; onSelect: (id: string | undefined) => void; onCancel: (offer: Offer) => void }) {
  const expired = now > offer.expiry;
  const mine = !!user && offer.offerer.toLowerCase() === user.toLowerCase();
  const id = offer.id.toString();
  return (
    <li className={selected ? "rung on" : "rung"}>
      <span className="rung-depth" style={{ width }} />
      <span className="rung-price">
        {eth(offer.price, 4)} <small>ETH</small>
      </span>
      <span className="rung-what">
        wants {offer.remaining}
        {offer.filled > 0 && <span className="muted"> ({offer.filled} filled)</span>} · by <Addr address={offer.offerer} /> {mine && <Badge tone="muted">You</Badge>}
        <small>
          {expired ? <Badge tone="bad">Expired</Badge> : `offer #${id} · expires ${relative(offer.expiry, now)}`} · collection <Addr address={offer.collection} />{" "}
          {other && <Badge tone="bad">Another collection</Badge>}
        </small>
      </span>
      <span className="rung-actions">
        {!mine && (
          <button type="button" className="btn small" aria-pressed={selected} disabled={expired} onClick={() => onSelect(selected ? undefined : id)}>
            {selected ? "Selected" : "Sell into it"}
          </button>
        )}
        {mine && (
          <ActionButton className="secondary small" onClick={() => onCancel(offer)}>
            Cancel
          </ActionButton>
        )}
      </span>
    </li>
  );
}
