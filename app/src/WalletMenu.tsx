import { useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useChains, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { anvil } from "wagmi/chains";
import { shortAddress } from "./lib/format";
import { LOCAL_WALLET_ID, RABBY_RDNS, walletErrorMessage, walletOptions } from "./lib/wallets";
import { getLocalAccountIndex, LOCAL_ACCOUNT_COUNT, selectLocalAccount } from "./localWallet";
import { Addr, Modal } from "./ui";

function WalletIcon({ connector }: { connector: Pick<Connector, "icon" | "name"> }) {
  // EIP-6963 icons are data: URIs supplied by the wallet itself; nothing is fetched.
  return connector.icon?.startsWith("data:") ? (
    <img className="wallet-icon" src={connector.icon} alt="" />
  ) : (
    <span className="wallet-icon wallet-icon-fallback" aria-hidden="true">
      {connector.name.slice(0, 1)}
    </span>
  );
}

/**
 * Ids of announced wallets whose provider is really Rabby (Rabby can present itself as MetaMask).
 * Wallets set an `isRabby` flag on their provider; that is the only way to tell from the page.
 */
function useImpersonators(connectors: readonly Connector[]): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected" && c.id !== RABBY_RDNS);
    void Promise.all(
      announced.map(async (connector) => {
        try {
          const provider = (await connector.getProvider()) as { isRabby?: boolean } | undefined;
          return provider?.isRabby ? connector.id : undefined;
        } catch {
          return undefined;
        }
      }),
    ).then((found) => {
      if (!cancelled) setIds(new Set(found.filter((id): id is string => !!id)));
    });
    return () => {
      cancelled = true;
    };
  }, [connectors]);
  return ids;
}

/** The app's chain selector. Choosing a chain also asks a connected wallet to switch to it. */
export function ChainSelect() {
  const chains = useChains();
  const chainId = useChainId();
  const account = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const usingLocal = account.connector?.id === LOCAL_WALLET_ID;

  const choose = async (target: number) => {
    // The local test account exists only on anvil and cannot switch, so it is disconnected first.
    if (usingLocal && target !== anvil.id) await disconnectAsync();
    switchChain({ chainId: target as typeof chainId });
  };
  return (
    <select className="chain-select" value={chainId} onChange={(e) => void choose(Number(e.target.value))} aria-label="Chain">
      {chains.map((chain) => (
        <option key={chain.id} value={chain.id}>
          {chain.name}
        </option>
      ))}
    </select>
  );
}

