// LOCAL DEVELOPMENT MACHINERY, in one place: the anvil chain, the local test account, the probe of
// 127.0.0.1 on a first visit, the mock-settle buttons and the local deployment's addresses.
//
// All of it is off in a production build unless it was built with VITE_ENABLE_LOCAL=1. Both sides of
// the test below are known at build time, so the bundler drops the code behind it: a production
// build makes no request to a loopback address and carries none of this.
import type { Deployment } from "./generated/addresses";

export const LOCAL_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_ENABLE_LOCAL === "1";

/**
 * A build for hosting the demo alone ("1" in VITE_DEMO_ONLY): no Live mode, no wallet connectors and
 * no wallet discovery, so the site never asks a wallet for anything. For hosts that cannot send the
 * security headers a live build needs, or that share their origin with other sites.
 */
export const DEMO_ONLY: boolean = import.meta.env?.VITE_DEMO_ONLY === "1" && !LOCAL_ENABLED;
export const LOCAL_CHAIN_ID = 31337;

/** Whether `chainId` is the local anvil chain and local development is enabled in this build. */
export const isLocalChain = (chainId: number): boolean => LOCAL_ENABLED && chainId === LOCAL_CHAIN_ID;

// The file exists only after `npm run sync -- --local`; the glob matches nothing otherwise.
const localFiles = LOCAL_ENABLED ? import.meta.glob<{ localDeployment?: Deployment }>("./generated/addresses.local.ts", { eager: true }) : {};

/** The local chain's deployment, if this build has local development enabled and one was synced. */
export const localDeployment: Deployment | undefined = Object.values(localFiles)[0]?.localDeployment;
