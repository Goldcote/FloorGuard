# FloorGuard app

Web front end for the FloorGuard protocol: Vite + React + TypeScript, wagmi v2 + viem.

> Unaudited experimental software. Do not use with real funds.

It has two modes, switched in the header:

- **Demo** (the default when no local chain answers): a simulated protocol that runs entirely in the
  browser tab, with play money and no wallet. It follows the contracts' rules through the same maths
  module the live path uses (`src/lib/gameMath.ts`), settles with a seeded pseudo-random generator,
  and runs its clock 600 times faster than real time so rounds end while you watch. It mirrors the
  contracts' current rules: a bid that is the curve limited by the budget, a minimum bid, a curve
  that restarts when money reaches a budget that could not cover it, points credited once per fee,
  the prediction markets' dead band and short betting window, the games' wager cap and bankroll
  share, house shares, the vault's moving lock (daily floor samples and their median, a daily draw
  with a chance rising with age, a required floor falling with age, the weekly release cap, one
  purchase in five set aside for players and raffled after 30 days; a simulated keeper does the
  daily steps later in each simulated day if the visitor has not), prize vesting, and the vault
  raffle's minimum of activated points. It is labelled
  "Demo: simulated, no real transactions, play money" on every page and is not fair play.
- **Live**: a real chain through wagmi and viem. There is no analytics, no CDN, no remote font or
  image, and no backend. What the browser contacts: the page's own origin (the bundle), and the
  JSON-RPC endpoint of the selected chain, which is that chain's public RPC unless a
  `VITE_<CHAIN>_RPC_URL` was set at build time. A connected browser wallet makes its own requests,
  which are not the app's. With WalletConnect enabled at build time, its SDK contacts
  WalletConnect/Reown servers. A link to a block explorer is only followed when clicked. CCIP-Read
  is switched off, so a contract cannot make the app fetch a URL. A development build (and only a
  development build, or one built with `VITE_ENABLE_LOCAL=1`) also talks to a local node on a
  loopback address; see "Local development is not in a production build" below.

The pages (hash routes, each a lazy chunk): `#/` landing · `#/app` overview · Trade (marketplace,
floor bid) · Vault (holdings and auctions, licences, vault raffles) · Play (dice, slots, lottery,
ticket raffles, predictions, the house) · Fairness. Design decisions are recorded in
[DESIGN.md](DESIGN.md). The theme is dark on a first visit; the toggle's choice is remembered.

What each of the non-game pages shows:

- **Landing**: a hero drawn from the demo simulation (the bid rising towards the floor line, the
  demo vault's holdings resting on it), a scroll-driven, operable diagram of the flywheel running on
  an explainer model with example amounts, the games, a fairness walkthrough, and the project's
  status as `SECURITY.md` and `docs/AUDIT.md` state it.
- **Overview**: the flywheel with the collection's real numbers (a dot travels only when the budget
  or the vault changed), key figures, next actions and the event stream.
- **Floor bid**: the curve over time with sales and restarts, the cap, the minimum bid, the budget
  as a ceiling and as fuel. The curve and the bid are told apart: "the curve is at X; the budget can
  pay Y, so the bid is Y". In the demo the chart has the whole history; on a chain it draws the
  climb that is running now.
- **Vault**: the moving lock. The day's unlock draw (requested, waiting, what it picked), each
  collection's 30-day median floor, today's sample and its weekly release cap, with buttons for the
  permissionless steps (take today's floor sample, request today's draw). Each holding with its state,
  age, the date it joins the draw, its chance in today's draw, the floor its age requires against the
  median, whether it was picked today, and Unlock when all of that holds; players' holdings with
  their 30-day countdown and "Send to the players' raffle"; its licence tiers; and each auction as a
  falling price on a log scale with the reserve as the floor line. Vault raffle prizes show until
  when they vest, and Claim only once they can be claimed.
- **Marketplace**: collection offers as a ladder (the protocol's own bid sits in it at its price),
  single-token offers, and a preview of who receives what before accepting or offering.
- **The house** (`#/play/house`): the games bankroll (free, set aside for open bets, wagers in
  play), the fair value of a share over time from events, and your shares. Deposits and
  redemptions are requests: the page shows each one's state ("requested, waiting for N open bets to
  finish", "ready", or "waiting for a quieter moment" when carrying it out now would give up more
  against fair value than the limit you set), the fair value next to what carrying it out right
  now gives, the spread between the two, and a "most I will give up" control (0.5% by default)
  that the contract enforces. It is not a yield product and does not look like one.
