# FloorGuard front end: design notes

Working notes for whoever continues this. Keep them short and true.

## Identity: "guard the floor", a vault at night

Dark is the hero look and the default for a first visit (`index.html` sets `data-theme` before first
paint; `src/theme.ts` remembers a choice). The name stays; the copy does not promise that a floor is
defended. The docs say the protocol "spends its fees on buying the cheapest tokens" and that the
effect is modest, so the headline is "Fees that buy the floor", not "guards".

- **Base**: deep blue-black (`--bg`), surfaces one and two steps lighter. Light theme is "the vault by
  day": warm paper, dark ink, the same accents darkened for contrast. It is designed, not inverted.
- **Signature accent** (`--accent`): electric mint. Used for the floor line, primary actions, focus.
- **Gold** (`--gold`): reserved for prizes and results that return MORE than the wager. Nothing else.
- **Floor line**: a glowing horizontal rule. Things rest on it (cards, the hero), rise from it (the
  bid), are defended at it. Class `.floorline`; the logo is a shield cut by it.
- **Type**: Space Grotesk (bundled through `@fontsource-variable/space-grotesk`, OFL) for headings and
  every number; system UI for body text. `font-variant-numeric: tabular-nums` wherever money shows.
- Tokens live at the top of `src/styles.css`. Components use tokens only.

## Structure

