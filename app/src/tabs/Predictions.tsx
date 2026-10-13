import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Address } from "viem";
import { AmountCount, claimValue, Countdown, CountUp, flash, observeReveal, ParticleLayer, shake, stakePayout, tugShare, useParticles, useRevealClock } from "../fx";
import { useChainTime, useProtocol, useRead } from "../hooks";
import { claimMarketCall, createMarketCall, placeBetCall, resolveMarketCall } from "../lib/calls";
import { bps, dateTime, duration, eth } from "../lib/format";
import { parseEth } from "../lib/parse";
import { impliedMultiple, Outcome, OUTCOME_NAMES, readMarkets, type Market, type Markets } from "../lib/reads";
import { sound } from "../lib/sound";
import { useTx } from "../tx";
import { ActionButton, Addr, Badge, Card, Empty, Field, QueryView } from "../ui";

/** How long the rope takes to snap to the winning side once a market resolves. The same every time. */
const RESOLVE_REVEAL_MS = 1_300;
/**
 * `PredictionMarket.createMarket` requires the market to last at least this many times its betting
 * period. The contract enforces it; it has no getter the app reads, so the form mirrors the rule only
 * to explain a refusal before it happens.
 */
const DURATION_PER_BETTING = 10;

const multipleText = (value: number | undefined) => (value === undefined ? "–" : `${value.toFixed(2)}×`);

/** One side of the rope: its pool as a mass, what it pays, and the bet button. */
function Side({ side, pool, other, market, amount, open, blocked, onBet, won, lost }: { side: "higher" | "lower"; pool: bigint; other: bigint; market: Market; amount: bigint | undefined; open: boolean; blocked: string | false; onBet: () => void; won: boolean; lost: boolean }) {
  const total = pool + other;
  // The block's area follows the pool's share: equal pools, equal blocks.
  const share = total === 0n ? 0.5 : Number((pool * 1000n) / total) / 1000;
  const scale = 0.62 + Math.sqrt(share) * 0.62;
  const now = impliedMultiple(pool, other, market.feeBps);
  const mine = side === "higher" ? market.stake?.higher : market.stake?.lower;
  const payout = amount !== undefined ? stakePayout(amount, pool, other, market.feeBps) : undefined;
  const after = amount !== undefined && payout !== undefined ? Number((payout * 1000n) / amount) / 1000 : undefined;
  return (
    <div className={`tug-side tug-${side}${won ? " is-won" : ""}${lost ? " is-lost" : ""}`}>
      <div className="tug-mass" style={{ "--mass": scale } as CSSProperties} aria-hidden="true">
        <span>{side === "higher" ? "▲" : "▼"}</span>
      </div>
      <div className="tug-info">
        <span className="eyebrow-s">{side === "higher" ? "Higher pool" : "Lower pool"}</span>
        <strong className="tug-pool">
          <AmountCount wei={pool} text={eth(pool)} /> <small>ETH</small>
        </strong>
        <span className="tug-pays">
          {market.outcome === Outcome.Pending ? (
            <>
              pays{" "}
              <strong>
                {after !== undefined ? <CountUp value={after} format={(v) => `${v.toFixed(2)}×`} duration={350} /> : multipleText(now)}
              </strong>{" "}
              {after !== undefined ? "with your stake in" : now === undefined ? "no bets on this side yet" : "at the pools now"}
              {other === 0n && " · the other side is empty: a one-sided market is void"}
            </>
          ) : won ? (
            "this side won"
          ) : (
            " "
          )}
        </span>
        {payout !== undefined && open && (
          <span className="tug-quote">
            {eth(amount!)} ETH here returns <strong>{eth(payout)} ETH</strong> if {side} wins
          </span>
        )}
        {mine !== undefined && mine > 0n && <span className="tug-mine">Your stake: {eth(mine)} ETH</span>}
      </div>
      {open && (
        <ActionButton className={`big bet-${side}`} onClick={onBet} blocked={blocked}>
          Bet {side}
        </ActionButton>
      )}
    </div>
  );
}

