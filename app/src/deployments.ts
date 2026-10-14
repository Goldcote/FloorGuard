// The deployments the app knows: the public chains from the checked-in generated/addresses.ts, plus
// the local anvil chain when local development is enabled in this build (see local.ts).
import { deployments as publicDeployments, type Deployment } from "./generated/addresses";
import { LOCAL_CHAIN_ID, localDeployment } from "./local";

export const deployments: Partial<Record<number, Deployment>> = localDeployment ? { ...publicDeployments, [LOCAL_CHAIN_ID]: localDeployment } : publicDeployments;
