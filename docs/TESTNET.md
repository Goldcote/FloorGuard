# Deploying to a testnet

These steps deploy FloorGuard to Base Sepolia. The deployment has been simulated
against Base Sepolia (about 16.7 million gas in total) but has not been
broadcast: no testnet deployment exists yet.

The Chainlink values below were read from Chainlink's
[supported networks page](https://docs.chain.link/vrf/v2-5/supported-networks).
Check them against that page before use; they change.

| | Base Sepolia | Ethereum Sepolia |
|---|---|---|
| Chain id | 84532 | 11155111 |
| VRF v2.5 coordinator | `0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE` | `0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B` |
| Key hash | `0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71` | `0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae` |

## 1. A deployer account

Create or import an account into Foundry's encrypted keystore. Never put a
private key in `.env` or on the command line.

```bash
cast wallet import floorguard-deployer --interactive
```

Fund it with Base Sepolia ETH from a faucet. Well under 0.01 ETH is enough.

## 2. A VRF subscription

Create a subscription at [vrf.chain.link](https://vrf.chain.link) on Base
Sepolia, fund it, and note its id. You will add two consumers to it after
deploying.

## 3. Configure

Copy `.env.example` to `.env` and set:

```
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
VRF_COORDINATOR=0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE
VRF_KEY_HASH=0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71
VRF_SUB_ID=<your subscription id>
OWNER=<your multisig, or leave empty to keep the deployer as owner>
TIMELOCK_DELAY=<optional: seconds owner actions wait in a public timelock>
```

## 4. Deploy

Simulate first:

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --account floorguard-deployer
```

Then broadcast:

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --account floorguard-deployer --broadcast
```

Addresses are written to `deployments/84532.json`. Commit that file.

## 5. After deploying

1. Add the `randomness`, `gamesRandomness` and `ticketRaffleRandomness` addresses
   from the deployment file as consumers of the VRF subscription. Raffles and
   games cannot settle until this is done.
2. If `OWNER` was set, that account finishes the handover with
   `script/AcceptOwnership.s.sol`. With a timelock, run it once with
   `STEP=schedule` and again after the delay with `STEP=execute`. A multisig
   submits the same calls itself.
3. Onboard a collection (see `script/AddCollection.s.sol` for all options):

   ```bash
   COLLECTION=<address> BID_BASE=<wei> BID_MAX=<wei> forge script script/AddCollection.s.sol --rpc-url base_sepolia --account floorguard-deployer --broadcast
   ```

4. Fund the games bankroll with `Games.fundBankroll()` if games are enabled.
5. In `app/`, run `npm run sync` so the app picks up the new addresses.
