// Event logs, read in bounded pieces. A public RPC refuses `eth_getLogs` over a long block range, so
// a scan from the deployment block to the tip is made window by window; and because every page
// refreshes every few seconds, what was scanned is kept in memory and only the new blocks are asked
// for the next time.
import type { Client, Hash } from "viem";
import { getBlock, getContractEvents } from "viem/actions";

/** Largest block range of one request. */
const WINDOW = BigInt(import.meta.env?.VITE_LOGS_WINDOW || 9_000);
/**
 * Most windows scanned in one go. A scan that would need more starts later instead and says so:
 * set VITE_LOGS_FROM_BLOCK to the deployment block so that it never comes to that.
 */
const MAX_WINDOWS = 40n;

type Tip = { number: bigint; hash: Hash };
type Entry = { logs: unknown[]; scannedTo: Tip; from: bigint };

const cache = new WeakMap<Client, Map<string, Entry>>();
const tips = new WeakMap<Client, Promise<Tip>>();
let warned = false;

/** The latest block. Reads that ask while one request is on its way share it; nothing is kept after it answers. */
function latest(client: Client): Promise<Tip> {
  const running = tips.get(client);
  if (running) return running;
  const tip = getBlock(client, { blockTag: "latest" })
    .then((block) => ({ number: block.number, hash: block.hash }))
    .finally(() => tips.delete(client));
  tips.set(client, tip);
  return tip;
}

const keyOf = (params: { address?: unknown; eventName?: unknown; args?: unknown; strict?: unknown }, from: bigint) =>
  JSON.stringify([params.address, params.eventName, params.args, params.strict, from.toString()], (_, value) => (typeof value === "bigint" ? `${value}n` : value));

/**
 * `getContractEvents` from `fromBlock` to the tip, paged and remembered. A call with any other
 * `toBlock` (one block, for a proof) goes straight through. The remembered part is dropped if the
 * block it ended at is no longer on the chain (a reorganisation, or a local chain that was reset).
 */
export const getEvents: typeof getContractEvents = (async (client: Client, params: { fromBlock?: bigint; toBlock?: bigint | "latest"; address?: unknown; eventName?: unknown; args?: unknown; strict?: unknown }) => {
  if (params.toBlock !== undefined && params.toBlock !== "latest") return getContractEvents(client, params as never);
  const tip = await latest(client);
  let from = params.fromBlock ?? 0n;
  // too far back to scan in one go: start at the most recent blocks that can be covered
  if (tip.number - from > WINDOW * MAX_WINDOWS) {
    from = tip.number - WINDOW * MAX_WINDOWS + 1n;
    if (!warned) {
      warned = true;
      console.warn(`Event history is read from block ${from} only: scanning from block ${params.fromBlock ?? 0n} would take too many requests. Set VITE_LOGS_FROM_BLOCK to the deployment block.`);
    }
  }
  const perClient = cache.get(client) ?? new Map<string, Entry>();
  cache.set(client, perClient);
  const key = keyOf(params, params.fromBlock ?? 0n);
  let entry = perClient.get(key);
  if (entry) {
    // still the same chain? the block the scan ended at must still be there, with the same hash
    const still =
      entry.from === from && entry.scannedTo.number <= tip.number
        ? entry.scannedTo.number === tip.number
          ? entry.scannedTo.hash === tip.hash
          : await getBlock(client, { blockNumber: entry.scannedTo.number }).then(
              (block) => block.hash === entry!.scannedTo.hash,
              () => false,
            )
        : false;
    if (!still) entry = undefined;
  }
  const logs = entry ? [...entry.logs] : [];
  let start = entry ? entry.scannedTo.number + 1n : from;
  while (start <= tip.number) {
    const end = start + WINDOW - 1n < tip.number ? start + WINDOW - 1n : tip.number;
    logs.push(...((await getContractEvents(client, { ...params, fromBlock: start, toBlock: end } as never)) as unknown[]));
    start = end + 1n;
  }
  perClient.set(key, { logs, scannedTo: tip, from });
  return logs;
}) as never;
