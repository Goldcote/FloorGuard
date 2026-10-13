import { useState } from "react";
import type { Address } from "viem";
import { claimMarketCall, createMarketCall, placeBetCall, resolveMarketCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, dateTime, duration, eth, relative } from "../lib/format";
import { parseEth } from "../lib/parse";
import { impliedMultiple, Outcome, OUTCOME_NAMES, readMarkets, type Market } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, Field, QueryView, Stat } from "../ui";

function pays(value: number | undefined, side: string): string {
  return value === undefined ? "No bets on this side yet" : `Pays ${value.toFixed(2)}× if ${side}`;
}

export function Predictions({ collection }: { collection: Address }) {
  const { deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["markets", user], (c, dep) => readMarkets(c, dep, user));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [newMarket, setNewMarket] = useState({ bettingHours: "6", durationHours: "24" });

  const bettingSeconds = Math.round(Number(newMarket.bettingHours) * 3_600);
  const durationSeconds = Math.round(Number(newMarket.durationHours) * 3_600);
  const create = () =>
    void run(`Create a ${newMarket.durationHours}h market`, (send) =>
      send("Create market", createMarketCall(d!, collection, BigInt(bettingSeconds), BigInt(durationSeconds))),
      [
        `Opens a market on the selected collection: betting for ${duration(bettingSeconds)}, settled ${duration(durationSeconds)} from now.`,
        "The oracle's current floor becomes the start price. No ETH is sent; you pay only the transaction fee.",
      ],
    );

  const bet = (market: Market, higher: boolean, amount: bigint) =>
    void run(`Bet ${eth(amount)} ETH on ${higher ? "higher" : "lower"} (market #${market.id})`, (send) =>
      send("Place bet", placeBetCall(d!, market.id, higher, amount)),
      [
        `${eth(amount)} ETH moves from your wallet into the ${higher ? "higher" : "lower"} pool of market #${market.id}.`,
        `If the floor at resolution is ${higher ? "above" : "below"} ${eth(market.startPrice)} ETH, you get it back plus a share of the other pool, less the fee on winnings.`,
        "Otherwise you lose it. If the market is voided, you get a full refund. A bet cannot be withdrawn.",
      ],
    );
  const resolve = (market: Market) =>
    void run(`Resolve market #${market.id}`, (send) => send("Resolve", resolveMarketCall(d!, market.id)), [
      "Settles the market against the oracle's floor price. Anyone may do this; you pay only the transaction fee.",
    ]);
  const claim = (market: Market) =>
    void run(`Claim from market #${market.id}`, (send) => send("Claim", claimMarketCall(d!, market.id)), [
      market.outcome === Outcome.Void
        ? "The market was voided: you receive your whole stake back."
        : "You receive your winning stake plus its share of the losing pool, less the fee on winnings. A losing stake pays nothing but earns points.",
    ]);

  return (
    <Card title="Prediction markets">
      <QueryView query={query}>
        {({ markets, feeBps, minBet, minBettingPeriod, maxDuration }) => (
          <>
            <div className="form-row create-market">
              <Field label="Betting open for (hours)">
                <input
                  className="narrow"
                  inputMode="decimal"
                  value={newMarket.bettingHours}
                  onChange={(e) => setNewMarket({ ...newMarket, bettingHours: e.target.value })}
                />
              </Field>
              <Field label="Resolves after (hours)">
                <input
                  className="narrow"
                  inputMode="decimal"
                  value={newMarket.durationHours}
                  onChange={(e) => setNewMarket({ ...newMarket, durationHours: e.target.value })}
                />
              </Field>
              <ActionButton
                onClick={create}
                blocked={
                  !(bettingSeconds >= minBettingPeriod)
                    ? `Betting must stay open for at least ${duration(minBettingPeriod)}`
                    : !(durationSeconds > bettingSeconds)
                      ? "The market must resolve after betting closes"
                      : durationSeconds > maxDuration && `A market can run for at most ${duration(maxDuration)}`
                }
              >
                Create market for the selected collection
              </ActionButton>
              <p className="muted grow">
                Anyone can open a market on a collection the owner has enabled, as long as the oracle has a fresh
                price; that price becomes the start price.
              </p>
            </div>
            <p className="muted">
              Pooled bets on whether the floor will be higher or lower than the start price at resolution. Winners
              split the losing pool; a fee on winnings ({bps(feeBps)} for new markets, fixed per market when it opens) funds buybacks. Minimum bet {eth(minBet)} ETH. A
              market with a one-sided pool or an unchanged price is voided and refunded. Resolving needs an oracle
              price published after the resolve time; if none arrives within 3 days the market is voided.
            </p>
            {markets.length === 0 && <Empty title="No markets yet.">Create the first one above.</Empty>}
            {markets.map((m) => {
              const key = m.id.toString();
              const pending = m.outcome === Outcome.Pending;
              const open = pending && now < m.closeTime;
              const amount = parseEth(amounts[key] ?? "");
              const staked = !!m.stake && (m.stake.higher > 0n || m.stake.lower > 0n);
              const betBlocked = !open
                ? "Betting has closed"
                : amount === undefined
                  ? "Enter an amount"
                  : amount < minBet && `The minimum bet is ${eth(minBet)} ETH`;
              return (
                <div className="item" key={key}>
                  <div className="item-head">
                    <strong>Market #{key}</strong>
                    <Addr address={m.collection} />
                    {pending ? (
                      open ? <Badge tone="good">Betting open</Badge> : <Badge tone="warn">Awaiting resolution</Badge>
                    ) : (
                      <Badge tone="muted">Resolved: {OUTCOME_NAMES[m.outcome] ?? m.outcome}</Badge>
                    )}
                  </div>
                  <div className="stats">
                    <Stat label="Start price" value={`${eth(m.startPrice)} ETH`} />
                    <Stat label={now < m.closeTime ? "Betting closes" : "Betting closed"} value={relative(m.closeTime, now)} hint={dateTime(m.closeTime)} />
                    <Stat
                      label={now < m.resolveTime ? "Resolvable" : pending ? "Resolvable since" : "Resolve time"}
                      value={relative(m.resolveTime, now)}
                      hint={dateTime(m.resolveTime)}
                    />
                    <Stat
                      label="Higher pool"
                      value={`${eth(m.higherPool)} ETH`}
                      hint={pending ? pays(impliedMultiple(m.higherPool, m.lowerPool, m.feeBps), "higher") : undefined}
                    />
                    <Stat
                      label="Lower pool"
                      value={`${eth(m.lowerPool)} ETH`}
                      hint={pending ? pays(impliedMultiple(m.lowerPool, m.higherPool, m.feeBps), "lower") : undefined}
                    />
                    <Stat
                      label="Your stake"
                      value={m.stake ? `${eth(m.stake.higher)} ↑ / ${eth(m.stake.lower)} ↓ ETH` : <span className="muted">Connect a wallet</span>}
                      hint={m.stake && !staked && !pending ? "Nothing staked, or already claimed" : undefined}
                    />
                  </div>
                  <div className="form-row">
                    {open && (
                      <>
                        <input
                          className="narrow"
                          placeholder="ETH"
                          aria-label={`Bet amount in ETH for market ${key}`}
                          inputMode="decimal"
                          value={amounts[key] ?? ""}
                          onChange={(e) => setAmounts((s) => ({ ...s, [key]: e.target.value }))}
                        />
                        <ActionButton onClick={() => amount && bet(m, true, amount)} blocked={betBlocked}>
                          Bet higher
                        </ActionButton>
                        <ActionButton onClick={() => amount && bet(m, false, amount)} blocked={betBlocked}>
                          Bet lower
                        </ActionButton>
                      </>
                    )}
                    {pending && (
                      <ActionButton
                        className="secondary"
                        onClick={() => resolve(m)}
                        blocked={now < m.resolveTime && `Resolvable from ${dateTime(m.resolveTime)}`}
                      >
                        Resolve
                      </ActionButton>
                    )}
                    {!pending && (
                      <ActionButton onClick={() => claim(m)} blocked={!staked && "You have nothing to claim in this market"}>
                        {m.outcome === Outcome.Void ? "Claim refund" : "Claim"}
                      </ActionButton>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </QueryView>
    </Card>
  );
}
