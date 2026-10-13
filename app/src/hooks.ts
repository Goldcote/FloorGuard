import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Client } from "viem";
import { useAccount, useChainId, useClient } from "wagmi";
import { deployments, type Deployment } from "./generated/addresses";
import { readChainTime, readIsDeployed } from "./lib/reads";

/** Root of every query key in the app; a confirmed transaction invalidates everything under it. */
export const QUERY_ROOT = "floorguard";
const REFRESH_MS = 5_000;

/** The selected chain, its client, its deployment (if any) and the connected account. */
export function useProtocol() {
  const chainId = useChainId();
  const client = useClient({ chainId }) as Client | undefined;
  const { address: user } = useAccount();
  return { chainId, client, deployment: deployments[chainId], user };
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
  const { chainId, client, deployment } = useProtocol();
  return useQuery({
    queryKey: [QUERY_ROOT, chainId, ...key],
    queryFn: () => read(client!, deployment!),
    enabled: enabled && !!client && !!deployment,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}

/** Latest block timestamp. Falls back to the wall clock until the first block arrives. */
export function useChainTime(): number {
  const { data } = useRead(["chainTime"], (client) => readChainTime(client));
  return data ?? Math.floor(Date.now() / 1000);
}

export function useIsDeployed() {
  return useRead(["isDeployed"], readIsDeployed);
}
