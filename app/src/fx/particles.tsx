// A pooled canvas particle system: bursts, coin and spark showers, confetti.
//
// One <ParticleLayer> covers its positioned parent; a controller from useParticles() emits into it.
// The pool is allocated once (no garbage while playing), the frame loop runs only while particles are
// alive AND the layer is on screen in a visible tab, and with prefers-reduced-motion nothing is
// emitted at all: every caller must already show its result in text.
import { useEffect, useMemo, useRef } from "react";
import { prefersReducedMotion } from "./motion";

export type ParticleShape = "spark" | "coin" | "confetti" | "dust";

/** Where to emit: a fraction of the layer (0..1 on both axes) or the centre of an element. */
export type EmitOrigin = { x: number; y: number } | Element;

export type EmitOptions = {
  at?: EmitOrigin;
  /** Emit along a horizontal band of this width (fraction of the layer) centred on `at`. */
  spreadX?: number;
  count: number;
  shape?: ParticleShape;
  /** CSS colours or token names (`--gold`); tokens are resolved against the layer at emit time. */
  colors?: readonly string[];
  /** Direction in degrees (0 = right, -90 = up) and the cone around it. */
  angle?: number;
  cone?: number;
  /** Pixels per second, [min, max]. */
  speed?: readonly [number, number];
  /** Pixels per second squared, downwards. */
  gravity?: number;
  /** Fraction of velocity kept per second (1 = no drag). */
  drag?: number;
  /** Seconds, [min, max]. */
  life?: readonly [number, number];
  /** Pixels, [min, max]. */
  size?: readonly [number, number];
  /** Spread the emission over this many milliseconds instead of one frame. */
  over?: number;
};

type Particle = {
  alive: boolean;
  shape: ParticleShape;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  drag: number;
  age: number;
  life: number;
  size: number;
  spin: number;
  spinRate: number;
  delay: number;
};

const CAPACITY = 360;
const MAX_DPR = 2;
const rand = (min: number, max: number) => min + Math.random() * (max - min);

export class ParticleEngine {
  private pool: Particle[] = Array.from({ length: CAPACITY }, () => ({
    alive: false, shape: "spark", color: "#fff", x: 0, y: 0, vx: 0, vy: 0, gravity: 0, drag: 1, age: 0, life: 1, size: 2, spin: 0, spinRate: 0, delay: 0,
  }));
  private cursor = 0;
  private live = 0;
  private frame = 0;
  private last = 0;
  private visible = true;
  private width = 0;
  private height = 0;
  private context: CanvasRenderingContext2D | null;

  constructor(private canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d");
    this.resize();
  }

  /** Number of particles currently alive (for tests and for callers that wait for quiet). */
  get count() {
    return this.live;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.run();
    else cancelAnimationFrame(this.frame), (this.frame = 0);
  }

  clear() {
    for (const p of this.pool) p.alive = false;
    this.live = 0;
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.clear();
  }

  emit(options: EmitOptions) {
    if (prefersReducedMotion() || !this.context) return;
    if (this.width === 0) this.resize();
    const { count, shape = "spark", angle = -90, cone = 360, speed = [80, 260], gravity = 520, drag = 0.4, life = [0.6, 1.2], size = [2, 4], over = 0, spreadX = 0 } = options;
    const colors = (options.colors ?? ["--gold"]).map((c) => this.resolve(c));
    const origin = this.origin(options.at);
    for (let i = 0; i < count; i++) {
      const p = this.take();
      const direction = ((angle + rand(-cone / 2, cone / 2)) * Math.PI) / 180;
      const velocity = rand(speed[0], speed[1]);
      p.alive = true;
      p.shape = shape;
      p.color = colors[i % colors.length];
      p.x = origin.x + rand(-0.5, 0.5) * spreadX * this.width;
      p.y = origin.y;
      p.vx = Math.cos(direction) * velocity;
      p.vy = Math.sin(direction) * velocity;
      p.gravity = gravity;
      p.drag = drag;
      p.age = 0;
      p.life = rand(life[0], life[1]);
      p.size = rand(size[0], size[1]);
      p.spin = rand(0, Math.PI * 2);
      p.spinRate = rand(-9, 9);
      p.delay = over > 0 ? (Math.random() * over) / 1000 : 0;
    }
    this.run();
  }

