/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANVIL_RPC_URL?: string;
  readonly VITE_MAINNET_RPC_URL?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_LOGS_FROM_BLOCK?: string;
  /** "1" keeps the local-development machinery (anvil, the local test account) in a production build. */
  readonly VITE_ENABLE_LOCAL?: string;
  /** Largest block range of one eth_getLogs request (default 9000). */
  readonly VITE_LOGS_WINDOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
