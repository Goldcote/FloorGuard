import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { App } from "./App";
import { pageMayRender } from "./lib/frame";
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

// Framed by anything but the Safe web app, the app does not render: a page that embeds it could
// otherwise overlay it and steer clicks. (The deployment should also send `frame-ancestors`; see README.)
createRoot(document.getElementById("root")!).render(
  pageMayRender() ? (
    <StrictMode>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <TxProvider>
            <App />
          </TxProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>
  ) : (
    <p style={{ margin: "2rem", font: "16px system-ui, sans-serif", color: "#eaf0f7" }} role="alert">
      FloorGuard does not run inside another site's frame. Open it in its own tab.
    </p>
  ),
);
