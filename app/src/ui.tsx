import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { decodeError } from "./lib/errors";
import { shortAddress } from "./lib/format";
import { useTx } from "./tx";

export function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Addr({ address }: { address: string }) {
  return (
    <code className="addr" title={address}>
      {shortAddress(address)}
    </code>
  );
}

export function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "muted"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Renders the loading and error states of a query, and its data once there is some. */
export function QueryView<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <p className="error">Could not load: {decodeError(query.error).message}</p>;
  return <p className="muted">Loading…</p>;
}

/**
 * Button for a transaction. Disabled without a wallet or while another action is in flight;
 * `blocked` is a reason the action is not available right now (shown as a tooltip).
 */
export function ActionButton({
  blocked,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { blocked?: string | false }) {
  const { isConnected } = useAccount();
  const { busy } = useTx();
  const reason = !isConnected ? "Connect a wallet first" : busy ? "Another action is in progress" : blocked || undefined;
  return (
    <button {...props} disabled={!!reason || props.disabled} title={reason}>
      {children}
    </button>
  );
}
