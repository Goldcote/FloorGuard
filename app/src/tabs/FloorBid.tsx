import { useState } from "react";
import type { Address } from "viem";
import { approveCall, sellCall } from "../lib/calls";
import { useProtocol, useRead } from "../hooks";
import { bps, eth } from "../lib/format";
import { parsePercentBps, parseUint } from "../lib/parse";
import { readFloorBid, readTokenState, withSlippage } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Badge, Card, Field, QueryView, Stat } from "../ui";

export function FloorBid({ collection }: { collection: Address }) {
  const { client, deployment: d, user } = useProtocol();
  const { run } = useTx();
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
    });
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
                value={bid.isFillable ? <Badge tone="good">Yes</Badge> : <Badge tone="bad">No</Badge>}
              />
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
                  !bid.active
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
