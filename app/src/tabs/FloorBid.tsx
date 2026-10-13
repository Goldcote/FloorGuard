// The floor bid as a living curve you can sell into. Two things are drawn and never confused: the
// curve (where the rule has taken the price) and the bid (what a seller is paid, which is never
// more than the budget holds).
import { useState } from "react";
import type { Address } from "viem";
import { approveCall, sellCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parsePercentBps, parseUint } from "../lib/parse";
import { readFloorBid, readOverview, readTokenState, withSlippage, type FloorBid as Bid } from "../lib/reads";
import { href } from "../routes";
import { useTx } from "../tx";
import { ActionButton, Badge, Field, PageHead, Panel, QueryView } from "../ui";
import { BID_STATE_TEXT, BidChart, bidState, useLiveNow } from "../viz/charts";
import { bidAt, fillsCovered, maxFillCooldown, payableBid, toEth, unlockPrice } from "../viz/curves";
import { bidHistory, ownedTokens } from "../viz/data";
import { useClock, useFlash } from "../viz/motion";
import { LiveDot, TokenTile } from "../viz/parts";

/** The headline: the bid, ticking, and the sentence that tells curve and bid apart. */
function BidHeadline({ bid, clock }: { bid: Bid; clock: () => number }) {
  const now = useLiveNow(clock, true);
  const state = bidState(bid, now);
  const curve = bid.active ? bidAt(bid, now) : 0n;
  const payable = bid.active ? payableBid(curve, bid.budget) : 0n;
  const limited = state === "budget" || state === "empty";
  return (
    <div className={`bid-headline state-${state}`}>
      <div className="bid-now">
        <span className="bid-now-label">
          <LiveDot /> The bid, right now
        </span>
        <span className="bid-now-value">
          {toEth(payable).toFixed(5)} <small>ETH</small>
        </span>
      </div>
      <div className="bid-now-state">
        <Badge tone={state === "rising" ? "good" : state === "inactive" ? "muted" : "warn"}>{BID_STATE_TEXT[state]}</Badge>
        <p>
          {state === "inactive"
            ? "The owner has not configured a bid for this collection."
            : state === "empty"
              ? `The curve is at ${eth(curve, 4)} ETH, but the budget holds ${eth(bid.budget, 4)} ETH, below the minimum bid of ${eth(bid.minBid, 4)} ETH, so nothing can be sold into it. The next money in restarts the curve.`
              : limited
                ? `The curve is at ${eth(curve, 4)} ETH; the budget can pay ${eth(bid.budget, 4)} ETH, so the bid is ${eth(payable, 4)} ETH. The rise does not count while the budget cannot cover it: the next money in restarts the curve, from its base or from what the budget held if that is higher.`
                : `The curve is at ${eth(curve, 4)} ETH${state === "capped" ? ", its cap," : ""} and the budget covers it, so the bid is the curve.${state === "cooldown" ? ` It is pausing between sales until ${dateTime(bid.nextFillAt)}.` : ""}`}
        </p>
      </div>
    </div>
  );
}

/** What a seller is paid at this instant, re-drawn between reads so every figure on the page agrees. */
function LivePayable({ bid, clock, digits = 5 }: { bid: Bid; clock: () => number; digits?: number }) {
  const now = useLiveNow(clock, true);
  return <>{bid.active ? toEth(payableBid(bidAt(bid, now), bid.budget)).toFixed(digits) : "0"}</>;
}

