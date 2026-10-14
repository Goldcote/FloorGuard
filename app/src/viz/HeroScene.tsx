// The landing hero: the vault at night. A glowing floor line as the horizon, the vault's holdings
// resting on it, and the protocol's bid rising towards it. Everything that carries a number is read
// from the demo simulation in this tab (src/demo/sim.ts): the bid curve is the simulated bid, the
// tiles are the simulated vault's holdings. The stars, the dust and the receding floor are scenery.
//
// One canvas, redrawn per frame only while it is on screen and the tab is visible. Reduced motion
// gets the same picture, redrawn once a second with nothing drifting.
import { useEffect, useRef } from "react";
import { demoBidEvents, demoBidStart, demoNow, demoReads } from "../demo/sim";
import { bidAt, bidPolyline, bidSegments, DAY, toEth, tokenPattern } from "./curves";
import { clamp, lerp, useFrame, useInView, useReducedMotion, useThemeVersion } from "./motion";

type Palette = { accent: string; text: string; muted: string; border: string; surface: string; surface2: string; bg: string; dark: boolean };

function readPalette(node: Element): Palette {
  const css = getComputedStyle(node);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { accent: v("--accent"), text: v("--text"), muted: v("--muted"), border: v("--border-strong"), surface: v("--surface"), surface2: v("--surface-2"), bg: v("--bg"), dark: css.colorScheme.includes("dark") };
}