- **Fairness**: the request → proof → roll → payout walk, the rules with each game's expected
  return, and the live status of the four conditions the claim depends on.

## Wallets and chains

- **Browser wallets** are discovered through EIP-6963 and listed by their own name and icon (Rabby
  first when present). The generic "Browser wallet" entry appears only when no wallet announced
  itself. A MetaMask-branded entry whose provider is really Rabby is hidden when Rabby is listed too.
  The last wallet reconnects on reload.
- **Local test account** (chain 31337 only): see below. It never reconnects by itself.
- **Safe**: when the app runs inside an iframe (opened as a Safe App), wagmi's `safe` connector is
  added, restricted to `app.safe.global`. It talks to the parent Safe window by `postMessage`; it is
  not created otherwise. Framed by any other origin the app refuses to render (`src/lib/frame.ts`):
  it checks `location.ancestorOrigins`, or the referrer where a browser has none. That is a second
  line only; the deployment must send the `frame-ancestors` header (see "Deploying" below).
- Every wallet's name, icon and identifier (rdns) are what the wallet says about itself. The menu
  shows the identifier next to the name, lists wallets alphabetically, puts Rabby first only when
  its provider itself reports `isRabby`, and warns when two wallets announced the same identifier.
- **WalletConnect** is off unless `VITE_WALLETCONNECT_PROJECT_ID` is set at build time. When enabled,
  using it loads the WalletConnect SDK (a separate chunk bundled with the app) which connects to
  WalletConnect/Reown's relay and API servers and may load its modal's assets from their servers.
  Those are third-party network calls; the exact list is theirs and has not been audited here.
- **Chains**: anvil, Ethereum, Sepolia, Base and Base Sepolia, each on its public RPC unless
  `VITE_MAINNET_RPC_URL`, `VITE_SEPOLIA_RPC_URL`, `VITE_BASE_RPC_URL` or `VITE_BASE_SEPOLIA_RPC_URL`
  is set. A chain without a `deployments/<chainId>.json` shows "No deployment found for this chain"
  and is never queried.

Real Rabby and MetaMask extensions have not been tested. For development, opening the dev server with
`?mock-wallets` in the URL (for example `http://localhost:5173/?mock-wallets#/app`) announces two
fake EIP-6963 wallets named like Rabby and MetaMask that proxy to anvil's unlocked accounts;
`?mock-wallets=impersonate` adds a MetaMask-branded entry backed by the fake Rabby. The module
(`src/dev/mockWallets.ts`) is not part of a production build.

## Fairness and Verify

Every settled bet, spin, lottery round and ticket raffle has a **Verify** button: it reads the
events, recomputes the payout step by step in the browser and shows it next to what the contract
paid, with the settlement transaction (linked to the block explorer on chains that have one). The
**Fairness** page explains the rules from `docs/FAIRNESS.md` and shows, for the connected chain, each
module's randomness provider and whether it is the local mock, who owns Games and whether that is a
contract, and the current edge, fees and limits. On a chain whose provider is the mock, every game
screen says so. Vault raffle draws emit only the winner, so they cannot be recomputed.

## Run against a local anvil chain

