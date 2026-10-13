import { createConfig, http } from "wagmi";
import { anvil, baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

// Injected wallets only. The only network requests the app makes are JSON-RPC calls to the selected
// chain: the local anvil node, or Base Sepolia (its public RPC unless VITE_BASE_SEPOLIA_RPC_URL is set).
export const config = createConfig({
  chains: [anvil, baseSepolia],
  connectors: [injected()],
  transports: {
    [anvil.id]: http(import.meta.env.VITE_ANVIL_RPC_URL || "http://127.0.0.1:8545"),
    [baseSepolia.id]: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL || undefined),
  },
});

/** First block to scan for Marketplace logs. Set it to the deployment block on public chains. */
export const LOGS_FROM_BLOCK = BigInt(import.meta.env.VITE_LOGS_FROM_BLOCK || 0);

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
