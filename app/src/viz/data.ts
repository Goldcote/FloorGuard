// Reads the visualisations need on top of lib/reads.ts, as plain functions for `useRead`.
import type { Address, Client } from "viem";
import { demoBidEvents, demoBidStart, demoOwnedTokens, demoReads, isDemo } from "../demo/sim";
import type { Deployment } from "../generated/addresses";
import { readFloor, type Floor } from "../lib/reads";
import type { BidEvent } from "./curves";

/** The sales-oracle floor (the one the Vault reads) of each collection, keyed by lower-case address. */
export async function readSalesFloors(client: Client, d: Deployment, collections: readonly Address[]): Promise<Record<string, Floor>> {
  const unique = [...new Set(collections.map((c) => c.toLowerCase()))];
  if (isDemo(client)) {
    const floor = demoReads.overview().salesFloor;
    return Object.fromEntries(unique.map((c) => [c, floor]));
  }
  const floors = await Promise.all(unique.map((c) => readFloor(client, d.salesFloorOracle, c as Address)));
  return Object.fromEntries(unique.map((c, i) => [c, floors[i]]));
}

export type BidHistory = { events: BidEvent[]; first: { time: number; base: bigint } | undefined };

/**
 * What ended each past climb of the bid curve, for the chart. The demo keeps that; on a chain the
 * chart draws the climb that is running now (its start and base are on-chain) and no earlier ones.
 */
export function bidHistory(demo: boolean): BidHistory {
  return demo ? { events: demoBidEvents(), first: demoBidStart() } : { events: [], first: undefined };
}

/** Tokens the visitor can pick from without typing an id. Only the demo knows them. */
export const ownedTokens = (demo: boolean): bigint[] => (demo ? demoOwnedTokens() : []);
