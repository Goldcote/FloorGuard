// The house: the games bankroll and the shares in it. Not a yield product, and not drawn as one:
// the page shows what the bankroll holds, the realised history of the share price from events, and
// what a deposit or a redemption would do right now. Wording follows docs/ARCHITECTURE.md ("The
// house") and SECURITY.md ("House shares").
import { useState } from "react";
import { useProtocol, useRead } from "../hooks";
import { depositHouseCall, redeemHouseCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import { housePoints, leftBehind, previewDeposit, previewRedeem, readHouse, readHouseEvents, SHARE_UNIT, sharePrice, withTolerance, type HouseState } from "../lib/house";
import { parseEth, parsePercentBps } from "../lib/parse";
import { href } from "../routes";
import { useTx } from "../tx";
import { ActionButton, Empty, Field, Notice, PageHead, Panel, QueryView } from "../ui";
import { HouseChart } from "../viz/charts";
import { toEth } from "../viz/curves";
import { Num } from "../viz/motion";
import { LiveDot } from "../viz/parts";
import { LOGS_FROM_BLOCK } from "../wagmi";

/** Shares in units of a million raw shares (what 1 wei bought at the first deposit). */
const units = (shares: bigint, digits = 4) => eth(shares / SHARE_UNIT, digits);

/** The bankroll as an object: what is free, what is set aside for open bets, and the wagers in play. */
function Vessel({ h }: { h: HouseState }) {
  const total = h.bankroll + h.reserved + h.openWagers;
  const pct = (v: bigint) => (total === 0n ? 0 : Number((v * 10_000n) / total) / 100);
  const open = h.reserved > 0n || h.openWagers > 0n;
  return (
    <div className={open ? "vessel has-open" : "vessel"}>
      <div className="vessel-bar" role="img" aria-label={`The bankroll: ${eth(h.bankroll, 4)} ETH free, ${eth(h.reserved, 4)} ETH set aside for open bets, ${eth(h.openWagers, 4)} ETH of players' wagers in play`}>
        <span className="vessel-free" style={{ flexGrow: Math.max(0.0001, pct(h.bankroll)) }} />
        <span className="vessel-reserved" style={{ flexGrow: pct(h.reserved) }} />
        <span className="vessel-wagers" style={{ flexGrow: pct(h.openWagers) }} />
      </div>
      <dl className="vessel-legend">
        <div>
          <dt>
            <i className="key free" /> Free bankroll
          </dt>
          <dd>
            <Num value={toEth(h.bankroll)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">What redemptions are paid from</dd>
        </div>
        <div>
          <dt>
            <i className="key reserved" /> Set aside for open bets
          </dt>
          <dd>
            <Num value={toEth(h.reserved)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">House money a win would pay; back when the bet settles</dd>
        </div>
        <div>
          <dt>
            <i className="key wagers" /> Wagers in play
          </dt>
          <dd>
            <Num value={toEth(h.openWagers)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">Players' stakes on the open bets</dd>
        </div>
      </dl>
    </div>
  );
}

export function House() {
  const { deployment: d, user, demo } = useProtocol();
  const { run } = useTx();
  const query = useRead(["house", user], (c, dep) => readHouse(c, dep, user));
  const events = useRead(["houseEvents"], (c, dep) => readHouseEvents(c, dep, LOGS_FROM_BLOCK));
  const [depositText, setDepositText] = useState("");
  const [redeemText, setRedeemText] = useState("");
  const [toleranceText, setToleranceText] = useState("0.5");
  const tolerance = parsePercentBps(toleranceText);

  return (
    <>
      <PageHead eyebrow="Play · the house" title="The house">
        Dice and slots are played against a bankroll. Anyone can fund it for shares and redeem them later; the holders of shares are the house. When
        players win, the house pays.
      </PageHead>
      <Notice>
        This is not a savings or yield product. Share holders can lose part or all of what they put in when players win; nothing is guaranteed, and the
        part of the edge the bankroll keeps only tilts the average. Redeeming while bets are open gives up your part of the funds set aside for them.
        Offering a share in a gambling bankroll may be regulated separately from the games. The share mechanism is new and has not been independently
        reviewed.
      </Notice>

      <QueryView query={query} lines={6}>
        {(h) => {
          const price = sharePrice(h.bankroll, h.totalShares);
          const mine = h.userShares ?? 0n;
          const mineValue = previewRedeem(h, mine);
          const mineLeft = leftBehind(h, mine);
          const ofHouse = h.totalShares > 0n ? Number((mine * 1_000_000n) / h.totalShares) / 10_000 : 0;

          const amount = parseEth(depositText);
          const shares = amount !== undefined ? previewDeposit(h, amount) : undefined;
          // the visitor types share units; the contract takes raw shares
          const redeemUnits = parseEth(redeemText);
          // "All" means every raw share, including the part of a unit the field cannot show
          const redeemShares = redeemUnits === undefined ? undefined : mine > 0n && redeemUnits === mine / SHARE_UNIT ? mine : redeemUnits * SHARE_UNIT;
          const tooMany = redeemShares !== undefined && redeemShares > mine;
          const pays = redeemShares !== undefined && !tooMany ? previewRedeem(h, redeemShares) : undefined;
          const stays = redeemShares !== undefined && !tooMany ? leftBehind(h, redeemShares) : undefined;

          const deposit = () => {
            if (!d || amount === undefined || shares === undefined || tolerance === undefined) return;
            const minShares = withTolerance(shares, tolerance);
            void run(`Deposit ${eth(amount)} ETH into the house`, (send) => send("Deposit", depositHouseCall(d, amount, minShares)), [
              `${eth(amount)} ETH moves from your wallet into the games bankroll. You receive about ${units(shares)} shares.`,
              "Deposits are priced as if the house wins every open bet, so a result already on its way cannot be bought into.",
              `The deposit is rejected if you would receive more than ${toleranceText}% fewer shares than previewed.`,
              "You can lose part or all of this when players win. Nothing is guaranteed.",
            ]);
          };
          const redeem = () => {
            if (!d || !user || redeemShares === undefined || pays === undefined || tolerance === undefined) return;
            const minAssets = withTolerance(pays, tolerance);
            void run(`Redeem ${units(redeemShares)} house shares`, (send) => send("Redeem", redeemHouseCall(d, redeemShares, minAssets, user)), [
              `You burn ${units(redeemShares)} shares and receive about ${eth(pays)} ETH from the free bankroll.`,
              stays && stays > 0n
                ? `Bets are open right now: about ${eth(stays)} ETH that is your part of the funds set aside for them stays with the remaining holders.`
                : "No bets are open right now, so nothing is left behind.",
              `The redemption is rejected if you would receive more than ${toleranceText}% less than previewed.`,
            ]);
          };

          return (
            <>
              <Panel title="The bankroll, right now" aside={<span className="muted small">{h.reserved > 0n ? <><LiveDot /> bets are open</> : "no bets open"}</span>}>
                <Vessel h={h} />
              </Panel>

              <div className="house-layout">
                <div>
                  <Panel title="Share price so far" aside={<span className="muted small">Realised history from the contract's events. Not a forecast.</span>}>
                    <div className="house-stage">
                      <div className="house-price">
                        <span className="figure-label">Redeem value of one share</span>
                        <strong>
                          <Num value={price} format={(n) => n.toFixed(6)} /> <small>ETH</small>
                        </strong>
                        <span className="muted small">1 was the price of the first deposit. A share here is a million of the contract's raw shares.</span>
                      </div>
                      <QueryView query={events}>
                        {(list) =>
                          list === undefined ? (
                            <p className="muted">The node refused the log queries, so the history cannot be drawn. The figures above are read directly.</p>
                          ) : list.length === 0 ? (
                            <Empty icon="stream" title="Nothing has happened to the house yet." />
                          ) : (
                            <>
                              <HouseChart points={housePoints(list)} />
                              <p className="chart-foot">
                                Each step is a settled bet: up when the player lost or the edge was kept, down when the player won. Triangles are deposits (▲)
                                and redemptions (▼), which happen at the going price.{demo && " In the demo the bets are the ones you place on the dice and slots stages."}
                              </p>
                            </>
                          )
                        }
                      </QueryView>
                    </div>
                  </Panel>

                  <Panel title="What moves the price">
                    <div className="house-rules">
                      <div>
                        <h3>What comes in</h3>
                        <ul className="plain-list">
                          <li>
                            {bps(h.bankrollShareBps)} of each edge stays in the bankroll, whatever the outcome. The edge is {bps(h.edgeBps)} of a wager; the rest of it goes
                            to the Treasury as buyback budget.
                          </li>
                          <li>The stake of every bet a player loses.</li>
                        </ul>
                      </div>
                      <div>
                        <h3>What goes out</h3>
                        <ul className="plain-list">
                          <li>Every win is paid from it. The stake after the edge is played at exactly fair odds, so on average those two cancel; only the kept part of the edge tilts it.</li>
                          <li>
                            One bet can put at most {bps(h.maxExposureBps)} of the free bankroll at risk, and all open bets together at most {bps(h.maxTotalExposureBps)} of the
                            house's funds. A long run of player wins can still exhaust it.
                          </li>
                        </ul>
                      </div>
                      <div>
                        <h3>Two pricing rules</h3>
                        <ul className="plain-list">
                          <li>A deposit is priced as if the house wins every open bet.</li>
                          <li>A redemption is priced as if the house loses every open bet.</li>
                          <li>So nobody can time a result they have seen. The cost falls on whoever redeems while bets are open: their part of the funds set aside stays with the remaining holders.</li>
                        </ul>
                      </div>
                    </div>
                    <p className="muted small">
                      The owner cannot withdraw the bankroll. The owner does set the edge, the bankroll's share of it, the limits above and the randomness provider; see the{" "}
                      <a href={href("/fairness")}>fairness page</a>.
                    </p>
                  </Panel>
                </div>

                <aside className="house-side">
                  <Panel title="Your shares" className="house-card">
                    {!user ? (
                      <Empty title="Connect a wallet to see your shares." />
                    ) : (
                      <dl className="sell-sum">
                        <div>
                          <dt>Shares</dt>
                          <dd>
                            <strong>{units(mine)}</strong>
                          </dd>
                        </div>
                        <div>
                          <dt>Of the house</dt>
                          <dd>{ofHouse.toFixed(2)}%</dd>
                        </div>
                        <div>
                          <dt>Redeem value now</dt>
                          <dd>{eth(mineValue, 6)} ETH</dd>
                        </div>
                        <div>
                          <dt>Left behind if you redeem now</dt>
                          <dd className={mineLeft > 0n ? "warn-text" : undefined}>{eth(mineLeft, 6)} ETH</dd>
                        </div>
                      </dl>
                    )}
                    <p className="muted small">
                      {mineLeft > 0n
                        ? "Bets are open. Redeeming now is priced as if the house loses them all: your part of what is set aside for them, and of the wagers in play, stays with the others."
                        : "No bets are open, so a redemption now leaves nothing behind."}
                    </p>
                  </Panel>

                  <Panel title="Deposit" className="house-card">
                    <Field label="Amount (ETH)">
                      <input inputMode="decimal" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
                    </Field>
                    <dl className="sell-sum">
                      <div>
                        <dt>You would receive</dt>
                        <dd>{shares !== undefined ? `${units(shares)} shares` : "–"}</dd>
                      </div>
                      <div>
                        <dt>At least</dt>
                        <dd>{shares !== undefined && tolerance !== undefined ? `${units(withTolerance(shares, tolerance))} shares` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Redeemable for, right now</dt>
                        <dd>{shares !== undefined && amount !== undefined ? `${eth(previewRedeem({ ...h, bankroll: h.bankroll + amount, totalShares: h.totalShares + shares }, shares), 6)} ETH` : "–"}</dd>
                      </div>
                    </dl>
                    <ActionButton onClick={deposit} blocked={(amount === undefined || tolerance === undefined) && "Enter an amount and a tolerance"}>
                      Deposit into the house
                    </ActionButton>
                    <p className="muted small">You can lose part or all of it. With bets open, a deposit redeems for a little less than it cost until they settle.</p>
                  </Panel>

                  <Panel title="Redeem" className="house-card">
                    <Field label="Shares">
                      <span className="input-with-btn">
                        <input inputMode="decimal" value={redeemText} onChange={(e) => setRedeemText(e.target.value)} aria-invalid={tooMany} />
                        <button type="button" className="btn secondary small" onClick={() => setRedeemText(eth(mine / SHARE_UNIT, 18))} disabled={mine === 0n}>
                          All
                        </button>
                      </span>
                    </Field>
                    <dl className="sell-sum">
                      <div>
                        <dt>You would receive</dt>
                        <dd>{pays !== undefined ? `${eth(pays, 6)} ETH` : "–"}</dd>
                      </div>
                      <div>
                        <dt>At least</dt>
                        <dd>{pays !== undefined && tolerance !== undefined ? `${eth(withTolerance(pays, tolerance), 6)} ETH` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Left behind</dt>
                        <dd className={stays ? "warn-text" : undefined}>{stays !== undefined ? `${eth(stays, 6)} ETH` : "–"}</dd>
                      </div>
                    </dl>
                    <ActionButton className="secondary" onClick={redeem} blocked={tooMany ? "You do not hold that many shares" : (redeemShares === undefined || tolerance === undefined) && "Enter a number of shares and a tolerance"}>
                      Redeem
                    </ActionButton>
                    <Field label="Tolerance for both (%)">
                      <input className="narrow" inputMode="decimal" value={toleranceText} onChange={(e) => setToleranceText(e.target.value)} />
                    </Field>
                    <p className="muted small">The minimum sent with the transaction is the preview less this tolerance; if the price has moved further, nothing happens.</p>
                  </Panel>
                </aside>
              </div>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
