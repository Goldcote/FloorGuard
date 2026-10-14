// DEVELOPMENT ONLY. Loaded from main.tsx when the dev server is opened with `?mock-wallets` in the URL;
// never part of a production build.
//
// Announces two fake browser wallets over EIP-6963, named and identified like Rabby and MetaMask, so
// the wallet menu can be exercised without installing extensions. Each proxies to one of anvil's
// unlocked accounts. They are NOT the real wallets and prove nothing about them.
const RPC = "http://127.0.0.1:8545";

type Listener = (payload: unknown) => void;

function icon(letter: string, color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-size="18" text-anchor="middle" fill="#fff" font-family="sans-serif">${letter}</text></svg>`)}`;
}

function createMock(key: string, name: string, rdns: string, accountIndex: number, flags: Record<string, boolean>, color: string) {
  const store = `fg.mock.${key}`;
  const listeners = new Map<string, Set<Listener>>();
  let chainId = "0x7a69";
  let index = accountIndex;
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((fn) => fn(payload));
  const node = async (method: string, params: unknown = []) => {
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = await response.json();
    if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code, data: json.error.data });
    return json.result;
  };
  const account = async () => ((await node("eth_accounts")) as string[])[index];
  const connected = () => sessionStorage.getItem(store) === "1";

  const provider = {
    ...flags,
    on: (event: string, fn: Listener) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn),
    removeListener: (event: string, fn: Listener) => void listeners.get(event)?.delete(fn),
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_requestAccounts":
          if (sessionStorage.getItem(`${store}.reject`) === "1") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          sessionStorage.setItem(store, "1");
          return [await account()];
        case "eth_accounts":
          return connected() ? [await account()] : [];
        case "eth_chainId":
          return chainId;
        case "wallet_revokePermissions":
          sessionStorage.removeItem(store);
          return null;
        case "wallet_switchEthereumChain": {
          const target = (params as [{ chainId: string }])[0].chainId;
          // Like a real wallet that only knows the local chain: anything else must be added first.
          if (target !== "0x7a69" && sessionStorage.getItem(`${store}.added.${target}`) !== "1") throw Object.assign(new Error("Unrecognized chain."), { code: 4902 });
          chainId = target;
          emit("chainChanged", chainId);
          return null;
        }
        case "wallet_addEthereumChain": {
          const target = (params as [{ chainId: string }])[0].chainId;
          sessionStorage.setItem(`${store}.added.${target}`, "1");
          chainId = target;
          emit("chainChanged", chainId);
          return null;
        }
        default:
          return node(method, params);
      }
    },
  };
  const controls = {
    /** As if the user picked another account in the wallet. */
    async switchAccount(next: number) {
      index = next;
      emit("accountsChanged", [await account()]);
    },
    /** As if the user picked another network in the wallet. */
    switchChain(hex: string) {
      chainId = hex;
      emit("chainChanged", hex);
    },
    lock() {
      sessionStorage.removeItem(store);
      emit("accountsChanged", []);
    },
    rejectNextConnect(on: boolean) {
      if (on) sessionStorage.setItem(`${store}.reject`, "1");
      else sessionStorage.removeItem(`${store}.reject`);
    },
  };
  const detail = Object.freeze({ info: { uuid: `mock-${key}`, name, icon: icon(name[0], color), rdns }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  return controls;
}

export function installMockWallets() {
  const params = new URLSearchParams(window.location.search);
  const mocks: Record<string, ReturnType<typeof createMock>> = {
    // announced MetaMask first on purpose: the menu must still put Rabby first
    metamask: createMock("metamask", "MetaMask", "io.metamask", 5, { isMetaMask: true }, "#e2761b"),
    rabby: createMock("rabby", "Rabby Wallet", "io.rabby", 4, { isRabby: true, isMetaMask: true }, "#7084ff"),
  };
  // `?mock-wallets=impersonate`: Rabby also announces a MetaMask-branded entry backed by itself.
  if (params.get("mock-wallets") === "impersonate") {
    mocks.fakeMetaMask = createMock("fakemm", "MetaMask", "io.metamask.flask", 4, { isRabby: true, isMetaMask: true }, "#e2761b");
  }
  (window as unknown as { __mockWallets: typeof mocks }).__mockWallets = mocks;
}
