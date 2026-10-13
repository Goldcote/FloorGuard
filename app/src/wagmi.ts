import { createConfig, http } from "wagmi";
import { anvil, baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { localTestAccount } from "./localWallet";

const ANVIL_RPC_URL = import.meta.env.VITE_ANVIL_RPC_URL || "http://127.0.0.1:8545";

// Wallets: an injected browser wallet, or (chain 31337 only) one of anvil's unlocked accounts. The
// only network requests the app makes are JSON-RPC calls to the selected chain: the local anvil node,
// or Base Sepolia (its public RPC unless VITE_BASE_SEPOLIA_RPC_URL is set).
export const config = createConfig({
  chains: [anvil, baseSepolia],
  connectors: [injected(), localTestAccount(ANVIL_RPC_URL)],
  transports: {
    [anvil.id]: http(ANVIL_RPC_URL),
    [baseSepolia.id]: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL || undefined),
  },
  // anvil mines instantly, so poll for receipts quickly there; stay gentle on public RPCs.
  pollingInterval: { [anvil.id]: 500, [baseSepolia.id]: 4_000 },
});

/** First block to scan for Marketplace and Games logs. Set it to the deployment block on public chains. */
export const LOGS_FROM_BLOCK = BigInt(import.meta.env.VITE_LOGS_FROM_BLOCK || 0);

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