- `#/` landing (outward-facing) · `#/app` overview dashboard · Trade · Vault · Play (with "The
  house") · Fairness.
- Routes are in `src/routes.ts`; each page is a lazy chunk. A route with `ownHead` draws its own
  heading with `PageHead` (eyebrow, the one h1, a sentence); the shell then does not repeat the label.
  A page may carry a selection in the hash query (`#/vault/licences?holding=2`, `useRouteParam`).
- Styles: `src/styles.css` is tokens, base components and the shell; `src/styles/world.css` is the
  landing, overview, trade, vault, fairness and house pages and everything in `src/viz/`;
  `src/styles/play.css` belongs to the Play stages.
- Modes: **Demo** (simulated in the browser, default when no deployment is reachable) and **Live**
  (a chain with a deployment). The demo is always labelled "Demo: simulated, play money".

## One implementation of the game maths

`src/lib/gameMath.ts` holds fee, stake, dice payout, the slots table and pot splits. The live path
(previews, verify) and the demo simulator (`src/demo/`) both import it; `test/` checks it against the
contracts' numbers.

## Honesty rules (do not break)

- Reels show exactly what the roll maps to. No staged near-misses.
- A result that returns less than or equal to the wager is never celebrated. Slots 1x is "stake
  returned", neutral. Gold and particles only when payout > wager.
- Cost, edge and odds are always on screen next to the action; the session net is always visible.
- No fake activity, urgency or jackpots. No "provably fair" label while the provider is the mock.
- Reduced motion gets the full information without the movement.

## The shell

- **One rail for the standing notices.** "Unaudited…" and "Demo: simulated, no real transactions,
  play money" share one sticky rail: side by side from 940 px, two one-line rows below. They are
  never hidden. The landing shows the demo strip too, because what moves there is the simulation.
- **Header.** The section links have an ink line that slides to the current section. Sticky with a
  blur from 940 px; in the demo a section with a single page has no second row.
- **Phones (≤ 720 px).** The sections move to a thumb bar at the bottom (`.tab-bar`), sound and theme
  fold into one "more" menu, the play balance sits beside the sub-navigation, and inside the app the
  wordmark gives way to the mark. At 375 px the chrome is the rail (44 px) plus 50 to 86 px of header.
- **Pages arrive** with a 0.36 s rise (`.route-view`, keyed by route). Buttons lift on hover and
  press down; focus is a 2 px accent ring with a soft halo.
- **The review dialog** (`src/tx.tsx`) is a moment: an eyebrow ("Review before signing", or "Review ·
  demo, nothing is signed"), an optional picture of who receives what (`options.preview`), the
  numbered consequences, then progress and a drawn seal.
- `Empty` has a small picture (nothing rests on the floor line yet); `Skeleton` shimmers in the accent.

## Visualisations (`src/viz/`)

| File | What it is |
|---|---|
| `curves.ts` | Pure maths: the bid curve and the budget-limited bid, base after a sale, saw-tooth segments, the vault's moving lock (required floor and draw chance by age, the weekly cap), the auction price, the sale split, scales. Mirrors the contracts; tested in `test/viz.test.ts`. |
| `flywheelModel.ts` | The landing page's explainer model: the contracts' rules with example amounts. Pure, tested. |
| `Flywheel.tsx` | The system diagram (SVG), three layouts: `wide` (landing), `strip` (overview), `tall` (phones). `emit(flow)` sends one particle. |
| `HeroScene.tsx` | The landing hero (canvas): floor line as horizon, the demo vault's holdings on it, the demo bid rising. |
| `charts.tsx` | `BidChart`, `AuctionChart` (log scale: each halving is one equal step), `HouseChart` (steps per event), `bidState`. |
| `parts.tsx` | `TokenTile` (a placeholder pattern from the token id; no artwork is loaded), `TimeLockDial`, `DrawDial`, `PriceLockGauge`, `SplitBar`, `StatePlate`. |
| `FairnessWalk.tsx` | Request → proof → roll → payout, operated with a sample number from the browser. |
| `motion.tsx` | `useFrame` (pauses off-screen and in hidden tabs), `Num` (count-up without layout shift), `useClock`, reduced-motion helpers. |
| `data.ts` | Reads the visualisations need on top of `lib/reads.ts`. |

Rules for anything that moves:

- **A particle is an event.** The flywheel has no ambient traffic. A dot travels when a fee reached
  the budget, a sale was paid, a token went to the vault or proceeds came back; on the overview that
  is a real change in the budget, on the landing a button the visitor pressed.
- **Say which numbers are which.** The hero reads the demo simulation (labelled); the landing story
  is an explainer model with example amounts (labelled "not the demo, not a chain"); the fairness
  walk uses a sample number from the browser (labelled "not a draw").
- **The curve and the bid are two things.** The curve is where the rule has taken the price; the bid
  is what a seller is paid, never more than the budget holds and nothing below the minimum bid. A
  budget-limited bid is a state of its own (amber, hatched ceiling, the curve dashed above it), and a
  curve restart is drawn where it happened.
- **History, not forecasts.** The bid's projection is its rule and is dashed; while the budget cannot
  cover the curve no projection is drawn. The house's share price is drawn from events only.
- **60 fps or nothing.** Canvas for the hero, attribute writes for particles, transforms and opacity
  in CSS. Loops stop off-screen and in hidden tabs. Charts re-render about ten times a second while
  visible, once a second under reduced motion.
- **Reduced motion** keeps every figure and state: the hero redraws once a second with nothing
  drifting, particles become a flash and a label, count-ups jump, the story's auction is stepped by
  the visitor.

## Words that must stay true

- Not "floor support", not "guards", not "earn". The house page is not a yield product: no APY, no
  projection, and it says holders can lose part or all of what they put in.
- Games: half of the 2% edge goes to buybacks by default; the bankroll keeps the other half.
- "Provably fair" means only that the draw can be checked; the expected return of every game is
  negative, and the page says so.
- The status panel on the landing quotes `SECURITY.md` and `docs/AUDIT.md`. When those change, it
  changes.

## Effects for the Play stages (`src/fx/`)

A small, dependency-free library: motion primitives, a particle layer, counting numbers, screen
responses, presence, the reveal clock and the pure functions that decide what a stage draws from a
settled result (`gameviz.ts`). Its API and rules are in [src/fx/README.md](src/fx/README.md);
`test/gameviz.test.ts` checks that what the stages draw is a pure function of the result.

- **The reveal clock** (`fx/reveal.ts`) is shared: a result that reached the app is not shown
  anywhere else until the stage has finished showing it. The play balance in the header observes the
  same clock, so it never gives a result away early.
- **Class names.** `styles.css` holds tokens, base components and the shell; page styles live in
  `styles/world.css` and `styles/play.css`. Page-specific classes carry a prefix for their page or
  component (`lp-`, `story-`, `fly-`, `ov-`, `bid-`, `vault-`, `auction-`, `licence-`, `market-`,
  `house-`, `vessel-`, `walk-`), so the two files cannot collide. Some older classes in `world.css`
  are still unprefixed (`.figure`, `.holding`, `.rung`, `.stream`, `.fuel`, `.chart`); prefix them
  when you next touch them.

## Development aids

`?always-visible` keeps animation loops running in a tab the browser reports as hidden (an embedded
preview pane); `?reduce-motion` takes the script-driven calm path. On the Play stages, in a
development build only, `window.__fgPreview.*` (for example `__fgPreview.dice(roll, percent)`, and
the hooks the slots and lottery stages register) plays a result moment with a chosen roll, without
placing a bet, to look at a rare outcome. All of these are ignored in a production build.
