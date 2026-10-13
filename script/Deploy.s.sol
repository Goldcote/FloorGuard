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
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {Lottery} from "../src/Lottery.sol";
import {IPLicenseManager} from "../src/IPLicenseManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
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
///   OWNER              who controls the protocol (default: the deployer); use a multisig. Ownership is
///                      two-step: finish the handover with script/AcceptOwnership.s.sol.
///   TIMELOCK_DELAY     optional, in seconds. If set, an OpenZeppelin TimelockController with OWNER as
///                      its only proposer and executor is deployed and becomes the owner of every
///                      contract, so each owner action waits out the delay in public first.
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
        TicketRaffle ticketRaffle;
        Lottery lottery;
        address lotteryRandomness;
        IPLicenseManager licenses;
        address randomness;
        address gamesRandomness;
        address ticketRaffleRandomness;
        address timelock;
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

        d.ticketRaffle = new TicketRaffle(deployer, d.treasury, IRandomnessProvider(address(0)));
        d.licenses = new IPLicenseManager(deployer, d.vault, d.treasury);
        d.lottery = new Lottery(deployer, d.treasury, IRandomnessProvider(address(0)));

        uint256 timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(0));
        if (timelockDelay != 0) {
            address[] memory controllers = new address[](1);
            controllers[0] = owner;
            d.timelock = address(new TimelockController(timelockDelay, controllers, controllers, address(0)));
            owner = d.timelock;
        }

        // Each VRF adapter serves one consumer; all four must be added to a VRF subscription.
        d.randomness = _randomness(vrfCoordinator, owner, address(d.raffle));
        d.gamesRandomness = vrfCoordinator == address(0)
            ? d.randomness
            : _randomness(vrfCoordinator, owner, address(d.games));
        d.ticketRaffleRandomness = vrfCoordinator == address(0)
            ? address(new MockRandomness())
            : _randomness(vrfCoordinator, owner, address(d.ticketRaffle));
        d.ticketRaffle.setRandomness(IRandomnessProvider(d.ticketRaffleRandomness));
        d.lotteryRandomness = vrfCoordinator == address(0)
            ? address(new MockRandomness())
            : _randomness(vrfCoordinator, owner, address(d.lottery));
        d.lottery.setRandomness(IRandomnessProvider(d.lotteryRandomness));

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
            d.ticketRaffle.transferOwnership(owner);
            d.licenses.transferOwnership(owner);
            d.lottery.transferOwnership(owner);
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
        vm.serializeAddress(key, "ticketRaffle", address(d.ticketRaffle));
        vm.serializeAddress(key, "ticketRaffleRandomness", d.ticketRaffleRandomness);
        vm.serializeAddress(key, "ipLicenseManager", address(d.licenses));
        vm.serializeAddress(key, "lottery", address(d.lottery));
        vm.serializeAddress(key, "lotteryRandomness", d.lotteryRandomness);
        vm.serializeAddress(key, "timelock", d.timelock);
        // the block to start reading events from; the app and the keeper need it
        vm.serializeUint(key, "deployBlock", block.number);
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
