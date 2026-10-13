// The sound set, synthesised with WebAudio: no audio files, nothing fetched.
//
// Off until the visitor turns it on with the header toggle. That click is the user gesture browsers
// require before audio may start, and the AudioContext is not even created before it. Every sound is
// a few oscillators and filtered noise through one master bus (gain, then a gentle compressor so a
// jackpot cannot clip). Loops (reel spin, lottery drum) are started and stopped by name and always
// stop when sound is turned off.
//
// Honesty rule carried into audio: the bright rising stingers belong to results that pay more than
// the wager. A returned stake and a loss get short, plain, neutral tones.

let context: AudioContext | undefined;
let master: GainNode | undefined;
let noiseBuffer: AudioBuffer | undefined;
let enabled = false;
let played = 0;
const listeners = new Set<() => void>();
const loops = new Map<string, () => void>();

export const soundEnabled = () => enabled;
export const subscribeSound = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** For diagnostics and tests: whether sound is on, the AudioContext state, voices started so far, loops running. */
export const soundStatus = () => ({ enabled, state: context?.state ?? "none", played, loops: [...loops.keys()] });

export function setSound(on: boolean) {
  enabled = on;
  if (on) {
    if (!context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        context = new Ctor();
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.2;
        master = context.createGain();
        master.gain.value = 0.55;
        master.connect(compressor).connect(context.destination);
      }
    }
    void context?.resume();
    sound.toggle();
  } else {
    stopAllLoops();
  }
  listeners.forEach((fn) => fn());
}

function stopAllLoops() {
  loops.forEach((stop) => stop());
  loops.clear();
}

/** The context when sound may play right now, resuming it if the browser suspended it. */
function live(): { ctx: AudioContext; out: GainNode } | undefined {
  if (!enabled || !context || !master) return undefined;
  if (context.state === "suspended") void context.resume();
  return { ctx: context, out: master };
}

function noise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

type ToneOptions = {
  type?: OscillatorType;
  /** Seconds from now. */
  at?: number;
  /** Seconds. */
  length?: number;
  gain?: number;
  /** Glide to this frequency over the length. */
  to?: number;
  attack?: number;
};

/** One enveloped oscillator: quick attack, exponential decay. */
function tone(frequency: number, { type = "sine", at = 0, length = 0.12, gain = 0.2, to, attack = 0.004 }: ToneOptions = {}) {
  const audio = live();
  if (!audio) return;
  const { ctx, out } = audio;
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (to) oscillator.frequency.exponentialRampToValueAtTime(to, start + length);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + attack);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(volume).connect(out);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
  played++;
}

type HissOptions = {
  at?: number;
  length?: number;
  gain?: number;
  filter?: BiquadFilterType;
  frequency?: number;
  /** Sweep the filter to this frequency over the length. */
  to?: number;
  q?: number;
};

/** One enveloped burst of filtered noise: clicks, knocks, whooshes. */
function hiss({ at = 0, length = 0.08, gain = 0.2, filter = "bandpass", frequency = 1200, to, q = 1.2 }: HissOptions = {}) {
  const audio = live();
  if (!audio) return;
  const { ctx, out } = audio;
  const start = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  source.loop = true;
  const biquad = ctx.createBiquadFilter();
  biquad.type = filter;
  biquad.Q.value = q;
  biquad.frequency.setValueAtTime(frequency, start);
  if (to) biquad.frequency.exponentialRampToValueAtTime(to, start + length);
  const volume = ctx.createGain();
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.01, length / 4));
  volume.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(biquad).connect(volume).connect(out);
  source.start(start, Math.random() * 0.5);
  source.stop(start + length + 0.02);
  played++;
}

/** A struck piece of metal: two inharmonic partials ringing out. Coins, bells. */
function ping(frequency: number, at = 0, gain = 0.12, length = 0.35) {
  tone(frequency, { at, length, gain, type: "sine" });
  tone(frequency * 1.506, { at, length: length * 0.7, gain: gain * 0.55, type: "sine" });
  tone(frequency * 2.42, { at, length: length * 0.35, gain: gain * 0.3, type: "triangle" });
}

/** A knock on wood or felt: a pitched thump with a click on top. */
function knock(frequency: number, at = 0, gain = 0.25) {
  tone(frequency, { at, length: 0.09, gain, to: frequency * 0.55, type: "sine" });
  hiss({ at, length: 0.03, gain: gain * 0.5, filter: "highpass", frequency: 1800 });
}

