// What the Play stages draw must be a pure, honest function of the settled result.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimValue,
  DIE_ROTATION,
  dieFace,
  diceMultiple,
  drawTape,
  IDLE_WINDOW,
  potVessel,
  REEL_STOP_MS,
  reelWindow,
  resultTone,
  slotsTierIndex,
  stakePayout,
  tapeProgress,
  tugShare,
} from "../src/fx/gameviz";
import { bounceHeight, ease, spring } from "../src/fx/motion";
import { observeReveal, resetReveals } from "../src/fx/reveal";
import { recomputeBet, SLOTS_PAY_TABLE, slotsLine, slotsMultiplier } from "../src/lib/gameMath";

describe("reelWindow", () => {
  it("rests on exactly the line the roll maps to, for all 10000 rolls, and never stages a near miss", () => {
    for (let roll = 0; roll < 10_000; roll++) {
      const window = reelWindow(roll);
      const line = window.map((column) => column[1]);
      expect(line).toEqual(slotsLine(roll));
      // the pay table and the picture agree: three of a kind exactly when the roll pays more than the stake
      const triple = line[0] === line[1] && line[1] === line[2];
      expect(triple).toBe(slotsMultiplier(roll) >= 2);
      for (const row of [0, 2] as const) {
        const symbols = window.map((column) => column[row]);
        // the top symbol is never shown just off the line
        expect(symbols).not.toContain("7");
        // no three of a kind, nor even a pair, one step from the line
        expect(new Set(symbols).size).toBe(3);
      }
      // a reel does not repeat its payline symbol directly above or below
      for (const [above, on, below] of window) {
        expect(above).not.toBe(on);
        expect(below).not.toBe(on);
      }
    }
  });

  it("is deterministic and the idle display is not a winning line", () => {
    expect(reelWindow(4321)).toEqual(reelWindow(4321));
    expect(new Set(IDLE_WINDOW.map((column) => column[1])).size).toBe(3);
  });

  it("stops the reels at fixed, increasing times", () => {
    expect([...REEL_STOP_MS]).toEqual([...REEL_STOP_MS].sort((a, b) => a - b));
    expect(REEL_STOP_MS).toHaveLength(3);
  });

  it("finds the pay-table row of a roll", () => {
    for (const roll of [0, 19, 20, 119, 120, 519, 520, 2019, 2020, 5019, 5020, 9999]) {
      expect(SLOTS_PAY_TABLE[slotsTierIndex(roll)].multiplier).toBe(slotsMultiplier(roll));
    }
  });
});

describe("resultTone", () => {
  it("celebrates only a payout above the wager", () => {
    const wager = 10n ** 18n;
    for (let roll = 0; roll < 10_000; roll += 7) {
      const { payout, multiplier } = recomputeBet({ wager, edgeBps: 200n, chanceBps: 0, roll });
      const tone = resultTone(payout, wager, multiplier!);
      if (payout > wager) expect(["win", "big", "jackpot"]).toContain(tone);
      else expect(tone).toBe(payout === 0n ? "loss" : "returned");
    }
    // a 1x slots result returns the stake after the edge: less than the wager, so never a win
    expect(resultTone((wager * 98n) / 100n, wager, 1)).toBe("returned");
    // a large multiple cannot turn a payout that is not above the wager into a win
    expect(resultTone(wager, wager, 50)).toBe("returned");
    expect(resultTone(0n, wager, 50)).toBe("loss");
    expect(resultTone(wager * 49n, wager, 50)).toBe("jackpot");
    expect(resultTone(wager * 9n, wager, 10)).toBe("big");
    expect(resultTone(wager * 2n, wager, 2)).toBe("win");
  });
});

describe("dieFace", () => {
  it("is the sixth of the range the roll fell in: 1 to 6, never decreasing", () => {
    let previous = 1;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let roll = 0; roll < 10_000; roll++) {
      const face = dieFace(roll);
      expect(face).toBeGreaterThanOrEqual(previous);
      expect(face).toBe(Math.floor((roll * 6) / 10_000) + 1);
      previous = face;
      counts[face - 1]++;
    }
    expect(previous).toBe(6);
    for (const count of counts) expect(Math.abs(count - 10_000 / 6)).toBeLessThan(1);
  });

  it("agrees with an even-chance bet like a real die: 1 to 3 win, 4 to 6 lose", () => {
    for (let roll = 0; roll < 10_000; roll++) expect(dieFace(roll) <= 3).toBe(roll < 5_000);
  });

  it("has a rotation for every face, and opposite faces differ by a half turn", () => {
    expect(Object.keys(DIE_ROTATION)).toHaveLength(6);
    expect(DIE_ROTATION[1]).toEqual([0, 0]);
    expect(Math.abs(DIE_ROTATION[2][1] - DIE_ROTATION[5][1])).toBe(180);
    expect(Math.abs(DIE_ROTATION[3][0] - DIE_ROTATION[4][0])).toBe(180);
  });

  it("quotes the multiple of a win from the chance and the edge", () => {
    expect(diceMultiple(5_000, 200n)).toBeCloseTo(1.96);
    expect(diceMultiple(100, 200n)).toBeCloseTo(98);
  });
});

