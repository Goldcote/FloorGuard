import { useEffect, useState } from "react";
import { useProtocol, useRead } from "../hooks";
import { requestLicenseCall } from "../lib/calls";
import { dateTime, duration, eth } from "../lib/format";
import { HoldingStatus, LICENSE_TIER_PROBE, readLicensing } from "../lib/reads";
import { href, useRouteParam } from "../routes";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Empty, Field, Notice, PageHead, Panel, QueryView } from "../ui";
import { StatePlate, TokenTile } from "../viz/parts";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function Licences() {
  const { deployment: d, user } = useProtocol();
  const { run } = useTx();
  const query = useRead(["licences", user], (c, dep) => readLicensing(c, dep, user));
  const linked = useRouteParam("holding");
  const [holdingId, setHoldingId] = useState(linked ?? "");
  const [tierText, setTierText] = useState("");
  const [scope, setScope] = useState("");
  useEffect(() => {
    if (linked) setHoldingId(linked);
  }, [linked]);

  return (
    <>
      <PageHead eyebrow="Vault · licences" title="Artwork licences">
        Time-limited licence tiers on the artwork of tokens locked in the vault. The fee goes to the collection's buyback budget.
      </PageHead>
      <Notice>
        A licence here is a record that you paid for a licence tier on a vault NFT, for a limited time. It is not, by itself, a right to use the
        artwork: whether the vault can license a collection's artwork at all, and on what terms, depends on that collection's own terms. The licence
        text lives off-chain. Nothing here is legal advice.
      </Notice>
      <QueryView query={query}>
        {({ holdings, maxScopeLength }) => {
          const lockable = holdings.filter((h) => h.holding.status === HoldingStatus.Locked);
          const selected = lockable.find((h) => h.holding.id.toString() === holdingId) ?? lockable[0];
          const tier = selected?.tiers.find((t) => t.tier.toString() === tierText) ?? selected?.tiers[0];
          const scopeBytes = byteLength(scope);
          const request = () => {
            if (!d || !selected || !tier) return;
            void run(
              `Request a tier ${tier.tier} licence on holding #${selected.holding.id}`,
              (send) => send("Request licence", requestLicenseCall(d, selected.holding.id, tier.tier, scope, tier.price)),
              [
                tier.price === 0n ? "This tier is free; you pay only the transaction fee." : `You pay ${eth(tier.price)} ETH, which goes to the collection's buyback budget. It is not refundable.`,
                `Records a tier ${tier.tier} licence for ${duration(tier.duration)} on vault holding #${selected.holding.id}, with your intended-use text stored publicly on-chain.`,
                "This is a record of payment. Whether it gives you any right to use the artwork depends on the collection's own terms.",
              ],
            );
          };
          if (holdings.length === 0) {
            return (
              <Empty icon="vault" title="The vault holds nothing that can be licensed.">
                Holdings appear here once the floor bid has bought a token.
              </Empty>
            );
          }
          return (
            <>
              <Panel title="Holdings and their tiers" aside={<a className="small" href={href("/vault/holdings")}>Back to the vault</a>}>
                <div className="licence-wall">
                  {holdings.map(({ holding, tiers, licenses, banned }) => {
                    const locked = holding.status === HoldingStatus.Locked;
                    const isSelected = selected?.holding.id === holding.id;
                    return (
                      <article key={holding.id.toString()} className={isSelected ? "licence-card on" : "licence-card"}>
                        <header>
                          <TokenTile tokenId={holding.tokenId} size={64} state={locked ? "locked" : "unlocked"} />
                          <div>
                            <h3>
                              Token #{holding.tokenId.toString()} <span className="muted">· holding #{holding.id.toString()}</span>
                            </h3>
                            <p className="muted small">
                              <Addr address={holding.collection} />
                            </p>
                            <StatePlate state={locked ? "locked" : "unlocked"} />
                          </div>
                        </header>
                        {!locked && <p className="muted small">Unlocked: no new licences. Only holdings still locked in the vault can be licensed.</p>}
                        {tiers.length === 0 ? (
                          <p className="muted small">No licence tiers are set for this collection.</p>
                        ) : (
                          <div className="licence-tier-row" role="group" aria-label={`Licence tiers for holding ${holding.id}`}>
                            {tiers.map((t) => {
                              const on = isSelected && tier?.tier === t.tier;
                              return (
                                <button
                                  key={t.tier}
                                  type="button"
                                  className={on ? "licence-tier on" : "licence-tier"}
                                  aria-pressed={on}
                                  disabled={!locked}
                                  onClick={() => {
                                    setHoldingId(holding.id.toString());
                                    setTierText(t.tier.toString());
                                  }}
                                >
                                  <span className="licence-tier-name">Tier {t.tier}</span>
                                  <strong>{t.price === 0n ? "Free" : `${eth(t.price)} ETH`}</strong>
                                  <span className="licence-tier-term">{duration(t.duration)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <p className="small">
                          <span className="figure-label">Your licences in force</span>{" "}
                          {!user ? (
                            <span className="muted">Connect a wallet</span>
                          ) : banned ? (
                            <Badge tone="bad">Banned from this holding</Badge>
                          ) : licenses.length > 0 ? (
                            licenses.map((l) => (
                              <Badge key={l.tier} tone="good">
                                Tier {l.tier}, until {dateTime(l.end)}
                              </Badge>
                            ))
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </p>
                        {banned && <p className="muted small">A licence of yours here was revoked. None is in force and you cannot buy another unless the owner lifts the ban.</p>}
                      </article>
                    );
                  })}
                </div>
              </Panel>

              {lockable.length > 0 && selected && (
                <Panel title="Request a licence" className="licence-request">
                  <div className="form-row">
                    <Field label="Holding">
                      <select value={selected.holding.id.toString()} onChange={(e) => setHoldingId(e.target.value)}>
                        {lockable.map((h) => (
                          <option key={h.holding.id.toString()} value={h.holding.id.toString()}>
                            #{h.holding.id.toString()} (token #{h.holding.tokenId.toString()})
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Tier">
                      <select value={tier?.tier.toString() ?? ""} onChange={(e) => setTierText(e.target.value)}>
                        {selected.tiers.map((t) => (
                          <option key={t.tier} value={t.tier}>
                            Tier {t.tier}: {t.price === 0n ? "free" : `${eth(t.price)} ETH`}, {duration(t.duration)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label={`Intended use, recorded publicly on-chain with the licence (${scopeBytes}/${maxScopeLength} bytes)`}>
                    <textarea rows={3} maxLength={maxScopeLength} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="For example: prints for a local art fair, up to 100 copies" />
                  </Field>
                  <div className="form-row">
                    <ActionButton
                      onClick={request}
                      blocked={
                        !tier
                          ? "No licence tier is available for this collection"
                          : selected.banned
                            ? "A licence of yours on this holding was revoked"
                            : scopeBytes > maxScopeLength && `The intended use is too long (${maxScopeLength} bytes at most)`
                      }
                    >
                      {tier ? (tier.price === 0n ? "Request the free licence" : `Pay ${eth(tier.price)} ETH and record the licence`) : "Request licence"}
                    </ActionButton>
                    <p className="muted grow">
                      This sends the tier price and records the payment against your address. It does not grant rights beyond what the collection's own
                      terms allow.
                    </p>
                  </div>
                </Panel>
              )}

              <details className="fine-print">
                <summary>How licences lapse</summary>
                <p className="muted">
                  Licences are per tier, and you can hold several on one holding. A licence lapses when its term ends, when the owner revokes it (which
                  also bans you from that holding), or when the NFT goes to auction or leaves the vault; no refund is paid. Tier numbers are defined by
                  the protocol owner per collection (tiers 0 to {LICENSE_TIER_PROBE - 1} are shown).
                </p>
              </details>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
