// Shared by the tests that run against a local anvil chain (anvil.test.ts, parity.anvil.test.ts):
// the client, the deployment, and the way src/tx.tsx sends a transaction.
import { createTestClient, http, publicActions, walletActions, type Abi, type Address, type TransactionReceipt } from "viem";
import { anvil } from "viem/chains";
import { expect } from "vitest";
import { errorsAbi } from "../src/generated/abis";
import { deployments } from "../src/deployments";
import type { Call } from "../src/lib/calls";
import { decodeError, type DecodedError } from "../src/lib/errors";
import { gasLimitFor } from "../src/lib/gas";
import { readIsDeployed } from "../src/lib/reads";

export const client = createTestClient({
  mode: "anvil",
  chain: anvil,
  transport: http(process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545"),
  // anvil mines instantly; do not wait viem's default 4s between receipt polls.
  pollingInterval: 50,
})
  .extend(publicActions)
  .extend(walletActions);

export const deployment = deployments[anvil.id];
const reachable = await client.getChainId().then(
  (id) => id === anvil.id,
  () => false,
);
/** True when anvil answers and holds a deployed and seeded protocol. */
export const ready = reachable && !!deployment?.demoCollection && (await readIsDeployed(client, deployment));

export const DAY = 86_400;

/** Mirrors the `send` step of src/tx.tsx: simulate with the merged error ABI, then send with the app's gas margin. */
export async function send(account: Address, call: Call): Promise<TransactionReceipt> {
  const request = { ...call, abi: [...call.abi, ...errorsAbi] as Abi, account };
  await client.simulateContract(request);
  const gas = gasLimitFor(await client.estimateContractGas(request));
  const hash = await client.writeContract({ ...request, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    // say why: replay the call on the state just before its block
    const reason = await client.simulateContract({ ...request, blockNumber: receipt.blockNumber - 1n }).then(
      () => "the replay on the previous block succeeds",
      (error) => decodeError(error).message,
    );
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    throw new Error(`${call.functionName} was mined but reverted (block ${receipt.blockNumber} at ${block.timestamp}, gas ${receipt.gasUsed}): ${reason}`);
  }
  expect(receipt.status).toBe("success");
  return receipt;
}

/** Simulates a call that must revert and returns what the UI would show. */
export async function revertOf(account: Address, call: Call): Promise<DecodedError> {
  try {
    await client.simulateContract({ ...call, abi: [...call.abi, ...errorsAbi] as Abi, account });
  } catch (error) {
    return decodeError(error);
  }
  throw new Error(`${call.functionName} was expected to revert`);
}

/** A call the UI has no button for (owner settings, mocks), built from a generated ABI. */
export const raw = (address: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[] = [], value?: bigint): Call => ({
  address,
  abi: abi as Abi,
  functionName,
  args,
  value,
});

/** Mine a block at exactly `timestamp`. */
export async function warpTo(timestamp: number) {
  await client.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  await client.mine({ blocks: 1 });
}

export async function timeOf(receipt: TransactionReceipt): Promise<number> {
  return Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
}

/** ETH an account gained over a transaction it sent itself, the gas it paid added back. */
export async function gained(account: Address, before: bigint, receipt: TransactionReceipt): Promise<bigint> {
  return (await client.getBalance({ address: account })) - before + receipt.gasUsed * receipt.effectiveGasPrice;
}