/** `#rrggbb` with an alpha. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Scenery is laid out once from a fixed seed, so the sky is the same on every visit.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seeded(0xf100d);
const STARS = Array.from({ length: 90 }, () => ({ x: rand(), y: rand(), r: 0.4 + rand() * 1.1, phase: rand() * 6.28, speed: 0.4 + rand() * 1.2, depth: 0.2 + rand() * 0.8 }));
const MOTES = Array.from({ length: 26 }, () => ({ x: rand(), y: rand(), speed: 0.012 + rand() * 0.03, sway: rand() * 6.28, r: 0.8 + rand() * 1.4 }));

type Tile = { id: bigint; tokenId: bigint; status: number };

export function HeroScene({ onReadout }: { onReadout?: (r: { bid: number; floor: number; x: number; y: number; horizon: number; capped: boolean; limited: boolean }) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const inView = useInView(wrap, "0px");
  const reduced = useReducedMotion();
  const theme = useThemeVersion();
  const palette = useRef<Palette>();
  const pointer = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const seen = useRef(new Map<string, number>());
  const lastStatic = useRef(-1e9);
  const report = useRef(onReadout);
  report.current = onReadout;

  useEffect(() => {
    if (wrap.current) palette.current = readPalette(wrap.current);
    lastStatic.current = -1e9;
  }, [theme]);

  useEffect(() => {
    const node = wrap.current;
    const cv = canvas.current;
    if (!node || !cv) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = node.clientWidth;
      const h = node.clientHeight;
      size.current = { w, h, dpr };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      lastStatic.current = -1e9;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const box = node.getBoundingClientRect();
      pointer.current.tx = clamp((event.clientX - box.left) / box.width - 0.5, -0.5, 0.5);
      pointer.current.ty = clamp((event.clientY - box.top) / box.height - 0.5, -0.5, 0.5);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", move);
    };
  }, []);

  useFrame((elapsed, dt) => {
    const cv = canvas.current;
    const c = palette.current;
    const ctx = cv?.getContext("2d");
    const { w, h, dpr } = size.current;
    if (!cv || !ctx || !c || w === 0) return;
    // Reduced motion: one still frame a second, so the figures stay current and nothing drifts.
    if (reduced) {
      if (elapsed - lastStatic.current < 1_000) return;
      lastStatic.current = elapsed;
    }
    const t = reduced ? 0 : elapsed / 1000;
    const p = pointer.current;
    p.x = reduced ? 0 : lerp(p.x, p.tx, Math.min(1, dt / 220));
    p.y = reduced ? 0 : lerp(p.y, p.ty, Math.min(1, dt / 220));

    const narrow = w < 760;
    const horizon = Math.round(h * (narrow ? 0.8 : 0.76)) + p.y * -6;
    const now = demoNow();
    const bid = demoReads.floorBid();
    const overview = demoReads.overview();
    const floor = overview.salesFloor.ok ? toEth(overview.salesFloor.price) : toEth(bid.maxPrice);
    const yOf = (price: number) => clamp(price <= floor ? horizon + ((floor - price) / floor) * h * 1.5 : horizon - ((price - floor) / floor) * h * 0.75, 30, h - 10);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // the glow on the horizon
    const gx = w * (narrow ? 0.5 : 0.62) + p.x * -24;
    const glow = ctx.createRadialGradient(gx, horizon, 0, gx, horizon, Math.max(w, h) * 0.62);
    glow.addColorStop(0, alpha(c.accent, c.dark ? 0.26 : 0.16));
    glow.addColorStop(0.45, alpha(c.accent, c.dark ? 0.07 : 0.05));
    glow.addColorStop(1, alpha(c.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // far layer: stars by night, faint dust by day
    for (const s of STARS) {
      const a = (c.dark ? 0.55 : 0.16) * (0.55 + 0.45 * Math.sin(t * s.speed + s.phase)) * s.depth;
      ctx.fillStyle = alpha(c.dark ? c.text : c.muted, a);
      ctx.beginPath();
      ctx.arc(s.x * w + p.x * -14 * s.depth, s.y * horizon * 0.96 + p.y * -8 * s.depth, s.r, 0, 6.283);
      ctx.fill();
    }

    // the vault floor, receding to the horizon
    const vx = w * 0.5 + p.x * -40;
    const depth = h - horizon;
    ctx.lineWidth = 1;
    for (let i = -14; i <= 14; i++) {
      ctx.strokeStyle = alpha(c.accent, c.dark ? 0.1 : 0.12);
      ctx.beginPath();
      ctx.moveTo(vx + i * w * 0.012, horizon);
      ctx.lineTo(vx + i * w * 0.17, h);
      ctx.stroke();
    }
    const rows = 9;
    const phase = (t * 0.09) % 1;
    for (let k = 0; k < rows; k++) {
      const z = (k + phase) / rows;
      const yy = horizon + depth * z ** 2.3;
      ctx.strokeStyle = alpha(c.accent, (c.dark ? 0.2 : 0.2) * z);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }

    // the bid, live from the simulation: solid where it has been, dashed where its rule takes it
    // next if nobody sells into it
    const span = 2.2 * DAY;
    const segments = bidSegments(bid, demoBidEvents(), demoBidStart(), now);
    const running = segments[segments.length - 1];
    const left = Math.max(running.from, now - 1.5 * DAY) - 0.1 * span;
    const xRight = w * (narrow ? 0.94 : 0.62);
    const xOf = (time: number) => ((time - left) / span) * xRight + p.x * -10;
    const line = bidPolyline(segments);
    // what a seller would be paid: the curve, or less when the budget holds less
    const curveNow = toEth(bidAt(bid, now));
    const current = Math.min(curveNow, toEth(bid.budget));
    const capped = curveNow >= toEth(bid.maxPrice);
    const nowX = xOf(now);
    const dotY = yOf(current);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, nowX, h);
    ctx.clip();
    ctx.beginPath();
    line.forEach((pt, i) => (i === 0 ? ctx.moveTo(xOf(pt.t), yOf(pt.p)) : ctx.lineTo(xOf(pt.t), yOf(pt.p))));
    const area = ctx.createLinearGradient(0, Math.min(dotY, horizon), 0, h);
    area.addColorStop(0, alpha(c.accent, c.dark ? 0.3 : 0.2));
    area.addColorStop(1, alpha(c.accent, 0));
    ctx.lineTo(nowX, h);
    ctx.lineTo(xOf(line[0].t), h);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();
    ctx.beginPath();
    line.forEach((pt, i) => (i === 0 ? ctx.moveTo(xOf(pt.t), yOf(pt.p)) : ctx.lineTo(xOf(pt.t), yOf(pt.p))));
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = c.dark ? 16 : 0;
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([2, 7]);
    ctx.lineCap = "round";
    ctx.strokeStyle = alpha(c.accent, 0.7);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, dotY);
    for (let k = 1; k <= 12; k++) {
      const time = now + ((left + span - now) * k) / 12;
      ctx.lineTo(xOf(time), yOf(toEth(bidAt(bid, time))));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
    // the gap between the bid and the floor
    if (Math.abs(dotY - horizon) > 6) {
      const beam = ctx.createLinearGradient(0, dotY, 0, horizon);
      beam.addColorStop(0, alpha(c.accent, 0.5));
      beam.addColorStop(1, alpha(c.accent, 0.05));
      ctx.strokeStyle = beam;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(nowX, dotY);
      ctx.lineTo(nowX, horizon);
      ctx.stroke();
    }

    // the floor line itself
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = c.dark ? 22 : 6;
    const lineGrad = ctx.createLinearGradient(0, 0, w, 0);
    lineGrad.addColorStop(0, alpha(c.accent, 0.15));
    lineGrad.addColorStop(0.2, c.accent);
    lineGrad.addColorStop(0.85, c.accent);
    lineGrad.addColorStop(1, alpha(c.accent, 0.3));
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // the vault's holdings rest on the line (released ones have left)
    const tiles: Tile[] = demoReads
      .holdings()
      .holdings.filter((x) => x.status !== 4)
      .slice(0, 7)
      .reverse();
    const side = narrow ? clamp(w * 0.15, 44, 64) : clamp(w * 0.075, 64, 112);
    const gap = side * 0.34;
    const total = tiles.length * side + (tiles.length - 1) * gap;
    const right = w * (narrow ? 0.95 : 0.93) + p.x * -22;
    const stamp = performance.now();
    tiles.forEach((tile, i) => {
      const key = tile.id.toString();
      // the holdings there at load arrive one after another; a later one drops in when it is bought
      if (!seen.current.has(key)) seen.current.set(key, elapsed < 400 ? stamp + 250 + i * 180 : stamp);
      const age = (stamp - seen.current.get(key)!) / 900;
      if (age < 0 && !reduced) return;
      // a new holding drops onto the line and settles
      const drop = reduced || age >= 1 ? 0 : (1 - age) ** 2 * Math.abs(Math.cos(age * 7.5)) * h * 0.5;
      const onAuction = tile.status === 3;
      const bob = onAuction && !reduced ? Math.sin(t * 1.6 + i) * 3 - 7 : 0;
      const s = side * (i % 2 ? 0.9 : 1);
      const x = right - total + i * (side + gap) + (side - s) / 2;
      const y = horizon - s - 1 - drop + bob;
      const { hue, cells } = tokenPattern(tile.tokenId);
      const drawTile = (ty: number, flip: boolean, a: number) => {
        ctx.save();
        ctx.globalAlpha = a;
        if (flip) {
          ctx.translate(0, 2 * horizon + 2);
          ctx.scale(1, -1);
        }
        ctx.beginPath();
        ctx.roundRect(x, ty, s, s, s * 0.16);
        ctx.fillStyle = c.dark ? `hsl(${hue} 32% 13%)` : `hsl(${hue} 40% 92%)`;
        ctx.fill();
        ctx.strokeStyle = onAuction ? c.text : alpha(c.accent, 0.75);
        ctx.lineWidth = 1.5;
        if (onAuction) ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const cell = (s * 0.62) / 5;
        ctx.fillStyle = c.dark ? `hsl(${hue} 70% 66%)` : `hsl(${hue} 55% 36%)`;
        cells.forEach((on, k) => {
          if (on) ctx.fillRect(x + s * 0.19 + (k % 5) * cell, ty + s * 0.19 + Math.floor(k / 5) * cell, cell + 0.5, cell + 0.5);
        });
        ctx.restore();
      };
      // a faint reflection on the floor, then the tile
      drawTile(y, true, c.dark ? 0.16 : 0.1);
      drawTile(y, false, 1);
      ctx.font = `600 ${narrow ? 10 : 11}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = alpha(c.text, 0.7);
      ctx.fillText(`#${tile.tokenId}${onAuction ? " on auction" : ""}`, x + s / 2, y - 8);
    });

    // near layer: motes rising off the line
    if (!reduced) {
      for (const mote of MOTES) {
        const life = (mote.y + t * mote.speed) % 1;
        const mx = mote.x * w + Math.sin(t * 0.6 + mote.sway) * 14 + p.x * -34;
        const my = horizon - life * h * 0.42 + p.y * -16;
        ctx.fillStyle = alpha(c.accent, (c.dark ? 0.55 : 0.35) * (1 - life) * (life < 0.08 ? life / 0.08 : 1));
        ctx.beginPath();
        ctx.arc(mx, my, mote.r, 0, 6.283);
        ctx.fill();
      }
    }

    // the live point
    const pulse = reduced ? 0.5 : (t * 0.9) % 1;
    ctx.strokeStyle = alpha(c.accent, 0.7 * (1 - pulse));
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(nowX, dotY, 6 + pulse * 16, 0, 6.283);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = c.dark ? 18 : 4;
    ctx.beginPath();
    ctx.arc(nowX, dotY, 5.5, 0, 6.283);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.arc(nowX, dotY, 2, 0, 6.283);
    ctx.fill();

    report.current?.({ bid: current, floor, x: nowX, y: dotY, horizon, capped, limited: current < curveNow });
  }, inView);

  return (
    <div className="hero-canvas" ref={wrap} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
