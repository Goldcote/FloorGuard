// The house: the games bankroll and the shares in it. Not a yield product, and not drawn as one:
// the page shows what the bankroll holds, the realised history of the share price from events, and
// what a deposit or a redemption would do right now. Wording follows docs/ARCHITECTURE.md ("The
// house") and SECURITY.md ("House shares").
import { useState } from "react";
import { useProtocol, useRead } from "../hooks";
import { cancelDepositHouseCall, cancelRedeemHouseCall, depositHouseCall, executeDepositHouseCall, executeRedeemHouseCall, redeemHouseCall } from "../lib/calls";
import { bps, eth } from "../lib/format";
import {
  DEFAULT_SPREAD_BPS,
  depositSpreadBps,
  depositWithinSpread,
  givenUpByRedeemingNow,
  houseFundsOf,
  housePoints,
  lastHolderBlocked,
  previewDeposit,
  previewRedeem,
  quietDeposit,
  readHouse,
  readHouseEvents,
  redeemRequestShares,
  redeemSpreadBps,
  redeemWithinSpread,
  SHARE_UNIT,
  sharePrice,
  shareValue,
  SPREAD_PRESETS_BPS,
  SPREAD_WARN_BPS,
  type HouseRequest,
  type HouseState,
} from "../lib/house";
import { parseEth, parsePercentBps } from "../lib/parse";
import { href } from "../routes";
import { useTx, single } from "../tx";
import { ActionButton, Empty, Field, Notice, PageHead, Panel, QueryView } from "../ui";
import { HouseChart } from "../viz/charts";
import { toEth } from "../viz/curves";
import { Num } from "../viz/motion";
import { LiveDot } from "../viz/parts";
import { LOGS_FROM_BLOCK } from "../wagmi";

/** Shares in units of a million raw shares (what 1 wei bought at the first deposit). */
const units = (shares: bigint, digits = 4) => eth(shares / SHARE_UNIT, digits);

/** Where a request stands: waiting for the bets that were open when it was made, or ready. */
function requestState(r: HouseRequest): string {
  if (r.ready) return "Ready: carry it out now";
  if (r.waitingFor === undefined) return "Requested: waiting for the bets that were open at the time to finish";
  return `Requested: waiting for ${r.waitingFor} open bet${r.waitingFor === 1 ? "" : "s"} to finish`;
}

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
            <i className="vessel-key free" /> Free bankroll
          </dt>
          <dd>
            <Num value={toEth(h.bankroll)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">What redemptions are paid out of</dd>
        </div>
        <div>
          <dt>
            <i className="vessel-key reserved" /> Set aside for open bets
          </dt>
          <dd>
            <Num value={toEth(h.reserved)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">House money a win would pay; back when the bet settles</dd>
        </div>
        <div>
          <dt>
            <i className="vessel-key wagers" /> Wagers in play
          </dt>
          <dd>
            <Num value={toEth(h.openWagers)} format={(n) => n.toFixed(4)} /> <small>ETH</small>
          </dd>
          <dd className="muted small">Players' stakes on the open bets; not the house's until they settle</dd>
        </div>
      </dl>
    </div>
  );
}

