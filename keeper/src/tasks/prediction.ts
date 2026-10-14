// PredictionMarket.resolve: settle every market at the first oracle price published at or after its
// settlement time, so that nobody can wait for a price they prefer.
import type { Address } from "viem";
import { range } from "../chain.ts";
import { type Ctx, type Head, carryOut, firstOpen, readerAt } from "../context.ts";
import { duration } from "../logger.ts";
import { type Decision, type TaskReport, emptyDecision } from "../types.ts";

export const OUTCOME_PENDING = 0;

export interface MarketState {
  id: bigint;
  collection: Address;
  resolveTime: bigint;
  higherPool: bigint;
  lowerPool: bigint;
  outcome: number;
  /** The oracle's answer for the collection; null if it reverted. Only read for markets due to settle. */
  oracle: { price: bigint; updatedAt: bigint } | null;
}

export interface PredictionState {
  now: bigint;
  maxOracleAge: bigint;
  voidGrace: bigint;
  /** A market waiting this long for a price is reported as a warning instead of a note. */
  stuckWarnSeconds: bigint;
  markets: MarketState[];
}

export function decidePrediction(state: PredictionState): Decision {
  const decision = emptyDecision();
  const { now } = state;
  for (const m of state.markets) {
    if (m.outcome !== OUTCOME_PENDING) continue;
    if (now < m.resolveTime) {
      decision.wakeAt.push(m.resolveTime);
      continue;
    }
    const resolve = (reason: string) =>
      decision.actions.push({ task: "prediction", contract: "predictionMarket", functionName: "resolve", args: [m.id], reason });

    if (m.higherPool === 0n || m.lowerPool === 0n) {
      resolve("one side has no bets: the market is void whatever the price");
      continue;
    }
    const o = m.oracle;
    // the same three conditions as PredictionMarket.resolve
    const usable = o !== null && o.price !== 0n && o.updatedAt >= m.resolveTime && o.updatedAt + state.maxOracleAge >= now;
    if (usable) {
      resolve(`oracle price ${o.price} published at ${o.updatedAt}, ${o.updatedAt - m.resolveTime}s after the settlement time`);
      continue;
    }
    if (now >= m.resolveTime + state.voidGrace) {
      resolve("no usable price within the grace period: the market is void");
      continue;
    }
    const waited = now - m.resolveTime;
    decision.findings.push({
      task: "prediction",
      level: waited >= state.stuckWarnSeconds ? "warn" : "info",
      code: "market_waiting_for_price",
      message:
        `market ${m.id} is ${duration(waited)} past its settlement time and the oracle has ` +
        (o === null ? "no price" : `no price published since (latest is from ${o.updatedAt})`) +
        `; it voids ${duration(m.resolveTime + state.voidGrace - now)} from now`,
      data: { marketId: m.id, collection: m.collection, resolveTime: m.resolveTime, waitedSeconds: waited, oracleUpdatedAt: o?.updatedAt ?? null },
    });
    // poll again as soon as possible: the price may be published in the next block
    decision.wakeAt.push(now);
  }
  return decision;
}

interface MarketStruct {
  collection: Address;
  resolveTime: number;
  higherPool: bigint;
  lowerPool: bigint;
  outcome: number;
}

export async function fetchPrediction(ctx: Ctx, head: Head): Promise<PredictionState> {
  const r = readerAt(ctx, head);
  const [count, maxOracleAge, voidGrace, oracle] = await Promise.all([
    r.read<bigint>("predictionMarket", "marketCount"),
    r.read<bigint>("predictionMarket", "maxOracleAge"),
    r.read<bigint>("predictionMarket", "VOID_GRACE"),
    r.read<Address>("predictionMarket", "oracle"),
  ]);
  const from = ctx.cache.watermark("markets");
  const markets = await r.map(range(from, count), async (id): Promise<MarketState> => {
    const m = await r.struct<MarketStruct>("predictionMarket", "markets", [id]);
    const state: MarketState = {
      id,
      collection: m.collection,
      resolveTime: BigInt(m.resolveTime),
      higherPool: m.higherPool,
      lowerPool: m.lowerPool,
      outcome: Number(m.outcome),
      oracle: null,
    };
    if (state.outcome === OUTCOME_PENDING && head.timestamp >= state.resolveTime) {
      const price = await r.tryRead<readonly [bigint, bigint]>("floorOracle", "floorPrice", [m.collection], oracle);
      if (price) state.oracle = { price: price[0], updatedAt: price[1] };
    }
    return state;
  });
  ctx.cache.setWatermark("markets", firstOpen(markets, (m) => m.outcome !== OUTCOME_PENDING, from, count));
  return { now: head.timestamp, maxOracleAge, voidGrace, stuckWarnSeconds: ctx.config.predictionStuckWarnSeconds, markets };
}

export async function runPrediction(ctx: Ctx, head: Head): Promise<TaskReport> {
  const state = await fetchPrediction(ctx, head);
  const report = await carryOut(ctx, "prediction", decidePrediction(state));
  report.metrics = { pendingMarkets: state.markets.filter((m) => m.outcome === OUTCOME_PENDING).length };
  return report;
}
