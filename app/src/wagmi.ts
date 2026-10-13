import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { anvil, base, baseSepolia, mainnet, sepolia } from "wagmi/chains";
import { injected, safe, walletConnect } from "wagmi/connectors";
import { localTestAccount } from "./localWallet";

const env = import.meta.env;
const ANVIL_RPC_URL = env.VITE_ANVIL_RPC_URL || "http://127.0.0.1:8545";

// Wallets:
//  - every browser wallet that announces itself (EIP-6963: Rabby, MetaMask, ...) gets its own
//    connector, created by wagmi's multiInjectedProviderDiscovery; `injected()` is the fallback for
//    a wallet that only sets window.ethereum.
//  - the local test account: anvil's unlocked accounts, chain 31337 only.
//  - Safe: only when the app runs inside an iframe, i.e. opened as a Safe App.
//  - WalletConnect: only when VITE_WALLETCONNECT_PROJECT_ID is set.
// The SDKs of the last two are separate chunks that load on first use, and neither connector exists
// by default, so out of the box the app talks to nothing but the selected chain's RPC.
const connectors: CreateConnectorFn[] = [injected(), localTestAccount(ANVIL_RPC_URL)];
if (typeof window !== "undefined" && window.parent !== window) connectors.push(safe());
if (env.VITE_WALLETCONNECT_PROJECT_ID) {
  connectors.push(walletConnect({ projectId: env.VITE_WALLETCONNECT_PROJECT_ID, showQrModal: true }));
}

export const config = createConfig({
  chains: [anvil, mainnet, sepolia, base, baseSepolia],
  connectors,
  multiInjectedProviderDiscovery: true,
  // Each chain uses its public RPC unless a VITE_<CHAIN>_RPC_URL is set. A chain is only contacted
  // while it is the selected one and has a deployment on record.
  transports: {
    [anvil.id]: http(ANVIL_RPC_URL),
    [mainnet.id]: http(env.VITE_MAINNET_RPC_URL || undefined),
    [sepolia.id]: http(env.VITE_SEPOLIA_RPC_URL || undefined),
    [base.id]: http(env.VITE_BASE_RPC_URL || undefined),
    [baseSepolia.id]: http(env.VITE_BASE_SEPOLIA_RPC_URL || undefined),
  },
  // anvil mines instantly, so poll for receipts quickly there; stay gentle on public RPCs.
  pollingInterval: { [anvil.id]: 500, [mainnet.id]: 4_000, [sepolia.id]: 4_000, [base.id]: 4_000, [baseSepolia.id]: 4_000 },
});

/** First block to scan for event logs. Set it to the deployment block on public chains. */
export const LOGS_FROM_BLOCK = BigInt(env.VITE_LOGS_FROM_BLOCK || 0);

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
