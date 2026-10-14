import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import type { Address } from "viem";
import { FloorLine, Logo, NavIcon, Wordmark } from "./brand";
import { getMode, modeWasChosen, setMode, useMode } from "./demo/mode";
import { DEMO_CHAIN_ID, demoReads, resetDemo } from "./demo/sim";
import { DICE_REVEAL_MS, SLOTS_REVEAL_MS } from "./fx/gameviz";
import { observeReveal, useRevealClock } from "./fx/reveal";
import { deployments } from "./deployments";
import { LOCAL_CHAIN_ID, LOCAL_ENABLED } from "./local";
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
  "/play/house": page(() => import("./tabs/House"), "House"),
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

/**
 * The play balance. A bet's payout reaches the simulated balance the instant it settles, a second or
 * two before the game stage has finished showing the result, so the figure here waits for the same
 * reveal clock the stages use (src/fx/reveal.ts) and never gives a result away early.
 */
function DemoBalance() {
  // one read for both, so the balance and the bets it depends on are always from the same moment
  const query = useRead(["demoBalance"], async () => ({ balance: demoReads.balance(), bets: demoReads.userBets().slice(0, 6) }));
  useRevealClock();
  const revealing = (query.data?.bets ?? []).some(
    (bet) =>
      observeReveal(`bet:${DEMO_CHAIN_ID}:${bet.requestId}`, bet.status === "pending" ? "pending" : bet.status === "won" || bet.status === "lost" ? "settled" : "other", bet.kind === "slots" ? SLOTS_REVEAL_MS : DICE_REVEAL_MS) === "revealing",
  );
  const shown = useRef<bigint>();
  if (query.data && !revealing) shown.current = query.data.balance;
  return (
    <span className="pill balance-pill" title="Play money. It has no value and cannot be withdrawn.">
      <strong>{shown.current !== undefined ? eth(shown.current, 4) : "…"}</strong> play ETH
      <button type="button" className="link-btn" onClick={() => resetDemo()} title="Start the demo over">
        reset
      </button>
    </span>
  );
}

