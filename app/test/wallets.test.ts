// Pure unit tests for the wallet menu's ordering and de-duplication: no chain needed.
import { describe, expect, it } from "vitest";
import { walletErrorMessage, walletOptions, type WalletCandidate } from "../src/lib/wallets";

const generic: WalletCandidate = { id: "injected", name: "Injected", type: "injected" };
const rabby: WalletCandidate = { id: "io.rabby", name: "Rabby Wallet", type: "injected" };
const metamask: WalletCandidate = { id: "io.metamask", name: "MetaMask", type: "injected" };
const brave: WalletCandidate = { id: "com.brave.wallet", name: "Brave Wallet", type: "injected" };
const coinbase: WalletCandidate = { id: "com.coinbase.wallet", name: "Coinbase Wallet", type: "injected" };
const local: WalletCandidate = { id: "localTestAccount", name: "Local test account", type: "localTest" };
const walletConnect: WalletCandidate = { id: "walletConnect", name: "WalletConnect", type: "walletConnect" };
const safe: WalletCandidate = { id: "safe", name: "Safe", type: "safe" };

const labels = (options: { label: string }[]) => options.map((o) => o.label);

describe("walletOptions", () => {
  it("shows the generic entry as 'Browser wallet' only when no wallet announced itself", () => {
    expect(labels(walletOptions([generic, local]))).toEqual(["Browser wallet"]);
    expect(labels(walletOptions([generic, metamask, local]))).toEqual(["MetaMask"]);
    expect(labels(walletOptions([local]))).toEqual([]);
  });

  it("lists announced wallets by their own names, Rabby first, the rest alphabetically", () => {
    expect(labels(walletOptions([generic, metamask, coinbase, rabby, brave]))).toEqual([
      "Rabby Wallet",
      "Brave Wallet",
      "Coinbase Wallet",
      "MetaMask",
    ]);
    expect(labels(walletOptions([metamask, brave]))).toEqual(["Brave Wallet", "MetaMask"]);
  });

  it("keeps MetaMask next to Rabby when both are really installed", () => {
    expect(labels(walletOptions([generic, metamask, rabby]))).toEqual(["Rabby Wallet", "MetaMask"]);
  });

  it("hides a MetaMask entry that is Rabby's impersonation", () => {
    const options = walletOptions([generic, metamask, rabby], { impersonators: new Set(["io.metamask"]) });
    expect(labels(options)).toEqual(["Rabby Wallet"]);
    // without a real Rabby entry the impersonating one is all there is, so it stays
    expect(labels(walletOptions([generic, metamask], { impersonators: new Set(["io.metamask"]) }))).toEqual(["MetaMask"]);
  });

  it("drops duplicate announcements of the same wallet", () => {
    expect(labels(walletOptions([rabby, { ...rabby }, metamask]))).toEqual(["Rabby Wallet", "MetaMask"]);
  });

  it("offers the local test account only on the local chain, after everything else", () => {
    expect(walletOptions([generic, rabby, local]).some((o) => o.group === "local")).toBe(false);
    const options = walletOptions([local, generic, rabby, walletConnect, safe], { localChain: true });
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ["installed", "Rabby Wallet"],
      ["other", "WalletConnect (mobile wallets)"],
      ["other", "Safe (this Safe App)"],
      ["local", "Local test account"],
    ]);
  });
});

describe("walletErrorMessage", () => {
  it("explains the common failures", () => {
    expect(walletErrorMessage({ code: 4001 })).toBe("You declined the request in the wallet.");
    expect(walletErrorMessage({ name: "UserRejectedRequestError" })).toBe("You declined the request in the wallet.");
    expect(walletErrorMessage({ code: -32002 })).toMatch(/already has a request open/);
    expect(walletErrorMessage({ cause: { code: 4902 } })).toMatch(/does not know this chain/);
    expect(walletErrorMessage({ name: "ProviderNotFoundError" })).toMatch(/No browser wallet was found/);
    expect(walletErrorMessage({ shortMessage: "Something specific." })).toBe("Something specific.");
    expect(walletErrorMessage(undefined)).toBe("The wallet request failed.");
  });
});
