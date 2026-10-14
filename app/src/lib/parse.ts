// What the visitor types, turned into values. Strict on purpose: anything that is not plainly a
// number or an address is refused rather than guessed at.
import { getAddress, isAddress, parseEther, type Address } from "viem";

/** A non-negative integer (token id, quantity) or undefined. */
export function parseUint(text: string): bigint | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
}

/** Plain decimal notation: digits, optionally a point and more digits. No sign, exponent, hex or spaces inside. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** A positive ETH amount in wei, or undefined. More than 18 decimals cannot be paid exactly and is refused. */
export function parseEth(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return undefined;
  try {
    const wei = parseEther(trimmed);
    return wei > 0n ? wei : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An address. All-lowercase and all-uppercase hex carry no checksum and are accepted as typed; a
 * mixed-case address must match its EIP-55 checksum, so a mistyped character is caught.
 */
export function parseAddress(text: string): Address | undefined {
  const trimmed = text.trim();
  if (!isAddress(trimmed, { strict: false })) return undefined;
  const hex = trimmed.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && getAddress(trimmed) !== trimmed) return undefined;
  return trimmed as Address;
}

/** A percentage like "0.5" as basis points (0..10000), or undefined. At most two decimals (whole basis points). */
export function parsePercentBps(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed) || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [whole, frac = ""] = trimmed.split(".");
  const bps = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return bps <= 10_000n ? bps : undefined;
}

/** The most a slippage or price tolerance may be: beyond it a guard guards nothing. */
export const MAX_TOLERANCE_BPS = 2_000n;
/** Above this the page warns. */
export const WARN_TOLERANCE_BPS = 500n;

export type Tolerance = { bps: bigint; warning?: string };

/**
 * A slippage or tolerance percentage: 0 to 20%. Above 5% it comes with a warning, because the
 * transaction would then go through at a much worse price than the one shown.
 */
export function parseTolerance(text: string): Tolerance | undefined {
  const bps = parsePercentBps(text);
  if (bps === undefined || bps > MAX_TOLERANCE_BPS) return undefined;
  return bps > WARN_TOLERANCE_BPS
    ? { bps, warning: `A tolerance of ${Number(bps) / 100}% is large: the transaction would still go through at a price that much worse than the one shown.` }
    : { bps };
}

/** Why a tolerance was refused, for the field's hint. */
export const TOLERANCE_HINT = "A percentage from 0 to 20, with at most two decimals";

/** A uniformly random 256-bit word from the browser's CSPRNG (for the local mock randomness provider). */
export function randomWord(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((word, byte) => (word << 8n) | BigInt(byte), 0n);
}