/** The section links, with an ink line that slides under the current one. */
function PrimaryNav({ group }: { group: Group }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>("a.active");
      nav.style.setProperty("--ink-x", `${active ? active.offsetLeft : 0}px`);
      nav.style.setProperty("--ink-w", `${active ? active.offsetWidth : 0}px`);
    };
    place();
    window.addEventListener("resize", place);
    // the display font arrives after first paint and changes the link widths
    void document.fonts?.ready.then(place);
    return () => window.removeEventListener("resize", place);
  }, [group]);
  return (
    <nav className="primary-nav" aria-label="Sections" ref={ref}>
      {GROUPS.map((name) => (
        <a key={name} href={href(routesOf(name)[0].path)} className={name === group ? "active" : undefined} aria-current={name === group ? "page" : undefined}>
          <NavIcon name={name} />
          <span>{name}</span>
        </a>
      ))}
      <i className="nav-ink" aria-hidden="true" />
    </nav>
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
  const soundOn = useSyncExternalStore(subscribeSound, soundEnabled);
  const [collectionText, setCollectionText] = useState<string>(deployment?.demoCollection ?? "");
  useDemoSync();

  // First visit with no choice made: if a local chain with a deployment answers, start live;
  // otherwise stay in the demo, which needs nothing.
  useEffect(() => {
    // Local development only (see local.ts): a production build never asks a loopback address anything.
    if (!LOCAL_ENABLED || modeWasChosen()) return;
    const local = deployments[LOCAL_CHAIN_ID];
    if (!local) return;
    const client = config.getClient({ chainId: LOCAL_CHAIN_ID });
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
    document.title = route.path === "/" ? "FloorGuard: fees that buy the floor" : `${route.label} · FloorGuard`;
    window.scrollTo(0, 0);
  }, [route]);

  const collection = parseAddress(collectionText);
  const landing = route.path === "/";
  const group = route.group as Group;
  const subRoutes = landing ? [] : routesOf(group as Exclude<Group, "Home">);
  const Current = PAGES[route.path];
  const ownHead = "ownHead" in route;

  let body;
  if (landing) {
    body = (
      <Suspense fallback={<div className="landing-fallback" aria-busy="true" />}>
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
          <code>script/Deploy.s.sol</code>, run <code>npm run sync</code> in <code>app/</code> (with <code>-- --local</code> for a local chain), then reload. Or pick
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
        {LOCAL_ENABLED && (
          <p className="muted">
            On a local chain this usually means anvil was restarted. Run <code>script/Deploy.s.sol</code> (and{" "}
            <code>script/SeedLocal.s.sol</code>) again, then <code>npm run sync -- --local</code>.
          </p>
        )}
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

  const themeLabel = `Switch to the ${theme === "dark" ? "light" : "dark"} theme`;
  const soundLabel = soundOn ? "Turn sound off" : "Turn sound on";

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {/* One slim rail carries both standing notices. They are never hidden, at any width. */}
      <div className={demo || landing ? "banners rail two" : "banners rail"}>
        <div className="banner" role="alert">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 2.500 20h19L12 3Z" />
            <path d="M12 10v4.500M12 17.500v.01" />
          </svg>
          <span>Unaudited experimental software. Do not use with real funds.</span>
        </div>
        {(demo || landing) && (
          <div className="banner demo" role="status">
            <span>
              Demo: simulated, no real transactions, play money.<span className="rail-extra"> Simulated time runs fast.</span>
            </span>
          </div>
        )}
      </div>
      <header className={landing ? "site-header on-landing" : "site-header"}>
        <div className="header-row header-main">
          <a className="brand" href={href("/")} aria-label="FloorGuard home">
            <Logo />
            <Wordmark />
          </a>
          <PrimaryNav group={group} />
          <div className="header-tools">
            {!landing && <PointsPill />}
            <ModeSwitch />
            {mode === "demo" ? (
              !landing && <DemoBalance />
            ) : (
              <>
                <ChainSelect />
                <WalletMenu />
              </>
            )}
            <span className="tool-icons">
              <SoundToggle />
              <button type="button" className="icon-btn theme-toggle" onClick={toggle} aria-label={themeLabel} title={themeLabel}>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {theme === "dark" ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2.500v2M12 19.500v2M2.500 12h2M19.500 12h2M5.300 5.300l1.400 1.400M17.300 17.300l1.400 1.400M5.300 18.700l1.400-1.400M17.300 6.700l1.400-1.400" />
                    </>
                  ) : (
                    <path d="M20 14.500A8 8 0 0 1 9.500 4 8 8 0 1 0 20 14.500Z" />
                  )}
                </svg>
              </button>
            </span>
            {/* On a phone the two icon buttons fold into one menu, so the header stays one row. */}
            <details className="more-menu">
              <summary className="icon-btn" aria-label="More settings">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <circle cx="5" cy="12" r="1.800" />
                  <circle cx="12" cy="12" r="1.800" />
                  <circle cx="19" cy="12" r="1.800" />
                </svg>
              </summary>
              <div className="more-pop">
                <button type="button" onClick={toggle}>
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </button>
                <button type="button" aria-pressed={soundOn} onClick={() => setSound(!soundOn)}>
                  {soundLabel}
                </button>
                {demo && (
                  <button type="button" onClick={() => resetDemo()}>
                    Reset the demo
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
        {!landing && (
          <div className={subRoutes.length > 1 || !demo ? "header-row header-sub" : "header-row header-sub solo"}>
            {subRoutes.length > 1 ? (
              <nav className="sub-nav" aria-label={`${group} pages`}>
                {subRoutes.map((sub) => (
                  <a key={sub.path} href={href(sub.path)} className={sub.path === route.path ? "active" : undefined} aria-current={sub.path === route.path ? "page" : undefined}>
                    {sub.label}
                  </a>
                ))}
              </nav>
            ) : (
              <span className="sub-nav-none" />
            )}
            {deployment &&
              (demo ? (
                <>
                  <span className="pill muted demo-collection">Demo collection</span>
                  <DemoBalance />
                </>
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
        {/* Keyed by route: each page arrives with a short rise, and leaves no state behind. */}
        <div className="route-view" key={route.path}>
          {!landing && !ownHead && <h1 className="page-title">{route.label}</h1>}
          {body}
        </div>
      </main>
      <footer className="site-footer">
        <TxHistory />
        <div className="footer-brand">
          <Logo size={22} />
          <Wordmark />
          <span className="muted small">Fees that buy the floor.</span>
        </div>
        <p className="muted small">
          FloorGuard is unaudited, experimental software. Nothing here is financial or legal advice, and nothing here
          is an investment. Games, lotteries and paid raffles are regulated or prohibited in many places. Play only
          with what you can afford to lose, and stop when it stops being fun.
        </p>
      </footer>
      {/* Phones get the sections as a thumb-reach bar instead of a second header row. */}
      <nav className="tab-bar" aria-label="Sections">
        {GROUPS.map((name) => (
          <a key={name} href={href(routesOf(name)[0].path)} className={name === group ? "active" : undefined} aria-current={name === group ? "page" : undefined}>
            <NavIcon name={name} size={22} />
            <span>{name}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
