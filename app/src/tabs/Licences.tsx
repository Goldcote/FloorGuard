import { useState } from "react";
import { useProtocol, useRead } from "../hooks";
import { requestLicenseCall } from "../lib/calls";
import { dateTime, duration, eth } from "../lib/format";
import { HoldingStatus, LICENSE_TIER_PROBE, readLicensing } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Field, QueryView } from "../ui";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function Licences() {
  const { deployment: d, user } = useProtocol();
  const { run } = useTx();
  const query = useRead(["licences", user], (c, dep) => readLicensing(c, dep, user));
  const [holdingId, setHoldingId] = useState("");
  const [tierText, setTierText] = useState("");
  const [scope, setScope] = useState("");

  return (
    <Card title="Artwork licences">
      <p className="notice">
        A licence here is a record that you paid for a licence tier on a vault NFT, for a limited time. It is not, by
        itself, a right to use the artwork: whether the vault can license a collection's artwork at all, and on what
        terms, depends on that collection's own terms. The licence text lives off-chain. Nothing here is legal advice.
      </p>
      <QueryView query={query}>
        {({ holdings, maxScopeLength }) => {
          const lockable = holdings.filter((h) => h.holding.status === HoldingStatus.Locked);
          const selected = lockable.find((h) => h.holding.id.toString() === holdingId) ?? lockable[0];
          const tier = selected?.tiers.find((t) => t.tier.toString() === tierText) ?? selected?.tiers[0];
          const scopeBytes = byteLength(scope);
          const request = () => {
            if (!d || !selected || !tier) return;
            void run(`Request a tier ${tier.tier} licence on holding #${selected.holding.id}`, (send) =>
              send("Request licence", requestLicenseCall(d, selected.holding.id, tier.tier, scope, tier.price)),
            );
          };
          return (
            <>
              <p className="muted">
                Licence fees go to the collection's buyback budget. Only holdings still locked in the vault can be
                licensed. A licence lapses when its term ends, when the owner revokes it, or when the NFT goes to
                auction or leaves the vault; no refund is paid. Tier numbers are defined by the protocol owner per
                collection (tiers 0 to {LICENSE_TIER_PROBE - 1} are shown).
              </p>
              {holdings.length === 0 ? (
                <p className="muted">The vault holds nothing that can be licensed.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Holding</th>
                        <th>Collection</th>
                        <th>Token</th>
                        <th>Status</th>
                        <th>Available tiers</th>
                        <th>Your licence in force</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map(({ holding, tiers, license, banned }) => (
                        <tr key={holding.id.toString()}>
                          <td>#{holding.id.toString()}</td>
                          <td><Addr address={holding.collection} /></td>
                          <td>#{holding.tokenId.toString()}</td>
                          <td>
                            {holding.status === HoldingStatus.Locked ? (
                              <Badge tone="good">Locked: can be licensed</Badge>
                            ) : (
                              <Badge tone="muted">Unlocked: no new licences</Badge>
                            )}
                          </td>
                          <td className="wrap">
                            {tiers.length === 0
                              ? "None set for this collection"
                              : tiers.map((t) => (
                                  <div key={t.tier}>
                                    Tier {t.tier}: {t.price === 0n ? "free" : `${eth(t.price)} ETH`} for {duration(t.duration)}
                                  </div>
                                ))}
                          </td>
                          <td>
                            {!user ? (
                              <span className="muted">Connect a wallet</span>
                            ) : license ? (
                              <>
                                Tier {license.tier}, until {dateTime(license.end)}
                              </>
                            ) : (
                              "None"
                            )}
                            {banned && <div><Badge tone="bad">Revoked: you cannot license this holding</Badge></div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {lockable.length > 0 && selected && (
                <div className="licence-form">
                  <h3>Request a licence</h3>
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
                    <textarea
                      rows={3}
                      maxLength={maxScopeLength}
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      placeholder="For example: prints for a local art fair, up to 100 copies"
                    />
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
                      This sends the tier price and records the payment against your address. It does not grant rights
                      beyond what the collection's own terms allow.
                    </p>
                  </div>
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </Card>
  );
}
