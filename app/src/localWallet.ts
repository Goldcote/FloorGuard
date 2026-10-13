// LOCAL DEVELOPMENT ONLY. A wagmi connector that acts as one of anvil's unlocked accounts.
//
// It holds no keys. Transactions go to the local node as `eth_sendTransaction`, which anvil signs
// with its own unlocked dev accounts; the account addresses are read from the node (`eth_accounts`).
// It refuses to connect unless the node it talks to reports chain id 31337, and it cannot switch to
// any other chain, so it cannot be used against a public network.
import { getAddress, http, numberToHex, SwitchChainError, type Address, type EIP1193RequestFn } from "viem";
import { createConnector } from "wagmi";
import { anvil } from "wagmi/chains";

export const LOCAL_WALLET_ID = "localTestAccount";
/** anvil accounts #0..#3 are offered. #0 is the deployer and protocol owner after the seed script. */
export const LOCAL_ACCOUNT_COUNT = 4;

type Provider = { request: EIP1193RequestFn };

let accountIndex = 0;
let onAccountSelected: (() => void) | undefined;

export function getLocalAccountIndex(): number {
  return accountIndex;
}

/** Choose which unlocked anvil account the connector acts as. Takes effect immediately if connected. */
export function selectLocalAccount(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= LOCAL_ACCOUNT_COUNT) return;
  accountIndex = index;
  onAccountSelected?.();
}

export function localTestAccount(rpcUrl: string) {
  let connected = false;

  return createConnector<Provider>((config) => {
    const node = http(rpcUrl)({ chain: anvil, retryCount: 0 });
    const nodeRequest = (method: string, params?: unknown) => node.request({ method, params });

    const assertLocalNode = async () => {
      const chainId = Number(await nodeRequest("eth_chainId"));
      if (chainId !== anvil.id) {
        throw new Error(`The local test account only works on anvil (chain ${anvil.id}); the node reports chain ${chainId}.`);
      }
    };

    const currentAccount = async (): Promise<Address> => {
      const unlocked = (await nodeRequest("eth_accounts")) as Address[];
      const account = unlocked[accountIndex];
      if (!account) throw new Error(`The local node has no unlocked account #${accountIndex}.`);
      return getAddress(account);
    };

    const provider: Provider = {
      request: (async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case "eth_requestAccounts":
            return [await currentAccount()];
          case "eth_accounts":
            return connected ? [await currentAccount()] : [];
          case "eth_chainId":
            return numberToHex(anvil.id);
          case "wallet_switchEthereumChain": {
            const requested = Number((params as [{ chainId: string }])[0].chainId);
            if (requested !== anvil.id) {
              throw new SwitchChainError(new Error("The local test account only works on the local anvil chain."));
            }
            return null;
          }
          default:
            // Everything else, including eth_sendTransaction, is answered by the node itself.
            return nodeRequest(method, params);
        }
      }) as EIP1193RequestFn,
    };

    onAccountSelected = () => {
      if (!connected) return;
      void currentAccount().then(
        (account) => config.emitter.emit("change", { accounts: [account] }),
        () => config.emitter.emit("disconnect"),
      );
    };

    return {
      id: LOCAL_WALLET_ID,
      name: "Local test account",
      type: "localTest",
      async connect({ chainId } = {}) {
        if (chainId !== undefined && chainId !== anvil.id) {
          throw new SwitchChainError(new Error("The local test account only works on the local anvil chain."));
        }
        await assertLocalNode();
        const account = await currentAccount();
        connected = true;
        return { accounts: [account] as never, chainId: anvil.id };
      },
      async disconnect() {
        connected = false;
      },
      async getAccounts() {
        return connected ? [await currentAccount()] : [];
      },
      async getChainId() {
        return anvil.id;
      },
      async getProvider() {
        return provider;
      },
      // Never reconnects by itself after a reload: using it is always an explicit choice.
      async isAuthorized() {
        return false;
      },
      async switchChain({ chainId }) {
        if (chainId !== anvil.id) {
          throw new SwitchChainError(new Error("The local test account only works on the local anvil chain."));
        }
        return anvil;
      },
      onAccountsChanged(accounts) {
        if (accounts.length === 0) this.onDisconnect();
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged() {},
      onDisconnect() {
        connected = false;
        config.emitter.emit("disconnect");
      },
    };
  });
}