export function WalletMenu() {
  const chains = useChains();
  const chainId = useChainId();
  const account = useAccount();
  const { connect, connectors, error: connectError, isPending, variables, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error: switchError, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [localIndex, setLocalIndex] = useState(getLocalAccountIndex());

  const impersonators = useImpersonators(connectors);
  const options = useMemo(
    () => walletOptions(connectors, { impersonators, localChain: chainId === anvil.id }),
    [connectors, impersonators, chainId],
  );
  const usingLocal = account.connector?.id === LOCAL_WALLET_ID;
  const chainName = (id: number | undefined) => chains.find((c) => c.id === id)?.name ?? `chain ${id}`;
  const wrongChain = account.isConnected && account.chainId !== chainId;

  // Leaving anvil by any route disconnects the local test account.
  useEffect(() => {
    if (usingLocal && chainId !== anvil.id) disconnect();
  }, [usingLocal, chainId, disconnect]);
  // Close the menu once a connection succeeds.
  useEffect(() => {
    if (account.isConnected) {
      reset();
      setOpen(false);
    }
  }, [account.isConnected, reset]);

  const chooseLocal = (index: number) => {
    setLocalIndex(index);
    selectLocalAccount(index);
  };
  const localSelect = (
    <select value={localIndex} onChange={(e) => chooseLocal(Number(e.target.value))} aria-label="Local test account">
      {Array.from({ length: LOCAL_ACCOUNT_COUNT }, (_, i) => (
        <option key={i} value={i}>
          anvil #{i}
          {i === 0 ? " (owner)" : ""}
        </option>
      ))}
    </select>
  );

  const group = (name: "installed" | "other") =>
    options
      .filter((option) => option.group === name)
      .map(({ connector, label }) => (
        <button
          key={connector.uid}
          type="button"
          className="wallet-option"
          disabled={isPending}
          onClick={() => connect({ connector, chainId }, { onSuccess: () => setOpen(false) })}
        >
          <WalletIcon connector={connector} />
          <span>{label}</span>
          {isPending && variables?.connector === connector && <span className="muted small">Check your wallet…</span>}
        </button>
      ));
  const local = options.find((option) => option.group === "local");

  return (
    <>
      {account.isConnected && account.address && account.connector ? (
        <button type="button" className={wrongChain ? "wallet-button warn" : "wallet-button"} onClick={() => setOpen(true)}>
          <WalletIcon connector={account.connector} />
          <span className="wallet-name">{usingLocal ? `Test #${localIndex}` : account.connector.name}</span>
          <code>{shortAddress(account.address)}</code>
          {wrongChain && <span className="badge badge-warn">Wrong chain</span>}
        </button>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Connect wallet
        </button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={account.isConnected ? "Wallet" : "Connect a wallet"}>
        {account.isConnected && account.address && account.connector ? (
          <div className="wallet-menu">
            <div className="wallet-row">
              <WalletIcon connector={account.connector} />
              <strong>{usingLocal ? "Local test account" : account.connector.name}</strong>
              <Addr address={account.address} />
            </div>
            {usingLocal && (
              <label className="field">
                <span>Local development only: which of anvil's unlocked accounts to act as</span>
                {localSelect}
              </label>
            )}
            <label className="field">
              <span>Chain the app shows</span>
              <ChainSelect />
            </label>
            {wrongChain ? (
              <div className="callout warn" role="alert">
                <p>
                  Your wallet is on {chainName(account.chainId)}, the app is showing {chainName(chainId)}. Transactions
                  need both to match.
                </p>
                <button type="button" className="btn" disabled={switching} onClick={() => switchChain({ chainId })}>
                  Switch the wallet to {chainName(chainId)}
                </button>
                <p className="muted small">If the wallet does not know this chain yet, it will ask to add it first.</p>
              </div>
            ) : (
              <p className="muted small">The wallet and the app are both on {chainName(chainId)}.</p>
            )}
            {switchError && (
              <p className="error" role="alert">
                Could not switch chain: {walletErrorMessage(switchError)}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="wallet-menu">
            {group("installed").length > 0 ? (
              <>
                <h3>Installed wallets</h3>
                <div className="wallet-list">{group("installed")}</div>
              </>
            ) : (
              <p className="muted">No browser wallet was detected on this page.</p>
            )}
            {group("other").length > 0 && (
              <>
                <h3>Other ways to connect</h3>
                <div className="wallet-list">{group("other")}</div>
              </>
            )}
            {local && (
              <>
                <h3>Local development</h3>
                <div className="wallet-local">
                  <p className="small">
                    Acts as one of anvil's unlocked accounts. Only on the local chain (31337); never reconnects by
                    itself.
                  </p>
                  <div className="form-row">
                    {localSelect}
                    <button
                      type="button"
                      className="btn secondary local"
                      disabled={isPending}
                      onClick={() => connect({ connector: local.connector, chainId }, { onSuccess: () => setOpen(false) })}
                    >
                      Use local test account (anvil only)
                    </button>
                  </div>
                </div>
              </>
            )}
            {connectError && (
              <p className="error" role="alert">
                {walletErrorMessage(connectError)}
              </p>
            )}
            <div className="callout">
              <strong>No wallet?</strong>
              <p className="small">
                A browser wallet extension holds your keys and signs transactions. Rabby (rabby.io) and MetaMask
                (metamask.io) both work with this app. Install one, reload this page, and it will be listed here by
                name.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
