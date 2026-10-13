import { isAddress, parseEther, type Address } from "viem";

/** A non-negative integer (token id, quantity) or undefined. */
export function parseUint(text: string): bigint | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
}

/** A positive ETH amount in wei, or undefined. */
export function parseEth(text: string): bigint | undefined {
  try {
    const wei = parseEther(text.trim());
    return wei > 0n ? wei : undefined;
  } catch {
    return undefined;
  }
}

export function parseAddress(text: string): Address | undefined {
  const trimmed = text.trim();
  return isAddress(trimmed, { strict: false }) ? (trimmed as Address) : undefined;
}

/** A percentage like "0.5" as basis points (0..10000), or undefined. */
export function parsePercentBps(text: string): bigint | undefined {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return BigInt(Math.round(value * 100));
}

/** A uniformly random 256-bit word from the browser's CSPRNG (for the local mock randomness provider). */
export function randomWord(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((word, byte) => (word << 8n) | BigInt(byte), 0n);
}
