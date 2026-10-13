import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import type { Address } from "viem";
import { FloorLine, Logo, Wordmark } from "./brand";
import { getMode, modeWasChosen, setMode, useMode } from "./demo/mode";
import { demoReads, resetDemo } from "./demo/sim";
import { deployments } from "./generated/addresses";
import { useDemoSync, useIsDeployed, useProtocol, useRead } from "./hooks";
import { decodeError } from "./lib/errors";
import { eth, points as formatPoints } from "./lib/format";
import { parseAddress } from "./lib/parse";
import { readPoints } from "./lib/reads";
import { setSound, soundEnabled, subscribeSound } from "./lib/sound";
import { GROUPS, href, routesOf, useRoute, type Group, type RoutePath } from "./routes";
import { useTheme } from "./theme";
import { TxHistory } from "./tx";
import { Card, Field, Skeleton } from "./ui";
import { ChainSelect, WalletMenu } from "./WalletMenu";
import { config } from "./wagmi";

type Page = ComponentType<{ collection: Address }>;
const page = <K extends string>(load: () => Promise<Record<K, ComponentType<never>>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] as unknown as Page }));

// Each page is its own chunk, loaded when first opened.
const PAGES: Record<RoutePath, Page> = {
  "/": page(() => import("./tabs/Landing"), "Landing"),
  "/app": page(() => import("./tabs/Overview"), "Overview"),
  "/trade/marketplace": page(() => import("./tabs/Marketplace"), "Marketplace"),
  "/trade/floor-bid": page(() => import("./tabs/FloorBid"), "FloorBid"),
  "/vault/holdings": page(() => import("./tabs/Vault"), "Vault"),
  "/vault/licences": page(() => import("./tabs/Licences"), "Licences"),
  "/vault/raffles": page(() => import("./tabs/Raffles"), "Raffles"),
  "/play/dice": page(() => import("./tabs/Dice"), "Dice"),
  "/play/slots": page(() => import("./tabs/Slots"), "Slots"),
  "/play/lottery": page(() => import("./tabs/Lottery"), "Lottery"),
  "/play/ticket-raffles": page(() => import("./tabs/TicketRaffles"), "TicketRaffles"),
  "/play/predictions": page(() => import("./tabs/Predictions"), "Predictions"),
  "/fairness": page(() => import("./tabs/Fairness"), "Fairness"),
};

function PointsPill() {
  const { user } = useProtocol();
  const query = useRead(["points", user], (client, d) => readPoints(client, d, user!), !!user);
  if (!user || !query.data) return null;
  const { active, pending } = query.data;
  return (
    <a className="pill" href={href("/app")} title="Your points: your weight in vault raffles. Pending points must be activated on the overview.">
      <strong>{formatPoints(active)}</strong> pts
      {pending > 0n && <span className="pending-dot">+{formatPoints(pending)} pending</span>}
    </a>
  );
}

/** Demo or live. The demo needs no wallet and no chain; live talks to the selected chain. */
function ModeSwitch() {
  const mode = useMode();
  return (
    <div className="segmented" role="group" aria-label="Mode">
      <button type="button" className={mode === "demo" ? "on" : undefined} aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>
        Demo
      </button>
      <button type="button" className={mode === "live" ? "on" : undefined} aria-pressed={mode === "live"} onClick={() => setMode("live")}>
        Live
      </button>
    </div>
  );
}

function DemoBalance() {
  const balance = useRead(["demoBalance"], async () => demoReads.balance());
  return (
    <span className="pill" title="Play money. It has no value and cannot be withdrawn.">
      <strong>{balance.data !== undefined ? eth(balance.data, 4) : "…"}</strong> play ETH
      <button type="button" className="link-btn" onClick={() => resetDemo()} title="Start the demo over">
        reset
      </button>
    </span>
  );
}

function SoundToggle() {
  const on = useSyncExternalStore(subscribeSound, soundEnabled);
  return (
    <button type="button" className="icon-btn" aria-pressed={on} onClick={() => setSound(!on)} title={on ? "Sound on: turn off" : "Sound off: turn on"} aria-label={on ? "Turn sound off" : "Turn sound on"}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9v6h4l5 4V5L8 9H4Z" />
        {on ? <path d="M16.500 8.500a5 5 0 0 1 0 7M19 6a8.500 8.500 0 0 1 0 12" /> : <path d="m17 9 5 6m0-6-5 6" />}
      </svg>
    </button>
  );
}

