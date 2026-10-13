// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Games} from "../src/Games.sol";
import {Vault} from "../src/Vault.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {Lottery} from "../src/Lottery.sol";

/// @notice Onboards an NFT collection in one run. Must be broadcast by the protocol owner, so run it
///         before ownership is handed to a multisig or timelock, or have that owner submit the same
///         calls. Licence tiers are set separately with `IPLicenseManager.setTier`.
///
/// Environment:
///   COLLECTION           the ERC-721 contract
///   BID_BASE             starting floor bid in wei; set it below the current floor
///   BID_MAX              hard cap on the floor bid in wei
///   BID_GROWTH_BPS_DAY   daily rise of the bid in basis points (default 1000 = 10%)
///   BID_STEP_DOWN_BPS    drop after each fill in basis points (default 500 = 5%)
///   PROJECT_RECIPIENT    optional: address that receives the project's share of fees
///   PROJECT_SHARE_BPS    optional: that share in basis points, at most 5000
///   ENABLE_PREDICTIONS   optional (default false). Only enable with a trustworthy oracle price.
///   MIN_AUCTION_RESERVE  optional, in wei: the lowest reserve for vault auctions of this collection.
///                        Recommended: it is the protection against a manipulated oracle.
///   ENABLE_GAMES         optional (default false)
///   LOTTERY_TICKET_PRICE optional, in wei: starts a weekly lottery for the collection at this price
///   ENABLE_TICKET_RAFFLES optional (default false): lets holders raffle tokens of this collection
contract AddCollection is Script {
    using stdJson for string;

    function run() external {
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address collection = vm.envAddress("COLLECTION");
        address projectRecipient = vm.envOr("PROJECT_RECIPIENT", address(0));

        vm.startBroadcast();
        Marketplace(json.readAddress(".marketplace")).setCollectionSupport(collection, true);
        BuybackEngine(json.readAddress(".buybackEngine"))
            .configureBid(
                collection,
                uint128(vm.envUint("BID_BASE")),
                uint128(vm.envUint("BID_MAX")),
                uint16(vm.envOr("BID_GROWTH_BPS_DAY", uint256(1_000))),
                uint16(vm.envOr("BID_STEP_DOWN_BPS", uint256(500))),
                true
            );
        if (projectRecipient != address(0)) {
            Treasury(payable(json.readAddress(".treasury")))
                .setProjectShare(collection, projectRecipient, uint16(vm.envUint("PROJECT_SHARE_BPS")));
        }
        uint256 minReserve = vm.envOr("MIN_AUCTION_RESERVE", uint256(0));
        if (minReserve != 0) Vault(json.readAddress(".vault")).setMinReserve(collection, minReserve);
        if (vm.envOr("ENABLE_PREDICTIONS", false)) {
            PredictionMarket(json.readAddress(".predictionMarket")).setCollectionSupport(collection, true);
        }
        if (vm.envOr("ENABLE_TICKET_RAFFLES", false)) {
            TicketRaffle(json.readAddress(".ticketRaffle")).setCollectionSupport(collection, true);
        }
        uint256 lotteryTicketPrice = vm.envOr("LOTTERY_TICKET_PRICE", uint256(0));
        if (lotteryTicketPrice != 0) {
            Lottery(json.readAddress(".lottery"))
                .setConfig(collection, uint128(lotteryTicketPrice), 7 days, true);
        }
        if (vm.envOr("ENABLE_GAMES", false)) {
            Games(json.readAddress(".games")).setCollectionSupport(collection, true);
        }
        vm.stopBroadcast();
        console2.log("Collection onboarded", collection);
    }
}
