import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Abi, Hash } from "viem";
import { useAccount, useChainId, useChains, useConfig, useSwitchChain } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { errorsAbi } from "./generated/abis";
import type { Call } from "./lib/calls";
import { decodeError } from "./lib/errors";
import { demoWrite } from "./demo/sim";
import { QUERY_ROOT, useProtocol } from "./hooks";
import { Modal } from "./ui";

/** How long the dialog shows a confirmation before closing by itself. */
const SUCCESS_VISIBLE_MS = 1_600;

type Status = "review" | "preparing" | "wallet" | "confirming" | "success" | "error";

export type TxEntry = {
  id: number;
  /** The user-level action, e.g. "Accept offer #3". */
  title: string;
  /** What will happen, shown before anything is signed: amounts, who receives what, approval steps. */
  details: readonly string[];
  /** An optional picture of the same thing (who receives what), shown above the details in the review. */
  preview?: ReactNode;
  /** The transaction currently in flight within the action, e.g. "Approve marketplace". */
  step?: string;
  status: Status;
  hash?: Hash;
  error?: string;
};

/** Sends one transaction as a step of the running action and resolves once it is mined. */
export type Send = (step: string, call: Call) => Promise<void>;

type TxContextValue = {
  /** True from the moment an action is opened for review until it has finished. */
  busy: boolean;
  /** The latest finished actions, newest first. */
  history: TxEntry[];
  /**
   * Review, then run, an action of one or more transactions. `details` is what the user reads before
   * confirming. Never throws: a failure is shown in the dialog.
   */
  run: (title: string, action: (send: Send) => Promise<void>, details?: readonly string[], options?: { quickInDemo?: boolean; preview?: ReactNode }) => Promise<void>;
};

const TxContext = createContext<TxContextValue | null>(null);

const STATUS_TEXT: Record<Exclude<Status, "review">, string> = {
  preparing: "Checking…",
  wallet: "Waiting for your wallet…",
  confirming: "Waiting for confirmation…",
  success: "Confirmed",
  error: "Failed",
};