export function House() {
  const { deployment: d, user, demo } = useProtocol();
  const { run } = useTx();
  const query = useRead(["house", user], (c, dep) => readHouse(c, dep, user, LOGS_FROM_BLOCK));
  const events = useRead(["houseEvents"], (c, dep) => readHouseEvents(c, dep, LOGS_FROM_BLOCK));
  const [depositText, setDepositText] = useState("");
  const [redeemText, setRedeemText] = useState("");
  // The most the visitor will give up against fair value when a request is carried out while bets are open.
  const [spreadText, setSpreadText] = useState((Number(DEFAULT_SPREAD_BPS) / 100).toString());
  const maxSpread = parsePercentBps(spreadText);
  const pct = (basisPoints: bigint) => `${Number(basisPoints) / 100}%`;

  return (
    <>
      <PageHead eyebrow="Play · the house" title="The house">
        Dice and slots are played against a bankroll. Anyone can fund it for shares and redeem them later; the holders of shares are the house. When
        players win, the house pays.
      </PageHead>
      <Notice>
        This is not a savings or yield product. Share holders can lose part or all of what they put in when players win; nothing is guaranteed, and the
        part of the edge the bankroll keeps only tilts the average. Deposits and redemptions are requests: while bets are open they wait for those bets
        to finish, shares you have asked to redeem stay at risk until then, and carrying a request out while other bets are open costs you.
        Offering a share in a gambling bankroll may be regulated separately from the games. The share mechanism is new and has not been independently
        reviewed.
      </Notice>

      <QueryView query={query} lines={6}>
        {(h) => {
          const price = sharePrice(houseFundsOf(h), h.totalShares);
          const mine = h.userShares ?? 0n;
          const mineFair = shareValue(h, mine);
          const mineNow = previewRedeem(h, mine);
          const ofHouse = h.totalShares > 0n ? Number((mine * 1_000_000n) / h.totalShares) / 10_000 : 0;
          const betsOpen = h.reserved > 0n || h.openWagers > 0n;
          const openText = h.openBets === undefined ? "bets are" : `${h.openBets} bet${h.openBets === 1 ? " is" : "s are"}`;

          const amount = parseEth(depositText);
          // what the deposit would get right now, what it would get with no bet open, and the gap between them
          const shares = amount !== undefined ? previewDeposit(h, amount) : undefined;
          const sharesQuiet = amount !== undefined ? quietDeposit(h, amount) : undefined;
          const depositSpread = amount !== undefined ? depositSpreadBps(h, amount) : undefined;
          // the visitor types share units; the contract takes raw shares
          const redeemUnits = parseEth(redeemText);
          // "All" means every raw share, including the part of a unit the field cannot show; and a
          // remainder too small to ever be redeemed is taken along, as the contract does
          const typedShares = redeemUnits === undefined ? undefined : mine > 0n && redeemUnits === mine / SHARE_UNIT ? mine : redeemUnits * SHARE_UNIT;
          const tooMany = typedShares !== undefined && typedShares > mine;
          const redeemShares = typedShares !== undefined && !tooMany ? redeemRequestShares(mine, typedShares) : typedShares;
          const pays = redeemShares !== undefined && !tooMany ? previewRedeem(h, redeemShares) : undefined;
          const paysFair = redeemShares !== undefined && !tooMany ? shareValue(h, redeemShares) : undefined;
          const redeemSpread = redeemShares !== undefined && !tooMany ? redeemSpreadBps(h, redeemShares) : undefined;
          // the connected account's requests, priced as carrying them out right now would be
          const pendingDepositShares = h.pendingDeposit ? previewDeposit(h, h.pendingDeposit.amount) : undefined;
          const pendingDepositQuiet = h.pendingDeposit ? quietDeposit(h, h.pendingDeposit.amount) : undefined;
          const pendingDepositSpread = h.pendingDeposit ? depositSpreadBps(h, h.pendingDeposit.amount) : undefined;
          const pendingDepositWithin = !!h.pendingDeposit && maxSpread !== undefined && depositWithinSpread(h, h.pendingDeposit.amount, maxSpread);
          const pendingRedeemShares = h.pendingRedeem ? (h.pendingRedeem.amount > mine ? mine : h.pendingRedeem.amount) : undefined;
          const pendingRedeemPays = pendingRedeemShares !== undefined ? previewRedeem(h, pendingRedeemShares) : undefined;
          const pendingRedeemFair = pendingRedeemShares !== undefined ? shareValue(h, pendingRedeemShares) : undefined;
          const pendingRedeemSpread = pendingRedeemShares !== undefined ? redeemSpreadBps(h, pendingRedeemShares) : undefined;
          const pendingRedeemWithin = pendingRedeemShares !== undefined && maxSpread !== undefined && redeemWithinSpread(h, pendingRedeemShares, maxSpread);
          const lastHolder = pendingRedeemShares !== undefined && lastHolderBlocked(h, pendingRedeemShares);
          const waiting = (spreadNow: bigint) => `Waiting for a quieter moment: the spread now is ${pct(spreadNow)}, your limit is ${maxSpread !== undefined ? pct(maxSpread) : "not set"}`;
          const RULE_ONE = "Rule 1: a request waits for the bets that were open when it was made, so nobody can trade on a result they have seen.";
          const RULE_TWO = "Rule 2: bets open when a request is carried out are priced against whoever carries it out, so a ready request cannot be kept as a free option on later bets.";
          const limitLine = maxSpread !== undefined ? `The most you will give up against fair value is ${pct(maxSpread)}: that limit is sent with the transaction and checked by the contract when the request is carried out.` : "";

          const deposit = () => {
            if (!d || amount === undefined || shares === undefined || maxSpread === undefined) return;
            void run(`Deposit ${eth(amount)} ETH into the house`, single("Deposit", depositHouseCall(d, amount, maxSpread)), [
              betsOpen
                ? `${eth(amount)} ETH leaves your wallet and waits as a pending deposit, apart from the bankroll, because ${openText} open. You can cancel it and take it back until it is carried out.`
                : `${eth(amount)} ETH moves from your wallet into the games bankroll. No bet is open, so you receive ${units(shares)} shares at once, at fair value.`,
              RULE_ONE,
              RULE_TWO,
              limitLine,
              betsOpen ? "Once the bets open now have finished you carry it out here; the number of shares is set then, not now." : "If a bet opens before this is mined, the deposit waits as a pending request instead; it is never carried out beyond your limit.",
              "You can lose part or all of this when players win. Nothing is guaranteed.",
            ]);
          };
          const redeem = () => {
            if (!d || !user || redeemShares === undefined || pays === undefined || maxSpread === undefined) return;
            void run(`Redeem ${units(redeemShares)} house shares`, single("Redeem", redeemHouseCall(d, redeemShares, maxSpread, user)), [
              betsOpen
                ? `You ask to redeem ${units(redeemShares)} shares. Because ${openText} open, the request waits until every bet open now has finished; the shares stay at risk until it is carried out, and you can cancel it.`
                : `You burn ${units(redeemShares)} shares and receive ${eth(pays)} ETH, their fair value. No bet is open, so it is carried out at once.`,
              RULE_ONE,
              RULE_TWO,
              limitLine,
              ...(typedShares !== undefined && redeemShares !== typedShares ? ["The few raw shares that would be left are too small ever to redeem, so the request is for your whole holding."] : []),
              ...(h.pendingRedeem ? ["This replaces the redemption you have already requested."] : []),
            ]);
          };
          const carryOutDeposit = () => {
            if (!d || !h.pendingDeposit || pendingDepositShares === undefined || pendingDepositQuiet === undefined || pendingDepositSpread === undefined || maxSpread === undefined) return;
            void run(`Carry out your deposit of ${eth(h.pendingDeposit.amount)} ETH`, single("Carry out deposit", executeDepositHouseCall(d, maxSpread)), [
              `Your pending ${eth(h.pendingDeposit.amount)} ETH joins the bankroll and you receive about ${units(pendingDepositShares)} shares.`,
              ...(pendingDepositQuiet > pendingDepositShares
                ? [`Because ${openText} open right now, that is ${units(pendingDepositQuiet - pendingDepositShares)} shares fewer than fair value (${units(pendingDepositQuiet)}), a spread of ${pct(pendingDepositSpread)}: a deposit is priced as if the house wins every open bet. Waiting until fewer bets are open gets you more.`]
                : []),
              `${limitLine} If the spread is larger than that when this is mined, nothing happens and the deposit stays pending.`,
              "You can lose part or all of this when players win. Nothing is guaranteed.",
            ]);
          };
          const cancelDeposit = () => {
            if (!d || !h.pendingDeposit) return;
            void run("Cancel your pending deposit", single("Cancel deposit", cancelDepositHouseCall(d)), [`Your pending ${eth(h.pendingDeposit.amount)} ETH comes back to your wallet. No shares are issued.`]);
          };
          const carryOutRedeem = () => {
            if (!d || !user || pendingRedeemShares === undefined || pendingRedeemPays === undefined || pendingRedeemFair === undefined || pendingRedeemSpread === undefined || maxSpread === undefined) return;
            void run(`Carry out your redemption of ${units(pendingRedeemShares)} shares`, single("Carry out redemption", executeRedeemHouseCall(d, maxSpread, user)), [
              `You burn ${units(pendingRedeemShares)} shares and receive about ${eth(pendingRedeemPays)} ETH.`,
              ...(pendingRedeemFair > pendingRedeemPays
                ? [`Because ${openText} open right now, that is ${eth(pendingRedeemFair - pendingRedeemPays)} ETH less than the shares' fair value (${eth(pendingRedeemFair)} ETH), a spread of ${pct(pendingRedeemSpread)}: a redemption is paid as if the house loses every open bet, and the difference stays with the holders who remain. Waiting until fewer bets are open pays more.`]
                : []),
              `${limitLine} If the spread is larger than that when this is mined, nothing happens and the request stays pending.`,
            ]);
          };
          const cancelRedeem = () => {
            if (!d || !h.pendingRedeem) return;
            void run("Cancel your pending redemption", single("Cancel redemption", cancelRedeemHouseCall(d)), ["The request is withdrawn. You keep the shares; nothing is paid."]);
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
                        <span className="figure-label">Fair value of one share</span>
                        <strong>
                          <Num value={price} format={(n) => n.toFixed(6)} /> <small>ETH</small>
                        </strong>
                        <span className="muted small">The house's funds, free and set aside, per share. 1 was the price of the first deposit. A share here is a million of the contract's raw shares.</span>
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
                        <h3>Two rules for deposits and redemptions</h3>
                        <ul className="plain-list">
                          <li>Both are requests, and only the account that made one can carry it out. With no bet open it is carried out at once, at the fair value.</li>
                          <li>
                            <strong>A request waits</strong> for the bets that were open when it was made. So nobody can trade on a result they have seen.
                          </li>
                          <li>
                            <strong>Bets open when it is carried out are priced against whoever carries it out</strong>: a deposit as if the house wins them all, a redemption as
                            if it loses them all. So nobody can sit on a ready request as a free option on later bets. Pick a quiet moment and name the least you accept.
                          </li>
                          <li>A redemption is paid in full or not at all. Whoever holds every share cannot redeem while bets are open.</li>
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
                          <dt>Fair value</dt>
                          <dd>{eth(mineFair, 6)} ETH</dd>
                        </div>
                        <div>
                          <dt>If you redeem right now</dt>
                          <dd>{eth(mineNow, 6)} ETH</dd>
                        </div>
                        <div>
                          <dt>Given up by redeeming now</dt>
                          <dd className={mineFair > mineNow ? "warn-text" : undefined}>{eth(givenUpByRedeemingNow(h, mine), 6)} ETH</dd>
                        </div>
                      </dl>
                    )}
                    {user && (
                      <p className="muted small">
                        {betsOpen
                          ? `Because ${openText} open, a redemption carried out right now is paid as if the house loses them all. The difference would stay with the holders who remain.`
                          : "No bets are open, so a redemption right now pays the fair value."}
                      </p>
                    )}
                    {h.pendingDeposit && pendingDepositShares !== undefined && pendingDepositQuiet !== undefined && pendingDepositSpread !== undefined && (
                      <div className="callout" role="status">
                        <p>
                          <strong>Pending deposit: {eth(h.pendingDeposit.amount, 6)} ETH.</strong> {requestState(h.pendingDeposit)}. It is held apart from the bankroll
                          and is not at risk.{" "}
                          {h.pendingDeposit.ready &&
                            (pendingDepositQuiet > pendingDepositShares
                              ? `Carried out now you receive ${units(pendingDepositShares)} shares; fair value is ${units(pendingDepositQuiet)}. The spread now is ${pct(pendingDepositSpread)}. Waiting until fewer bets are open gets you more.`
                              : `Carried out now you receive ${units(pendingDepositShares)} shares, at fair value.`)}
                        </p>
                        <div className="holding-actions">
                          <ActionButton
                            onClick={carryOutDeposit}
                            blocked={!h.pendingDeposit.ready ? "The bets that were open when you asked have not all finished" : maxSpread === undefined ? "Set the most you will give up" : !pendingDepositWithin && waiting(pendingDepositSpread)}
                          >
                            Carry out now ({units(pendingDepositShares)} shares)
                          </ActionButton>
                          <ActionButton className="secondary" onClick={cancelDeposit}>
                            Cancel and take it back
                          </ActionButton>
                        </div>
                        {h.pendingDeposit.ready && maxSpread !== undefined && !pendingDepositWithin && <p className="muted small">{waiting(pendingDepositSpread)}.</p>}
                      </div>
                    )}
                    {h.pendingRedeem && pendingRedeemShares !== undefined && pendingRedeemPays !== undefined && pendingRedeemFair !== undefined && pendingRedeemSpread !== undefined && (
                      <div className="callout" role="status">
                        <p>
                          <strong>Pending redemption: {units(h.pendingRedeem.amount)} shares.</strong> {requestState(h.pendingRedeem)}. These shares stay at risk until it is
                          carried out.{" "}
                          {h.pendingRedeem.ready &&
                            (lastHolder
                              ? "You hold every share, and whoever does cannot redeem while bets are open."
                              : pendingRedeemFair > pendingRedeemPays
                                ? `Carried out now you receive ${eth(pendingRedeemPays, 6)} ETH; the fair value is ${eth(pendingRedeemFair, 6)} ETH. The spread now is ${pct(pendingRedeemSpread)}. Waiting until fewer bets are open pays more.`
                                : `Carried out now you receive ${eth(pendingRedeemPays, 6)} ETH, the fair value.`)}
                        </p>
                        <div className="holding-actions">
                          <ActionButton
                            onClick={carryOutRedeem}
                            blocked={
                              !h.pendingRedeem.ready
                                ? "The bets that were open when you asked have not all finished"
                                : lastHolder
                                  ? "You hold every share: wait until no bet is open"
                                  : maxSpread === undefined
                                    ? "Set the most you will give up"
                                    : !pendingRedeemWithin && waiting(pendingRedeemSpread)
                            }
                          >
                            Carry out now ({eth(pendingRedeemPays, 6)} ETH)
                          </ActionButton>
                          <ActionButton className="secondary" onClick={cancelRedeem}>
                            Cancel the request
                          </ActionButton>
                        </div>
                        {h.pendingRedeem.ready && !lastHolder && maxSpread !== undefined && !pendingRedeemWithin && <p className="muted small">{waiting(pendingRedeemSpread)}.</p>}
                      </div>
                    )}
                  </Panel>

                  <Panel title="Deposit" className="house-card">
                    <Field label="Amount (ETH)">
                      <input inputMode="decimal" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
                    </Field>
                    <dl className="sell-sum">
                      <div>
                        <dt>{betsOpen ? "With no bet open" : "You would receive"}</dt>
                        <dd>{sharesQuiet !== undefined ? `${units(sharesQuiet)} shares` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Carried out right now</dt>
                        <dd>{shares !== undefined ? `${units(shares)} shares` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Spread right now</dt>
                        <dd className={depositSpread !== undefined && maxSpread !== undefined && depositSpread > maxSpread ? "warn-text" : undefined}>{depositSpread !== undefined ? pct(depositSpread) : "–"}</dd>
                      </div>
                      <div>
                        <dt>Carried out</dt>
                        <dd>{betsOpen ? "when the open bets have finished" : "at once"}</dd>
                      </div>
                    </dl>
                    <ActionButton onClick={deposit} blocked={(amount === undefined || maxSpread === undefined) && "Enter an amount, and the most you will give up"}>
                      Deposit into the house
                    </ActionButton>
                    <p className="muted small">You can lose part or all of it. With bets open, a deposit waits apart from the bankroll, can be cancelled, and is priced when you carry it out: as if the house wins every bet open at that moment.</p>
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
                        <dt>{betsOpen ? "Fair value" : "You would receive"}</dt>
                        <dd>{paysFair !== undefined ? `${eth(paysFair, 6)} ETH` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Carried out right now</dt>
                        <dd>{pays !== undefined ? `${eth(pays, 6)} ETH` : "–"}</dd>
                      </div>
                      <div>
                        <dt>Spread right now</dt>
                        <dd className={redeemSpread !== undefined && maxSpread !== undefined && redeemSpread > maxSpread ? "warn-text" : undefined}>{redeemSpread !== undefined ? pct(redeemSpread) : "–"}</dd>
                      </div>
                      <div>
                        <dt>Carried out</dt>
                        <dd>{betsOpen ? "when the open bets have finished" : "at once"}</dd>
                      </div>
                    </dl>
                    <ActionButton className="secondary" onClick={redeem} blocked={tooMany ? "You do not hold that many shares" : (redeemShares === undefined || maxSpread === undefined) && "Enter a number of shares, and the most you will give up"}>
                      Redeem
                    </ActionButton>
                    <Field label="The most I will give up against fair value (%)">
                      <input className="narrow" inputMode="decimal" value={spreadText} onChange={(e) => setSpreadText(e.target.value)} aria-invalid={maxSpread === undefined} />
                    </Field>
                    <div className="chips" role="group" aria-label="Preset limits">
                      {SPREAD_PRESETS_BPS.map((preset) => (
                        <button key={preset.toString()} type="button" className={maxSpread === preset ? "chip on" : "chip"} aria-pressed={maxSpread === preset} onClick={() => setSpreadText((Number(preset) / 100).toString())}>
                          {pct(preset)}
                        </button>
                      ))}
                    </div>
                    {maxSpread === undefined && <p className="notice">A percentage from 0 to 100, with at most two decimals.</p>}
                    {maxSpread !== undefined && maxSpread > SPREAD_WARN_BPS && (
                      <div className="callout warn" role="alert">
                        <p>
                          <strong>{pct(maxSpread)} is a lot to be willing to give up.</strong> Anyone can make you pay up to your limit by opening bets just before your request is
                          carried out. Keep it small.
                        </p>
                      </div>
                    )}
                    <p className="muted small">
                      This limit applies to both, and the contract checks it when a request is carried out: beyond it, the request waits. Whatever spread you tolerate, someone
                      else can make you pay by opening bets, so keep it small.
                    </p>
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
