import { useState } from "react";
import type { Address } from "viem";
import { approveCall, sellCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parsePercentBps, parseUint } from "../lib/parse";
import { readFloorBid, readTokenState, withSlippage } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Badge, Card, Field, QueryView, Stat } from "../ui";

export function FloorBid({ collection }: { collection: Address }) {
  const { client, deployment: d, user } = useProtocol();
  const { run } = useTx();
  const now = useChainTime();
  const query = useRead(["floorBid", collection], (c, dep) => readFloorBid(c, dep, collection));
  const [tokenText, setTokenText] = useState("");
  const [slippageText, setSlippageText] = useState("1");

  const tokenId = parseUint(tokenText);
  const slippageBps = parsePercentBps(slippageText);

  const sell = () => {
    if (!client || !d || !user || tokenId === undefined || slippageBps === undefined) return;
    void run(`Sell token #${tokenId} into the floor bid`, async (send) => {
      const token = await readTokenState(client, collection, tokenId, d.buybackEngine);
      if (token.owner.toLowerCase() !== user.toLowerCase()) throw new Error(`You do not own token #${tokenId}.`);
      if (!token.approved) {
        await send("Approve buyback engine", approveCall(collection, d.buybackEngine, tokenId));
      }
      // Re-read the bid after the approval: it moves with time and drops when someone else sells.
      const { currentBid } = await readFloorBid(client, d, collection);
      await send("Sell", sellCall(d, collection, tokenId, withSlippage(currentBid, slippageBps)));
    }, [
      `You sell token #${tokenId} to the protocol at the live bid${query.data ? `, about ${eth(query.data.currentBid)} ETH` : ""}, paid in full from the collection's buyback budget. No fee is taken.`,
      `The sale is rejected if the bid has dropped more than ${slippageText}% by the time it is mined.`,
      "The token goes to the vault and is locked there; this cannot be undone.",
      "If the buyback engine is not yet approved for this token, an approval transaction comes first.",
    ]);
  };

  return (
    <Card title="Sell into the floor bid">
      <QueryView query={query}>
        {(bid) => (
          <>
            <div className="stats">
              <Stat
                label="Live bid"
                value={bid.active ? `${eth(bid.currentBid)} ETH` : <Badge tone="muted">No active bid</Badge>}
                hint={
                  bid.active
                    ? `Rises ${bps(bid.growthBpsPerDay)} of ${eth(bid.basePrice)} ETH per day up to ${eth(bid.maxPrice)} ETH; drops ${bps(bid.stepDownBps)} after each fill`
                    : undefined
                }
              />
              <Stat label="Buyback budget" value={`${eth(bid.budget)} ETH`} />
              <Stat
                label="Fillable"
                value={bid.isFillable && now >= bid.nextFillAt ? <Badge tone="good">Yes</Badge> : <Badge tone="bad">No</Badge>}
                hint={now < bid.nextFillAt ? `Pausing between fills until ${dateTime(bid.nextFillAt)}` : undefined}
              />
              {bid.fillCooldown > 0 && (
                <Stat
                  label="Pause between fills"
                  value={duration(bid.fillCooldown)}
                  hint={
                    now < bid.nextFillAt
                      ? `Next sale possible from ${dateTime(bid.nextFillAt)}`
                      : "After each sale the bid accepts no other for this long"
                  }
                />
              )}
              <Stat
                label="Your minimum price"
                value={slippageBps !== undefined && bid.active ? `${eth(withSlippage(bid.currentBid, slippageBps))} ETH` : "–"}
                hint="Live bid less slippage, sent as minPrice"
              />
            </div>
            <p className="muted">
              The protocol pays the live bid in full (no fee) and locks the token in the vault. The engine is approved
              for the token first if it is not already.
            </p>
            <div className="form-row">
              <Field label="Token id">
                <input className="narrow" inputMode="numeric" value={tokenText} onChange={(e) => setTokenText(e.target.value)} />
              </Field>
              <Field label="Slippage (%)">
                <input className="narrow" inputMode="decimal" value={slippageText} onChange={(e) => setSlippageText(e.target.value)} />
              </Field>
              <ActionButton
                onClick={sell}
                blocked={
                  now < bid.nextFillAt
                    ? `The bid pauses between fills; next sale possible from ${dateTime(bid.nextFillAt)}`
                    : !bid.active
                    ? "There is no active bid for this collection"
                    : !bid.isFillable
                      ? "The buyback budget does not cover the bid"
                      : (tokenId === undefined || slippageBps === undefined) && "Enter a token id and a slippage"
                }
              >
                Sell at {eth(bid.currentBid)} ETH
              </ActionButton>
            </div>
          </>
        )}
      </QueryView>
    </Card>
  );
}