Needs Node 22 and [Foundry](https://book.getfoundry.sh). From the repository root, start a chain and
leave it running:

```sh
anvil
```

In a second terminal, deploy and seed. The key is anvil's well-known test account #0; never use it
anywhere else.

```sh
forge script script/Deploy.s.sol --rpc-url local --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/SeedLocal.s.sol --rpc-url local --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Then start the app:

```sh
cd app
npm install
npm run sync -- --local   # the current ABIs, and deployments/31337.json into addresses.local.ts
npm run dev    # http://localhost:5173
```

With anvil deployed and reachable, a first visit starts in Live mode; otherwise it starts in the demo.
The choice made with the Demo/Live switch is remembered.

### Local test account (no browser wallet needed)

While the chain selector is on Anvil (31337), the header offers a dashed **Use local test account
(anvil only)** button with a selector for anvil's accounts #0 to #3. It is a wagmi connector
(`src/localWallet.ts`) that sends transactions to the node as `eth_sendTransaction`, which anvil signs
with its own unlocked dev accounts. The app holds no keys; the addresses are read from the node. Every
write path in the app works with it unchanged, and you can switch between the four accounts while
connected to play both sides of a trade. #0 is the deployer and protocol owner after seeding.

It is for local development only: the option is hidden on every other chain, the connector refuses to
connect unless the node reports chain id 31337, it cannot switch chains (choosing another chain in
the selector disconnects it), and it never reconnects by itself after a page reload.

### With a browser wallet

In the wallet, add the network `http://127.0.0.1:8545` (chain id 31337) and import anvil's account #0.
After seeding it owns demo tokens 1-10, has an open collection offer and a token offer, a funded floor
bid and an open prediction market, and the Games contract has a 50 ETH bankroll with the demo collection
enabled. Import account #1 as well to act as a second party.

Things to know on a local chain:

- anvil only mines a block when a transaction arrives, and the app reads time from the latest block.
  The floor bid, auction prices and countdowns therefore stand still between transactions. Use
  `cast rpc evm_increaseTime <seconds>` then `cast rpc evm_mine` to move time forward.
- Restarting anvil wipes the chain. Deploy and seed again; the app shows "No contracts at the recorded
  addresses" until you do. Also reset the wallet's nonce/activity data for the account.
- Unlocking vault holdings by governance, sending them to a raffle, pushing an oracle floor and
  setting a collection's project share are owner actions with no button in the app. Use `cast send`
  with `--unlocked --from <account #0>`.
- A vault raffle draw and the vault's daily unlock draw need a randomness answer. On chain 31337 only,
  a raffle in the Drawing state, and the vault's draw while it waits, show a dashed "Local only" button
  that calls `MockRandomness.fulfill`.
- To walk through everything: a holding joins the daily unlock draw 90 days after purchase; a picked
  holding unlocks only if the median of the last 30 daily floor samples (at least 15; take one a day
  with the button, which needs a fresh sales floor, three recent collection-offer or floor-bid sales) is
  at least 130% of its purchase price at 90 days, falling to 100% at a year, and only within the
  collection's weekly release cap. Every fifth purchase is set aside for players and can be sent to
  the vault raffle after 30 days. A raffle can be drawn 7 days after it opens, and only once someone
  has activated points; its prize can be claimed 30 days after the draw. A prediction market resolves
  only with an oracle price pushed after its resolve time.

## Games (Play)

Dice and slots are separate pages over the same house bankroll; the lottery has its own page. The
slots page states that the reels illustrate the roll and the payout comes from the contract: the line
shown is derived from the settled roll alone and never stages a near miss. Only a result that pays
more than the wager is presented as a win; a 1x result is shown as "stake returned". The session's
wagered, paid back and net figures stay on screen. Sound (WebAudio, no files) is off until turned on
in the header.

In a development build the stages register `window.__fgPreview.*` hooks (for example
`__fgPreview.dice(roll, percent)`) that play a result moment with a chosen roll without placing a
bet. They do not exist in a production build.

## Dice (formerly the Games tab)

Dice and coinflip against the house bankroll (`Games.sol`), backing the selected collection: half of the edge on
every wager (by default; `bankrollShareBps` sets it) is a protocol fee for that collection and the
bankroll keeps the rest. A wager can be at most `maxWager()`, 1% of the free bankroll by default. The tab shows the bankroll, the edge, the funds
reserved for open bets and the largest wager allowed at the chosen chance. That maximum is the smallest of the four
limits the contract enforces: the wager cap, one bet's exposure (1% of the free bankroll), all open
bets' exposure together (20% of the house's funds) and all wagers in play together (also 20%). The tab quotes the payout and fee live from
`Games.quote`, and lists the connected account's bets from `BetPlaced` / `BetSettled` / `BetRefunded`
logs (pending, won, lost, refundable, refunded).

> Games of chance are regulated or prohibited in many places. Check the law that applies to you before
> playing, deploying or operating this.