export function App() {
  const mode = useMode();
  const { demo, chainId, deployment } = useProtocol();
  const deployed = useIsDeployed();
  const route = useRoute();
  const { theme, toggle } = useTheme();
  const [collectionText, setCollectionText] = useState<string>(deployment?.demoCollection ?? "");
  useDemoSync();

  // First visit with no choice made: if a local chain with a deployment answers, start live;
  // otherwise stay in the demo, which needs nothing.
  useEffect(() => {
    if (modeWasChosen()) return;
    const local = deployments[31337];
    if (!local) return;
    const client = config.getClient({ chainId: 31337 });
    void client
      .request({ method: "eth_getCode", params: [local.marketplace, "latest"] })
      .then((code) => {
        if (!modeWasChosen() && getMode() === "demo" && code && code !== "0x") setMode("live", false);
      })
      .catch(() => undefined);
  }, []);

  // Each chain (and the demo) has its own demo collection, or none.
  useEffect(() => setCollectionText(deployment?.demoCollection ?? ""), [chainId, deployment]);
  useEffect(() => {
    document.title = route.path === "/" ? "FloorGuard" : `${route.label} · FloorGuard`;
    window.scrollTo(0, 0);
  }, [route]);

  const collection = parseAddress(collectionText);
  const landing = route.path === "/";
  const group = route.group as Group;
  const subRoutes = landing ? [] : routesOf(group as Exclude<Group, "Home">);
  const Current = PAGES[route.path];

  let body;
  if (landing) {
    body = (
      <Suspense fallback={<Skeleton lines={6} />}>
        <Current collection={(collection ?? "0x0000000000000000000000000000000000000000") as Address} />
      </Suspense>
    );
  } else if (!deployment) {
    body = (
      <Card title="No deployment found for this chain">
        <p>
          There is no FloorGuard deployment on record for chain <strong>{chainId}</strong>, so there is nothing to show.
        </p>
        <p className="muted">
          Addresses are read from <code>deployments/{chainId}.json</code> in the repository root. Deploy with{" "}
          <code>script/Deploy.s.sol</code>, run <code>npm run sync</code> in <code>app/</code>, then reload. Or pick
          another chain, or try the demo.
        </p>
        <button type="button" className="btn" onClick={() => setMode("demo")}>
          Open the demo
        </button>
      </Card>
    );
  } else if (deployed.isError) {
    body = (
      <Card title="Cannot reach the chain">
        <p className="error" role="alert">
          {decodeError(deployed.error).message}
        </p>
        <p className="muted">Check that the RPC node for chain {chainId} is running and reachable, or try the demo.</p>
        <button type="button" className="btn" onClick={() => setMode("demo")}>
          Open the demo
        </button>
      </Card>
    );
  } else if (deployed.data === undefined) {
    body = <Skeleton lines={4} />;
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
  } else if (route.needsCollection && !collection) {
    body = (
      <Card title="Choose a collection">
        <p className="muted">Enter the address of an NFT collection in the field above to see this page.</p>
      </Card>
    );
  } else {
    body = (
      <Suspense fallback={<Skeleton lines={5} />}>
        <Current collection={collection as Address} />
      </Suspense>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="banners">
        <div className="banner" role="alert">
          Unaudited experimental software. Do not use with real funds.
        </div>
        {demo && !landing && (
          <div className="banner demo" role="status">
            Demo: simulated, no real transactions, play money. Simulated time runs fast.
          </div>
        )}
      </div>
      <header className="site-header">
        <div className="header-row">
          <a className="brand" href={href("/")} aria-label="FloorGuard home">
            <Logo />
            <Wordmark />
          </a>
          <nav className="primary-nav" aria-label="Sections">
            {GROUPS.map((name) => (
              <a key={name} href={href(routesOf(name)[0].path)} className={name === group ? "active" : undefined} aria-current={name === group ? "page" : undefined}>
                {name}
              </a>
            ))}
          </nav>
          <div className="header-tools">
            {!landing && <PointsPill />}
            <ModeSwitch />
            {mode === "demo" ? (
              <DemoBalance />
            ) : (
              <>
                <ChainSelect />
                <WalletMenu />
              </>
            )}
            <SoundToggle />
            <button
              type="button"
              className="icon-btn theme-toggle"
              onClick={toggle}
              aria-label={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </div>
        {!landing && (
          <div className="header-row header-sub">
            {subRoutes.length > 1 ? (
              <nav className="sub-nav" aria-label={`${group} pages`}>
                {subRoutes.map((sub) => (
                  <a key={sub.path} href={href(sub.path)} className={sub.path === route.path ? "active" : undefined} aria-current={sub.path === route.path ? "page" : undefined}>
                    {sub.label}
                  </a>
                ))}
              </nav>
            ) : (
              <span />
            )}
            {deployment &&
              (demo ? (
                <span className="pill muted">Demo collection</span>
              ) : (
                <div className="collection-picker">
                  <Field label="Collection">
                    <input
                      value={collectionText}
                      onChange={(e) => setCollectionText(e.target.value)}
                      placeholder="0x… NFT collection address"
                      spellCheck={false}
                      aria-invalid={collectionText !== "" && !collection}
                    />
                  </Field>
                  {deployment.demoCollection && collectionText !== deployment.demoCollection && (
                    <button type="button" className="btn secondary small" onClick={() => setCollectionText(deployment.demoCollection!)}>
                      Use demo
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}
        <FloorLine />
      </header>
      <main id="main" tabIndex={-1} className={landing ? "landing" : undefined}>
        {!landing && <h1 className="page-title">{route.label}</h1>}
        {body}
      </main>
      <footer className="site-footer">
        <TxHistory />
        <p className="muted small">
          FloorGuard is unaudited, experimental software. Nothing here is financial or legal advice, and nothing here
          is an investment. Games, lotteries and paid raffles are regulated or prohibited in many places. Play only
          with what you can afford to lose, and stop when it stops being fun.
        </p>
      </footer>
    </>
  );
}
