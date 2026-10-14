import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Address, Client } from "viem";
import { useAccount, useChainId, useClient } from "wagmi";
import { useMode } from "./demo/mode";
import { DEMO_CHAIN_ID, DEMO_CLIENT, DEMO_DEPLOYMENT, DEMO_USER, subscribeDemo } from "./demo/sim";
import { deployments } from "./deployments";
import type { Deployment } from "./generated/addresses";
import { playMoney } from "./lib/format";
import { readChainTime, readIsDeployed } from "./lib/reads";

/** Root of every query key in the app; a confirmed transaction invalidates everything under it. */
export const QUERY_ROOT = "floorguard";
/** How often reads are refreshed: about one block. Polling stops while the tab is hidden. */
const REFRESH_MS: Record<number, number> = { 1: 12_000, 11155111: 12_000, 8453: 4_000, 84532: 4_000 };
const DEFAULT_REFRESH_MS = 5_000;

export type Protocol = {
  /** True in demo mode: everything below is the in-browser simulation. */
  demo: boolean;
  chainId: number;
  client: Client | undefined;
  deployment: Deployment | undefined;
  user: Address | undefined;
};

/** The selected chain, its client, its deployment (if any) and the connected account; or the demo's. */
export function useProtocol(): Protocol {
  const mode = useMode();
  const chainId = useChainId();
  const client = useClient({ chainId }) as Client | undefined;
  const { address } = useAccount();
  if (mode === "demo") return { demo: true, chainId: DEMO_CHAIN_ID, client: DEMO_CLIENT, deployment: DEMO_DEPLOYMENT, user: DEMO_USER };
  return { demo: false, chainId, client, deployment: deployments[chainId], user: address };
}

/**
 * Poll a read function from lib/reads.ts. `key` must be JSON-serialisable (no bigints). The query is
 * idle while the chain has no deployment.
 */
export function useRead<T>(
  key: readonly (string | number | boolean | undefined)[],
  read: (client: Client, deployment: Deployment) => Promise<T>,
  enabled = true,
): UseQueryResult<T> {
  const { demo, chainId, client, deployment } = useProtocol();
  return useQuery({
    queryKey: [QUERY_ROOT, chainId, ...key],
    queryFn: () => read(client!, deployment!),
    enabled: enabled && !!client && !!deployment,
    // The demo's clock runs fast, so its prices and countdowns are refreshed every second.
    refetchInterval: demo ? 1_000 : (REFRESH_MS[chainId] ?? DEFAULT_REFRESH_MS),
    // a hidden tab asks for nothing; it catches up when it is shown again
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Labels amounts as play money in the demo ("play ETH"); leaves text alone on a chain. */
export function useMoney(): (text: string) => string {
  const { demo } = useProtocol();
  return demo ? playMoney : (text) => text;
}

/** Latest block timestamp (simulated time in the demo). Falls back to the wall clock until it arrives. */
export function useChainTime(): number {
  const { data } = useRead(["chainTime"], (client) => readChainTime(client));
  return data ?? Math.floor(Date.now() / 1000);
}

export function useIsDeployed() {
  return useRead(["isDeployed"], readIsDeployed);
}

/** Refetch everything whenever the simulated state changes (a settlement arriving, for example). */
export function useDemoSync() {
  const queryClient = useQueryClient();
  useEffect(() => subscribeDemo(() => void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })), [queryClient]);
}