A bet settles when the randomness provider answers. On public networks that is Chainlink VRF. On anvil
it is `test/mocks/MockRandomness.sol`, which answers only when someone calls `fulfill`, so on chain
31337 (and only there) each pending bet has a dashed button, "Local only: settle with mock randomness".
It calls `MockRandomness.fulfill` with a 256-bit word from `crypto.getRandomValues`. Whoever calls
`fulfill` chooses the word, so this is not a fair game; it exists to exercise the flow locally. A bet
left unsettled for six hours (`Games.REFUND_TIMEOUT`) shows a Refund button (`cast rpc evm_increaseTime 21600` to get
there), and winnings that could not be delivered show a Withdraw button. After any refund betting is
paused for ten minutes and the stages say when it resumes.

## Ticket raffles tab

Paid-ticket raffles of an NFT (`TicketRaffle.sol`). The tab lists every raffle with its prize, ticket
price, tickets sold against the minimum and maximum, time left, status and your tickets, and it has a
form to raffle a token of the selected collection (the raffle contract is approved for the token
first). Buttons appear only when they apply: Buy, Cancel (creator, no tickets sold), Close (after the
end or a sell-out; it says whether it will request the draw or open refunds), Settle, Refund, Reclaim
(creator, after refunds opened), Reset the draw (no randomness for a day), Abort (anyone, a raffle stuck
for a week) and Withdraw (creator revenue).

> Paid raffles are regulated or prohibited in many places. Check the law that applies to you before
> buying tickets, creating a raffle, deploying or operating this.

Your odds are shown against the tickets sold so far and against the maximum. They can fall until the
raffle closes, because anyone, the creator included, can buy the unsold tickets late. On chain 31337
only, a raffle waiting for its draw has a dashed "Local only: draw with mock randomness" button; the
ticket raffle has its own `MockRandomness` instance (`ticketRaffleRandomness`).

## Artwork licences (Vault tab)

Below the holdings, the Vault tab lists every holding a licence can be in force on, the licence tiers
of its collection (`IPLicenseManager.sol`), your licence in force (tier and end date), and a request
form with the intended-use field (280 bytes at most, stored publicly on-chain). Requesting sends
exactly the tier price. Only locked holdings can be licensed.

A licence here records that you paid for a tier for a limited time. Whether the vault may license a
collection's artwork at all, and on what terms, depends on that collection's own terms; the licence
text lives off-chain. Tiers are a free-form number per collection with no on-chain list, so the app
probes tier numbers 0 to 7 and shows the active ones.

## Project fee share

The Treasury can pay part of a collection's protocol fees to the NFT project
(`Treasury.projectShareOf`). Overview shows the recipient and percentage, and a Claim button when the
connected account has a balance in `Treasury.owedTo`. The seed sets no share; to try it locally:

