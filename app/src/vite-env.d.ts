/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANVIL_RPC_URL?: string;
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string;
  readonly VITE_LOGS_FROM_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
