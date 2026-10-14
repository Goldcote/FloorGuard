// eth_getLogs in ranges an RPC provider will accept.
import type { AbiEvent, Address, Log, PublicClient } from "viem";

export interface LogQuery {
  address: Address;
  events: AbiEvent[];
  fromBlock: bigint;
  toBlock: bigint;
  /** Largest block span of one request. Halved, down to one block, when the provider refuses. */
  maxRange: bigint;
}

export type DecodedLog = Log<bigint, number, false> & { eventName: string; args: Record<string, unknown> };

/** Split [from, to] into consecutive spans of at most `size` blocks. */
export function blockRanges(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  if (size < 1n) throw new Error("range size must be at least 1");
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push([start, end > to ? to : end]);
  }
  return out;
}

export async function getLogsChunked(client: PublicClient, query: LogQuery): Promise<DecodedLog[]> {
  const out: DecodedLog[] = [];
  let span = query.maxRange < 1n ? 1n : query.maxRange;
  let from = query.fromBlock;
  while (from <= query.toBlock) {
    const to = from + span - 1n > query.toBlock ? query.toBlock : from + span - 1n;
    try {
      const logs = await client.getLogs({
        address: query.address,
        events: query.events,
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      out.push(...(logs as unknown as DecodedLog[]));
      from = to + 1n;
    } catch (error) {
      // most providers answer an oversized range or result with an error: retry with half the span
      if (span === 1n) throw error;
      span = span / 2n;
    }
  }
  return out;
}

export function eventsOf(abi: readonly unknown[], names: string[]): AbiEvent[] {
  const events = (abi as AbiEvent[]).filter((item) => item.type === "event" && names.includes(item.name));
  if (events.length !== names.length) throw new Error(`ABI is missing one of the events ${names.join(", ")}`);
  return events;
}

/**
 * Where to start a scan. A few blocks before the last scanned one are read again, so that a shallow
 * reorg cannot hide an event; every consumer treats what it finds as a set.
 */
export function scanFrom(lastScanned: bigint | null, startBlock: bigint, overlap = 64n): bigint {
  if (lastScanned === null) return startBlock;
  const from = lastScanned + 1n - overlap;
  return from < startBlock ? startBlock : from;
}
