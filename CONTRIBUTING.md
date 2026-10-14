# Contributing to FloorGuard

Thank you for looking. FloorGuard is an unaudited prototype built in the open,
and the most useful help is listed in section 15 of the
[design paper](docs/FLOORGUARD-V1.md#15-how-to-contribute): security review,
mechanism design, front end, operations, legal, and NFT communities that want a
home venue.

## Where to start

- Read the [README](README.md) and the [design paper](docs/FLOORGUARD-V1.md).
- Pick an issue labelled `help wanted` or `good first issue`, or one of the
  [open problems](docs/FLOORGUARD-V1.md#13-open-problems), and say in the issue
  that you are looking at it.
- For a larger change, open an issue first so the approach can be discussed
  before you write it.

## Working on the code

| Part | Where | Checks to run |
|---|---|---|
| Contracts | `src/`, `test/` | `forge fmt` and `forge test` |
| Web app | `app/` | `npm test` and `npm run typecheck` |
| Keeper bot | `keeper/` | `npm test` and `npm run typecheck` |
| Economics models | `test/econ/` | `python3 test/econ/<model>.py` |
| Design paper | `docs/FLOORGUARD-V1.md`, `paper/` | see `paper/README.md` |

The README explains how to run everything against a local chain. CI runs the
same checks on every pull request.

- Add tests for behaviour you change. Contract changes need unit tests, and
  fuzz or invariant tests where state can be reached in many orders.
- Keep the docs true: if a change alters what a contract does, update
  `docs/ARCHITECTURE.md`, and `SECURITY.md` if it changes a limitation.
- Write plainly. The docs state limits as clearly as features; please keep it
  that way.

## Reporting a vulnerability

Do not open a public issue. Report it privately as described in
[SECURITY.md](SECURITY.md).

## What this project is not

FloorGuard is not raising money and has nothing to buy. There is no token
today. Contributions are welcome as contributions, not as investments, and
nothing here is financial advice. Games, lotteries and paid raffles are
regulated or prohibited in many places.

By contributing you agree that your contributions are licensed under the
[MIT licence](LICENSE).
