# src/fx: effects library

Small, dependency-free pieces for motion, particles, counting numbers and result moments. Built for
the Play stages; anything here may be imported by other pages. Import from `../fx` (the barrel also
loads `fx.css`). Pure helpers can be imported from their own file (`../fx/gameviz`, `../fx/motion`)
when no CSS is wanted, for example in tests.

Rules every export follows:

- **Reduced motion**: with `prefers-reduced-motion` nothing moves. Tweens jump to their end,
  particles are not emitted, screen responses do nothing, reveals take no time. Callers must show the
  result in text anyway.
- **60 fps**: only `transform`, `opacity`, `filter` and canvas drawing are animated. No layout reads
  inside a frame loop.
- **Pauses when unseen**: the particle loop runs only while particles are alive and the layer is on
  screen in a visible tab.
- **Tokens only**: colours come from the design tokens (`var(--gold)`, `--accent`, …).
- **Honesty** (DESIGN.md): gold, particles and win sounds are for results that pay more than the
  wager. `resultTone()` is the single place that decides it.

## motion.ts

| Export | What it is |
| --- | --- |
| `prefersReducedMotion()` / `useReducedMotion()` | The system setting, as a function and as a reactive hook. |
| `ease.{linear,inQuad,outQuad,outCubic,inOutCubic,outQuart,outExpo,outBack}` | Easing curves `(t) => number`, 0..1. |
| `spring(t, bounces = 2, damping = 6)` | A damped spring 0→1 as a closed-form curve; exactly 1 at `t = 1`. |
| `bounceHeight(t, bounces = 3, restitution = 0.38)` | Height (1→0) of a dropped body that bounces and is at rest at `t = 1`. |
| `tween({ duration, ease, delay, onUpdate, onDone })` | A rAF tween 0→1; returns a cancel function. |
| `wait(ms)` | A promise for sequencing; resolves at once with reduced motion. |
| `useOnScreen(ref)` | True while the element is in view and the tab is visible. |
| `clamp`, `lerp` | The usual. |

## particles.tsx

```tsx
const particles = useParticles();
return (
  <div style={{ position: "relative" }}>
    …
    <ParticleLayer controller={particles} />   {/* last child; covers the parent, ignores the pointer */}
  </div>
);
// later, in an event handler or effect:
particles.burst(element, 0.6);        // sparks from an element (or { x, y } as fractions of the layer)
particles.coinShower(2400, 1);        // coins from the top edge for 2.4 s
particles.coinFountain(element, 26);  // coins thrown up from a point
particles.confetti(80);               // both top corners; the top prize only
particles.drop(element, 6);           // a few coins falling onto a point
particles.emit({ … });                // raw: shape "spark" | "coin" | "confetti" | "dust", colours, speed, gravity, life, size
```

One canvas, a pool of 360 particles allocated once; when the pool is full the oldest is recycled.
`particles.count()` is the number alive (0 with reduced motion).

## count.tsx

- `<CountUp value={n} format={(v) => v.toFixed(2)} duration={700} from={0} onTick={…} />`: counts
  from the value shown to the new one. The element is as wide as its final text from the first frame
  (no layout shift), the moving digits are hidden from assistive technology and the final value is
  what is read.
- `<AmountCount wei={x} text={eth(x)} />`: the same for an 18-decimal amount; the last frame is
  exactly `text`.

## response.ts

`shake(el, strength, ms)`, `thump(el, depth)`, `pop(el, scale)`, `flash(el, color, peak, ms)` (the
element must be positioned), `glowPulse(el, color)`, `vibrate(pattern)`. Web Animations API; they
clean up after themselves.

## presence.tsx

`usePresence(present, exitMs)` → `{ mounted, phase }` keeps an element mounted while it leaves.
`<Presence show kind="fade" | "rise" | "drop" | "scale" delay={ms}>` wraps a child with enter and exit
animations.

## reveal.ts: pending → reveal → outcome

A settled result reaches the app before the stage has shown it. `observeReveal(key, state, revealMs)`
is called while rendering with what the data says (`"pending"`, `"settled"`, `"other"`) and returns
the phase to draw: `"pending"`, `"revealing"` (known, but the stage is still showing it arrive: do not
display it anywhere else), `"done"`. A result is only held back if this page saw it pending.
`revealMs` is a constant per game, never per outcome. `useRevealClock()` re-renders a component when
any reveal ends; `revealElapsed(key)` lets an animation resume mid-way.

## widgets.tsx

- `<Countdown seconds total? label? done? />`: big tabular digits, `role="timer"`.
- `<ShareRing share outer? tone label>…centre…</ShareRing>`: a ring filled to a share (0..1).
- `<TokenEmblem collection tokenId />`: a generated emblem for a token the app has no artwork for. It
  is labelled as an emblem, not the artwork.
- `<DrawTapeView count ticket phase startedMs mine onStep onLand />`: the draw of a ticket number
  (`"still" | "rolling" | "landing" | "landed"`).

## gameviz.ts: what a result looks like

Pure functions, tested in `test/gameviz.test.ts`:

- `reelWindow(roll)`: the 3×3 window the slot reels rest on. The middle row is `slotsLine(roll)`; the
  rows above and below never contain the top symbol, never a pair or three of a kind, and never repeat
  the payline symbol of their reel. Checked for all 10,000 rolls.
- `REEL_STOP_MS`, `REEL_SETTLE_MS`, `SLOTS_REVEAL_MS`, `DICE_TUMBLE_MS`, `DICE_REVEAL_MS`,
  `DRAW_TAPE_MS`, `DRAW_REVEAL_MS`: reveal timings. Constants: no timing depends on the outcome.
- `resultTone(payout, wager, multiple)`: `"loss" | "returned" | "win" | "big" | "jackpot"`. Only a
  payout above the wager is a win of any size.
- `dieFace(roll)`, `DIE_ROTATION`, `diceMultiple(chanceBps, edgeBps)`.
- `drawTape(ticket, ticketsSold)`, `tapeProgress(t)`: the tape counts tickets in natural order and
  stops on the real winning ticket.
- `potVessel(pot, minPot)`, `tugShare(higher, lower)`, `stakePayout(…)`, `claimValue(…)`, `percent`,
  `hueOf`.

## Sound (src/lib/sound.ts)

Not in this folder, but the same family: `sound.click()`, `tick(pitch)`, `stake()`, `lever()`,
`spinStart()` / `spinStop()`, `reelStop(i)`, `dieRoll()`, `dieBounce(n)`, `coinToss()`, `coinLand()`,
`coinTumble(seconds)`, `drumStart()` / `drumStop()`, `drawLand()`, `ticket()`, `whoosh()`, `snap()`,
`win(multiple)`, `returned()`, `loss()`, `refund()`, `error()`, `countTick()`, `buzz(pattern)`.
All WebAudio, no files; silent until the header toggle turns sound on. `soundStatus()` reports the
AudioContext state for diagnostics.