```sh
cast send <treasury> "setProjectShare(address,address,uint16)" <collection> <recipient> 2000 \
  --rpc-url local --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

## Syncing ABIs and addresses

`src/generated/` is produced by `scripts/sync-contracts.mjs`:

```sh
npm run sync             # rewrite src/generated/abis.ts and addresses.ts (public chains only)
npm run sync -- --local  # also write the local anvil chain to src/generated/addresses.local.ts
npm run sync -- --check  # write nothing, exit 1 if src/generated/ is out of date
```

- `abis.ts`: the ABIs from `../out/<Name>.sol/<Name>.json` as `as const` TypeScript (the protocol
  contracts, OpenZeppelin's ERC721, and `MockRandomness` for the local-only settle button), plus `errorsAbi`,
  every custom error of every contract (used to decode reverts that bubble up from a nested contract).
  It is checked in so the app builds without Foundry. If the Foundry artifacts are missing, the script
  leaves the existing file alone. Run `forge build` and then `npm run sync` whenever a contract changes.
- `addresses.ts`: one entry per `../deployments/<chainId>.json`, except the local chain. It is
  checked in and never carries a local deployment.
- `addresses.local.ts` (git-ignored, only with `--local`): the entry for chain 31337. Only a
  development build, or one built with `VITE_ENABLE_LOCAL=1`, imports it. Without it the app shows
  "No deployment found for this chain" on anvil until you deploy and run `npm run sync -- --local`.

### Local development is not in a production build

The anvil chain and its transport, the local test account, the first-visit probe of
`127.0.0.1:8545`, the "Local only" mock-settle and mock-draw buttons and the local deployment's
addresses all sit behind one build-time switch (`src/local.ts`): `import.meta.env.DEV`, or
`VITE_ENABLE_LOCAL=1` for a production build that is meant for a local chain. A production build
without the flag makes no request to a loopback address, its default chain is Ethereum, and
`grep -ri "local test account" dist/` finds nothing. `VITE_ANVIL_RPC_URL` is refused unless it is a
loopback address, and the local test account re-checks the node's chain id before it forwards a
transaction.

## Base Sepolia

Deploy with `script/Deploy.s.sol` (see its header for the VRF environment variables), which writes
`deployments/84532.json`, then `npm run sync`. Optional settings, in `app/.env.local`:

| Variable | Purpose |
| --- | --- |
| `VITE_BASE_SEPOLIA_RPC_URL` | RPC endpoint. Defaults to the chain's public RPC. |
| `VITE_LOGS_FROM_BLOCK` | First block to scan for event logs. Set it to the deployment block. Logs are read in windows (`VITE_LOGS_WINDOW` blocks, 9000 by default) and what was scanned is kept in memory, so a refresh only asks for the new blocks; a scan that would need more than 40 windows starts later instead and says so in the console. If the log query fails, the offer list falls back to reading the most recent 200 offer ids directly; the bet list has no fallback (bets cannot be enumerated on-chain) and shows an error. The connected account's own offers and open bets are always looked up by their indexed topic, so they cannot be crowded out of the lists. |
| `VITE_LOGS_WINDOW` | Largest block range of one `eth_getLogs` request. |
| `VITE_ANVIL_RPC_URL` | Local node URL, development only. Defaults to `http://127.0.0.1:8545`; anything but a loopback address is ignored. |
| `VITE_ENABLE_LOCAL` | `1` keeps the local-development machinery in a production build. Leave it unset for anything public. |
| `VITE_DEMO_ONLY` | `1` builds the demo alone: no Live mode, no wallet connectors, no wallet discovery. Use it wherever the headers below cannot be sent or the origin is shared, such as GitHub Pages. |

Reads made together go out as one multicall3 call on chains that have the contract (the public ones
do; a bare anvil does not, and they are then sent one by one). Polling follows the chain's block
time and stops while the tab is hidden.

## Deploying

### The demo alone

The hosted demo at https://goldcote.github.io/FloorGuard/ is a demo-only build served by GitHub Pages
from the `gh-pages` branch. Pages cannot send the headers below and `goldcote.github.io` is shared by
every Pages site of the account, so that build must never offer Live mode or talk to a wallet:

```bash
VITE_DEMO_ONLY=1 npm run build
```

Publish `dist/` with an empty `.nojekyll` file beside it. Then run the checklist at the end of this
section on `dist/`.

### A live build

The build uses relative asset URLs (`base: "./"`) and has no inline script or style, so it runs under
a strict Content-Security-Policy without hashes. Serve it from a dedicated origin (never from a path
of an IPFS gateway or any origin shared with other sites: everything on an origin shares its
storage and its wallet permissions) with these headers, adding to `connect-src` only the RPC origins
the build was configured with:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://<rpc-origin-1> https://<rpc-origin-2>; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
```

- `frame-ancestors` cannot be set from a `<meta>` tag: it has to be this header. Use
  `frame-ancestors https://app.safe.global` instead of `'none'` only if the app is to be opened as
  a Safe App. The in-page check in `src/lib/frame.ts` is a fallback, not a replacement.