/** The budget as fuel: how many sales at the present bid it can pay for. */
function Fuel({ bid }: { bid: Bid }) {
  const covered = bid.currentBid > 0n ? fillsCovered(bid.budget, bid.currentBid) : 0;
  const cells = 8;
  return (
    <div className="fuel">
      <div className="fuel-head">
        <span className="figure-label">Budget: the fuel</span>
        <strong>
          {eth(bid.budget, 4)} <small>ETH</small>
        </strong>
      </div>
      <div className="fuel-cells" role="img" aria-label={`The budget pays for ${covered.toFixed(1)} sales at the present bid`}>
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className="fuel-cell">
            <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, covered - i))})` }} />
          </span>
        ))}
      </div>
      <p className="muted small">
        {bid.currentBid === 0n || bid.currentBid < bid.minBid
          ? "Less than the minimum bid: nothing to bid with. Fees, auction proceeds or a donation refill it."
          : covered >= cells
            ? `Enough for more than ${cells} sales at the present bid.`
            : `Enough for ${covered.toFixed(1)} sale${covered === 1 ? "" : "s"} at the present bid. Each sale spends the bid from this budget.`}
      </p>
    </div>
  );
}

export function FloorBid({ collection }: { collection: Address }) {
  const { client, deployment: d, user, demo } = useProtocol();
  const { run } = useTx();
  const now = useChainTime();
  const clock = useClock();
  const query = useRead(["floorBid", collection], (c, dep) => readFloorBid(c, dep, collection));
  const overview = useRead(["overview", collection, user], (c, dep) => readOverview(c, dep, collection, user));
  const [tokenText, setTokenText] = useState("");
  const [slippageText, setSlippageText] = useState("1");
  const [sold, setSold] = useState<{ tokenId: bigint; before: number }>();

  const tokenId = parseUint(tokenText);
  const slippageBps = parsePercentBps(slippageText);
  const history = bidHistory(demo);
  const owned = ownedTokens(demo);
  const floor = overview.data?.salesFloor.ok ? overview.data.salesFloor.price : undefined;
  // a sale (anyone's) restarts the curve: flash the stage when that happens
  const justFilled = useFlash(query.data?.lastReset, 1_600) && history.events.at(-1)?.kind !== "restart";
  const lastFill = [...history.events].reverse().find((e) => e.kind === "fill");

  const sell = () => {
    if (!client || !d || !user || tokenId === undefined || slippageBps === undefined || !query.data) return;
    const quoted = query.data.currentBid;
    void run(
      `Sell token #${tokenId} into the floor bid`,
      async (send) => {
        const token = await readTokenState(client, collection, tokenId, d.buybackEngine);
        if (token.owner.toLowerCase() !== user.toLowerCase()) throw new Error(`You do not own token #${tokenId}.`);
        if (!token.approved) {
          await send("Approve buyback engine", approveCall(collection, d.buybackEngine, tokenId));
        }
        // Re-read the bid after the approval: it moves with time and drops when someone else sells.
        const { currentBid } = await readFloorBid(client, d, collection);
        await send("Sell", sellCall(d, collection, tokenId, withSlippage(currentBid, slippageBps)));
        setSold({ tokenId, before: history.events.length });
        setTokenText("");
      },
      [
        `You sell token #${tokenId} to the protocol at the live bid, about ${eth(quoted)} ETH, paid from the collection's buyback budget. No fee is taken.`,
        `The sale is rejected if the bid has dropped more than ${slippageText}% by the time it is mined.`,
        "The token goes to the vault and is locked there; this cannot be undone.",
        "If the buyback engine is not yet approved for this token, an approval transaction comes first.",
      ],
      {
        preview: (
          <div className="swap-preview">
            <div className="swap-side">
              <TokenTile tokenId={tokenId} size={56} />
              <span>
                Token #{tokenId.toString()}
                <small>to the vault, locked</small>
              </span>
            </div>
            <span className="swap-arrow" aria-hidden="true">
              ⇄
            </span>
            <div className="swap-side">
              <strong className="swap-amount">{eth(quoted, 5)} ETH</strong>
              <span>
                to you
                <small>from the budget, no fee</small>
              </span>
            </div>
          </div>
        ),
      },
    );
  };

  return (
    <>
      <PageHead eyebrow="Trade · floor bid" title="The rising bid">
        A standing bid for any token of the collection. Its curve climbs until a holder sells into it, then steps down and climbs again. It
        never pays more than the collection's budget holds.
      </PageHead>
      <QueryView query={query} lines={6}>
        {(bid) => {
          const state = bidState(bid, now);
          const maxCooldown = maxFillCooldown(bid.growthBpsPerDay, bid.stepDownBps);
          const minPrice = slippageBps !== undefined && bid.active ? withSlippage(bid.currentBid, slippageBps) : undefined;
          return (
            <div className="bid-layout">
              <section className={justFilled ? "bid-stage just-filled" : "bid-stage"} aria-label="The bid curve">
                <BidHeadline bid={bid} clock={clock} />
                {bid.active ? (
                  <BidChart bid={bid} events={history.events} first={history.first} clock={clock} floor={floor} />
                ) : (
                  <p className="muted">There is no curve to draw until the owner configures a bid.</p>
                )}
                <dl className="bid-facts">
                  <div>
                    <dt>Base</dt>
                    <dd>{eth(bid.basePrice, 4)} ETH</dd>
                    <dd className="muted small">since {dateTime(bid.lastReset)}</dd>
                  </div>
                  <div>
                    <dt>Rise</dt>
                    <dd>+{bps(bid.growthBpsPerDay)} a day</dd>
                    <dd className="muted small">of the base, while the budget covers it</dd>
                  </div>
                  <div>
                    <dt>After a sale</dt>
                    <dd>−{bps(bid.stepDownBps)}</dd>
                    <dd className="muted small">one step below the sale; a sale limited by the budget pulls the base down by at most three more</dd>
                  </div>
                  <div>
                    <dt>Cap</dt>
                    <dd>{eth(bid.maxPrice, 4)} ETH</dd>
                    <dd className="muted small">set by the owner; the upper limit on what is paid</dd>
                  </div>
                  <div>
                    <dt>Minimum bid</dt>
                    <dd>{eth(bid.minBid, 4)} ETH</dd>
                    <dd className="muted small">no buyback below this, however thin the budget</dd>
                  </div>
                  <div>
                    <dt>Pause between sales</dt>
                    <dd>{bid.fillCooldown > 0 ? duration(bid.fillCooldown) : "none"}</dd>
                    <dd className="muted small">
                      {now < bid.nextFillAt ? `next sale from ${dateTime(bid.nextFillAt)}` : maxCooldown !== undefined ? `at most ${duration(maxCooldown)}: the time the curve needs to regrow one step` : "no limit applies without growth"}
                    </dd>
                  </div>
                </dl>
              </section>

              <aside className="sell-panel">
                <Fuel bid={bid} />
                <Panel title="Sell into it" className="sell-form">
                  {owned.length > 0 && (
                    <div className="token-picks" role="group" aria-label="Your tokens in the demo">
                      {owned.map((id) => (
                        <button key={id.toString()} type="button" className={tokenId === id ? "token-pick on" : "token-pick"} aria-pressed={tokenId === id} onClick={() => setTokenText(id.toString())}>
                          <TokenTile tokenId={id} size={52} />
                        </button>
                      ))}
                    </div>
                  )}
                  {demo && owned.length === 0 && <p className="muted small">You hold no tokens of the demo collection any more. Reset the demo to start over.</p>}
                  <div className="form-row">
                    <Field label="Token id">
                      <input className="narrow" inputMode="numeric" value={tokenText} onChange={(e) => setTokenText(e.target.value)} />
                    </Field>
                    <Field label="Slippage (%)">
                      <input className="narrow" inputMode="decimal" value={slippageText} onChange={(e) => setSlippageText(e.target.value)} />
                    </Field>
                  </div>
                  <dl className="sell-sum">
                    <div>
                      <dt>You receive</dt>
                      <dd>
                        <strong>
                          <LivePayable bid={bid} clock={clock} />
                        </strong>{" "}
                        ETH
                      </dd>
                    </div>
                    <div>
                      <dt>Fee</dt>
                      <dd>none</dd>
                    </div>
                    <div>
                      <dt>Your minimum</dt>
                      <dd>{minPrice !== undefined ? `${eth(minPrice, 5)} ETH` : "–"}</dd>
                    </div>
                    <div>
                      <dt>The token</dt>
                      <dd>to the vault: 180 days, and until the floor is {eth(unlockPrice(bid.currentBid), 4)} ETH</dd>
                    </div>
                  </dl>
                  <ActionButton
                    className="big sell-btn"
                    onClick={sell}
                    blocked={
                      now < bid.nextFillAt
                        ? `The bid pauses between sales; the next is possible from ${dateTime(bid.nextFillAt)}`
                        : !bid.active
                          ? "There is no active bid for this collection"
                          : bid.currentBid === 0n || bid.currentBid < bid.minBid
                            ? "The budget holds less than the minimum bid, so there is nothing to bid with"
                            : (tokenId === undefined || slippageBps === undefined) && "Choose a token and a slippage"
                    }
                  >
                    {tokenId !== undefined ? `Sell #${tokenId} at ` : "Sell at "}
                    <LivePayable bid={bid} clock={clock} digits={4} /> ETH
                  </ActionButton>
                  <p className="muted small">The engine is approved for the token first if it is not already. The sale cannot be undone.</p>
                  {sold && history.events.length > sold.before && lastFill?.kind === "fill" && (
                    <div className="callout good sold-note" role="status">
                      <p>
                        Sold. Token #{sold.tokenId.toString()} went to the vault for {eth(lastFill.price, 5)} ETH, and the curve restarted {bps(bid.stepDownBps)} lower.
                      </p>
                      <a className="btn secondary small" href={href("/vault/holdings")}>
                        See it in the vault
                      </a>
                    </div>
                  )}
                </Panel>
                {state === "budget" && <p className="notice">The bid is limited by the budget right now: a sale is paid what the budget holds, not what the curve says.</p>}
              </aside>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