/**
 * A noise bed with a rhythmic pulse, running until stopped: the reel spin and the lottery drum.
 * `rate` is the clatter per second, `colour` the band the noise sits in.
 */
function startLoop(name: string, { rate, colour, gain, hum }: { rate: number; colour: number; gain: number; hum: number }) {
  const audio = live();
  if (!audio || loops.has(name)) return;
  const { ctx, out } = audio;
  const now = ctx.currentTime;
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  source.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = colour;
  band.Q.value = 0.8;
  const volume = ctx.createGain();
  volume.gain.setValueAtTime(0.0001, now);
  volume.gain.exponentialRampToValueAtTime(gain, now + 0.18);
  // the clatter: a square LFO chopping the bed
  const lfo = ctx.createOscillator();
  lfo.type = "square";
  lfo.frequency.value = rate;
  const depth = ctx.createGain();
  depth.gain.value = gain * 0.6;
  lfo.connect(depth).connect(volume.gain);
  const low = ctx.createOscillator();
  low.type = "triangle";
  low.frequency.value = hum;
  const lowVolume = ctx.createGain();
  lowVolume.gain.setValueAtTime(0.0001, now);
  lowVolume.gain.exponentialRampToValueAtTime(gain * 0.9, now + 0.25);
  source.connect(band).connect(volume).connect(out);
  low.connect(lowVolume).connect(out);
  source.start();
  lfo.start();
  low.start();
  played++;
  loops.set(name, () => {
    const end = ctx.currentTime;
    for (const node of [volume, lowVolume]) {
      node.gain.cancelScheduledValues(end);
      node.gain.setTargetAtTime(0.0001, end, 0.04);
    }
    depth.gain.setTargetAtTime(0.0001, end, 0.03);
    for (const node of [source, lfo, low]) node.stop(end + 0.3);
  });
}

function stopLoop(name: string) {
  loops.get(name)?.();
  loops.delete(name);
}

// Notes of a major pentatonic scale from C5: a win stinger can only climb through pleasant notes.
const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093];
let lastCountTick = 0;

