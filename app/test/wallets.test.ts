// Pure unit tests for the wallet menu's ordering and de-duplication: no chain needed.
import { describe, expect, it } from "vitest";
import { duplicatedRdns, walletErrorMessage, walletOptions, type WalletCandidate } from "../src/lib/wallets";

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

  const isRabby = { verifiedRabby: new Set(["io.rabby"]) };

  it("lists announced wallets by their own names, alphabetically: a self-declared rdns earns no special place", () => {
    expect(labels(walletOptions([generic, metamask, coinbase, rabby, brave]))).toEqual(["Brave Wallet", "Coinbase Wallet", "MetaMask", "Rabby Wallet"]);
    expect(labels(walletOptions([metamask, brave]))).toEqual(["Brave Wallet", "MetaMask"]);
  });

  it("puts Rabby first only when its provider itself reports isRabby", () => {
    expect(labels(walletOptions([generic, metamask, coinbase, rabby, brave], isRabby))).toEqual(["Rabby Wallet", "Brave Wallet", "Coinbase Wallet", "MetaMask"]);
    // a wallet that merely calls itself io.rabby is listed like any other
    expect(labels(walletOptions([metamask, rabby]))).toEqual(["MetaMask", "Rabby Wallet"]);
    // the flag on some other wallet's provider does not move that wallet up
    expect(labels(walletOptions([metamask, brave], { verifiedRabby: new Set(["io.metamask"]) }))).toEqual(["Brave Wallet", "MetaMask"]);
  });

  it("shows the rdns each announced wallet declared, next to its name", () => {
    expect(walletOptions([generic, metamask, rabby], isRabby).map((o) => [o.label, o.rdns])).toEqual([
      ["Rabby Wallet", "io.rabby"],
      ["MetaMask", "io.metamask"],
    ]);
    expect(walletOptions([generic])[0].rdns).toBeUndefined();
  });

  it("keeps MetaMask next to Rabby when both are really installed", () => {
    expect(labels(walletOptions([generic, metamask, rabby], isRabby))).toEqual(["Rabby Wallet", "MetaMask"]);
  });

  it("hides a MetaMask entry that is Rabby's impersonation", () => {
    const options = walletOptions([generic, metamask, rabby], { ...isRabby, impersonators: new Set(["io.metamask"]) });
    expect(labels(options)).toEqual(["Rabby Wallet"]);
    // without a real Rabby entry the impersonating one is all there is, so it stays
    expect(labels(walletOptions([generic, metamask], { impersonators: new Set(["io.metamask"]) }))).toEqual(["MetaMask"]);
    // and an entry that only claims Rabby's rdns hides nothing
    expect(labels(walletOptions([generic, metamask, rabby], { impersonators: new Set(["io.metamask"]) }))).toEqual(["MetaMask", "Rabby Wallet"]);
  });

  it("warns when two wallets announced the same rdns", () => {
    expect(duplicatedRdns([{ info: { rdns: "io.metamask" } }, { info: { rdns: "io.rabby" } }, { info: { rdns: "io.metamask" } }])).toEqual(new Set(["io.metamask"]));
    expect(duplicatedRdns([{ info: { rdns: "io.metamask" } }, { info: { rdns: "io.rabby" } }])).toEqual(new Set());
    const options = walletOptions([rabby, metamask], { ...isRabby, duplicated: new Set(["io.metamask"]) });
    expect(options.find((o) => o.rdns === "io.metamask")!.warning).toMatch(/More than one wallet on this page announced itself as io\.metamask/);
    expect(options.find((o) => o.rdns === "io.rabby")!.warning).toBeUndefined();
  });

  it("lists a connector once however often it is passed", () => {
    expect(labels(walletOptions([rabby, { ...rabby }, metamask], isRabby))).toEqual(["Rabby Wallet", "MetaMask"]);
  });

  it("offers the local test account only on the local chain, after everything else", () => {
    expect(walletOptions([generic, rabby, local]).some((o) => o.group === "local")).toBe(false);
    const options = walletOptions([local, generic, rabby, walletConnect, safe], { localChain: true, ...isRabby });
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
    // anything else is the wallet's own text: labelled, cut short and without links
    expect(walletErrorMessage({ shortMessage: "Something specific." })).toBe("Message from the contract or node (untrusted): Something specific.");
    expect(walletErrorMessage({ message: "Session expired. Restore your wallet at https://evil.example/restore now" })).toBe("Message from the contract or node (untrusted): Session expired. Restore your wallet at [link removed] now");
    expect(walletErrorMessage(undefined)).toBe("The wallet request failed.");
  });
});
