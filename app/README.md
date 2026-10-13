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
  share, house shares, and the vault raffle's minimum of activated points. It is labelled
  "Demo: simulated, no real transactions, play money" on every page and is not fair play.
- **Live**: a real chain through wagmi and viem. The only network requests are JSON-RPC calls to the
  selected chain. There is no analytics, no CDN, no remote font or image, and no backend.

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
- **Vault**: each holding with its time lock and price lock, its state, its licence tiers, and each
  auction as a falling price on a log scale with the reserve as the floor line.
- **Marketplace**: collection offers as a ladder (the protocol's own bid sits in it at its price),
  single-token offers, and a preview of who receives what before accepting or offering.
- **The house** (`#/play/house`): the games bankroll (free, set aside for open bets, wagers in
  play), the realised share price from events, your shares, and deposit and redeem with previews,
  a tolerance and what redeeming with bets open leaves behind. It is not a yield product and does
  not look like one.
- **Fairness**: the request → proof → roll → payout walk, the rules with each game's expected
  return, and the live status of the four conditions the claim depends on.

## Wallets and chains

- **Browser wallets** are discovered through EIP-6963 and listed by their own name and icon (Rabby
  first when present). The generic "Browser wallet" entry appears only when no wallet announced
  itself. A MetaMask-branded entry whose provider is really Rabby is hidden when Rabby is listed too.
  The last wallet reconnects on reload.
- **Local test account** (chain 31337 only): see below. It never reconnects by itself.
- **Safe**: when the app runs inside an iframe (opened as a Safe App), wagmi's `safe` connector is
  added. It talks to the parent Safe window by `postMessage`; it is not created otherwise.
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
npm run sync   # picks up deployments/31337.json and the current ABIs
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
- A vault raffle draw needs a randomness answer. On chain 31337 only, a raffle in the Drawing state shows a
  dashed "Local only: draw with mock randomness" button that calls `MockRandomness.fulfill`.
- To walk through everything: a holding unlocks 180 days after purchase and only if the sales floor
  (three recent collection-offer or floor-bid sales) is at least 130% of its purchase price; a raffle
  can be drawn 7 days after it opens, and only once someone has activated points; a prediction market
  resolves only with an oracle price pushed after its resolve time.

## Games (Play)

Dice and slots are separate pages over the same house bankroll; the lottery has its own page. The
slots page states that the reels illustrate the roll and the payout comes from the contract: the line
shown is derived from the settled roll alone and never stages a near miss. Only a result that pays
more than the wager is presented as a win; a 1x result is shown as "stake returned". The session's
wagered, paid back and net figures stay on screen. Sound (WebAudio, no files) is off until turned on
in the header.

## Dice (formerly the Games tab)

Dice and coinflip against the house bankroll (`Games.sol`), backing the selected collection: half of the edge on
every wager (by default; `bankrollShareBps` sets it) is a protocol fee for that collection and the
bankroll keeps the rest. A wager can be at most `maxWager()`, 1% of the free bankroll by default. The tab shows the bankroll, the edge, the funds
reserved for open bets and the largest wager allowed at the chosen chance. That maximum respects both
caps the contract enforces: one bet may put at most 1% of the free bankroll at risk, and all open bets
together at most 20% of the house funds. The tab quotes the payout and fee live from
`Games.quote`, and lists the connected account's bets from `BetPlaced` / `BetSettled` / `BetRefunded`
logs (pending, won, lost, refundable, refunded).

> Games of chance are regulated or prohibited in many places. Check the law that applies to you before
> playing, deploying or operating this.

A bet settles when the randomness provider answers. On public networks that is Chainlink VRF. On anvil
it is `test/mocks/MockRandomness.sol`, which answers only when someone calls `fulfill`, so on chain
31337 (and only there) each pending bet has a dashed button, "Local only: settle with mock randomness".
It calls `MockRandomness.fulfill` with a 256-bit word from `crypto.getRandomValues`. Whoever calls
`fulfill` chooses the word, so this is not a fair game; it exists to exercise the flow locally. A bet
left unsettled for a day shows a Refund button (`cast rpc evm_increaseTime 86400` to get there), and
winnings that could not be delivered show a Withdraw button.

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
npm run sync             # rewrite src/generated/
npm run sync -- --check  # write nothing, exit 1 if src/generated/ is out of date
```

- `abis.ts`: the ABIs from `../out/<Name>.sol/<Name>.json` as `as const` TypeScript (the protocol
  contracts, OpenZeppelin's ERC721, and `MockRandomness` for the local-only settle button), plus `errorsAbi`,
  every custom error of every contract (used to decode reverts that bubble up from a nested contract).
  It is checked in so the app builds without Foundry. If the Foundry artifacts are missing, the script
  leaves the existing file alone. Run `forge build` and then `npm run sync` whenever a contract changes.
- `addresses.ts`: one entry per `../deployments/<chainId>.json`. `deployments/31337.json` is
  git-ignored, so a fresh clone may have no local entry; the app then shows "No deployment found for
  this chain" until you deploy and sync.

## Base Sepolia

Deploy with `script/Deploy.s.sol` (see its header for the VRF environment variables), which writes
`deployments/84532.json`, then `npm run sync`. Optional settings, in `app/.env.local`:

| Variable | Purpose |
| --- | --- |
| `VITE_BASE_SEPOLIA_RPC_URL` | RPC endpoint. Defaults to the chain's public RPC. |
| `VITE_LOGS_FROM_BLOCK` | First block to scan for Marketplace and Games logs. Set it to the deployment block: public RPCs refuse wide `eth_getLogs` ranges. If the log query fails, the offer list falls back to reading the most recent 200 offer ids directly; the bet list has no fallback (bets cannot be enumerated on-chain) and shows an error. |
| `VITE_ANVIL_RPC_URL` | Local node URL. Defaults to `http://127.0.0.1:8545`. |

## Checks

```sh
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build into dist/
npm test            # integration test, see below
```

`npm test` runs six files. `test/fairness.test.ts` (payout recomputation), `test/wallets.test.ts`
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
src/lib/house.ts             house shares: the contract's arithmetic, the reads, the history from events
src/viz/                     visualisations: curve maths, flywheel diagram, hero, charts, lock mechanisms
src/styles.css               tokens, base components and the shell; src/styles/ holds the page styles
src/demo/                    demo mode: the in-browser simulated protocol and the mode switch
src/routes.ts                hash routes; src/theme.ts light/dark; src/brand.tsx logo and floor line
src/WalletMenu.tsx           wallet picker and chain selector; src/lib/wallets.ts its ordering rules
src/hooks.ts                 react-query wrappers around lib/reads.ts (5 s polling; 1 s in the demo)
src/tx.tsx                   transaction runner: review dialog, simulate, sign, wait, result
src/localWallet.ts           local-only connector for anvil's unlocked accounts
src/tabs/                    one file per page, plus Verify.tsx and gamesShared.tsx
test/                        anvil integration test and five chain-free unit test files
```
