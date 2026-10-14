// Numbers that count up (or down) to their value instead of snapping, without moving the layout:
// the element is always as wide as its final text, and screen readers get only the final value.
import { useEffect, useRef } from "react";
import { ease, tween, type Ease } from "./motion";

export type CountUpProps = {
  /** The value to show. A change animates from the value shown at that moment. */
  value: number;
  /** Formats an in-between value. Keep the number of characters stable (fixed decimals). */
  format: (value: number) => string;
  /** The exact final text, when `format(value)` would round it (e.g. a bigint amount). */
  finalText?: string;
  /** Milliseconds. Default 700. */
  duration?: number;
  ease?: Ease;
  /** Start from this value on first mount instead of showing `value` at once. */
  from?: number;
  className?: string;
  /** Called with each frame's value: lets a caller tick a sound or scale with the number. */
  onTick?: (value: number) => void;
};

/**
 * `<CountUp value={12.5} format={(v) => v.toFixed(2)} />`
 *
 * The moving digits are written straight to the DOM (no React render per frame). With reduced motion
 * the value is simply replaced.
 */
export function CountUp({ value, format, finalText, duration = 700, ease: curve = ease.outExpo, from, className, onTick }: CountUpProps) {
  const live = useRef<HTMLSpanElement>(null);
  const shown = useRef(from ?? value);
  const text = finalText ?? format(value);

  useEffect(() => {
    const element = live.current;
    if (!element) return;
    const start = shown.current;
    if (start === value) {
      element.textContent = text;
      return;
    }
    const cancel = tween({
      duration,
      ease: curve,
      onUpdate: (k) => {
        shown.current = start + (value - start) * k;
        element.textContent = k >= 1 ? text : format(shown.current);
        onTick?.(shown.current);
      },
      onDone: () => {
        shown.current = value;
        element.textContent = text;
      },
    });
    return () => {
      cancel();
      // An interrupted count continues from where it was, not from the old target.
    };
  }, [value, text]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className={className ? `fx-count ${className}` : "fx-count"}>
      <span className="fx-count-size" aria-hidden="true">
        {text}
      </span>
      <span className="fx-count-live" aria-hidden="true" ref={live}>
        {from === undefined ? text : format(from)}
      </span>
      <span className="fx-sr">{text}</span>
    </span>
  );
}

/** Decimals a formatted amount shows, so in-between frames keep the same width. */
export function decimalsOf(text: string): number {
  const match = /\.(\d+)/.exec(text);
  return match ? match[1].length : 0;
}

/**
 * An 18-decimal amount (wei) counting to its value. The final frame is the exact `text` you pass
 * (format it with the app's own `eth()`), the frames before it use the same number of decimals.
 */
export function AmountCount({ wei, text, duration, from, className, onTick }: { wei: bigint; text: string; duration?: number; from?: bigint; className?: string; onTick?: (value: number) => void }) {
  const decimals = Math.max(decimalsOf(text), 3);
  const asNumber = (v: bigint) => Number(v / 10n ** 9n) / 1e9;
  return (
    <CountUp
      value={asNumber(wei)}
      from={from === undefined ? undefined : asNumber(from)}
      format={(v) => v.toFixed(decimals)}
      finalText={text}
      duration={duration}
      className={className}
      onTick={onTick}
    />
  );
}
