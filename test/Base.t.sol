// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Vault} from "../src/Vault.sol";
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {Games} from "../src/Games.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {IPLicenseManager} from "../src/IPLicenseManager.sol";
import {MockNFT} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev Deploys and wires the whole protocol. The Vault and the PredictionMarket read the push oracle so
///      tests control the floor; the sales oracle is fed by the Marketplace and the BuybackEngine.
abstract contract Base is Test {
    address internal gov = makeAddr("gov");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    Treasury internal treasury;
    Marketplace internal marketplace;
    BuybackEngine internal engine;
    Vault internal vault;
    SalesFloorOracle internal salesOracle;
    PushFloorOracle internal pushOracle;
    PredictionMarket internal prediction;
    Points internal points;
    VaultRaffle internal raffle;
    Games internal games;
    TicketRaffle internal ticketRaffle;
    IPLicenseManager internal licenses;
    MockRandomness internal randomness;
    MockNFT internal nft;

    /// 2,500 points (18 decimals) per ETH of fees: 50 points per ETH traded at the 2% marketplace fee.
    uint256 internal constant POINTS_RATE = 2_500e18;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        vm.startPrank(gov);
        treasury = new Treasury(gov);
        salesOracle = new SalesFloorOracle(gov);
        pushOracle = new PushFloorOracle(gov);
        marketplace = new Marketplace(gov, treasury);
        vault = new Vault(gov, treasury, pushOracle);
        engine = new BuybackEngine(gov, treasury, vault);

        treasury.setSpender(address(engine));
        vault.setEngine(address(engine));
        marketplace.setSaleRecorder(salesOracle);
        engine.setSaleRecorder(salesOracle);
        salesOracle.setReporter(address(marketplace), true);
        salesOracle.setReporter(address(engine), true);
        pushOracle.setReporter(gov, true);

        randomness = new MockRandomness();
        points = new Points(gov);
        prediction = new PredictionMarket(gov, treasury, pushOracle);
        raffle = new VaultRaffle(gov, points, address(vault), randomness);
        vault.setRaffle(raffle);
        points.setRaffle(address(raffle));
        points.setRate(address(marketplace), POINTS_RATE);
        points.setRate(address(prediction), POINTS_RATE);
        marketplace.setPoints(points);
        prediction.setPoints(points);

        games = new Games(gov, treasury, randomness);
        games.setPoints(points);
        points.setRate(address(games), POINTS_RATE);

        ticketRaffle = new TicketRaffle(gov, treasury, randomness);
        licenses = new IPLicenseManager(gov, vault, treasury);
        vm.stopPrank();

        nft = new MockNFT();
        vm.prank(gov);
        prediction.setCollectionSupport(address(nft), true);
        vm.prank(gov);
        marketplace.setCollectionSupport(address(nft), true);
        vm.prank(gov);
        games.setCollectionSupport(address(nft), true);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _mintApproved(address to, uint256 tokenId, address operator) internal {
        nft.mint(to, tokenId);
        vm.prank(to);
        nft.approve(operator, tokenId);
    }

    /// Credit points from this test contract (which must have a rate) and activate them.
    function _earn(address user, uint256 feeWei) internal {
        points.creditFee(user, feeWei);
        points.flush(user);
    }

    function _pushFloor(uint256 price) internal {
        vm.prank(gov);
        pushOracle.pushFloor(address(nft), price);
    }
}
