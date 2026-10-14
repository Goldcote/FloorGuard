// Small motion and timing helpers for the visualisations. Everything here stops when it is not
// seen: loops pause off-screen and in hidden tabs, and reduced motion gets values without travel.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useMode } from "../demo/mode";
import { demoNow, subscribeDemo } from "../demo/sim";
import { useChainTime } from "../hooks";

const REDUCED = "(prefers-reduced-motion: reduce)";
// Development aid: `?reduce-motion` takes the script-driven calm path without changing the system
// setting (the CSS half still follows the real media query). Not part of a production build.
const FORCE_REDUCED = import.meta.env?.DEV === true && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("reduce-motion");
export const prefersReducedMotion = (): boolean => FORCE_REDUCED || (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED).matches);

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", fn);
      return () => query.removeEventListener("change", fn);
    },
    prefersReducedMotion,
    () => false,
  );
}

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Whether the element is on screen (with a margin), so loops can sleep when it is not. */
export function useInView(ref: RefObject<Element>, rootMargin = "120px", once = false): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return setInView(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (once && entry.isIntersecting) observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin, once]);
  return inView;
}

// Development aid: `?always-visible` keeps the loops running in a tab the browser reports as hidden
// (an embedded preview pane, for example). Not part of a production build.
const FORCE_VISIBLE = import.meta.env?.DEV === true && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("always-visible");
/** Whether the tab is hidden; loops and particles do not run then. */
export const pageHidden = (): boolean => !FORCE_VISIBLE && typeof document !== "undefined" && document.visibilityState === "hidden";

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
    () => !pageHidden(),
    () => true,
  );
}

/**
 * Calls `frame(elapsedMs, dtMs)` on every animation frame while `active` and the tab is visible.
 * The callback is kept in a ref, so it may close over fresh props without restarting the loop.
 */
export function useFrame(frame: (elapsed: number, dt: number) => void, active = true) {
  const visible = usePageVisible();
  const callback = useRef(frame);
  callback.current = frame;
  useEffect(() => {
    if (!active || !visible) return;
    let id = 0;
    let last = performance.now();
    const start = last;
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      callback.current(now - start, dt);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active, visible]);
}

/**
 * A number that counts to its new value instead of jumping. The text is written straight to the
 * DOM, in tabular figures, so nothing re-renders and nothing shifts. Reduced motion: it just changes.
 */
export function Num({ value, format, className, title }: { value: number; format: (n: number) => string; className?: string; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const formatRef = useRef(format);
  formatRef.current = format;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = shown.current;
    if (from === value || prefersReducedMotion() || !Number.isFinite(from)) {
      shown.current = value;
      node.textContent = formatRef.current(value);
      return;
    }
    const start = performance.now();
    const duration = 520;
    let id = 0;
    const step = (now: number) => {
      const k = clamp((now - start) / duration);
      shown.current = lerp(from, value, easeOut(k));
      node.textContent = formatRef.current(k === 1 ? value : shown.current);
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <span ref={ref} className={className ? `num ${className}` : "num"} title={title}>
      {format(shown.current)}
    </span>
  );
}

/** ETH with a fixed number of decimals, so a ticking figure keeps its width. */
export const ethFixed = (digits: number) => (n: number) => n.toFixed(digits);

/**
 * The protocol's clock as a function, for animation loops: simulated time in the demo (it runs
 * fast, so it moves every frame) and the latest block time on a chain (it moves when a block does).
 */
export function useClock(): () => number {
  const demo = useMode() === "demo";
  const chain = useChainTime();
  const latest = useRef(chain);
  latest.current = chain;
  const clock = useRef<() => number>(() => chain);
  clock.current = demo ? demoNow : () => latest.current;
  return useRef(() => clock.current()).current;
}

/** Re-render when the simulation changes and once a second (its clock runs fast). */
export function useDemoTick(intervalMs = 1_000) {
  const [, tick] = useState(0);
  useEffect(() => {
    const bump = () => tick((n) => n + 1);
    const id = setInterval(bump, intervalMs);
    const off = subscribeDemo(bump);
    return () => {
      clearInterval(id);
      off();
    };
  }, [intervalMs]);
}

/** The value from the previous render. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/** True for `ms` after `trigger` changes (not on mount): a one-shot flag for CSS flourishes. */
export function useFlash(trigger: unknown, ms = 1_200): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [trigger, ms]);
  return on;
}

/** Width of an element, tracked. Charts lay themselves out in real pixels so text stays readable. */
export function useWidth(ref: RefObject<HTMLElement>, initial = 0): number {
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Bumps whenever the colour theme changes, so canvases can re-read their colours from CSS. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return version;
}
