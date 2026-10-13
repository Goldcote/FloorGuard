import { useEffect, useState } from "react";
import { useAccount, useChainId, useChains, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { anvil } from "wagmi/chains";
import { getLocalAccountIndex, LOCAL_ACCOUNT_COUNT, LOCAL_WALLET_ID, selectLocalAccount } from "./localWallet";
import { useIsDeployed, useProtocol } from "./hooks";
import { decodeError } from "./lib/errors";
import { parseAddress } from "./lib/parse";
import { FloorBid } from "./tabs/FloorBid";
import { Games } from "./tabs/Games";
import { Marketplace } from "./tabs/Marketplace";
import { Overview } from "./tabs/Overview";
import { Predictions } from "./tabs/Predictions";
import { Raffles } from "./tabs/Raffles";
import { Vault } from "./tabs/Vault";
import { TxPanel } from "./tx";
import { Addr, Card, Field } from "./ui";

const TABS = ["Overview", "Marketplace", "Floor bid", "Predictions", "Games", "Vault", "Raffles"] as const;
type Tab = (typeof TABS)[number];
/** Tabs that act on the collection chosen in the collection bar. */
const COLLECTION_TABS: readonly Tab[] = ["Overview", "Marketplace", "Floor bid", "Predictions", "Games"];

function Wallet() {
  const chains = useChains();
  const chainId = useChainId();
  const account = useAccount();
  const { connect, connectors, error, isPending } = useConnect();
  const { disconnect, disconnectAsync } = useDisconnect();
  const { switchChain, error: switchError } = useSwitchChain();
  const wrongChain = account.isConnected && account.chainId !== chainId;
  const [localIndex, setLocalIndex] = useState(getLocalAccountIndex());
  const usingLocal = account.connector?.id === LOCAL_WALLET_ID;
  const onLocalChain = chainId === anvil.id;

  // The local test account exists only on anvil, and its connector refuses to switch chains. So
  // choosing another chain disconnects it first; the effect covers any other way of leaving anvil.
  const chooseChain = async (target: number) => {
    if (usingLocal && target !== anvil.id) await disconnectAsync();
    switchChain({ chainId: target as typeof chainId });
  };
  useEffect(() => {
    if (usingLocal && !onLocalChain) disconnect();
  }, [usingLocal, onLocalChain, disconnect]);

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

  return (
    <div className="wallet">
      <select value={chainId} onChange={(e) => void chooseChain(Number(e.target.value))} aria-label="Chain">
        {chains.map((chain) => (
          <option key={chain.id} value={chain.id}>
            {chain.name} ({chain.id})
          </option>
        ))}
      </select>
      {account.isConnected && account.address ? (
        <>
          {usingLocal && (
            <span className="local-wallet" title="One of anvil's unlocked accounts. Local development only.">
              Local test account {localSelect}
            </span>
          )}
          <Addr address={account.address} />
          {wrongChain && (
            <button className="secondary" onClick={() => switchChain({ chainId })}>
              Switch wallet to chain {chainId}
            </button>
          )}
          <button className="secondary" onClick={() => disconnect()}>
            Disconnect
          </button>
        </>
      ) : (
        connectors.map((connector) =>
          connector.id === LOCAL_WALLET_ID ? (
            onLocalChain && (
              <span key={connector.uid} className="local-wallet" title="One of anvil's unlocked accounts. Local development only.">
                {localSelect}
                <button className="secondary local" disabled={isPending} onClick={() => connect({ connector, chainId })}>
                  Use local test account (anvil only)
                </button>
              </span>
            )
          ) : (
            <button key={connector.uid} disabled={isPending} onClick={() => connect({ connector, chainId })}>
              Connect {connector.name === "Injected" ? "wallet" : connector.name}
            </button>
          ),
        )
      )}
      {error && <span className="error small">{decodeError(error).message}</span>}
      {switchError && <span className="error small">Could not switch chain: {decodeError(switchError).message}</span>}
    </div>
  );
}

function NoDeployment({ chainId }: { chainId: number }) {
  return (
    <Card title="No deployment found for this chain">
      <p>
        There is no FloorGuard deployment on record for chain <strong>{chainId}</strong>, so there is nothing to show.
      </p>
      <p className="muted">
        Addresses are read from <code>deployments/{chainId}.json</code> in the repository root. Deploy with{" "}
        <code>script/Deploy.s.sol</code>, run <code>npm run sync</code> in <code>app/</code>, then reload. Or pick
        another chain in the selector above.
      </p>
    </Card>
  );
}

export function App() {
  const { chainId, deployment } = useProtocol();
  const deployed = useIsDeployed();
  const [tab, setTab] = useState<Tab>("Overview");
  const [collectionText, setCollectionText] = useState(deployment?.demoCollection ?? "");

  // Each chain has its own demo collection (or none).
  useEffect(() => setCollectionText(deployment?.demoCollection ?? ""), [chainId, deployment]);

  const collection = parseAddress(collectionText);
  const needsCollection = COLLECTION_TABS.includes(tab);

  let body;
  if (!deployment) {
    body = <NoDeployment chainId={chainId} />;
  } else if (deployed.isError) {
    body = (
      <Card title="Cannot reach the chain">
        <p className="error">{decodeError(deployed.error).message}</p>
        <p className="muted">Check that the RPC node for chain {chainId} is running and reachable.</p>
      </Card>
    );
  } else if (deployed.data === undefined) {
    body = <p className="muted">Connecting to chain {chainId}…</p>;
  } else if (!deployed.data) {
    body = (
      <Card title="No contracts at the recorded addresses">
        <p>
          A deployment is recorded for chain <strong>{chainId}</strong>, but there is no contract code at those
          addresses on the node the app is talking to.
        </p>
        <p className="muted">
          On a local chain this usually means anvil was restarted. Run <code>script/Deploy.s.sol</code> (and{" "}
          <code>script/SeedLocal.s.sol</code>) again, then <code>npm run sync</code>.
        </p>
      </Card>
    );
  } else {
    body = (
      <>
        {needsCollection && (
          <div className="collection-bar">
            <Field label="Collection address">
              <input
                value={collectionText}
                onChange={(e) => setCollectionText(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </Field>
            {deployment.demoCollection && collectionText !== deployment.demoCollection && (
              <button className="secondary" onClick={() => setCollectionText(deployment.demoCollection!)}>
                Use demo collection
              </button>
            )}
          </div>
        )}
        {needsCollection && !collection ? (
          <p className="muted">Enter a valid NFT collection address above.</p>
        ) : (
          <>
            {tab === "Overview" && <Overview collection={collection!} />}
            {tab === "Marketplace" && <Marketplace collection={collection!} />}
            {tab === "Floor bid" && <FloorBid collection={collection!} />}
            {tab === "Predictions" && <Predictions collection={collection!} />}
            {tab === "Games" && <Games collection={collection!} />}
            {tab === "Vault" && <Vault />}
            {tab === "Raffles" && <Raffles />}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className="banner" role="alert">
        Unaudited experimental software. Do not use with real funds.
      </div>
      <header className="top">
        <h1>FloorGuard</h1>
        <Wallet />
      </header>
      <nav className="tabs">
        {TABS.map((name) => (
          <button key={name} className={name === tab ? "tab active" : "tab"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>
      <main>{body}</main>
      <TxPanel />
    </>
  );
}