function MarketStage({ m, t }: { m: Market; t: Markets }) {
  const { deployment: d, chainId } = useProtocol();
  const now = useChainTime();
  const { run } = useTx();
  const particles = useParticles();
  const stage = useRef<HTMLElement>(null);
  const previous = useRef("idle");
  const [amountText, setAmountText] = useState("");
  useRevealClock();

  const key = m.id.toString();
  const pending = m.outcome === Outcome.Pending;
  const open = pending && now < m.closeTime;
  const amount = parseEth(amountText);
  const staked = !!m.stake && (m.stake.higher > 0n || m.stake.lower > 0n);
  const stakedTotal = (m.stake?.higher ?? 0n) + (m.stake?.lower ?? 0n);
  const phase = observeReveal(`market:${chainId}:${key}`, pending ? "pending" : "settled", RESOLVE_REVEAL_MS);
  const resolved = !pending && phase === "done";
  const snapping = !pending && phase === "revealing";
  const outcome = resolved || snapping ? m.outcome : Outcome.Pending;
  const claim = !pending && m.stake ? claimValue(m.outcome, m.stake, m.higherPool, m.lowerPool, m.feeBps) : 0n;
  // Gold only when the claim is worth more than everything staked in this market.
  const ahead = resolved && staked && claim > stakedTotal;

  const share = tugShare(m.higherPool, m.lowerPool);
  // The rope is split by the pools: each side's colour is as long as its share of the money, and the
  // knot is where they meet. On resolution the winner takes the whole rope.
  const at = (higherShare: number) => 0.08 + (1 - higherShare) * 0.84;
  const knot = outcome === Outcome.Higher ? 0.03 : outcome === Outcome.Lower ? 0.97 : outcome === Outcome.Void ? 0.5 : at(share);
  const ghost = (toHigher: boolean) => (amount === undefined ? undefined : at(tugShare(m.higherPool + (toHigher ? amount : 0n), m.lowerPool + (toHigher ? 0n : amount))));
  const band = m.deadBandBps ?? 0n;
  const lowAt = m.startPrice - (m.startPrice * band) / 10_000n;
  const highAt = m.startPrice + (m.startPrice * band) / 10_000n;

  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (pending || before !== "pending") return;
    sound.snap();
    shake(stage.current, 5);
    if (m.outcome === Outcome.Void) return void setTimeout(() => sound.refund(), 500);
    flash(stage.current, "var(--accent)", 0.18);
    const worth = m.stake ? claimValue(m.outcome, m.stake, m.higherPool, m.lowerPool, m.feeBps) : 0n;
    if (staked && worth > stakedTotal) {
      setTimeout(() => {
        particles.burst(stage.current?.querySelector(".is-won .tug-mass") ?? undefined, 0.8);
        sound.win(Number((worth * 10n) / (stakedTotal || 1n)) / 10 >= 5 ? 5 : 2);
        sound.buzz();
      }, RESOLVE_REVEAL_MS);
    } else if (staked) setTimeout(() => sound.loss(), RESOLVE_REVEAL_MS);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const betBlocked = !open ? "Betting has closed" : amount === undefined ? "Enter an amount" : amount < t.minBet && `The minimum bet is ${eth(t.minBet)} ETH`;
  const bet = (higher: boolean) => {
    if (!amount || !d) return;
    sound.stake();
    void run(`Bet ${eth(amount)} ETH on ${higher ? "higher" : "lower"} (market #${m.id})`, (send) => send("Place bet", placeBetCall(d, m.id, higher, amount)), [
      `${eth(amount)} ETH moves from your wallet into the ${higher ? "higher" : "lower"} pool of market #${m.id}.`,
      `If the floor at resolution is ${higher ? `at least ${eth(highAt)}` : `at most ${eth(lowAt)}`} ETH, you get it back plus a share of the other pool, less the ${bps(m.feeBps)} fee on winnings.`,
      band > 0n ? `If the floor ends within ${bps(band)} of the ${eth(m.startPrice)} ETH start price, the market is void and everyone is refunded.` : "If the price is unchanged, the market is void and everyone is refunded.",
      "Otherwise you lose it. A bet cannot be withdrawn.",
    ]);
  };
  const resolve = () =>
    d &&
    void run(`Resolve market #${m.id}`, (send) => send("Resolve", resolveMarketCall(d, m.id)), [
      "Settles the market against the oracle's floor price. Anyone may do this; you pay only the transaction fee.",
    ]);
  const doClaim = () =>
    d &&
    void run(`Claim from market #${m.id}`, (send) => send("Claim", claimMarketCall(d, m.id)), [
      m.outcome === Outcome.Void
        ? "The market was voided: you receive your whole stake back."
        : "You receive your winning stake plus its share of the losing pool, less the fee on winnings. A losing stake pays nothing.",
    ]);

  return (
    <article className={`stage market${ahead ? " tone-win" : ""}${snapping ? " is-snapping" : ""} outcome-${outcome}`} ref={stage} aria-label={`Market ${key}`}>
      <header className="stage-head">
        <h2>Market #{key}</h2>
        <Addr address={m.collection} />
        {pending ? open ? <Badge tone="good">Betting open</Badge> : <Badge tone="warn">Awaiting resolution</Badge> : resolved ? <Badge tone="muted">Resolved: {OUTCOME_NAMES[m.outcome] ?? m.outcome}</Badge> : <Badge tone="accent">Resolving</Badge>}
      </header>
      <p className="market-question">
        Will the floor be <strong className="q-higher">higher</strong> or <strong className="q-lower">lower</strong> than <strong>{eth(m.startPrice)} ETH</strong> at {dateTime(m.resolveTime)}?
      </p>

        {open && (
        <label className="wager-field market-stake">
          <span className="wager-label">Your stake</span>
          <span className="wager-input">
            <input inputMode="decimal" placeholder="0.00" autoComplete="off" aria-label={`Bet amount in ETH for market ${key}`} value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            <span aria-hidden="true">ETH</span>
          </span>
          <span className="muted small">
            Minimum {eth(t.minBet)} ETH. Fee {bps(m.feeBps)} on winnings only. A bet cannot be withdrawn.
          </span>
        </label>
      )}

      <div className="tug">
        <Side side="lower" pool={m.lowerPool} other={m.higherPool} market={m} amount={open ? amount : undefined} open={open} blocked={betBlocked} onBet={() => bet(false)} won={outcome === Outcome.Lower} lost={outcome === Outcome.Higher} />
        <Side side="higher" pool={m.higherPool} other={m.lowerPool} market={m} amount={open ? amount : undefined} open={open} blocked={betBlocked} onBet={() => bet(true)} won={outcome === Outcome.Higher} lost={outcome === Outcome.Lower} />
      </div>

      <div className="rope-wrap">
        <div className="rope" role="img" aria-label={`Pools: ${eth(m.lowerPool)} ETH on lower, ${eth(m.higherPool)} ETH on higher`} style={{ "--knot": knot } as CSSProperties}>
          <span className="rope-lower" />
          <span className="rope-higher" />
          {open && [false, true].map((toHigher) => ghost(toHigher) !== undefined && <i key={String(toHigher)} className="rope-ghost" style={{ left: `${ghost(toHigher)! * 100}%` }} />)}
          <span className="rope-knot" />
        </div>
        <div className="rope-caption" aria-hidden="true">
          <span>lower: {Math.round((1 - share) * 100)}% of the money</span>
          {open && amount !== undefined && <span>dotted: where the knot would sit with your stake on either side</span>}
          <span>higher: {Math.round(share * 100)}% of the money</span>
        </div>
      </div>

      <dl className="price-scale" aria-label="Where the floor price must end">
        <div className="price-lower">
          <dt>Lower wins if the floor ends</dt>
          <dd>at or below {eth(lowAt)} ETH</dd>
        </div>
        <div className="price-void">
          <dt>{band > 0n ? `Within ${bps(band)} of the ${eth(m.startPrice)} ETH start` : `Exactly the ${eth(m.startPrice)} ETH start`}</dt>
          <dd>void: everyone is refunded</dd>
        </div>
        <div className="price-higher">
          <dt>Higher wins if the floor ends</dt>
          <dd>at or above {eth(highAt)} ETH</dd>
        </div>
      </dl>

      <p className={`cab-lcd${ahead ? " tone-win" : ""}`} aria-live="polite">
        {snapping
          ? " "
          : resolved
            ? m.outcome === Outcome.Void
              ? "Void: every stake is refunded in full."
              : `${OUTCOME_NAMES[m.outcome]} wins.${staked ? (claim > 0n ? ` Your claim: ${eth(claim)} ETH on ${eth(stakedTotal)} ETH staked.` : ` Your ${eth(stakedTotal)} ETH stake is lost.`) : ""}`
            : open
              ? "The rope is split by the money on each side. The payout moves as you type a stake."
              : now < m.resolveTime
                ? "Betting has closed. The market waits for its resolve time."
                : "Ready to resolve against the oracle's floor price."}
      </p>

      <div className="market-bottom">
        <div className="market-clock">
          <span className="eyebrow-s">{open ? "Betting closes in" : pending ? (now < m.resolveTime ? "Resolvable in" : "Resolvable") : "Resolved"}</span>
          {pending ? <Countdown seconds={(open ? m.closeTime : m.resolveTime) - now} label={open ? "Time left to bet" : "Time until the market can be resolved"} done="Now" /> : <strong className="cd-done">{OUTCOME_NAMES[m.outcome]}</strong>}
          <span className="muted small">
            {open ? `Resolvable from ${dateTime(m.resolveTime)}` : `Betting closed ${dateTime(m.closeTime)}`}
          </span>
        </div>
        <div className="market-actions">
          {pending && (
            <ActionButton className={open ? "secondary" : "big"} onClick={resolve} blocked={now < m.resolveTime && `Resolvable from ${dateTime(m.resolveTime)}`}>
              Resolve
            </ActionButton>
          )}
          {resolved && (
            <ActionButton className="big" onClick={doClaim} blocked={!staked && "You have nothing to claim in this market"}>
              {m.outcome === Outcome.Void ? `Claim refund${staked ? ` of ${eth(claim)} ETH` : ""}` : staked && claim > 0n ? `Claim ${eth(claim)} ETH` : "Claim"}
            </ActionButton>
          )}
          {m.stake && !staked && !pending && <span className="muted small">Nothing staked, or already claimed.</span>}
          {!m.stake && <span className="muted small">Connect a wallet to see your stake.</span>}
        </div>
      </div>
      <ParticleLayer controller={particles} />
    </article>
  );
}

