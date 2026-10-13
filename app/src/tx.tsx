import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Abi, Hash } from "viem";
import { useAccount, useChainId, useConfig, useSwitchChain } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { errorsAbi } from "./generated/abis";
import type { Call } from "./lib/calls";
import { decodeError } from "./lib/errors";
import { QUERY_ROOT } from "./hooks";

/** How long a confirmed action stays in the panel. */
const SUCCESS_VISIBLE_MS = 6_000;

type Status = "preparing" | "wallet" | "confirming" | "success" | "error";

export type TxEntry = {
  id: number;
  /** The user-level action, e.g. "Accept offer #3". */
  title: string;
  /** The transaction currently in flight within the action, e.g. "Approve marketplace". */
  step?: string;
  status: Status;
  hash?: Hash;
  error?: string;
};

/** Sends one transaction as a step of the running action and resolves once it is mined. */
export type Send = (step: string, call: Call) => Promise<void>;

type TxContextValue = {
  entries: TxEntry[];
  /** True while an action is in flight; action buttons disable themselves. */
  busy: boolean;
  /** Run an action of one or more transactions. Never throws: failures land in `entries`. */
  run: (title: string, action: (send: Send) => Promise<void>) => Promise<void>;
  dismiss: (id: number) => void;
};

const TxContext = createContext<TxContextValue | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const chainId = useChainId();
  const account = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [entries, setEntries] = useState<TxEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);

  const run = useCallback<TxContextValue["run"]>(
    async (title, action) => {
      const id = nextId.current++;
      const update = (patch: Partial<TxEntry>) =>
        setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
      setEntries((list) => [{ id, title, status: "preparing" as const }, ...list].slice(0, 4));
      setBusy(true);

      const send: Send = async (step, call) => {
        if (!account.address) throw new Error("Connect a wallet first.");
        update({ step, status: "preparing", hash: undefined });
        if (account.chainId !== chainId) await switchChainAsync({ chainId });

        const request = {
          address: call.address,
          // Errors of nested contracts (Treasury, Vault, oracles, the NFT) decode by name too.
          abi: [...call.abi, ...errorsAbi] as Abi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
          account: account.address,
          chainId,
        };
        // Simulating first surfaces a revert, with its decoded custom error, before the wallet opens.
        await simulateContract(config, request);
        update({ status: "wallet" });
        const hash = await writeContract(config, request);
        update({ status: "confirming", hash });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId });
        if (receipt.status !== "success") throw new Error("The transaction was mined but reverted.");
        await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
      };

      try {
        await action(send);
        update({ status: "success" });
        // The panel floats over the page; a confirmation must not keep covering the buttons under
        // it. Failures stay until dismissed.
        setTimeout(() => setEntries((list) => list.filter((entry) => entry.id !== id)), SUCCESS_VISIBLE_MS);
      } catch (error) {
        console.error(error);
        update({ status: "error", error: decodeError(error).message });
      } finally {
        setBusy(false);
      }
    },
    [account.address, account.chainId, chainId, config, queryClient, switchChainAsync],
  );

  const dismiss = useCallback((id: number) => setEntries((list) => list.filter((e) => e.id !== id)), []);
  const value = useMemo(() => ({ entries, busy, run, dismiss }), [entries, busy, run, dismiss]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

export function useTx(): TxContextValue {
  const value = useContext(TxContext);
  if (!value) throw new Error("useTx must be used inside TxProvider");
  return value;
}

const STATUS_TEXT: Record<Status, string> = {
  preparing: "Preparing…",
  wallet: "Confirm in your wallet…",
  confirming: "Waiting for confirmation…",
  success: "Confirmed",
  error: "Failed",
};

/** Fixed panel listing the latest actions with their pending / success / error state. */
export function TxPanel() {
  const { entries, dismiss } = useTx();
  if (entries.length === 0) return null;
  return (
    <div className="tx-panel" aria-live="polite">
      {entries.map((entry) => (
        <div key={entry.id} className={`tx tx-${entry.status}`}>
          <div className="tx-head">
            <strong>{entry.title}</strong>
            <button className="link" onClick={() => dismiss(entry.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
          <div className="tx-status">
            {entry.status !== "success" && entry.status !== "error" && <span className="spinner" />}
            {STATUS_TEXT[entry.status]}
            {entry.step && entry.status !== "success" ? ` (${entry.step})` : ""}
          </div>
          {entry.error && <div className="tx-message">{entry.error}</div>}
          {entry.hash && <code className="tx-hash">{entry.hash}</code>}
        </div>
      ))}
    </div>
  );
}