describe("drawTape", () => {
  it("lands on the winning ticket and counts tickets in their natural order", () => {
    for (const [ticket, sold] of [[0, 1], [3, 5], [17, 40], [39, 40], [0, 40], [250, 1000]]) {
      const { cells, landIndex } = drawTape(ticket, sold);
      expect(cells[landIndex]).toBe(ticket);
      for (let i = 1; i < cells.length; i++) expect(cells[i]).toBe((cells[i - 1] + 1) % sold);
      for (const cell of cells) expect(cell).toBeLessThan(sold);
    }
  });

  it("decelerates monotonically to rest", () => {
    expect(tapeProgress(0)).toBe(0);
    expect(tapeProgress(1)).toBe(1);
    let last = 0;
    let lastStep = Infinity;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const now = tapeProgress(t);
      expect(now).toBeGreaterThan(last);
      expect(now - last).toBeLessThanOrEqual(lastStep + 1e-9);
      lastStep = now - last;
      last = now;
    }
  });
});

describe("pot and pools", () => {
  const ETH = 10n ** 18n;

  it("sizes the pot's vessel in doublings of the minimum pot", () => {
    expect(potVessel(0n, ETH)).toEqual({ capacity: 2n * ETH, fill: 0, minLine: 0.5 });
    expect(potVessel(ETH, ETH).fill).toBe(0.5);
    expect(potVessel(3n * ETH, ETH)).toMatchObject({ capacity: 4n * ETH, fill: 0.75, minLine: 0.25 });
    expect(potVessel(5n * ETH, 0n).fill).toBeLessThanOrEqual(1);
  });

  it("splits the rope by the pools", () => {
    expect(tugShare(0n, 0n)).toBe(0.5);
    expect(tugShare(3n * ETH, ETH)).toBe(0.75);
  });

  it("pays a stake like PredictionMarket.claim: stake, pro-rata share of the other pool, fee on the profit", () => {
    // 1 ETH joins a 1 ETH pool against 4 ETH: half the winning pool, so half the losing pool
    expect(stakePayout(ETH, ETH, 4n * ETH, 300n)).toBe(ETH + 2n * ETH - (2n * ETH * 3n) / 100n);
    expect(stakePayout(0n, ETH, ETH, 300n)).toBe(0n);
    // what is quoted before the bet is what is claimable after it
    const stake = { higher: ETH, lower: 0n };
    expect(claimValue(1, stake, 2n * ETH, 4n * ETH, 300n)).toBe(stakePayout(ETH, ETH, 4n * ETH, 300n));
    expect(claimValue(2, stake, 2n * ETH, 4n * ETH, 300n)).toBe(0n);
    expect(claimValue(3, { higher: ETH, lower: 2n * ETH }, 2n * ETH, 4n * ETH, 300n)).toBe(3n * ETH);
  });
});

describe("motion curves", () => {
  it("end exactly on their target", () => {
    for (const curve of Object.values(ease)) {
      expect(curve(0)).toBeCloseTo(0);
      expect(curve(1)).toBeCloseTo(1);
    }
    expect(spring(0)).toBe(0);
    expect(spring(1)).toBe(1);
    expect(bounceHeight(0)).toBe(1);
    expect(bounceHeight(1)).toBe(0);
  });

  it("bounce lower each time and never go below the floor", () => {
    let peak = 0;
    let rising = false;
    const peaks: number[] = [];
    let last = 1;
    for (let t = 0; t <= 1; t += 0.002) {
      const h = bounceHeight(t, 3, 0.36);
      expect(h).toBeGreaterThanOrEqual(0);
      if (h > last) (rising = true), (peak = h);
      else if (rising) (rising = false), peaks.push(peak);
      last = h;
    }
    expect(peaks).toHaveLength(3);
    expect(peaks[0]).toBeGreaterThan(peaks[1]);
    expect(peaks[1]).toBeGreaterThan(peaks[2]);
    expect(peaks[0]).toBeLessThan(0.5);
  });
});

describe("result clock", () => {
  afterEach(() => (vi.useRealTimers(), resetReveals()));

  it("holds a result back only if it was seen pending, and only for the reveal", () => {
    vi.useFakeTimers();
    // already settled when first seen: shown at once
    expect(observeReveal("a", "settled", 1_000)).toBe("done");
    // seen pending, then settled: revealing for the fixed time, then done
    expect(observeReveal("b", "pending", 1_000)).toBe("pending");
    expect(observeReveal("b", "settled", 1_000)).toBe("revealing");
    vi.advanceTimersByTime(500);
    expect(observeReveal("b", "settled", 1_000)).toBe("revealing");
    vi.advanceTimersByTime(600);
    expect(observeReveal("b", "settled", 1_000)).toBe("done");
    // a refund is not a reveal
    expect(observeReveal("c", "other", 1_000)).toBe("idle");
    // an id that comes round again (a simulated chain starting over) reveals again
    expect(observeReveal("b", "pending", 1_000)).toBe("pending");
    expect(observeReveal("b", "settled", 1_000)).toBe("revealing");
  });
});
