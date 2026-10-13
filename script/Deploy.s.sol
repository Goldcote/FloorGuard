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
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {IRandomnessProvider} from "../src/interfaces/IFloorGuard.sol";
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

    function run() external {
        address vrfCoordinator = vm.envOr("VRF_COORDINATOR", address(0));
        require(vrfCoordinator != address(0) || block.chainid == 31337, "VRF_COORDINATOR required");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);

        Treasury treasury = new Treasury(deployer);
        SalesFloorOracle salesOracle = new SalesFloorOracle(deployer);
        PushFloorOracle pushOracle = new PushFloorOracle(deployer);
        Marketplace marketplace = new Marketplace(deployer, treasury);
        Vault vault = new Vault(deployer, treasury, salesOracle);
        BuybackEngine engine = new BuybackEngine(deployer, treasury, vault);
        PredictionMarket prediction = new PredictionMarket(deployer, treasury, pushOracle);
        Points points = new Points(deployer);
        VaultRaffle raffle =
            new VaultRaffle(deployer, points, address(vault), IRandomnessProvider(address(0)));

        address randomness;
        if (vrfCoordinator == address(0)) {
            randomness = address(new MockRandomness());
        } else {
            randomness = address(
                new ChainlinkVRFRandomness(
                    owner,
                    IVRFCoordinatorV2Plus(vrfCoordinator),
                    raffle,
                    vm.envBytes32("VRF_KEY_HASH"),
                    vm.envUint("VRF_SUB_ID")
                )
            );
        }

        treasury.setSpender(address(engine));
        vault.setEngine(address(engine));
        vault.setRaffle(raffle);
        raffle.setRandomness(IRandomnessProvider(randomness));
        marketplace.setSaleRecorder(salesOracle);
        engine.setSaleRecorder(salesOracle);
        salesOracle.setReporter(address(marketplace), true);
        salesOracle.setReporter(address(engine), true);
        points.setRaffle(address(raffle));
        points.setRate(address(marketplace), POINTS_PER_ETH_OF_FEES);
        points.setRate(address(prediction), POINTS_PER_ETH_OF_FEES);
        marketplace.setPoints(points);
        prediction.setPoints(points);

        if (owner != deployer) {
            treasury.transferOwnership(owner);
            salesOracle.transferOwnership(owner);
            pushOracle.transferOwnership(owner);
            marketplace.transferOwnership(owner);
            vault.transferOwnership(owner);
            engine.transferOwnership(owner);
            prediction.transferOwnership(owner);
            points.transferOwnership(owner);
            raffle.transferOwnership(owner);
        }
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeAddress(key, "treasury", address(treasury));
        vm.serializeAddress(key, "marketplace", address(marketplace));
        vm.serializeAddress(key, "buybackEngine", address(engine));
        vm.serializeAddress(key, "vault", address(vault));
        vm.serializeAddress(key, "predictionMarket", address(prediction));
        vm.serializeAddress(key, "points", address(points));
        vm.serializeAddress(key, "vaultRaffle", address(raffle));
        vm.serializeAddress(key, "salesFloorOracle", address(salesOracle));
        vm.serializeAddress(key, "pushFloorOracle", address(pushOracle));
        vm.serializeAddress(key, "randomness", randomness);
        string memory json = vm.serializeAddress(key, "owner", owner);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Deployment written to", path);
    }
}
