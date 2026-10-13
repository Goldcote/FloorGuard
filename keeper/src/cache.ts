// Optional on-disk cache. Everything in it can be rebuilt from the chain: it only saves log scans and
// remembers what cannot be read back cheaply (the day's spend, when points were last flushed).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address, keccak256, toHex } from "viem";
import type { Deployment } from "./chain.ts";

export interface CacheData {
  version: 1;
  chainId: number;
  /** Hash of the deployment's addresses. A different deployment starts from an empty cache. */
  fingerprint: string;
  /** Last block scanned, per log stream. */
  scanned: Record<string, string>;
  /** Accounts that have been credited points and may have some pending. */
  pointsAccounts: Address[];
  /** Request ids of bets seen placed and not yet seen settled or refunded. */
  openBets: string[];
  /** Collections that have had a bid configured. */
  collections: Address[];
  /** Per list, the lowest id that was not final at the last look. Ids below it never change again. */
  watermarks: Record<string, string>;
  spend: { day: string; wei: string };
  /** Chain time of the last scheduled points flush. */
  lastFlushAt: string | null;
  owners: Record<string, Address>;
  randomness: Record<string, Address>;
}

export function fingerprintOf(deployment: Deployment): string {
  return keccak256(toHex(JSON.stringify(Object.entries(deployment).sort(([a], [b]) => a.localeCompare(b)))));
}

function empty(chainId: number, fingerprint: string): CacheData {
  return {
    version: 1,
    chainId,
    fingerprint,
    scanned: {},
    pointsAccounts: [],
    openBets: [],
    collections: [],
    watermarks: {},
    spend: { day: "", wei: "0" },
    lastFlushAt: null,
    owners: {},
    randomness: {},
  };
}

export class Cache {
  readonly file: string | null;
  data: CacheData;
  /** Why a cache file on disk was ignored, if it was. */
  discarded: string | null = null;

  constructor(file: string | null, chainId: number, fingerprint: string) {
    this.file = file;
    this.data = empty(chainId, fingerprint);
    if (file && existsSync(file)) {
      try {
        const loaded = JSON.parse(readFileSync(file, "utf8")) as CacheData;
        if (loaded.version !== 1) this.discarded = "unknown version";
        else if (loaded.chainId !== chainId) this.discarded = "written for another chain";
        else if (loaded.fingerprint !== fingerprint) this.discarded = "written for another deployment";
        else this.data = { ...this.data, ...loaded };
      } catch {
        this.discarded = "unreadable";
      }
    }
  }

  /** Forget everything derived from logs. Called when the chain is shorter than what was scanned. */
  reset(): void {
    const { spend } = this.data;
    this.data = { ...empty(this.data.chainId, this.data.fingerprint), spend };
  }

  scannedTo(stream: string): bigint | null {
    const raw = this.data.scanned[stream];
    return raw === undefined ? null : BigInt(raw);
  }

  watermark(list: string): bigint {
    return BigInt(this.data.watermarks[list] ?? "1");
  }

  setWatermark(list: string, id: bigint): void {
    this.data.watermarks[list] = id.toString();
  }

  /** Wei spent on the UTC day of `now` (seconds). */
  spentOn(now: number): bigint {
    return this.data.spend.day === utcDay(now) ? BigInt(this.data.spend.wei) : 0n;
  }

  addSpend(now: number, wei: bigint): void {
    this.data.spend = { day: utcDay(now), wei: (this.spentOn(now) + wei).toString() };
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

export function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
