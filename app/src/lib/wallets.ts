// Which wallets the connect menu offers, and in what order. Pure, so it can be unit-tested.
import { untrusted } from "./errors";

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
  /** Name to show. The wallet chose it itself: it proves nothing. */
  label: string;
  /** The reverse-DNS identity an announced wallet declared, shown next to its name. Also self-declared. */
  rdns?: string;
  /** Something the visitor should know before connecting. */
  warning?: string;
  group: "installed" | "other" | "local";
};

/**
 * @param impersonators ids of announced wallets whose provider is really another wallet's (Rabby can
 *        present itself as MetaMask). They are hidden when the real wallet is listed too.
 * @param verifiedRabby ids of announced wallets whose provider itself reports `isRabby`. Only those
 *        are listed first: a self-declared rdns alone earns no special place.
 * @param duplicated rdns values that more than one wallet announced. Only one of them can be the
 *        wallet it says it is, so the entry carries a warning.
 * @param localChain whether the selected chain is the local anvil chain.
 */
export function walletOptions<T extends WalletCandidate>(
  candidates: readonly T[],
  {
    impersonators = new Set<string>(),
    verifiedRabby = new Set<string>(),
    duplicated = new Set<string>(),
    localChain = false,
  }: { impersonators?: ReadonlySet<string>; verifiedRabby?: ReadonlySet<string>; duplicated?: ReadonlySet<string>; localChain?: boolean } = {},
): WalletOption<T>[] {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const announced = unique.filter((c) => c.type === "injected" && c.id !== "injected");
  const isRabby = (c: T) => c.id === RABBY_RDNS && verifiedRabby.has(c.id);
  const hasRabby = announced.some(isRabby);
  const named = announced
    // Rabby announcing a second, MetaMask-branded entry is not a second wallet.
    .filter((c) => !(hasRabby && c.id !== RABBY_RDNS && impersonators.has(c.id)))
    .sort((a, b) => {
      if (isRabby(a) !== isRabby(b)) return isRabby(a) ? -1 : 1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });

  const options: WalletOption<T>[] = named.map((connector) => ({
    connector,
    label: connector.name,
    rdns: connector.id,
    warning: duplicated.has(connector.id)
      ? `More than one wallet on this page announced itself as ${connector.id}. Only one of them can be the real one; this entry is the first that did. If you did not expect that, do not connect.`
      : undefined,
    group: "installed",
  }));
  // The generic window.ethereum connector is only useful when no wallet announced itself.
  const generic = unique.find((c) => c.id === "injected");
  if (generic && named.length === 0) options.push({ connector: generic, label: "Browser wallet", group: "installed" });

  for (const connector of unique) {
    if (connector.type === "safe") options.push({ connector, label: "Safe (this Safe App)", group: "other" });
    if (connector.type === "walletConnect") options.push({ connector, label: "WalletConnect (mobile wallets)", group: "other" });
  }
  const local = unique.find((c) => c.id === LOCAL_WALLET_ID);
  if (local && localChain) options.push({ connector: local, label: local.name, group: "local" });
  return options;
}

/** The rdns values that appear more than once among the wallets announced on the page (EIP-6963). */
export function duplicatedRdns(announcements: readonly { info: { rdns: string } }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const { info } of announcements) counts.set(info.rdns, (counts.get(info.rdns) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([rdns]) => rdns));
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
  // anything else is the wallet's own text: shown cut short, without links, and labelled
  const text = e?.shortMessage || e?.message;
  return text ? untrusted(text) : "The wallet request failed.";
}
