# FloorGuard front end: design notes

Working notes for whoever continues this. Keep them short and true.

## Identity: "guard the floor", a vault at night

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

- `#/` landing (outward-facing) · `#/app` overview dashboard · Trade · Vault · Play · Fairness.
- Routes are in `src/routes.ts`; each page is a lazy chunk.
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
