import { useSyncExternalStore } from "react";

/** "demo": the in-browser simulation (src/demo/sim.ts). "live": a real chain through wagmi. */
export type Mode = "demo" | "live";
const KEY = "floorguard.mode";

function stored(): Mode | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value === "demo" || value === "live" ? value : undefined;
  } catch {
    return undefined;
  }
}

let mode: Mode = stored() ?? "demo";
/** Whether the visitor chose the mode themselves; until then the app may pick live when a chain answers. */
let chosen = stored() !== undefined;
const listeners = new Set<() => void>();

export const getMode = () => mode;
export const modeWasChosen = () => chosen;

export function setMode(next: Mode, remember = true) {
  mode = next;
  if (remember) {
    chosen = true;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private mode: lasts for this page view
    }
  }
  listeners.forEach((fn) => fn());
}

export function useMode(): Mode {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => mode,
  );
}