export function TxProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const chainId = useChainId();
  const chains = useChains();
  const account = useAccount();
  const { demo, user } = useProtocol();
  const { switchChainAsync } = useSwitchChain();
  const [current, setCurrent] = useState<TxEntry>();
  const [history, setHistory] = useState<TxEntry[]>([]);
  const nextId = useRef(1);
  const decision = useRef<(confirmed: boolean) => void>();

  const chainName = chains.find((chain) => chain.id === chainId)?.name ?? `chain ${chainId}`;

  const run = useCallback<TxContextValue["run"]>(
    async (title, action, details = [], options = {}) => {
      const id = nextId.current++;
      if (demo && options.quickInDemo) {
        // A demo bet: nothing is signed, and the cost is on screen next to the button, so the game
        // is not interrupted by a dialog. A refusal is still shown.
        try {
          await action(async (_step, call) => {
            await demoWrite(call);
            await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
          });
        } catch (error) {
          setCurrent({ id, title, details: [], status: "error", error: decodeError(error).message });
        }
        return;
      }
      let entry: TxEntry = { id, title, details, preview: options.preview, status: "review" };
      const update = (patch: Partial<TxEntry>) => {
        entry = { ...entry, ...patch };
        setCurrent(entry);
      };
      setCurrent(entry);

      const confirmed = await new Promise<boolean>((resolve) => {
        decision.current = resolve;
      });
      if (!confirmed) {
        setCurrent(undefined);
        return;
      }

      const send: Send = async (step, call) => {
        if (demo) {
          // Demo mode: nothing is signed or sent; the simulated protocol applies the same call.
          update({ step, status: "confirming", hash: undefined });
          await demoWrite(call);
          await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
          return;
        }
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
        update({ status: "preparing" });
        await action(send);
        update({ status: "success" });
        setTimeout(() => setCurrent((shown) => (shown?.id === id ? undefined : shown)), SUCCESS_VISIBLE_MS);
      } catch (error) {
        console.error(error);
        update({ status: "error", error: decodeError(error).message });
      }
      setHistory((list) => [entry, ...list].slice(0, 5));
    },
    [account.address, account.chainId, chainId, config, demo, queryClient, switchChainAsync],
  );

  const busy = !!current && current.status !== "success" && current.status !== "error";
  const value = useMemo(() => ({ busy, history, run }), [busy, history, run]);
  const inFlight = !!current && (current.status === "preparing" || current.status === "wallet" || current.status === "confirming");

  const close = () => {
    if (current?.status === "review") decision.current?.(false);
    else setCurrent(undefined);
  };

  const stage = current?.status === "preparing" ? 0 : current?.status === "wallet" ? 1 : 2;
  const eyebrow = !current
    ? undefined
    : current.status === "review"
      ? demo
        ? "Review · demo, nothing is signed"
        : "Review before signing"
      : current.status === "success"
        ? "Done"
        : current.status === "error"
          ? "Not done"
          : "In progress";

  return (
    <TxContext.Provider value={value}>
      {children}
      <Modal open={!!current} onClose={close} title={current?.title ?? ""} dismissible={!inFlight} className="tx-modal" eyebrow={eyebrow}>
        {current && (
          <div className={`tx-dialog tx-${current.status}`}>
            {current.status === "review" && current.preview && <div className="tx-preview">{current.preview}</div>}
            {current.details.length > 0 && current.status !== "success" && (
              <ol className="tx-details">
                {current.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            )}
            {current.status === "review" ? (
              <>
                <p className={demo ? "tx-context demo-note small" : "tx-context muted small"}>
                  {demo
                    ? "Demo: simulated in this browser with play money. Nothing is signed or sent."
                    : `On ${chainName}, from ${user ?? "your wallet"}. The transaction is simulated first; if it would fail you will see why before anything is signed.`}
                </p>
                <div className="modal-actions">
                  <button type="button" className="btn secondary" onClick={() => decision.current?.(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn tx-confirm" autoFocus onClick={() => decision.current?.(true)}>
                    Confirm
                  </button>
                </div>
              </>
            ) : (
              <>
                {inFlight && !demo && (
                  <ol className="tx-track" aria-hidden="true">
                    {["Check", "Wallet", "Chain"].map((name, i) => (
                      <li key={name} className={i < stage ? "done" : i === stage ? "now" : undefined}>
                        {name}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="tx-status" role="status" aria-live="polite">
                  {inFlight && <span className="spinner" aria-hidden="true" />}
                  {current.status === "success" && (
                    <svg className="tx-seal" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
                      <circle cx="22" cy="22" r="19" />
                      <path d="m13.500 22.500 6 6 11-12.500" />
                    </svg>
                  )}
                  <strong>{demo && current.status === "confirming" ? "Applying to the simulation…" : STATUS_TEXT[current.status]}</strong>
                  {current.step && current.status !== "success" && <span className="muted">{current.step}</span>}
                </div>
                {current.error && (
                  <p className="tx-message" role="alert">
                    {current.error}
                  </p>
                )}
                {current.hash && <code className="tx-hash">{current.hash}</code>}
                {!inFlight && (
                  <div className="modal-actions">
                    <button type="button" className="btn secondary" autoFocus onClick={close}>
                      Close
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </TxContext.Provider>
  );
}

export function useTx(): TxContextValue {
  const value = useContext(TxContext);
  if (!value) throw new Error("useTx must be used inside TxProvider");
  return value;
}

/** The last few actions and how they ended, in normal page flow so it never covers a control. */
export function TxHistory() {
  const { history } = useTx();
  if (history.length === 0) return null;
  return (
    <details className="tx-history">
      <summary>
        Recent transactions ({history.length}): last one {history[0].status === "success" ? "confirmed" : "failed"}
      </summary>
      <ul>
        {history.map((entry) => (
          <li key={entry.id}>
            <span className={entry.status === "success" ? "ok" : "error"}>{entry.status === "success" ? "Confirmed" : "Failed"}</span>{" "}
            {entry.title}
            {entry.error && <span className="muted">: {entry.error}</span>}
            {entry.hash && <code className="tx-hash">{entry.hash}</code>}
          </li>
        ))}
      </ul>
    </details>
  );
}
