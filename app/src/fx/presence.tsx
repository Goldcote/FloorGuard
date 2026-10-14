// Enter / exit transitions for elements that mount and unmount.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { prefersReducedMotion } from "./motion";

export type PresencePhase = "enter" | "idle" | "exit";

/**
 * Keeps something mounted while it plays its exit. Returns whether to render and the phase to style.
 *
 *   const { mounted, phase } = usePresence(open, 220);
 *   return mounted ? <div data-phase={phase} className="fx-fade" /> : null;
 */
export function usePresence(present: boolean, exitMs = 220, enterMs = 320): { mounted: boolean; phase: PresencePhase } {
  const [mounted, setMounted] = useState(present);
  const [phase, setPhase] = useState<PresencePhase>(present ? "idle" : "exit");
  useEffect(() => {
    const instant = prefersReducedMotion();
    if (present) {
      setMounted(true);
      setPhase(instant ? "idle" : "enter");
      const timer = setTimeout(() => setPhase("idle"), instant ? 0 : enterMs);
      return () => clearTimeout(timer);
    }
    setPhase("exit");
    const timer = setTimeout(() => setMounted(false), instant ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [present, exitMs, enterMs]);
  return { mounted: mounted || present, phase };
}

export type PresenceKind = "fade" | "rise" | "drop" | "scale";

/**
 * `<Presence show={open} kind="rise">…</Presence>`: fades / rises / drops / scales its child in and
 * out (classes `fx-presence fx-<kind>` with `data-phase`, styled in fx.css). `delay` staggers a list.
 */
export function Presence({ show, kind = "rise", delay = 0, className, children, as: Tag = "div" }: { show: boolean; kind?: PresenceKind; delay?: number; className?: string; children: ReactNode; as?: "div" | "span" | "li" }) {
  const { mounted, phase } = usePresence(show);
  if (!mounted) return null;
  const style = delay ? ({ "--fx-delay": `${delay}ms` } as CSSProperties) : undefined;
  return (
    <Tag className={`fx-presence fx-${kind}${className ? ` ${className}` : ""}`} data-phase={phase} style={style}>
      {children}
    </Tag>
  );
}