- Wallet icons announced by browser wallets are `data:` URIs, hence `img-src data:`.
- With WalletConnect enabled, its relay and API origins have to be added to `connect-src` (and its
  modal's assets to the relevant directives); they are WalletConnect's, not this app's, and have
  not been audited here.
- Checklist before publishing a build: `VITE_ENABLE_LOCAL` unset; `VITE_LOGS_FROM_BLOCK` set to the
  deployment block; RPC URLs set and listed in `connect-src`; `npm run sync -- --check` clean;
  `grep -rE "127\.0\.0\.1|localhost:8545" dist/` and `grep -ri "local test account" dist/` empty;
  the headers above verified on the live origin.

## Reviewing a transaction

Every action opens a review before anything is signed. It says in words what will happen, and
shows, for each transaction the wallet will be asked to sign: the contract (by its name in the
deployment, and its address), the function, the ETH value and, for an approval, the spender and the
token. The same block is shown again while the wallet is open, so the two can be compared. Limits
are fixed when the review opens, from the figures on screen, and are stated exactly: the most a
vault purchase may cost (that amount is the value sent; the contract refunds the rest), the least a
sale into the floor bid or into an offer may pay. If a re-read after confirming is worse than that
limit, nothing is sent and the review has to be opened again. A review is cancelled if the
connected account or the chain changes while it is open. Text that comes from a contract, a node or
a wallet (a revert reason, an RPC error) is cut to 200 characters, stripped of links and labelled
as untrusted.

## Checks

```sh
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build into dist/
npm test            # integration test, see below
```

`npm test` runs nine files, one at a time (two of them share the local chain). `test/security.test.ts`
covers the front end's defences (strict parsing, untrusted text, what a review shows, framing, the
local-development gate, bounded log reads). `test/parity.anvil.test.ts` runs the same sequences
through the demo simulator and through the chain and compares the numbers to the wei. `test/gameviz.test.ts` checks the pure functions behind the Play
stages (`src/fx/gameviz.ts`). `test/fairness.test.ts` (payout recomputation), `test/wallets.test.ts`
(wallet menu ordering), `test/demo.test.ts` (the demo simulator against the contracts' rules),
`test/house.test.ts` (house share arithmetic against `Games.sol`'s formulas) and `test/viz.test.ts`
(the curve, lock, auction and split maths behind the charts, and the landing's explainer model) need
no chain. `test/anvil.test.ts` runs against a freshly deployed and seeded anvil (the steps above; it
asserts on the seeded state, so do not click around in the app first). It
calls every read function behind the UI and sends every transaction the UI can build from anvil's
unlocked accounts, then asserts on the results and on the decoded custom errors. It snapshots the chain
first and reverts afterwards, so it can be re-run. Without a reachable, deployed anvil the suite is
skipped with a warning; it does not fail.

## Layout

```
scripts/sync-contracts.mjs   ABI and address generator
src/generated/               generated, checked in
src/lib/reads.ts             every on-chain read, as plain functions over a viem client
src/lib/calls.ts             every transaction the UI sends, as plain builders
src/lib/errors.ts            custom error -> readable message
src/lib/gameMath.ts          fee, stake, dice payout, slots table, pot split: used by live and demo
src/lib/house.ts             house shares: the reads, the connected account's requests, the history from events
src/lib/houseMath.ts         house shares: the contract's arithmetic (prices, spreads, tolerance), pure
src/lib/logs.ts              event logs in bounded windows, remembered between refreshes
src/lib/gas.ts               the gas margin over a node's estimate, and why
src/lib/review.ts            what a transaction is in the wallet's terms, for the review dialog
src/lib/frame.ts             the framing guard; src/lib/loopback.ts which node may be the local chain
src/local.ts                 the build-time switch for all local-development machinery
src/deployments.ts           the deployments the build knows (public ones, plus local when enabled)
src/viz/                     visualisations: curve maths, flywheel diagram, hero, charts, lock mechanisms
src/fx/                      effects for the Play stages: motion, particles, counts, reveal clock (see its README)
src/styles.css               tokens, base components and the shell; src/styles/ holds the page styles
src/demo/                    demo mode: the in-browser simulated protocol and the mode switch
src/routes.ts                hash routes; src/theme.ts light/dark; src/brand.tsx logo and floor line
src/WalletMenu.tsx           wallet picker and chain selector; src/lib/wallets.ts its ordering rules
src/hooks.ts                 react-query wrappers around lib/reads.ts (polling at block cadence, paused in hidden tabs; 1 s in the demo)
src/tx.tsx                   transaction runner: review dialog, simulate, sign, wait, result
src/localWallet.ts           local-only connector for anvil's unlocked accounts
src/tabs/                    one file per page, plus Verify.tsx and gamesShared.tsx
test/                        two anvil test files (integration, simulator parity) and seven chain-free unit test files
```
