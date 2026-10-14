import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { encodeFunctionData, type Abi, type Hash } from "viem";
import { useAccount, useChainId, useChains, useConfig, useSwitchChain } from "wagmi";
import { estimateGas, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { errorsAbi } from "./generated/abis";
import type { Call } from "./lib/calls";
import { decodeError } from "./lib/errors";
import { gasLimitFor } from "./lib/gas";
import { summariseCall, type CallSummary } from "./lib/review";
import { demoWrite } from "./demo/sim";
import { QUERY_ROOT, useProtocol } from "./hooks";
import { playMoney } from "./lib/format";
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
  /**
   * The transactions the action will send, in the wallet's terms (contract, function, value, who is
   * approved), so the review can be compared with what the wallet then shows.
   */
  plan?: readonly (CallSummary & { step: string })[];
  /** The transaction currently in flight within the action, e.g. "Approve marketplace", and what it is. */
  step?: string;
  sending?: CallSummary;
  status: Status;
  hash?: Hash;
  error?: string;
};

/** Sends one transaction as a step of the running action and resolves once it is mined. */
export type Send = (step: string, call: Call) => Promise<void>;

/** A transaction an action expects to send, known when the review opens. */
export type Planned = { step: string; call: Call };
export type Action = ((send: Send) => Promise<void>) & { plan?: readonly Planned[] };

/** An action of exactly one transaction. Its review shows what that transaction is. */
export const single = (step: string, call: Call): Action => Object.assign((send: Send) => send(step, call), { plan: [{ step, call }] });

/** Thrown by an action when what was reviewed no longer holds: nothing is sent and the visitor reviews again. */
export class ReviewAgain extends Error {}

type TxContextValue = {
  /** True from the moment an action is opened for review until it has finished. */
  busy: boolean;
  /** The latest finished actions, newest first. */
  history: TxEntry[];
  /**
   * Review, then run, an action of one or more transactions. `details` is what the user reads before
   * confirming. Never throws: a failure is shown in the dialog.
   */
  run: (
    title: string,
    action: Action,
    details?: readonly string[],
    /** `plan`: the transactions to show in the review when the action sends more than one (a `single` action carries its own). */
    options?: { quickInDemo?: boolean; preview?: ReactNode; plan?: readonly Planned[] },
  ) => Promise<void>;
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
  const { demo, user, deployment } = useProtocol();
  const { switchChainAsync } = useSwitchChain();
  const [current, setCurrent] = useState<TxEntry>();
  const [history, setHistory] = useState<TxEntry[]>([]);
  const nextId = useRef(1);
  const decision = useRef<(confirmed: boolean) => void>();
  /** The account and chain the open review was written for. */
  const reviewedFor = useRef<{ address: string | undefined; chainId: number }>();

  // A review is for one account on one chain. If either changes while it is open (the wallet
  // switched account, a script or another tab switched chain), it is cancelled: what the dialog
  // says no longer describes what would be signed.
  useEffect(() => {
    const snapshot = reviewedFor.current;
    if (!snapshot || current?.status !== "review") return;
    if (snapshot.address === account.address && snapshot.chainId === chainId) return;
    reviewedFor.current = undefined;
    decision.current?.(false);
    setCurrent({ id: current.id, title: current.title, details: [], status: "error", error: "The connected account or the chain changed while this was open for review, so it was cancelled. Nothing was sent. Start it again to review it for the account and chain you are on now." });
  }, [account.address, chainId, current]);

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
      const planned = options.plan ?? action.plan;
      const plan = planned?.map(({ step, call }) => ({ step, ...summariseCall(call, deployment) }));
      let entry: TxEntry = { id, title, details, preview: options.preview, plan, status: "review" };
      const update = (patch: Partial<TxEntry>) => {
        entry = { ...entry, ...patch };
        setCurrent(entry);
      };
      setCurrent(entry);
      const reviewed = { address: account.address, chainId };
      reviewedFor.current = demo ? undefined : reviewed;

      const confirmed = await new Promise<boolean>((resolve) => {
        decision.current = resolve;
      });
      reviewedFor.current = undefined;
      if (!confirmed) {
        // (a review cancelled because the account or chain changed leaves its notice on screen)
        setCurrent((shown) => (shown?.id === id && shown.status === "review" ? undefined : shown));
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
        update({ step, sending: summariseCall(call, deployment), status: "preparing", hash: undefined });
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
        // A margin over the node's estimate: some paths cost more a block later (see lib/gas.ts).
        // If the estimate cannot be had, the wallet is left to choose the limit.
        const gas = await estimateGas(config, {
          to: call.address,
          data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
          value: call.value,
          account: account.address,
          chainId,
        }).then(gasLimitFor, () => undefined);
        update({ status: "wallet" });
        const hash = await writeContract(config, { ...request, gas });
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
        update({
          status: "error",
          error: error instanceof ReviewAgain ? `${error.message} Nothing was sent. Start it again to review the new figures.` : decodeError(error).message,
        });
      }
      setHistory((list) => [entry, ...list].slice(0, 5));
    },
    [account.address, account.chainId, chainId, config, demo, deployment, queryClient, switchChainAsync],
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
      <Modal open={!!current} onClose={close} title={demo ? playMoney(current?.title ?? "") : (current?.title ?? "")} dismissible={!inFlight} className="tx-modal" eyebrow={eyebrow}>
        {current && (
          <div className={`tx-dialog tx-${current.status}`}>
            {current.status === "review" && current.preview && <div className="tx-preview">{current.preview}</div>}
            {current.details.length > 0 && current.status !== "success" && (
              <ol className="tx-details">
                {current.details.map((line) => (
                  // in the demo every amount is play money, and says so
                  <li key={line}>{demo ? playMoney(line) : line}</li>
                ))}
              </ol>
            )}
            {current.status === "review" && current.plan && current.plan.length > 0 && <CallBlock calls={current.plan} demo={demo} />}
            {current.status !== "review" && current.status !== "success" && current.sending && <CallBlock calls={[{ step: current.step ?? "", ...current.sending }]} demo={false} />}
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
                    {demo ? playMoney(current.error) : current.error}
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

/** The transactions of an action in the wallet's terms: contract, function, value, approved spender. */
function CallBlock({ calls, demo }: { calls: readonly (CallSummary & { step: string })[]; demo: boolean }) {
  return (
    <div className="tx-calls">
      <p className="figure-label">{demo ? "What this would send on a chain" : calls.length > 1 ? "What your wallet will be asked to sign, in order" : "What your wallet will be asked to sign"}</p>
      {calls.map((call, i) => (
        <dl key={`${i}-${call.functionName}`} className="tx-call">
          {calls.length > 1 && (
            <div>
              <dt>Step {i + 1}</dt>
              <dd>{call.step}</dd>
            </div>
          )}
          <div>
            <dt>Contract</dt>
            <dd>
              {call.contractName ?? "Unknown contract"} <code>{call.contract}</code>
            </dd>
          </div>
          <div>
            <dt>Function</dt>
            <dd>
              <code>{call.functionName}</code>
            </dd>
          </div>
          <div>
            <dt>Value</dt>
            <dd>{demo ? playMoney(call.value) : call.value}</dd>
          </div>
          <div>
            <dt>Approved spender</dt>
            <dd>
              {call.approval ? (
                <>
                  {call.approval.spenderName ?? "Unknown contract"} <code>{call.approval.spender}</code>, for {call.approval.scope}
                </>
              ) : (
                "none"
              )}
            </dd>
          </div>
        </dl>
      ))}
    </div>
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
