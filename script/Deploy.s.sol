// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Vault} from "../src/Vault.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {Games} from "../src/Games.sol";
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../src/interfaces/IFloorGuard.sol";
import {MockRandomness} from "../test/mocks/MockRandomness.sol";

/// @notice Deploys and wires the protocol, then writes the addresses to `deployments/<chainId>.json`.
///
/// The Vault reads the SalesFloorOracle and the PredictionMarket reads the PushFloorOracle; both can be
/// repointed by the owner afterwards.
///
/// Environment:
///   OWNER              final owner of every contract (default: the deployer). Ownership is two-step,
///                      so OWNER must call `acceptOwnership()` on each contract.
///   VRF_COORDINATOR    Chainlink VRF v2.5 coordinator. Required with VRF_KEY_HASH and VRF_SUB_ID on
///                      public networks. On a local chain (31337) a mock provider is deployed instead.
contract Deploy is Script {
    uint256 internal constant POINTS_PER_ETH_OF_FEES = 2_500e18;

    struct Deployment {
        Treasury treasury;
        SalesFloorOracle salesOracle;
        PushFloorOracle pushOracle;
        Marketplace marketplace;
        Vault vault;
        BuybackEngine engine;
        PredictionMarket prediction;
        Points points;
        VaultRaffle raffle;
        Games games;
        address randomness;
        address gamesRandomness;
    }

    function run() external {
        address vrfCoordinator = vm.envOr("VRF_COORDINATOR", address(0));
        require(vrfCoordinator != address(0) || block.chainid == 31337, "VRF_COORDINATOR required");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);
        Deployment memory d;

        d.treasury = new Treasury(deployer);
        d.salesOracle = new SalesFloorOracle(deployer);
        d.pushOracle = new PushFloorOracle(deployer);
        d.marketplace = new Marketplace(deployer, d.treasury);
        d.vault = new Vault(deployer, d.treasury, d.salesOracle);
        d.engine = new BuybackEngine(deployer, d.treasury, d.vault);
        d.prediction = new PredictionMarket(deployer, d.treasury, d.pushOracle);
        d.points = new Points(deployer);
        d.raffle = new VaultRaffle(deployer, d.points, address(d.vault), IRandomnessProvider(address(0)));
        d.games = new Games(deployer, d.treasury, IRandomnessProvider(address(0)));

        // Each VRF adapter serves one consumer; both must be added to the VRF subscription.
        d.randomness = _randomness(vrfCoordinator, owner, address(d.raffle));
        d.gamesRandomness = vrfCoordinator == address(0)
            ? d.randomness
            : _randomness(vrfCoordinator, owner, address(d.games));

        d.treasury.setSpender(address(d.engine));
        d.vault.setEngine(address(d.engine));
        d.vault.setRaffle(d.raffle);
        d.raffle.setRandomness(IRandomnessProvider(d.randomness));
        d.games.setRandomness(IRandomnessProvider(d.gamesRandomness));
        d.marketplace.setSaleRecorder(d.salesOracle);
        d.engine.setSaleRecorder(d.salesOracle);
        d.salesOracle.setReporter(address(d.marketplace), true);
        d.salesOracle.setReporter(address(d.engine), true);
        d.points.setRaffle(address(d.raffle));
        d.points.setRate(address(d.marketplace), POINTS_PER_ETH_OF_FEES);
        d.points.setRate(address(d.prediction), POINTS_PER_ETH_OF_FEES);
        d.points.setRate(address(d.games), POINTS_PER_ETH_OF_FEES);
        d.marketplace.setPoints(d.points);
        d.prediction.setPoints(d.points);
        d.games.setPoints(d.points);

        if (owner != deployer) {
            d.treasury.transferOwnership(owner);
            d.salesOracle.transferOwnership(owner);
            d.pushOracle.transferOwnership(owner);
            d.marketplace.transferOwnership(owner);
            d.vault.transferOwnership(owner);
            d.engine.transferOwnership(owner);
            d.prediction.transferOwnership(owner);
            d.points.transferOwnership(owner);
            d.raffle.transferOwnership(owner);
            d.games.transferOwnership(owner);
        }
        vm.stopBroadcast();
        _write(d, owner);
    }

    function _write(Deployment memory d, address owner) private {
        string memory key = "deployment";
        vm.serializeAddress(key, "treasury", address(d.treasury));
        vm.serializeAddress(key, "marketplace", address(d.marketplace));
        vm.serializeAddress(key, "buybackEngine", address(d.engine));
        vm.serializeAddress(key, "vault", address(d.vault));
        vm.serializeAddress(key, "predictionMarket", address(d.prediction));
        vm.serializeAddress(key, "points", address(d.points));
        vm.serializeAddress(key, "vaultRaffle", address(d.raffle));
        vm.serializeAddress(key, "games", address(d.games));
        vm.serializeAddress(key, "salesFloorOracle", address(d.salesOracle));
        vm.serializeAddress(key, "pushFloorOracle", address(d.pushOracle));
        vm.serializeAddress(key, "randomness", d.randomness);
        vm.serializeAddress(key, "gamesRandomness", d.gamesRandomness);
        string memory json = vm.serializeAddress(key, "owner", owner);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Deployment written to", path);
    }

    function _randomness(address vrfCoordinator, address owner, address consumer) private returns (address) {
        if (vrfCoordinator == address(0)) return address(new MockRandomness());
        return address(
            new ChainlinkVRFRandomness(
                owner,
                IVRFCoordinatorV2Plus(vrfCoordinator),
                IRandomnessConsumer(consumer),
                vm.envBytes32("VRF_KEY_HASH"),
                vm.envUint("VRF_SUB_ID")
            )
        );
    }
}
