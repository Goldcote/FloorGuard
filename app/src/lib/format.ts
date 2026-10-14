import { formatEther, type Address } from "viem";

/** Wei as ETH with at most `digits` decimals, trailing zeros trimmed. */
export function eth(wei: bigint, digits = 6): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const trimmed = frac.slice(0, digits).replace(/0+$/, "");
  const text = trimmed ? `${whole}.${trimmed}` : whole;
  // Do not show a non-zero amount as plain "0".
  return text === "0" && wei !== 0n ? `<0.${"0".repeat(digits - 1)}1` : text;
}

export function shortAddress(address: Address | string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Unix seconds as a local date-time. */
export function dateTime(seconds: number | bigint): string {
  const n = Number(seconds);
  if (n === 0) return "–";
  return new Date(n * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A duration in seconds as "3d 4h", "30d", "2h 5m", "40s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s % 60 > 0 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${s}s`;
}

/** "in 2h 5m" / "3d 4h ago", relative to the chain's clock. */
export function relative(target: number, now: number): string {
  if (target === now) return "just now";
  return target > now ? `in ${duration(target - now)}` : `${duration(now - target)} ago`;
}

/** Points use 18 decimals, like ETH. */
export function points(amount: bigint): string {
  return eth(amount, 2);
}

/** In the demo every amount is play money: "ETH" in a result line or a dialog reads "play ETH". */
export function playMoney(text: string): string {
  return text.replace(/(?<!play )\bETH\b/g, "play ETH");
}

/** Basis points as a percentage string. */
export function bps(value: bigint | number): string {
  return `${Number(value) / 100}%`;
}
