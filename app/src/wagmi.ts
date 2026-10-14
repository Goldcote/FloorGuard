import type { Chain, Transport } from "viem";
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { anvil, base, baseSepolia, mainnet, sepolia } from "wagmi/chains";
import { injected, safe, walletConnect } from "wagmi/connectors";
import { SAFE_ALLOWED_DOMAINS } from "./lib/frame";
import { anvilRpcUrl } from "./lib/loopback";
import { DEMO_ONLY, LOCAL_ENABLED } from "./local";
import { localTestAccount } from "./localWallet";

const env = import.meta.env;

// Wallets:
//  - every browser wallet that announces itself (EIP-6963: Rabby, MetaMask, ...) gets its own
//    connector, created by wagmi's multiInjectedProviderDiscovery; `injected()` is the fallback for
//    a wallet that only sets window.ethereum.
//  - Safe: only when the app runs inside an iframe, and only for the Safe web app's own origin.
//  - WalletConnect: only when VITE_WALLETCONNECT_PROJECT_ID is set.
//  - the local test account: anvil's unlocked accounts, chain 31337 only, and only in a development
//    build or one built with VITE_ENABLE_LOCAL=1 (see local.ts).
// The SDKs of Safe and WalletConnect are separate chunks that load on first use, and neither
// connector exists by default, so out of the box the app talks to nothing but the selected chain's RPC.
// A demo-only build (local.ts) has no connectors and no discovery: it never talks to a wallet.
const connectors: CreateConnectorFn[] = DEMO_ONLY ? [] : [injected()];
if (!DEMO_ONLY && typeof window !== "undefined" && window.parent !== window) connectors.push(safe({ allowedDomains: SAFE_ALLOWED_DOMAINS }));
if (!DEMO_ONLY && env.VITE_WALLETCONNECT_PROJECT_ID) {
  connectors.push(walletConnect({ projectId: env.VITE_WALLETCONNECT_PROJECT_ID, showQrModal: true }));
}

const publicChains = [mainnet, sepolia, base, baseSepolia] as const;
// Each chain uses its public RPC unless a VITE_<CHAIN>_RPC_URL is set. A chain is only contacted
// while it is the selected one and has a deployment on record.
const transports: Record<number, Transport> = {
  [mainnet.id]: http(env.VITE_MAINNET_RPC_URL || undefined),
  [sepolia.id]: http(env.VITE_SEPOLIA_RPC_URL || undefined),
  [base.id]: http(env.VITE_BASE_RPC_URL || undefined),
  [baseSepolia.id]: http(env.VITE_BASE_SEPOLIA_RPC_URL || undefined),
};
// Stay gentle on public RPCs: receipts are polled at about the chain's block time.
const pollingInterval: Record<number, number> = { [mainnet.id]: 4_000, [sepolia.id]: 4_000, [base.id]: 4_000, [baseSepolia.id]: 4_000 };

let chains: readonly [Chain, ...Chain[]] = publicChains;
if (LOCAL_ENABLED) {
  // Local development: the anvil chain comes first (so a fresh page opens on it), with the local
  // test account. None of this is in a production build.
  const rpcUrl = anvilRpcUrl(env.VITE_ANVIL_RPC_URL);
  chains = [anvil, ...publicChains];
  transports[anvil.id] = http(rpcUrl);
  pollingInterval[anvil.id] = 500; // anvil mines instantly
  connectors.push(localTestAccount(rpcUrl));
}

export const config = createConfig({
  chains,
  connectors,
  multiInjectedProviderDiscovery: !DEMO_ONLY,
  transports,
  pollingInterval,
  // Reads made in the same tick go out as one multicall3 `aggregate3` call on chains that have the
  // contract (the public ones do; a bare anvil does not, and viem then sends them one by one).
  batch: { multicall: true },
  // Never follow an ERC-3668 (CCIP-Read) `OffchainLookup` revert: a contract named in on-chain data
  // must not be able to make the browser fetch a URL of its choosing.
  ccipRead: false,
});

/** First block to scan for event logs. Set it to the deployment block on public chains. */
export const LOGS_FROM_BLOCK = BigInt(env.VITE_LOGS_FROM_BLOCK || 0);

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