export function Predictions({ collection }: { collection: Address }) {
  const { deployment: d, user } = useProtocol();
  const { run } = useTx();
  const query = useRead(["markets", user], (c, dep) => readMarkets(c, dep, user));
  const [newMarket, setNewMarket] = useState({ bettingHours: "6", durationHours: "72" });

  const bettingSeconds = Math.round(Number(newMarket.bettingHours) * 3_600);
  const durationSeconds = Math.round(Number(newMarket.durationHours) * 3_600);
  const create = () =>
    void run(`Create a ${newMarket.durationHours}h market`, (send) => send("Create market", createMarketCall(d!, collection, BigInt(bettingSeconds), BigInt(durationSeconds))), [
      `Opens a market on the selected collection: betting for ${duration(bettingSeconds)}, settled ${duration(durationSeconds)} from now.`,
      "The oracle's current floor becomes the start price. No ETH is sent; you pay only the transaction fee.",
    ]);

  return (
    <div className="play play-predictions">
      <QueryView query={query} lines={8}>
        {(t) => (
          <>
            {t.markets.length === 0 && <Empty title="No markets yet.">Create the first one below.</Empty>}
            {t.markets.map((m) => (
              <MarketStage key={m.id.toString()} m={m} t={t} />
            ))}
            <Card title="How prediction markets work">
              <p className="muted">
                Pooled bets on whether the floor will be higher or lower than the start price at resolution. Winners split the
                losing pool; a fee on winnings ({bps(t.feeBps)} for new markets, fixed per market when it opens) funds buybacks.
                Minimum bet {eth(t.minBet)} ETH. A market with a one-sided pool, or whose price ends within its dead band of the
                start price ({bps(t.deadBandBps)} for new markets), is voided and refunded. Resolving needs an oracle price
                published after the resolve time; if none arrives within 3 days the market is voided.
              </p>
            </Card>
            <Card title="Open a market for the selected collection">
              <div className="form-row create-market">
                <Field label="Betting open for (hours)">
                  <input className="narrow" inputMode="decimal" value={newMarket.bettingHours} onChange={(e) => setNewMarket({ ...newMarket, bettingHours: e.target.value })} />
                </Field>
                <Field label="Resolves after (hours)">
                  <input className="narrow" inputMode="decimal" value={newMarket.durationHours} onChange={(e) => setNewMarket({ ...newMarket, durationHours: e.target.value })} />
                </Field>
                <ActionButton
                  onClick={create}
                  blocked={
                    !(bettingSeconds >= t.minBettingPeriod)
                      ? `Betting must stay open for at least ${duration(t.minBettingPeriod)}`
                      : !(durationSeconds >= DURATION_PER_BETTING * bettingSeconds)
                        ? `The market must last at least ${DURATION_PER_BETTING} times its betting period (${duration(DURATION_PER_BETTING * bettingSeconds)})`
                        : durationSeconds > t.maxDuration && `A market can run for at most ${duration(t.maxDuration)}`
                  }
                >
                  Create market
                </ActionButton>
                <p className="muted grow">
                  Anyone can open a market on a collection the owner has enabled, as long as the oracle's price is at most{" "}
                  {duration(t.maxStartPriceAge)} old; that price becomes the start price. Betting may stay open for at most a
                  tenth of the market's life.
                </p>
              </div>
            </Card>
          </>
        )}
      </QueryView>
    </div>
  );
}
