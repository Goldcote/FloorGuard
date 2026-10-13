// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {MockNFT} from "../test/mocks/MockNFT.sol";

/// @notice Local chains only. Run after Deploy with the same account. Deploys a demo collection and
///         leaves the protocol in a state worth looking at: tokens minted to the deployer, an open
///         collection offer, a funded floor bid and an open prediction market.
contract SeedLocal is Script {
    using stdJson for string;

    function run() external {
        require(block.chainid == 31337, "local chain only");
        string memory path = "deployments/31337.json";
        string memory json = vm.readFile(path);
        Treasury treasury = Treasury(payable(json.readAddress(".treasury")));
        Marketplace marketplace = Marketplace(json.readAddress(".marketplace"));
        BuybackEngine engine = BuybackEngine(json.readAddress(".buybackEngine"));
        PredictionMarket prediction = PredictionMarket(json.readAddress(".predictionMarket"));
        PushFloorOracle pushOracle = PushFloorOracle(json.readAddress(".pushFloorOracle"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        MockNFT nft = new MockNFT();
        for (uint256 tokenId = 1; tokenId <= 10; ++tokenId) {
            nft.mint(deployer, tokenId);
        }
        nft.setApprovalForAll(address(marketplace), true);
        nft.setApprovalForAll(address(engine), true);

        // floor bid: starts at 0.9 ETH, +10% a day, capped at 1.5 ETH, drops 5% after each fill
        engine.configureBid(address(nft), 0.9 ether, 1.5 ether, 1_000, 500, true);
        treasury.deposit{value: 5 ether}(address(nft));

        marketplace.makeCollectionOffer{value: 3 ether}(address(nft), 3, block.timestamp + 7 days);
        marketplace.makeOffer{value: 2 ether}(address(nft), 7, block.timestamp + 7 days);

        pushOracle.setReporter(deployer, true);
        pushOracle.pushFloor(address(nft), 1 ether);
        prediction.setCollectionSupport(address(nft), true);
        uint256 marketId = prediction.createMarket(address(nft), 6 hours, 1 days);
        prediction.placeBet{value: 0.5 ether}(marketId, true);
        prediction.placeBet{value: 0.3 ether}(marketId, false);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(nft)), path, ".demoCollection");
        console2.log("Demo collection", address(nft));
    }
}
