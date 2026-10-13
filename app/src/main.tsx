import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { App } from "./App";
import { TxProvider } from "./tx";
import { config } from "./wagmi";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import "./styles/world.css";
import "./styles/play.css";

// Development aid: fake EIP-6963 wallets for exercising the wallet menu. Stripped from production builds.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock-wallets")) {
  (await import("./dev/mockWallets")).installMockWallets();
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <TxProvider>
          <App />
        </TxProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
