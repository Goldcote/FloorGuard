// Sound, synthesised with WebAudio: no audio files. Off until the visitor turns it on (the click
// that does so is the user gesture browsers require before audio may start).
let context: AudioContext | undefined;
let enabled = false;
const listeners = new Set<() => void>();

export const soundEnabled = () => enabled;
export const subscribeSound = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

export function setSound(on: boolean) {
  enabled = on;
  if (on) {
    context ??= new AudioContext();
    void context.resume();
    tone(660, 0.07);
  }
  listeners.forEach((fn) => fn());
}

function tone(frequency: number, seconds: number, type: OscillatorType = "sine", gain = 0.05, delay = 0) {
  if (!enabled || !context) return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  volume.gain.setValueAtTime(gain, start);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  oscillator.connect(volume).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + seconds);
}

export const sound = {
  click: () => tone(520, 0.04, "triangle", 0.03),
  /** A reel or a die coming to rest. */
  stop: () => tone(180, 0.09, "square", 0.04),
  /** A result that pays more than the wager. */
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, "triangle", 0.05, i * 0.09)),
  /** A result that returns the stake or nothing: deliberately plain. */
  settle: () => tone(300, 0.12, "sine", 0.03),
  /** Light haptic feedback on a win, where the device supports it. */
  buzz: () => {
    if (enabled && "vibrate" in navigator) navigator.vibrate?.([30, 40, 60]);
  },
};
