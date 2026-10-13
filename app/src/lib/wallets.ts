// Which wallets the connect menu offers, and in what order. Pure, so it can be unit-tested.

export const RABBY_RDNS = "io.rabby";
export const METAMASK_RDNS = "io.metamask";
export const LOCAL_WALLET_ID = "localTestAccount";

/** The parts of a wagmi connector the menu needs. */
export type WalletCandidate = {
  /** For a wallet discovered through EIP-6963 this is its reverse-DNS name, e.g. "io.rabby". */
  id: string;
  name: string;
  /** wagmi connector type: "injected", "walletConnect", "safe", "localTest". */
  type: string;
  icon?: string;
};

export type WalletOption<T extends WalletCandidate> = {
  connector: T;
  /** Name to show. */
  label: string;
  group: "installed" | "other" | "local";
};

/**
 * @param impersonators ids of announced wallets whose provider is really another wallet's (Rabby can
 *        present itself as MetaMask). They are hidden when the real wallet is listed too.
 * @param localChain whether the selected chain is the local anvil chain.
 */
export function walletOptions<T extends WalletCandidate>(
  candidates: readonly T[],
  { impersonators = new Set<string>(), localChain = false }: { impersonators?: ReadonlySet<string>; localChain?: boolean } = {},
): WalletOption<T>[] {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const announced = unique.filter((c) => c.type === "injected" && c.id !== "injected");
  const hasRabby = announced.some((c) => c.id === RABBY_RDNS);
  const named = announced
    // Rabby announcing a second, MetaMask-branded entry is not a second wallet.
    .filter((c) => !(hasRabby && c.id !== RABBY_RDNS && impersonators.has(c.id)))
    .sort((a, b) => {
      if (a.id === RABBY_RDNS) return -1;
      if (b.id === RABBY_RDNS) return 1;
      return a.name.localeCompare(b.name);
    });

  const options: WalletOption<T>[] = named.map((connector) => ({ connector, label: connector.name, group: "installed" }));
  // The generic window.ethereum connector is only useful when no wallet announced itself.
  const generic = unique.find((c) => c.id === "injected");
  if (generic && named.length === 0) options.push({ connector: generic, label: "Browser wallet", group: "installed" });

  for (const connector of unique) {
    if (connector.type === "safe") options.push({ connector, label: "Safe (this Safe App)", group: "other" });
    if (connector.type === "walletConnect") options.push({ connector, label: "WalletConnect (mobile wallets)", group: "other" });
  }
  const local = unique.find((c) => c.id === LOCAL_WALLET_ID);
  if (local && localChain) options.push({ connector: local, label: "Local test account", group: "local" });
  return options;
}

/** Readable text for the ways connecting or switching typically fails. */
export function walletErrorMessage(error: unknown): string {
  const e = error as { code?: number; name?: string; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = e?.code ?? e?.cause?.code;
  if (code === 4001 || e?.name === "UserRejectedRequestError") return "You declined the request in the wallet.";
  if (code === -32002) return "The wallet already has a request open. Open the wallet, unlock it if needed, and finish or dismiss that request.";
  if (code === 4100) return "The wallet is locked or has not authorised this site. Unlock it and try again.";
  if (code === 4902) return "The wallet does not know this chain and declined to add it.";
  if (e?.name === "ProviderNotFoundError") return "No browser wallet was found. Install one (for example Rabby or MetaMask) and reload.";
  if (e?.name === "ConnectorAlreadyConnectedError") return "This wallet is already connected.";
  return e?.shortMessage || e?.message || "The wallet request failed.";
}
