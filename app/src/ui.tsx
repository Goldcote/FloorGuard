import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { decodeError } from "./lib/errors";
import { dateTime, relative, shortAddress } from "./lib/format";
import { useMode } from "./demo/mode";
import { useTx } from "./tx";

export function Card({
  title,
  children,
  aside,
  className,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `card ${className}` : "card"}>
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

/** A shortened address; click to copy the full one. */
export function Addr({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // clipboard unavailable (insecure context): the title still shows the full address
    }
  };
  return (
    <button type="button" className="addr" title={`${address} (click to copy)`} aria-label={`Copy address ${address}`} onClick={copy}>
      {copied ? "Copied" : shortAddress(address)}
    </button>
  );
}

export function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "muted" | "accent"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** A regulatory or risk statement that must not be missed. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="notice" role="note">
      {children}
    </p>
  );
}

export type EmptyIcon = "floor" | "vault" | "book" | "stream" | "ticket";

/** The little picture of an empty state: nothing rests on the floor line yet. */
function EmptyGlyph({ icon }: { icon: EmptyIcon }) {
  return (
    <svg className="empty-glyph" width="72" height="48" viewBox="0 0 72 48" aria-hidden="true" focusable="false">
      {icon === "vault" && <rect className="ghost" x="24" y="6" width="24" height="24" rx="5" />}
      {icon === "book" && (
        <>
          <rect className="ghost" x="14" y="20" width="12" height="10" rx="2" />
          <rect className="ghost" x="30" y="12" width="12" height="18" rx="2" />
          <rect className="ghost" x="46" y="24" width="12" height="6" rx="2" />
        </>
      )}
      {icon === "stream" && <path className="ghost" d="M10 22h14m6 0h8m6 0h18M10 12h8m6 0h20" fill="none" />}
      {icon === "ticket" && <path className="ghost" d="M20 10h32v6a4 4 0 0 0 0 8v6H20v-6a4 4 0 0 0 0-8v-6Z" />}
      {icon === "floor" && <path className="ghost" d="M26 30 36 14l10 16" fill="none" />}
      <path className="line" d="M4 34h64" />
    </svg>
  );
}

export function Empty({ title, children, icon = "floor" }: { title: string; children?: ReactNode; icon?: EmptyIcon }) {
  return (
    <div className="empty">
      <EmptyGlyph icon={icon} />
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${90 - i * 18}%`, animationDelay: `${i * 90}ms` }} />
      ))}
      <i aria-hidden="true" />
    </div>
  );
}

/**
 * The heading of a page: a short eyebrow, the one h1, a sentence of context, and room for the
 * page's headline figure or action on the right. Pages that use it set `ownHead` on their route.
 */
export function PageHead({ eyebrow, title, children, aside }: { eyebrow: string; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children && <p className="page-lede">{children}</p>}
      </div>
      {aside && <div className="page-head-aside">{aside}</div>}
    </header>
  );
}

/** A titled region inside a page that is not a card: the title is small, the content is the point. */
export function Panel({ title, children, aside, className, id }: { title?: string; children: ReactNode; aside?: ReactNode; className?: string; id?: string }) {
  return (
    <section className={className ? `panel ${className}` : "panel"} id={id}>
      {(title || aside) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

/** A moment as relative text, with the absolute date as a tooltip, or spelled out with `both`. */
export function Time({ at, now, both }: { at: number; now: number; both?: boolean }) {
  if (at === 0) return <>–</>;
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={dateTime(at)}>
      {relative(at, now)}
      {both && <span className="muted"> ({dateTime(at)})</span>}
    </time>
  );
}

/** Renders the loading and error states of a query, and its data once there is some. */
export function QueryView<T>({
  query,
  children,
  lines,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  lines?: number;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        Could not load: {decodeError(query.error).message}
      </p>
    );
  }
  return <Skeleton lines={lines} />;
}

/**
 * Button for a transaction. Disabled without a wallet or while another action is in flight;
 * `blocked` is a reason the action is not available right now, shown as a tooltip and read out.
 */
export function ActionButton({
  blocked,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { blocked?: string | false }) {
  const { isConnected } = useAccount();
  const demo = useMode() === "demo";
  const { busy } = useTx();
  const reason = !isConnected && !demo ? "Connect a wallet first" : busy ? "Another action is in progress" : blocked || undefined;
  return (
    <button
      type="button"
      {...props}
      className={className ? `btn ${className}` : "btn"}
      disabled={!!reason || props.disabled}
      title={reason}
      aria-description={reason}
    >
      {children}
    </button>
  );
}

/** A modal dialog on the native <dialog> element: focus is trapped and restored by the browser. */
export function Modal({
  open,
  onClose,
  title,
  children,
  dismissible = true,
  className,
  eyebrow,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** A small line above the title, e.g. "Review before signing". */
  eyebrow?: ReactNode;
  /** When false, Escape and the close button do nothing (a transaction is in flight). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : "modal"}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        // a click on the backdrop lands on the dialog element itself
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <header className="modal-head">
            <div>
              {eyebrow && <p className="eyebrow modal-eyebrow">{eyebrow}</p>}
              <h2>{title}</h2>
            </div>
            {dismissible && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
                ×
              </button>
            )}
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
