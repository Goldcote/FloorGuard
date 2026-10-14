// Result moments: pending -> reveal -> outcome.
//
// Data arrives the instant a bet settles, but the stage needs a second or two to show it (reels
// stopping, a die landing, a tape running out). Until that reveal has played, nothing else on the
// page may give the result away: not the history table, not the session total. This module is the
// single clock for that. A result is only ever held back if this page watched it being pending;
// anything already settled when the page loaded is shown at once. With reduced motion the reveal
// takes no time, so nothing is held back.
import { useSyncExternalStore } from "react";
import { prefersReducedMotion } from "./motion";

export type RevealPhase = "idle" | "pending" | "revealing" | "done";

const seenPending = new Set<string>();
const startedAt = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  listeners.forEach((fn) => fn());
}

/**
 * Report what the data says about one result and learn which phase to draw. Call it while rendering
 * (it is idempotent). `key` identifies the result across the app, e.g. `bet:31337:42`.
 *
 * - `pending`: the result has been requested and not arrived;
 * - `settled`: the result is known;
 * - `revealMs`: how long this kind of result takes to show. A constant per game, never per outcome.
 */
export function observeReveal(key: string, state: "pending" | "settled" | "other", revealMs: number): RevealPhase {
  if (state === "pending") {
    seenPending.add(key);
    startedAt.delete(key);
    return "pending";
  }
  if (state !== "settled") return "idle";
  if (!seenPending.has(key)) return "done";
  const ms = prefersReducedMotion() ? 0 : revealMs;
  let started = startedAt.get(key);
  if (started === undefined) {
    started = performance.now();
    startedAt.set(key, started);
    if (ms > 0) setTimeout(notify, ms + 30);
  }
  return performance.now() - started < ms ? "revealing" : "done";
}

/** Milliseconds since the reveal of `key` began, or undefined if it has not. */
export function revealElapsed(key: string): number | undefined {
  const started = startedAt.get(key);
  return started === undefined ? undefined : performance.now() - started;
}

/** Re-renders the component when any reveal finishes, so held-back figures appear on time. */
export function useRevealClock(): number {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => version,
    () => 0,
  );
}

/** Forget everything (tests, or a simulated chain that starts over). */
export function resetReveals() {
  seenPending.clear();
  startedAt.clear();
  notify();
}
