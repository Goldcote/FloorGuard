# FloorGuard app

Web front end for the FloorGuard protocol: Vite + React + TypeScript, wagmi v2 + viem.

> Unaudited experimental software. Do not use with real funds.

It connects through an injected browser wallet only. There is no WalletConnect, no analytics and no
backend: the only network requests are JSON-RPC calls to the selected chain (the local anvil node, or
Base Sepolia).

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

In the wallet, add the network `http://127.0.0.1:8545` (chain id 31337) and import anvil's account #0.
After seeding it owns demo tokens 1-10, has an open collection offer and a token offer, a funded floor
bid and an open prediction market. Import account #1 as well to act as a second party.

Things to know on a local chain:

- anvil only mines a block when a transaction arrives, and the app reads time from the latest block.
  The floor bid, auction prices and countdowns therefore stand still between transactions. Use
  `cast rpc evm_increaseTime <seconds>` then `cast rpc evm_mine` to move time forward.
- Restarting anvil wipes the chain. Deploy and seed again; the app shows "No contracts at the recorded
  addresses" until you do. Also reset the wallet's nonce/activity data for the account.
- Unlocking vault holdings by governance, sending them to a raffle and fulfilling the mock randomness
  are owner or test actions with no button in the app. Use `cast send`, as in `test/anvil.test.ts`.

## Syncing ABIs and addresses

`src/generated/` is produced by `scripts/sync-contracts.mjs`:

```sh
npm run sync             # rewrite src/generated/
npm run sync -- --check  # write nothing, exit 1 if src/generated/ is out of date
```

- `abis.ts`: the ABIs from `../out/<Name>.sol/<Name>.json` as `as const` TypeScript, plus `errorsAbi`,
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
| `VITE_LOGS_FROM_BLOCK` | First block to scan for Marketplace logs. Set it to the deployment block: public RPCs refuse wide `eth_getLogs` ranges. If the log query fails the app falls back to reading the most recent 200 offer ids directly. |
| `VITE_ANVIL_RPC_URL` | Local node URL. Defaults to `http://127.0.0.1:8545`. |

## Checks

```sh
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build into dist/
npm test            # integration test, see below
```

`npm test` runs `test/anvil.test.ts` against a freshly deployed and seeded anvil (the steps above). It
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
src/hooks.ts                 react-query wrappers around lib/reads.ts (5 s polling)
src/tx.tsx                   transaction runner: simulate, sign, wait, with pending/success/error panel
src/tabs/                    Overview, Marketplace, Floor bid, Predictions, Vault, Raffles
test/anvil.test.ts           integration test against anvil
```