export const sound = {
  /** The toggle itself: a short rising pair that confirms audio is live. */
  toggle: () => (tone(660, { length: 0.07, gain: 0.12, type: "triangle" }), tone(990, { at: 0.07, length: 0.1, gain: 0.1, type: "triangle" })),
  /** A button or chip press. */
  click: () => (hiss({ length: 0.025, gain: 0.12, filter: "highpass", frequency: 2600 }), tone(420, { length: 0.04, gain: 0.08, type: "triangle", to: 300 })),
  /** A soft detent: a slider step, a ticket passing the pointer. `pitch` 0..1 raises it. */
  tick: (pitch = 0.5) => tone(900 + pitch * 900, { length: 0.035, gain: 0.09, type: "triangle", to: 600 + pitch * 500 }),
  /** Placing a stake: a chip set down. */
  stake: () => (knock(260, 0, 0.16), ping(1900, 0.01, 0.04, 0.12)),

  // ---- slots
  /** The lever: a spring release into the spin. */
  lever: () => (hiss({ length: 0.22, gain: 0.14, frequency: 500, to: 2400, q: 2 }), tone(110, { length: 0.16, gain: 0.2, to: 60 })),
  spinStart: () => startLoop("reels", { rate: 17, colour: 620, gain: 0.07, hum: 82 }),
  spinStop: () => stopLoop("reels"),
  /** A reel locking into place; each later reel a little higher, the same for every outcome. */
  reelStop: (index = 0) => (knock(150 + index * 22, 0, 0.3), tone(74 + index * 8, { length: 0.14, gain: 0.22, type: "triangle", to: 50 })),

  // ---- dice and coin
  /** The die leaving the hand: a few rattles, slowing. */
  dieRoll: () => [0, 0.07, 0.15, 0.25, 0.37].forEach((at, i) => knock(520 - i * 40 + Math.random() * 60, at, 0.1)),
  /** One bounce of the die on the floor line; `index` counts the bounces, each softer. */
  dieBounce: (index = 0) => knock(230 - index * 30, 0, Math.max(0.06, 0.28 - index * 0.08)),
  /** The coin flicked into the air: the thumbnail's ping and the ring of the spin. */
  coinToss: () => (ping(2350, 0, 0.14, 0.9), hiss({ length: 0.3, gain: 0.05, frequency: 1500, to: 5000, q: 3 })),
  /** The coin landing and rattling flat. */
  coinLand: () => [0, 0.09, 0.16, 0.21, 0.25].forEach((at, i) => ping(2100 + i * 60, at, Math.max(0.03, 0.13 - i * 0.025), 0.14)),
  /** Loose coins tumbling out: accompanies a coin shower. `seconds` is how long they fall. */
  coinTumble: (seconds = 1.2) => {
    const coins = Math.round(seconds * 14);
    for (let i = 0; i < coins; i++) ping(1700 + Math.random() * 1500, (i / coins) * seconds + Math.random() * 0.04, 0.03 + Math.random() * 0.04, 0.16);
  },

  // ---- lottery and raffles
  drumStart: () => startLoop("drum", { rate: 9, colour: 320, gain: 0.08, hum: 58 }),
  drumStop: () => stopLoop("drum"),
  /** The pointer stopping on the drawn ticket. */
  drawLand: () => (knock(190, 0, 0.3), ping(1320, 0.02, 0.1, 0.5)),
  /** A ticket torn off the roll. */
  ticket: () => hiss({ length: 0.09, gain: 0.1, filter: "highpass", frequency: 3000, to: 1400 }),
  /** Air moving: something large sliding in. */
  whoosh: () => hiss({ length: 0.34, gain: 0.1, frequency: 300, to: 2600, q: 0.9 }),

  // ---- predictions
  /** The rope going taut and the market deciding. */
  snap: () => (hiss({ length: 0.05, gain: 0.25, filter: "highpass", frequency: 2000 }), tone(160, { length: 0.3, gain: 0.25, to: 55 })),

  // ---- results
  /**
   * A result that pays more than the wager. The stinger grows with the multiple: a short climb for a
   * small win, a longer run with a chord for a big one, a fanfare with bells for the top prize.
   */
  win: (multiple = 2) => {
    const notes = multiple >= 50 ? 11 : multiple >= 10 ? 8 : multiple >= 5 ? 6 : multiple >= 2 ? 4 : 3;
    const step = multiple >= 50 ? 0.085 : 0.075;
    const loud = Math.min(0.2, 0.11 + notes * 0.008);
    for (let i = 0; i < notes; i++) {
      tone(SCALE[i], { at: i * step, length: 0.26, gain: loud, type: "triangle" });
      tone(SCALE[i] * 2, { at: i * step, length: 0.12, gain: loud * 0.25 });
    }
    const end = notes * step;
    // the landing chord: root, third, fifth of where the climb ended
    if (multiple >= 5) [0, 2, 3, 5].forEach((n) => tone(SCALE[n], { at: end, length: 0.9, gain: loud * 0.7, type: "triangle", attack: 0.02 }));
    if (multiple >= 10) (ping(2093, end, 0.1, 1.2), ping(1568, end + 0.12, 0.08, 1.1));
    if (multiple >= 50) {
      // jackpot: the climb again an octave up, bells, and the coins
      for (let i = 0; i < 8; i++) tone(SCALE[i + 3], { at: end + 0.35 + i * 0.07, length: 0.3, gain: 0.14, type: "triangle" });
      [0, 0.5, 1.0, 1.5].forEach((at, i) => ping(1046.5 * (i % 2 ? 1.5 : 2), end + 0.9 + at, 0.11, 1.4));
      sound.coinTumble(2.6);
    }
  },
  /** A stake that came back, less the fee: two level notes. Deliberately not a win sound. */
  returned: () => (tone(392, { length: 0.11, gain: 0.1, type: "triangle" }), tone(392, { at: 0.13, length: 0.14, gain: 0.08, type: "triangle" })),
  /** A loss: one soft falling tone. No sting, no ridicule. */
  loss: () => tone(233, { length: 0.26, gain: 0.11, to: 165, attack: 0.02 }),
  /** A refund or a voided market: neutral, level, closing. */
  refund: () => (tone(440, { length: 0.1, gain: 0.09 }), tone(330, { at: 0.11, length: 0.18, gain: 0.08 })),
  /** Something was refused. */
  error: () => (tone(150, { length: 0.1, gain: 0.14, type: "square" }), tone(120, { at: 0.12, length: 0.16, gain: 0.14, type: "square" })),
  /** The tick of a counting number, limited to about 28 a second however often it is called. */
  countTick: () => {
    const now = performance.now();
    if (now - lastCountTick < 36) return;
    lastCountTick = now;
    tone(1500, { length: 0.02, gain: 0.035, type: "square" });
  },
  /** Haptic feedback on a win, where the device supports it. Follows the sound toggle. */
  buzz: (pattern: number[] = [30, 40, 60]) => {
    if (enabled && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(pattern);
  },
};