  private take(): Particle {
    // Round-robin: when the pool is full the oldest particle is recycled, so a jackpot can never allocate.
    for (let i = 0; i < CAPACITY; i++) {
      const p = this.pool[(this.cursor + i) % CAPACITY];
      if (!p.alive) {
        this.cursor = (this.cursor + i + 1) % CAPACITY;
        this.live++;
        return p;
      }
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;
    return p;
  }

  private origin(at: EmitOrigin | undefined): { x: number; y: number } {
    if (!at) return { x: this.width / 2, y: this.height / 2 };
    if (at instanceof Element) {
      const own = this.canvas.getBoundingClientRect();
      const rect = at.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - own.left, y: rect.top + rect.height / 2 - own.top };
    }
    return { x: at.x * this.width, y: at.y * this.height };
  }

  private resolve(color: string): string {
    if (!color.startsWith("--")) return color;
    return getComputedStyle(this.canvas).getPropertyValue(color).trim() || "#ffffff";
  }

  private run() {
    if (this.frame || !this.visible || this.live === 0) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.step);
  }

  private step = (now: number) => {
    this.frame = 0;
    const context = this.context;
    if (!context) return;
    // Clamp the step: after a stall the particles continue, they do not teleport.
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    context.clearRect(0, 0, this.width, this.height);
    for (const p of this.pool) {
      if (!p.alive) continue;
      if (p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      p.age += dt;
      if (p.age >= p.life || p.y > this.height + 40) {
        p.alive = false;
        this.live--;
        continue;
      }
      const keep = p.drag ** dt;
      p.vx *= keep;
      p.vy = p.vy * keep + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.spin += p.spinRate * dt;
      this.draw(context, p);
    }
    context.globalAlpha = 1;
    if (this.live > 0 && this.visible) this.frame = requestAnimationFrame(this.step);
  };

  private draw(context: CanvasRenderingContext2D, p: Particle) {
    const t = p.age / p.life;
    const fade = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    context.fillStyle = p.color;
    if (p.shape === "spark") {
      // A bright core inside a soft halo, shrinking as it burns out.
      const r = p.size * (1 - t * 0.6);
      context.globalAlpha = fade * 0.22;
      context.beginPath();
      context.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = fade;
      context.beginPath();
      context.arc(p.x, p.y, r, 0, Math.PI * 2);
      context.fill();
    } else if (p.shape === "dust") {
      context.globalAlpha = fade * 0.5;
      context.beginPath();
      context.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      context.fill();
    } else if (p.shape === "coin") {
      // A disc seen at a turning angle: an ellipse whose height follows the spin, with a lit rim.
      const squash = Math.abs(Math.cos(p.spin));
      context.globalAlpha = fade;
      context.beginPath();
      context.ellipse(p.x, p.y, p.size, Math.max(0.6, p.size * squash), 0, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = fade * 0.55 * squash;
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.ellipse(p.x - p.size * 0.25, p.y - p.size * 0.25 * squash, p.size * 0.35, Math.max(0.3, p.size * 0.35 * squash), 0, 0, Math.PI * 2);
      context.fill();
    } else {
      // confetti: a small card tumbling about its long axis
      context.globalAlpha = fade;
      context.save();
      context.translate(p.x, p.y);
      context.rotate(p.spin * 0.6);
      context.fillRect(-p.size, (-p.size * 0.5) * Math.cos(p.spin), p.size * 2, p.size * Math.cos(p.spin));
      context.restore();
    }
  }
}

// ---------------------------------------------------------------- presets and React binding

export type ParticleController = {
  /** Raw emission, for anything the presets below do not cover. */
  emit: (options: EmitOptions) => void;
  /** A radial pop of sparks: a win landing. `power` 0..1 scales count and reach. */
  burst: (at?: EmitOrigin, power?: number, colors?: readonly string[]) => void;
  /** Coins raining from the top edge for `ms`: a big prize. */
  coinShower: (ms?: number, density?: number) => void;
  /** A fountain of coins from a point, e.g. out of a pot. */
  coinFountain: (at?: EmitOrigin, count?: number) => void;
  /** Confetti from both top corners. Use sparingly: the top prize only. */
  confetti: (count?: number) => void;
  /** A few coins dropping onto a point: tickets bought, a stake placed. */
  drop: (at?: EmitOrigin, count?: number, colors?: readonly string[]) => void;
  clear: () => void;
  /** Live particle count; 0 when idle or with reduced motion. */
  count: () => number;
  /** @internal bound by <ParticleLayer>. */
  attach: (engine: ParticleEngine | undefined) => void;
};

const GOLD = ["--gold", "--gold", "--warn", "#fff6d8"] as const;

export function createParticleController(): ParticleController {
  let engine: ParticleEngine | undefined;
  const emit = (options: EmitOptions) => engine?.emit(options);
  return {
    attach: (next) => (engine = next),
    emit,
    count: () => engine?.count ?? 0,
    clear: () => engine?.clear(),
    burst(at, power = 0.5, colors = GOLD) {
      emit({ at, count: Math.round(14 + power * 46), shape: "spark", colors, speed: [90 + power * 120, 260 + power * 420], gravity: 360, drag: 0.22, life: [0.5, 0.9 + power * 0.6], size: [1.5, 3.2 + power * 1.5] });
    },
    coinShower(ms = 2400, density = 1) {
      emit({ at: { x: 0.5, y: -0.04 }, spreadX: 1, count: Math.round((ms / 1000) * 34 * density), shape: "coin", colors: GOLD, angle: 90, cone: 40, speed: [60, 240], gravity: 900, drag: 0.7, life: [1.6, 2.6], size: [5, 9], over: ms });
    },
    coinFountain(at, count = 26) {
      emit({ at, count, shape: "coin", colors: GOLD, angle: -90, cone: 70, speed: [260, 520], gravity: 980, drag: 0.6, life: [1.1, 1.8], size: [4, 7], over: 380 });
    },
    confetti(count = 80) {
      const colors = ["--gold", "--accent", "--good", "--warn", "--text"];
      emit({ at: { x: 0.02, y: 0.02 }, count: count / 2, shape: "confetti", colors, angle: 35, cone: 50, speed: [240, 620], gravity: 520, drag: 0.35, life: [1.8, 3], size: [3, 6], over: 500 });
      emit({ at: { x: 0.98, y: 0.02 }, count: count / 2, shape: "confetti", colors, angle: 145, cone: 50, speed: [240, 620], gravity: 520, drag: 0.35, life: [1.8, 3], size: [3, 6], over: 500 });
    },
    drop(at, count = 6, colors = GOLD) {
      emit({ at, count, shape: "coin", colors, angle: 90, cone: 30, speed: [20, 90], gravity: 900, drag: 0.8, life: [0.5, 0.8], size: [3.5, 5.5], over: 260 });
    },
  };
}

/** A particle controller for one stage. Stable for the life of the component. */
export function useParticles(): ParticleController {
  return useMemo(createParticleController, []);
}

/**
 * The canvas a controller draws on. Put it last inside a `position: relative` container; it covers
 * the container, ignores the pointer and is hidden from assistive technology.
 */
export function ParticleLayer({ controller, className }: { controller: ParticleController; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const engine = new ParticleEngine(canvas);
    controller.attach(engine);
    let intersecting = true;
    const update = () => engine.setVisible(intersecting && document.visibilityState === "visible");
    const resize = new ResizeObserver(() => engine.resize());
    resize.observe(canvas);
    const observer = new IntersectionObserver(([entry]) => ((intersecting = entry.isIntersecting), update()));
    observer.observe(canvas);
    document.addEventListener("visibilitychange", update);
    return () => {
      controller.attach(undefined);
      resize.disconnect();
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      engine.destroy();
    };
  }, [controller]);
  return <canvas ref={ref} className={className ? `fx-particles ${className}` : "fx-particles"} aria-hidden="true" />;
}
