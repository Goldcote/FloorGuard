// Motion primitives: reduced-motion detection, easing and spring curves, a rAF tween and a
// visibility tracker. Dependency-free; everything else in src/fx builds on this file.
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

// ---------------------------------------------------------------- reduced motion

const QUERY = "(prefers-reduced-motion: reduce)";
const media = () => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(QUERY) : undefined);

/** True when the visitor asked the system for less motion. Safe to call anywhere, any time. */
export const prefersReducedMotion = (): boolean => media()?.matches ?? false;

function subscribeReduced(fn: () => void) {
  const query = media();
  query?.addEventListener("change", fn);
  return () => query?.removeEventListener("change", fn);
}

/** Reactive `prefers-reduced-motion`. Components use it to pick the calm path, not to hide content. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => false);
}

// ---------------------------------------------------------------- curves

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t: number) => 1 - (1 - t) ** 4,
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  /** Overshoots the target by about 10% and comes back: a reel or a marker arriving with weight. */
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
} satisfies Record<string, Ease>;

/**
 * A damped spring from 0 to 1 as a closed-form curve of normalised time `t` (0..1).
 * `bounces` is roughly how many times it crosses the target; `damping` how fast it dies (higher is
 * calmer). `spring(1)` is exactly 1, so a tween that ends on it never leaves a residue.
 */
export function spring(t: number, bounces = 2, damping = 6): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-damping * t) * Math.cos(Math.PI * 2 * bounces * t) * (1 - t);
}

/**
 * Height of a ball dropped from 1 that bounces `bounces` times and is at rest at t = 1.
 * Returns 0..1 (1 = start height, 0 = floor). Each bounce keeps `restitution` of the previous height.
 */
export function bounceHeight(t: number, bounces = 3, restitution = 0.38): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  // Durations: the first fall takes 1 unit; each bounce (up and down) takes 2 * sqrt(height).
  const spans = [1];
  let height = 1;
  for (let i = 0; i < bounces; i++) {
    height *= restitution;
    spans.push(2 * Math.sqrt(height));
  }
  const total = spans.reduce((a, b) => a + b, 0);
  let at = t * total;
  if (at < 1) return 1 - at * at;
  at -= 1;
  height = 1;
  for (let i = 1; i < spans.length; i++) {
    height *= restitution;
    if (at < spans[i]) {
      const half = spans[i] / 2;
      const x = (at - half) / half; // -1..1 over the bounce
      return height * (1 - x * x);
    }
    at -= spans[i];
  }
  return 0;
}

// ---------------------------------------------------------------- tween

export type TweenOptions = {
  /** Milliseconds. With reduced motion the tween jumps to its end on the next frame. */
  duration: number;
  ease?: Ease;
  delay?: number;
  onUpdate: (value: number, t: number) => void;
  onDone?: () => void;
  /** Run the full motion even with reduced motion on (for changes that are not movement, e.g. a number). */
  ignoreReducedMotion?: boolean;
};

/** A requestAnimationFrame tween from 0 to 1. Returns a cancel function; cancelling does not call `onDone`. */
export function tween({ duration, ease: curve = ease.outCubic, delay = 0, onUpdate, onDone, ignoreReducedMotion }: TweenOptions): () => void {
  let frame = 0;
  let cancelled = false;
  const instant = duration <= 0 || (!ignoreReducedMotion && prefersReducedMotion());
  const start = performance.now() + (instant ? 0 : delay);
  const step = (now: number) => {
    if (cancelled) return;
    const t = instant ? 1 : clamp((now - start) / duration);
    if (now >= start || instant) onUpdate(curve(t), t);
    if (t < 1) frame = requestAnimationFrame(step);
    else onDone?.();
  };
  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

/** Resolves after `ms`, or at once with reduced motion. For sequencing reveal steps. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));

// ---------------------------------------------------------------- visibility

/**
 * Whether the element is on screen and the tab is visible. Effects use it to stop their frame loop:
 * nothing in src/fx draws while it cannot be seen.
 */
export function useOnScreen(ref: RefObject<Element>, rootMargin = "80px"): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let intersecting = true;
    const update = () => setVisible(intersecting && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => ((intersecting = entry.isIntersecting), update()), { rootMargin });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref, rootMargin]);
  return visible;
}
