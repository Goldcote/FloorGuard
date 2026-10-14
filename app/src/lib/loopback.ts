// Which node may serve as the local chain. Used only where local development is enabled (local.ts).

const DEFAULT_ANVIL_RPC_URL = "http://127.0.0.1:8545";

/** Whether a URL points at this machine: only such a node may be used as the local chain. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") return false;
    return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127(\.\d{1,3}){3}$/.test(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * The RPC URL of the local chain. `VITE_ANVIL_RPC_URL` is refused unless it is a loopback address:
 * the local test account sends unsigned transactions to this node and must never reach a remote one.
 */
export function anvilRpcUrl(configured: string | undefined): string {
  if (!configured) return DEFAULT_ANVIL_RPC_URL;
  if (isLoopbackUrl(configured)) return configured;
  console.error(`VITE_ANVIL_RPC_URL (${configured}) is not a loopback address and was ignored; using ${DEFAULT_ANVIL_RPC_URL}.`);
  return DEFAULT_ANVIL_RPC_URL;
}
