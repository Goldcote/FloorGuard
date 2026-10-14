// Screen response: small physical reactions of an element to an event. All of them use the Web
// Animations API on transform / opacity / filter only, never touch layout, clean up after
// themselves, and do nothing with prefers-reduced-motion.
import { prefersReducedMotion } from "./motion";

const can = (element: Element | null | undefined): element is HTMLElement =>
  !!element && typeof (element as HTMLElement).animate === "function" && !prefersReducedMotion();

/** A short decaying shake. `strength` is the first swing in pixels (keep it under 10). */
export function shake(element: Element | null | undefined, strength = 5, duration = 420): void {
  if (!can(element)) return;
  const steps = 7;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const decay = 1 - i / steps;
    const side = i % 2 === 0 ? 1 : -1;
    frames.push({ transform: `translate3d(${(side * strength * decay).toFixed(2)}px, ${(-side * strength * 0.35 * decay).toFixed(2)}px, 0)` });
  }
  frames[0] = { transform: "translate3d(0, 0, 0)" };
  element.animate(frames, { duration, easing: "linear" });
}

/** A downward thump, as if something heavy landed on the element. */
export function thump(element: Element | null | undefined, depth = 4, duration = 260): void {
  if (!can(element)) return;
  element.animate([{ transform: "translateY(0)" }, { transform: `translateY(${depth}px)`, offset: 0.25 }, { transform: "translateY(0)" }], { duration, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" });
}

/** A scale pop: the element swells and settles. For a number that just changed. */
export function pop(element: Element | null | undefined, scale = 1.12, duration = 380): void {
  if (!can(element)) return;
  element.animate([{ transform: "scale(1)" }, { transform: `scale(${scale})`, offset: 0.3 }, { transform: "scale(1)" }], { duration, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.2)" });
}

/**
 * A flash of colour over the element (which must be positioned and clip its overflow). `color` is any
 * CSS colour, typically `var(--gold)`; `peak` is the strongest opacity.
 */
export function flash(element: Element | null | undefined, color = "var(--gold)", peak = 0.35, duration = 520): void {
  if (!can(element)) return;
  const veil = document.createElement("span");
  veil.className = "fx-flash";
  veil.setAttribute("aria-hidden", "true");
  veil.style.background = color;
  element.appendChild(veil);
  const animation = veil.animate([{ opacity: 0 }, { opacity: peak, offset: 0.12 }, { opacity: 0 }], { duration, easing: "ease-out" });
  const remove = () => veil.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
}

/** A ring of light expanding from the element's edge and fading: a soft "this just happened". */
export function glowPulse(element: Element | null | undefined, color = "var(--accent)", duration = 900): void {
  if (!can(element)) return;
  element.animate(
    [
      { boxShadow: `0 0 0 0 color-mix(in srgb, ${color} 70%, transparent)` },
      { boxShadow: `0 0 0 14px color-mix(in srgb, ${color} 0%, transparent)` },
    ],
    { duration, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
  );
}

/** Light haptic feedback where the device has it. Callers gate it on their own "feedback on" setting. */
export function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // not allowed without a user gesture: ignore
    }
  }
}
