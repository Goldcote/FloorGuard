import { useState } from "react";
import { claimMarketCall, placeBetCall, resolveMarketCall } from "../lib/calls";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { bps, dateTime, eth, relative } from "../lib/format";
import { parseEth } from "../lib/parse";
import { impliedMultiple, Outcome, OUTCOME_NAMES, readMarkets, type Market } from "../lib/reads";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, QueryView, Stat } from "../ui";

function multiple(value: number | undefined): string {
  return value === undefined ? "no bets yet" : `${value.toFixed(2)}×`;
}

export function Predictions() {
  const { deployment: d, user } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const query = useRead(["markets", user], (c, dep) => readMarkets(c, dep, user));
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const bet = (market: Market, higher: boolean, amount: bigint) =>
    void run(`Bet ${eth(amount)} ETH on ${higher ? "higher" : "lower"} (market #${market.id})`, (send) =>
      send("Place bet", placeBetCall(d!, market.id, higher, amount)),
    );
  const resolve = (market: Market) =>
    void run(`Resolve market #${market.id}`, (send) => send("Resolve", resolveMarketCall(d!, market.id)));
  const claim = (market: Market) =>
    void run(`Claim from market #${market.id}`, (send) => send("Claim", claimMarketCall(d!, market.id)));

  return (
    <Card title="Prediction markets">
      <QueryView query={query}>
        {({ markets, feeBps, minBet }) => (
          <>
            <p className="muted">
              Pooled bets on whether the floor will be higher or lower than the start price at resolution. Winners
              split the losing pool; {bps(feeBps)} of winnings funds buybacks. Minimum bet {eth(minBet)} ETH. A
              market with a one-sided pool or an unchanged price is voided and refunded. Resolving needs an oracle
              price published after the resolve time; if none arrives within 3 days the market is voided.
            </p>
            {markets.length === 0 && <p className="muted">No markets yet.</p>}
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
                    <Stat label="Betting closes" value={relative(m.closeTime, now)} hint={dateTime(m.closeTime)} />
                    <Stat label="Resolves" value={relative(m.resolveTime, now)} hint={dateTime(m.resolveTime)} />
                    <Stat
                      label="Higher pool"
                      value={`${eth(m.higherPool)} ETH`}
                      hint={`Pays ${multiple(impliedMultiple(m.higherPool, m.lowerPool, feeBps))} if higher`}
                    />
                    <Stat
                      label="Lower pool"
                      value={`${eth(m.lowerPool)} ETH`}
                      hint={`Pays ${multiple(impliedMultiple(m.lowerPool, m.higherPool, feeBps))} if lower`}
                    />
                    <Stat
                      label="Your stake"
                      value={m.stake ? `${eth(m.stake.higher)} ↑ / ${eth(m.stake.lower)} ↓ ETH` : <span className="muted">Connect a wallet</span>}
                      hint={m.stake && !staked && !pending ? "Nothing staked, or already claimed" : undefined}
                    />
                  </div>
                  <div className="form-row">
                    {pending && (
                      <>
                        <input
                          className="narrow"
                          placeholder="ETH"
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
                        <ActionButton
                          className="secondary"
                          onClick={() => resolve(m)}
                          blocked={now < m.resolveTime && `Resolvable from ${dateTime(m.resolveTime)}`}
                        >
                          Resolve
                        </ActionButton>
                      </>
                    )}
                    {!pending && (
                      <ActionButton onClick={() => claim(m)} blocked={!staked && "You have nothing to claim in this market"}>
                        Claim
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
